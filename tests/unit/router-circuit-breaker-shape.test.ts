/**
 * Circuit-breaker shape: failure window, warm-up tolerance, adapter-declared
 * policy (#173, follow-up to #128).
 *
 * - **Window.** `window` (ms) turns "N consecutive failures" into "N failures
 *   within `window`". Left unset the breaker is exactly what it was: a
 *   consecutive count with no notion of elapsed time.
 * - **Warm-up.** A backend loading a model is slow, not broken. An adapter says
 *   so with `ErrorCode.MODEL_LOADING`, which the default `countAsFailure`
 *   does not count; `countAsFailure` is the per-backend escape hatch for
 *   anything else that should not count.
 * - **Adapter-declared policy.** `AdapterMetadata.circuitBreaker` is the
 *   package's recommendation; precedence is register() option > adapter
 *   metadata > RouterConfig, and `BackendInfo.circuitBreaker.source` says which
 *   layer each field came from.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Router } from '@johnhenry/aimatey-core';
import { ErrorCode, ProviderError, NetworkError } from '@johnhenry/aimatey-errors';
import type {
  BackendAdapter,
  AdapterMetadata,
  IRCapabilities,
  IRChatRequest,
  IRChatResponse,
  IRStreamChunk,
} from '@johnhenry/aimatey-types';

const REQUEST = {
  messages: [{ role: 'user', content: 'hi' }],
  parameters: { model: 'mock-model' },
  metadata: { requestId: 'req', timestamp: 0, provenance: {} },
} as unknown as IRChatRequest;

const OK = {
  id: 'res',
  model: 'mock-model',
  message: { role: 'assistant', content: 'ok' },
  finishReason: 'stop',
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  metadata: { requestId: 'r', timestamp: 0, provenance: {} },
} as unknown as IRChatResponse;

/** An adapter that throws whatever the test queued, then succeeds. */
class ScriptedAdapter implements BackendAdapter {
  readonly metadata: AdapterMetadata;
  failWith: (() => unknown) | undefined = () => new Error('connection refused');
  /** Yield this in-band error chunk instead of throwing, when set. */
  streamError: { code: string; message: string } | undefined;
  calls = 0;

  constructor(name: string, circuitBreaker?: AdapterMetadata['circuitBreaker']) {
    this.metadata = {
      name,
      version: '1.0.0',
      provider: 'mock',
      capabilities: {
        streaming: true,
        multiModal: false,
        tools: false,
        systemMessageStrategy: 'in-messages' as const,
      } as IRCapabilities,
      ...(circuitBreaker ? { circuitBreaker } : {}),
    };
  }

  fromIR(request: IRChatRequest): IRChatRequest {
    return request;
  }

  toIR(response: IRChatResponse): IRChatResponse {
    return response;
  }

  async execute(): Promise<IRChatResponse> {
    this.calls++;
    if (this.failWith) {
      throw this.failWith();
    }
    return OK;
  }

  async *executeStream(): AsyncGenerator<IRStreamChunk> {
    this.calls++;
    if (this.streamError) {
      yield { type: 'error', sequence: 0, error: this.streamError } as unknown as IRStreamChunk;
      return;
    }
    if (this.failWith) {
      throw this.failWith();
    }
    yield { type: 'done', sequence: 0, finishReason: 'stop' } as unknown as IRStreamChunk;
  }
}

function requestFor(backend: string): IRChatRequest {
  return {
    ...REQUEST,
    metadata: { ...REQUEST.metadata, custom: { backend } },
  } as IRChatRequest;
}

const loading = (): ProviderError =>
  new ProviderError({
    code: ErrorCode.MODEL_LOADING,
    message: 'loading model',
    isRetryable: true,
  });

async function run(router: Router, name: string, n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    await router.execute(requestFor(name)).catch(() => undefined);
  }
}

