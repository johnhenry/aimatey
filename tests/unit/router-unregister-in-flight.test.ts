/**
 * Router.unregister() and requests that are already in flight (#117).
 *
 * The contract, in one place:
 *
 * - A request that has already been handed to the backend **runs to its natural
 *   end** -- `execute()` resolves, a stream keeps yielding. The router retains
 *   the adapter for exactly as long as that call needs it. `unregister()` is
 *   not cancellation; only an `AbortSignal` (the transport) can stop delivery.
 * - **No new request** is routed to the name once `unregister()` returns.
 * - What the in-flight call does after that is **not accounted anywhere**: the
 *   backend left the router, so its late outcome must neither land on an
 *   object nobody can read nor trip a breaker on whatever is registered under
 *   the same name next.
 * - `unregister(name, { drain })` additionally returns a promise that settles
 *   once the in-flight calls have finished (or the optional timeout passed).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Router } from '@johnhenry/aimatey-core';
import type {
  BackendAdapter,
  AdapterMetadata,
  IRCapabilities,
  IRChatRequest,
  IRChatResponse,
  IRStreamChunk,
} from '@johnhenry/aimatey-types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const RESPONSE = {
  id: 'res',
  model: 'mock-model',
  message: { role: 'assistant', content: 'ok' },
  finishReason: 'stop',
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  metadata: { requestId: 'r', timestamp: 0, provenance: {} },
} as unknown as IRChatResponse;

const REQUEST = {
  messages: [{ role: 'user', content: 'hi' }],
  parameters: { model: 'mock-model' },
  metadata: { requestId: 'req', timestamp: 0, provenance: {} },
} as unknown as IRChatRequest;

/** An adapter whose calls finish only when the test says so. */
class GatedAdapter implements BackendAdapter {
  readonly metadata: AdapterMetadata;
  executeGate = deferred<IRChatResponse>();
  streamGate = deferred<void>();
  executeCalls = 0;

  constructor(name = 'gated') {
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
    this.executeCalls++;
    return this.executeGate.promise;
  }

