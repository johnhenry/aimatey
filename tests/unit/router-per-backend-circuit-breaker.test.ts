/**
 * Per-backend circuit-breaker policy (#128).
 *
 * `circuitBreakerThreshold` / `circuitBreakerTimeout` / `enableCircuitBreaker`
 * on `RouterConfig` are the *defaults*. `register(name, adapter, { circuitBreaker })`
 * overrides any of them for one backend, so a LAN peer that sleeps and a cloud
 * API that blips can share a router without sharing a tolerance.
 *
 * Also pins what `openCircuitBreaker(name, timeoutMs)` means: `timeoutMs` is
 * the rest period of *that* open. It used to be silently capped at the
 * router-wide timeout, because `checkCircuitBreaker` consulted only the config.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Router } from '@johnhenry/aimatey-core';
import type {
  BackendAdapter,
  AdapterMetadata,
  IRCapabilities,
  IRChatRequest,
  IRChatResponse,
} from '@johnhenry/aimatey-types';

const REQUEST = {
  messages: [{ role: 'user', content: 'hi' }],
  parameters: { model: 'mock-model' },
  metadata: { requestId: 'req', timestamp: 0, provenance: {} },
} as unknown as IRChatRequest;

class FlakyAdapter implements BackendAdapter {
  readonly metadata: AdapterMetadata;
  failing = true;
  calls = 0;

  constructor(name: string) {
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
    if (this.failing) {
      throw new Error('connection refused');
    }
    return {
      id: 'res',
      model: 'mock-model',
      message: { role: 'assistant', content: 'ok' },
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      metadata: { requestId: 'r', timestamp: 0, provenance: {} },
    } as unknown as IRChatResponse;
  }
}

/** Fail `n` explicit requests against `name`, ignoring the errors. */
async function failTimes(router: Router, name: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await router.execute(requestFor(name)).catch(() => undefined);
  }
}

/** A request that names the backend it wants (`routingStrategy: 'explicit'`). */
function requestFor(backend: string): IRChatRequest {
  return {
    ...REQUEST,
    metadata: { ...REQUEST.metadata, custom: { backend } },
  } as IRChatRequest;
}

afterEach(() => {
  vi.useRealTimers();
});

function routerWith(config: ConstructorParameters<typeof Router>[0] = {}) {
  const lan = new FlakyAdapter('lan');
  const cloud = new FlakyAdapter('cloud');
  const router = new Router({
    enableCircuitBreaker: true,
    circuitBreakerThreshold: 5,
    circuitBreakerTimeout: 60_000,
    routingStrategy: 'explicit',
    fallbackStrategy: 'none',
    ...config,
  });
  return { router, lan, cloud };
}