function routerWith(config: ConstructorParameters<typeof Router>[0] = {}) {
  return new Router({
    enableCircuitBreaker: true,
    circuitBreakerThreshold: 3,
    circuitBreakerTimeout: 60_000,
    routingStrategy: 'explicit',
    fallbackStrategy: 'none',
    ...config,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('failure window (#173 part 1)', () => {
  it('without a window, failures spread over any amount of time still open the breaker', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const router = routerWith();
    router.register('a', new ScriptedAdapter('a'));

    await run(router, 'a', 2);
    vi.advanceTimersByTime(60 * 60_000);
    await run(router, 'a', 1);

    expect(router.isCircuitBreakerOpen('a')).toBe(true);
    expect(router.getBackendInfo('a')?.circuitBreaker.window).toBeUndefined();
  });

  it('opens when threshold failures land inside the window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const router = routerWith();
    router.register('a', new ScriptedAdapter('a'), { circuitBreaker: { window: 1_000 } });

    await run(router, 'a', 2);
    vi.advanceTimersByTime(500);
    await run(router, 'a', 1);

    expect(router.isCircuitBreakerOpen('a')).toBe(true);
  });

  it('does not open when the failures are spread wider than the window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const router = routerWith();
    router.register('a', new ScriptedAdapter('a'), { circuitBreaker: { window: 1_000 } });

    await run(router, 'a', 2);
    vi.advanceTimersByTime(1_500);
    await run(router, 'a', 1);
    expect(router.isCircuitBreakerOpen('a')).toBe(false);

    // The two early failures aged out; two more inside the window do open it.
    await run(router, 'a', 2);
    expect(router.isCircuitBreakerOpen('a')).toBe(true);
  });

  it('a success does not reset a windowed count (intermittent failure still counts)', async () => {
    const router = routerWith();
    const adapter = new ScriptedAdapter('a');
    router.register('a', adapter, { circuitBreaker: { window: 10_000 } });

    await run(router, 'a', 2);
    adapter.failWith = undefined;
    await run(router, 'a', 1); // succeeds
    adapter.failWith = () => new Error('boom');
    await run(router, 'a', 1);

    expect(router.isCircuitBreakerOpen('a')).toBe(true);
  });

  it('whereas without a window a success does reset the run (unchanged behaviour)', async () => {
    const router = routerWith();
    const adapter = new ScriptedAdapter('a');
    router.register('a', adapter);

    await run(router, 'a', 2);
    adapter.failWith = undefined;
    await run(router, 'a', 1);
    adapter.failWith = () => new Error('boom');
    await run(router, 'a', 1);

    expect(router.isCircuitBreakerOpen('a')).toBe(false);
  });

  it('a failed half-open probe reopens a windowed breaker even after the window aged out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const router = routerWith({ circuitBreakerTimeout: 10_000 });
    const adapter = new ScriptedAdapter('a');
    router.register('a', adapter, { circuitBreaker: { window: 1_000 } });

    await run(router, 'a', 3);
    expect(router.isCircuitBreakerOpen('a')).toBe(true);

    vi.advanceTimersByTime(11_000); // rest over -> half-open; window long gone
    await run(router, 'a', 1); // probe fails
    expect(router.isCircuitBreakerOpen('a')).toBe(true);
  });

  it('closing or resetting the breaker forgets windowed failures', async () => {
    const router = routerWith();
    router.register('a', new ScriptedAdapter('a'), { circuitBreaker: { window: 10_000 } });

    await run(router, 'a', 2);
    router.resetCircuitBreaker('a');
    await run(router, 'a', 1);
    expect(router.isCircuitBreakerOpen('a')).toBe(false);
  });

  it('can be set router-wide, and a per-backend value overrides it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const router = routerWith({ circuitBreakerWindow: 1_000 });
    router.register('a', new ScriptedAdapter('a'));
    router.register('b', new ScriptedAdapter('b'), { circuitBreaker: { window: 60_000 } });

    for (const name of ['a', 'b']) {
      await run(router, name, 2);
    }
    vi.advanceTimersByTime(5_000);
    for (const name of ['a', 'b']) {
      await run(router, name, 1);
    }

    expect(router.isCircuitBreakerOpen('a')).toBe(false);
    expect(router.isCircuitBreakerOpen('b')).toBe(true);
  });

  it('counts a failed stream in the window like a failed call', async () => {
    const router = routerWith({ fallbackStrategy: 'none' });
    router.register('a', new ScriptedAdapter('a'), { circuitBreaker: { window: 10_000 } });

    for (let i = 0; i < 3; i++) {
      for await (const _ of router.executeStream(requestFor('a'))) {
        // drain
      }
    }
    expect(router.isCircuitBreakerOpen('a')).toBe(true);
  });

  it('rejects a window that could never behave', () => {
    const router = routerWith();
    for (const window of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        router.register('a', new ScriptedAdapter('a'), { circuitBreaker: { window } })
      ).toThrow(/window/);
    }
    expect(router.has('a')).toBe(false);
  });
});