  async *executeStream(): AsyncGenerator<IRStreamChunk, void, undefined> {
    yield { type: 'content', sequence: 0, delta: 'a' } as unknown as IRStreamChunk;
    await this.streamGate.promise;
    yield { type: 'content', sequence: 1, delta: 'b' } as unknown as IRStreamChunk;
    yield { type: 'done', sequence: 2, finishReason: 'stop' } as unknown as IRStreamChunk;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('Router.unregister: in-flight execute()', () => {
  it('lets a request that is already running resolve normally', async () => {
    const router = new Router();
    const adapter = new GatedAdapter();
    router.register('a', adapter);

    const pending = router.execute(REQUEST);
    await tick();
    expect(adapter.executeCalls).toBe(1);

    router.unregister('a');
    adapter.executeGate.resolve(RESPONSE);

    await expect(pending).resolves.toBeDefined();
  });

  it('routes no new request to the name once unregister() has returned', async () => {
    const router = new Router();
    const adapter = new GatedAdapter();
    router.register('a', adapter);

    const pending = router.execute(REQUEST);
    await tick();
    router.unregister('a');

    await expect(router.execute(REQUEST)).rejects.toThrow();
    expect(adapter.executeCalls).toBe(1);

    adapter.executeGate.resolve(RESPONSE);
    await pending;
  });

  it('does not let a late failure trip a breaker on a backend re-registered under the name', async () => {
    const router = new Router({ enableCircuitBreaker: true, circuitBreakerThreshold: 1 });
    const old = new GatedAdapter('old');
    router.register('peer', old);

    const pending = router.execute(REQUEST);
    await tick();

    router.unregister('peer');
    router.register('peer', new GatedAdapter('fresh'));

    old.executeGate.reject(new Error('late failure of the removed backend'));
    await expect(pending).rejects.toThrow();

    // The failure belonged to the removed backend. The replacement under the
    // same name must not inherit its verdict.
    expect(router.isCircuitBreakerOpen('peer')).toBe(false);
    expect(router.getBackendStats('peer').failedRequests).toBe(0);
  });

  it('does not re-arm a recovery timer for a backend that has left the router', async () => {
    vi.useFakeTimers();
    const router = new Router({
      enableCircuitBreaker: true,
      circuitBreakerThreshold: 1,
      circuitBreakerTimeout: 30_000,
    });
    const adapter = new GatedAdapter();
    router.register('a', adapter);

    const pending = router.execute(REQUEST).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    router.unregister('a');
    adapter.executeGate.reject(new Error('late'));
    await pending;

    expect(vi.getTimerCount()).toBe(0);
  });

  it('counts the in-flight request on the backend until it settles', async () => {
    const router = new Router();
    const adapter = new GatedAdapter();
    router.register('a', adapter);

    expect(router.getBackendInfo('a')?.inFlight).toBe(0);

    const pending = router.execute(REQUEST);
    await tick();
    expect(router.getBackendInfo('a')?.inFlight).toBe(1);

    adapter.executeGate.resolve(RESPONSE);
    await pending;
    expect(router.getBackendInfo('a')?.inFlight).toBe(0);
  });
});

describe('Router.unregister: in-flight executeStream()', () => {
  it('lets a stream that is already running yield to its natural end', async () => {
    const router = new Router();
    const adapter = new GatedAdapter();
    router.register('a', adapter);

    const stream = router.executeStream(REQUEST);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect((first.value as { delta?: string }).delta).toBe('a');

    router.unregister('a');
    adapter.streamGate.resolve();

    const rest: IRStreamChunk[] = [];
    for (let step = await iterator.next(); !step.done; step = await iterator.next()) {
      rest.push(step.value);
    }
    expect(rest.map((chunk) => chunk.type)).toEqual(['content', 'done']);
  });

  it('counts an open stream as in flight until it ends or is abandoned', async () => {
    const router = new Router();
    const adapter = new GatedAdapter();
    router.register('a', adapter);

    const iterator = router.executeStream(REQUEST)[Symbol.asyncIterator]();
    await iterator.next();
    expect(router.getBackendInfo('a')?.inFlight).toBe(1);

    await iterator.return?.(undefined);
    expect(router.getBackendInfo('a')?.inFlight).toBe(0);
  });
});

describe('Router.unregister with { drain }', () => {
  it('stays synchronous and chainable without drain', () => {
    const router = new Router();
    router.register('a', new GatedAdapter());
    expect(router.unregister('a')).toBe(router);
  });

  it('resolves immediately when nothing is in flight', async () => {
    const router = new Router();
    router.register('a', new GatedAdapter());

    await expect(router.unregister('a', { drain: true })).resolves.toEqual({
      drained: true,
      inFlight: 0,
    });
  });

  it('removes the backend synchronously and settles only when an in-flight request does', async () => {
    const router = new Router();
    const adapter = new GatedAdapter();
    router.register('a', adapter);

    const pending = router.execute(REQUEST);
    await tick();

    let settled = false;
    const drain = router.unregister('a', { drain: true }).then((result) => {
      settled = true;
      return result;
    });

    // Gone from the router at once...
    expect(router.has('a')).toBe(false);
    // ...but the drain has not settled while the request is still running.
    await tick();
    expect(settled).toBe(false);

    adapter.executeGate.resolve(RESPONSE);
    await pending;
    await expect(drain).resolves.toEqual({ drained: true, inFlight: 0 });
  });

  it('waits for an in-flight stream to reach its end', async () => {
    const router = new Router();
    const adapter = new GatedAdapter();
    router.register('a', adapter);

    const iterator = router.executeStream(REQUEST)[Symbol.asyncIterator]();
    await iterator.next();

    let settled = false;
    const drain = router.unregister('a', { drain: true }).then((result) => {
      settled = true;
      return result;
    });
    await tick();
    expect(settled).toBe(false);

    adapter.streamGate.resolve();
    while (!(await iterator.next()).done) {
      /* consume */
    }
    await expect(drain).resolves.toEqual({ drained: true, inFlight: 0 });
  });

  it('gives up after a numeric timeout and reports what was left running', async () => {
    vi.useFakeTimers();
    const router = new Router();
    const adapter = new GatedAdapter();
    router.register('a', adapter);

    const pending = router.execute(REQUEST);
    await vi.advanceTimersByTimeAsync(0);

    const drain = router.unregister('a', { drain: 5_000 });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(drain).resolves.toEqual({ drained: false, inFlight: 1 });

    // The abandoned request is still allowed to finish.
    adapter.executeGate.resolve(RESPONSE);
    await expect(pending).resolves.toBeDefined();
  });

  it('leaves no drain timer behind once the backend has gone idle', async () => {
    vi.useFakeTimers();
    const router = new Router();
    const adapter = new GatedAdapter();
    router.register('a', adapter);

    const pending = router.execute(REQUEST);
    await vi.advanceTimersByTimeAsync(0);
    const drain = router.unregister('a', { drain: 60_000 });

    adapter.executeGate.resolve(RESPONSE);
    await pending;
    await drain;

    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the circuit-breaker timer even while draining', async () => {
    vi.useFakeTimers();
    const router = new Router({ enableCircuitBreaker: true, circuitBreakerTimeout: 30_000 });
    const adapter = new GatedAdapter();
    router.register('a', adapter);
    router.openCircuitBreaker('a');
    expect(vi.getTimerCount()).toBe(1);

    await router.unregister('a', { drain: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still throws for an unknown name, with or without drain', () => {
    const router = new Router();
    expect(() => router.unregister('nope')).toThrow(/not registered/);
    expect(() => router.unregister('nope', { drain: true })).toThrow(/not registered/);
  });
});