describe('per-backend circuit breaker overrides', () => {
  it('opens two backends at different thresholds', async () => {
    const { router, lan, cloud } = routerWith();
    router.register('lan', lan, { circuitBreaker: { threshold: 2 } });
    router.register('cloud', cloud); // inherits 5

    const failOn = (name: string, n: number) => failTimes(router, name, n);

    await failOn('lan', 2);
    expect(router.isCircuitBreakerOpen('lan')).toBe(true);

    await failOn('cloud', 2);
    expect(router.isCircuitBreakerOpen('cloud')).toBe(false);

    await failOn('cloud', 3);
    expect(router.isCircuitBreakerOpen('cloud')).toBe(true);
  });

  it('recovers each backend on its own timeout', () => {
    vi.useFakeTimers();
    const { router, lan, cloud } = routerWith();
    router.register('lan', lan, { circuitBreaker: { timeout: 5 * 60_000 } });
    router.register('cloud', cloud, { circuitBreaker: { timeout: 1_000 } });

    router.openCircuitBreaker('lan');
    router.openCircuitBreaker('cloud');

    vi.advanceTimersByTime(2_000);
    expect(router.isCircuitBreakerOpen('cloud')).toBe(false);
    expect(router.isCircuitBreakerOpen('lan')).toBe(true);

    vi.advanceTimersByTime(5 * 60_000);
    expect(router.isCircuitBreakerOpen('lan')).toBe(false);
  });

  it('refuses requests during the backend\'s own rest period, and admits a trial after it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { router, lan } = routerWith();
    router.register('lan', lan, { circuitBreaker: { timeout: 10_000 } });

    router.openCircuitBreaker('lan');

    vi.advanceTimersByTime(9_000);
    await expect(router.execute(requestFor('lan'))).rejects.toThrow();
    expect(lan.calls).toBe(0);

    vi.advanceTimersByTime(2_000);
    lan.failing = false;
    await expect(router.execute(requestFor('lan'))).resolves.toBeDefined();
    expect(lan.calls).toBe(1);
  });

  it('lets one backend opt out of a breaker the router turned on', async () => {
    const { router, lan, cloud } = routerWith({ circuitBreakerThreshold: 1 });
    router.register('lan', lan, { circuitBreaker: { enabled: false } });
    router.register('cloud', cloud);

    await failTimes(router, 'lan', 3);
    expect(router.isCircuitBreakerOpen('lan')).toBe(false);

    await failTimes(router, 'cloud', 1);
    expect(router.isCircuitBreakerOpen('cloud')).toBe(true);
  });

  it('lets one backend opt in when the router-wide breaker is off', async () => {
    const lan = new FlakyAdapter('lan');
    const cloud = new FlakyAdapter('cloud');
    const router = new Router({
      enableCircuitBreaker: false,
      routingStrategy: 'explicit',
      fallbackStrategy: 'none',
    });
    router.register('lan', lan, { circuitBreaker: { enabled: true, threshold: 2 } });
    router.register('cloud', cloud);

    await failTimes(router, 'lan', 2);
    expect(router.isCircuitBreakerOpen('lan')).toBe(true);

    await failTimes(router, 'cloud', 10);
    expect(router.isCircuitBreakerOpen('cloud')).toBe(false);
  });

  it('falls back to the router-wide values for fields the override leaves out', async () => {
    const { router, lan } = routerWith({ circuitBreakerThreshold: 3 });
    router.register('lan', lan, { circuitBreaker: { timeout: 1_000 } });

    await failTimes(router, 'lan', 2);
    expect(router.isCircuitBreakerOpen('lan')).toBe(false);
    await failTimes(router, 'lan', 1);
    expect(router.isCircuitBreakerOpen('lan')).toBe(true);
  });

  it('survives replace() and clone()', () => {
    const { router, lan, cloud } = routerWith();
    router.register('lan', lan, { circuitBreaker: { threshold: 2, timeout: 7_000 } });

    router.replace('lan', cloud);
    expect(router.getBackendInfo('lan')?.circuitBreaker).toEqual({
      enabled: true,
      threshold: 2,
      timeout: 7_000,
    });

    const cloned = router.clone({ trackLatency: false });
    expect(cloned.getBackendInfo('lan')?.circuitBreaker).toEqual({
      enabled: true,
      threshold: 2,
      timeout: 7_000,
    });
  });

  it('exposes the effective policy on getBackendInfo()', () => {
    const { router, lan, cloud } = routerWith();
    router.register('lan', lan, { circuitBreaker: { threshold: 2 } });
    router.register('cloud', cloud);

    expect(router.getBackendInfo('lan')?.circuitBreaker).toEqual({
      enabled: true,
      threshold: 2,
      timeout: 60_000,
    });
    expect(router.getBackendInfo('cloud')?.circuitBreaker).toEqual({
      enabled: true,
      threshold: 5,
      timeout: 60_000,
    });
  });

  it('rejects a policy that could never behave', () => {
    const { router, lan } = routerWith();
    expect(() => router.register('lan', lan, { circuitBreaker: { threshold: 0 } })).toThrow(
      /threshold/
    );
    expect(() => router.register('lan', lan, { circuitBreaker: { threshold: 1.5 } })).toThrow(
      /threshold/
    );
    expect(() => router.register('lan', lan, { circuitBreaker: { timeout: -1 } })).toThrow(
      /timeout/
    );
    expect(router.has('lan')).toBe(false);
  });
});

describe('openCircuitBreaker(name, timeoutMs) governs its own rest period', () => {
  it('is not capped by the router-wide timeout (#128 measured case)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { router, lan } = routerWith({ circuitBreakerTimeout: 20 });
    router.register('lan', lan);

    router.openCircuitBreaker('lan', 60_000);

    vi.advanceTimersByTime(50);
    await expect(router.execute(requestFor('lan'))).rejects.toThrow();
    expect(lan.calls).toBe(0);
  });

  it('applies only to the open it was passed to', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { router, lan } = routerWith({ circuitBreakerTimeout: 20 });
    router.register('lan', lan);

    router.openCircuitBreaker('lan', 60_000);
    router.closeCircuitBreaker('lan');
    router.openCircuitBreaker('lan');

    vi.advanceTimersByTime(50);
    expect(router.isCircuitBreakerOpen('lan')).toBe(false);
  });
});