describe('warm-up tolerance (#173 part 2)', () => {
  it('MODEL_LOADING is a documented error code in the provider category', () => {
    expect(ErrorCode.MODEL_LOADING).toBe('MODEL_LOADING');
    expect(loading().category).toBe('provider');
    expect(loading().isRetryable).toBe(true);
  });

  it('does not count a backend that says it is loading a model', async () => {
    const router = routerWith();
    const adapter = new ScriptedAdapter('a');
    adapter.failWith = loading;
    router.register('a', adapter);

    await run(router, 'a', 10);

    expect(router.isCircuitBreakerOpen('a')).toBe(false);
    expect(router.getBackendInfo('a')?.consecutiveFailures).toBe(0);
    // It is still a failed request, honestly reported.
    expect(router.getBackendInfo('a')?.stats.failedRequests).toBe(10);
  });

  it('does not count an in-band MODEL_LOADING error chunk either', async () => {
    const router = routerWith();
    const adapter = new ScriptedAdapter('a');
    adapter.streamError = { code: 'MODEL_LOADING', message: 'loading model' };
    router.register('a', adapter);

    for (let i = 0; i < 5; i++) {
      for await (const _ of router.executeStream(requestFor('a'))) {
        // drain
      }
    }
    expect(router.isCircuitBreakerOpen('a')).toBe(false);
  });

  it('warming errors do not break a run of real failures into a fresh count', async () => {
    const router = routerWith();
    const adapter = new ScriptedAdapter('a');
    router.register('a', adapter);

    await run(router, 'a', 2);
    adapter.failWith = loading;
    await run(router, 'a', 5);
    adapter.failWith = () => new Error('boom');
    await run(router, 'a', 1);

    expect(router.isCircuitBreakerOpen('a')).toBe(true);
  });

  it('every other failure counts by default, retryable or not', async () => {
    const router = routerWith({ circuitBreakerThreshold: 1 });
    const adapter = new ScriptedAdapter('a');
    adapter.failWith = () =>
      new NetworkError({ code: ErrorCode.NETWORK_ERROR, message: 'down', isRetryable: false });
    router.register('a', adapter);

    await run(router, 'a', 1);
    expect(router.isCircuitBreakerOpen('a')).toBe(true);
  });

  it('countAsFailure replaces the default predicate for that backend', async () => {
    const router = routerWith({ circuitBreakerThreshold: 2 });
    const slow = new ScriptedAdapter('slow');
    slow.failWith = () =>
      new ProviderError({
        code: ErrorCode.PROVIDER_TIMEOUT,
        message: 'first token took 40s',
        isRetryable: true,
      });
    const countAsFailure = vi.fn(
      (error: unknown) => (error as { code?: string }).code !== ErrorCode.PROVIDER_TIMEOUT
    );
    router.register('slow', slow, { circuitBreaker: { countAsFailure } });

    await run(router, 'slow', 6);
    expect(router.isCircuitBreakerOpen('slow')).toBe(false);
    expect(countAsFailure).toHaveBeenCalledTimes(6);

    slow.failWith = () => new Error('refused');
    await run(router, 'slow', 2);
    expect(router.isCircuitBreakerOpen('slow')).toBe(true);
  });

  it('a custom countAsFailure replaces the default, so it can count MODEL_LOADING if asked', async () => {
    const router = routerWith({ circuitBreakerThreshold: 2 });
    const adapter = new ScriptedAdapter('a');
    adapter.failWith = loading;
    router.register('a', adapter, { circuitBreaker: { countAsFailure: () => true } });

    await run(router, 'a', 2);
    expect(router.isCircuitBreakerOpen('a')).toBe(true);
  });

  it('a throwing predicate counts the failure rather than hiding it', async () => {
    const router = routerWith({ circuitBreakerThreshold: 1 });
    router.register('a', new ScriptedAdapter('a'), {
      circuitBreaker: {
        countAsFailure: () => {
          throw new Error('predicate bug');
        },
      },
    });

    await run(router, 'a', 1);
    expect(router.isCircuitBreakerOpen('a')).toBe(true);
  });

  it('rejects a countAsFailure that is not a function', () => {
    const router = routerWith();
    expect(() =>
      router.register('a', new ScriptedAdapter('a'), {
        circuitBreaker: { countAsFailure: 'yes' as unknown as () => boolean },
      })
    ).toThrow(/countAsFailure/);
  });
});

describe('adapter-declared policy (#173 part 3)', () => {
  it('reads AdapterMetadata.circuitBreaker beneath RouterConfig', async () => {
    const router = routerWith({ circuitBreakerThreshold: 5 });
    router.register('a', new ScriptedAdapter('a', { threshold: 2, timeout: 1_234 }));

    expect(router.getBackendInfo('a')?.circuitBreaker).toMatchObject({
      enabled: true,
      threshold: 2,
      timeout: 1_234,
    });
    await run(router, 'a', 2);
    expect(router.isCircuitBreakerOpen('a')).toBe(true);
  });

  it('precedence per field: register option > adapter metadata > RouterConfig', () => {
    const router = routerWith({
      circuitBreakerThreshold: 5,
      circuitBreakerTimeout: 60_000,
      circuitBreakerWindow: 9_000,
    });
    router.register('a', new ScriptedAdapter('a', { threshold: 2, timeout: 1_000, window: 500 }), {
      circuitBreaker: { threshold: 7 },
    });

    const info = router.getBackendInfo('a')?.circuitBreaker;
    expect(info).toMatchObject({ threshold: 7, timeout: 1_000, window: 500, enabled: true });
    expect(info?.source).toEqual({
      enabled: 'router',
      threshold: 'register',
      timeout: 'adapter',
      window: 'adapter',
      countAsFailure: 'router',
    });
  });

  it('reports the router layer for everything when nothing overrides', () => {
    const router = routerWith();
    router.register('a', new ScriptedAdapter('a'));
    expect(router.getBackendInfo('a')?.circuitBreaker.source).toEqual({
      enabled: 'router',
      threshold: 'router',
      timeout: 'router',
      window: 'router',
      countAsFailure: 'router',
    });
  });

  it('an adapter may recommend a countAsFailure; register can still override it', async () => {
    const recommended = vi.fn(() => false);
    const router = routerWith({ circuitBreakerThreshold: 1 });
    router.register('a', new ScriptedAdapter('a', { countAsFailure: recommended }));
    await run(router, 'a', 3);
    expect(router.isCircuitBreakerOpen('a')).toBe(false);
    expect(router.getBackendInfo('a')?.circuitBreaker.source.countAsFailure).toBe('adapter');

    const override = vi.fn(() => true);
    router.register('b', new ScriptedAdapter('b', { countAsFailure: recommended }), {
      circuitBreaker: { countAsFailure: override },
    });
    await run(router, 'b', 1);
    expect(router.isCircuitBreakerOpen('b')).toBe(true);
    expect(override).toHaveBeenCalled();
  });

  it('an adapter cannot switch the breaker on or off for the application', () => {
    const router = routerWith({ enableCircuitBreaker: false });
    router.register(
      'a',
      new ScriptedAdapter('a', { enabled: true } as unknown as AdapterMetadata['circuitBreaker'])
    );
    expect(router.getBackendInfo('a')?.circuitBreaker.enabled).toBe(false);
    expect(router.getBackendInfo('a')?.circuitBreaker.source.enabled).toBe('router');
  });

  it('validates an adapter-declared policy at register()', () => {
    const router = routerWith();
    expect(() => router.register('a', new ScriptedAdapter('a', { threshold: 0 }))).toThrow(
      /threshold/
    );
    expect(router.has('a')).toBe(false);
  });

  it("replace() takes the replacement adapter's recommended policy", () => {
    const router = routerWith();
    router.register('a', new ScriptedAdapter('a', { threshold: 2 }));
    router.replace('a', new ScriptedAdapter('a', { threshold: 4 }));
    expect(router.getBackendInfo('a')?.circuitBreaker.threshold).toBe(4);
  });

  it('clone() carries windowed failures along with the rest of the verdict', async () => {
    const router = routerWith();
    router.register('a', new ScriptedAdapter('a'), { circuitBreaker: { window: 10_000 } });
    await run(router, 'a', 2);

    const cloned = router.clone({});
    // The clone shares the adapter, which is still failing.
    await cloned.execute(requestFor('a')).catch(() => undefined);
    expect(cloned.isCircuitBreakerOpen('a')).toBe(true);
  });
});
