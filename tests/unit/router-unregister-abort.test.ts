/**
 * Router.unregister(name, { abort: true }) (#174, option 3 of #117).
 *
 * `unregister()` alone is not cancellation: a call already running finishes.
 * `{ abort: true }` is revocation. The router owns a per-call `AbortController`
 * linked to the caller's own signal, so it can cut the calls running against
 * the one backend that left, without touching anyone else's:
 *
 * - every in-flight call on that backend (chat, stream, embed, decide) has its
 *   signal aborted with an `AbortError`, and the caller gets that error back --
 *   whatever the adapter made of the abort, and **without failing over**: the
 *   router does not quietly answer from another backend what was just revoked;
 * - `adapter.cancel(requestId, reason)` is called as well, once per call, for a
 *   far side that cannot see an `AbortSignal` (#121);
 * - nothing the cut calls do afterwards is accounted (they are detached);
 * - without `abort`, nothing changes.
 */

import { describe, it, expect, vi } from 'vitest';
import { Router } from '@johnhenry/aimatey-core';
import type {
  BackendAdapter,
  AdapterMetadata,
  IRCapabilities,
  IRChatRequest,
  IRChatResponse,
  IRStreamChunk,
  IREmbedRequest,
  IREmbedResponse,
  IRDecisionRequest,
  IRDecisionResponse,
} from '@johnhenry/aimatey-types';

const tick = () => new Promise((resolve) => setImmediate(resolve));

const RESPONSE = {
  id: 'res',
  model: 'mock-model',
  message: { role: 'assistant', content: 'ok' },
  finishReason: 'stop',
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  metadata: { requestId: 'r', timestamp: 0, provenance: {} },
} as unknown as IRChatResponse;

function chatRequest(requestId = 'req-1', backend?: string): IRChatRequest {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    parameters: { model: 'mock-model' },
    metadata: {
      requestId,
      timestamp: 0,
      provenance: {},
      ...(backend ? { custom: { backend } } : {}),
    },
  } as unknown as IRChatRequest;
}

/** Settle when `signal` aborts, the way a well-behaved transport does. */
function onAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** An adapter whose every call hangs until its signal aborts. */
class HangingAdapter implements BackendAdapter {
  readonly metadata: AdapterMetadata;
  signals: Array<AbortSignal | undefined> = [];
  cancelled: Array<{ requestId: string; reason: unknown }> = [];
  calls = 0;
  /** When true, ignore the signal entirely (a misbehaving adapter). */
  ignoreSignal = false;
  cancelImpl: ((requestId: string, reason?: unknown) => void | Promise<void>) | undefined;

  constructor(name = 'hang') {
    this.metadata = {
      name,
      version: '1.0.0',
      provider: 'mock',
      capabilities: {
        streaming: true,
        multiModal: false,
        tools: false,
        embeddings: true,
        decisions: true,
        decisionTypes: ['choice'],
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

  cancel(requestId: string, reason?: unknown): void | Promise<void> {
    this.cancelled.push({ requestId, reason });
    return this.cancelImpl?.(requestId, reason);
  }

  async execute(_request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse> {
    this.calls++;
    this.signals.push(signal);
    return this.ignoreSignal ? new Promise(() => undefined) : onAbort(signal);
  }

  async *executeStream(
    _request: IRChatRequest,
    signal?: AbortSignal
  ): AsyncGenerator<IRStreamChunk, void, undefined> {
    this.calls++;
    this.signals.push(signal);
    yield { type: 'content', sequence: 0, delta: 'a' } as unknown as IRStreamChunk;
    if (this.ignoreSignal) {
      await new Promise(() => undefined);
    }
    await onAbort(signal);
  }

  async embed(_request: IREmbedRequest, signal?: AbortSignal): Promise<IREmbedResponse> {
    this.calls++;
    this.signals.push(signal);
    return onAbort(signal);
  }

  async decide(_request: IRDecisionRequest, signal?: AbortSignal): Promise<IRDecisionResponse> {
    this.calls++;
    this.signals.push(signal);
    return onAbort(signal);
  }
}

class OkAdapter extends HangingAdapter {
  override async execute(): Promise<IRChatResponse> {
    this.calls++;
    return RESPONSE;
  }
}

const abortError = expect.objectContaining({ name: 'AbortError' });

describe('unregister(name, { abort: true }): chat', () => {
  it('aborts a request in flight and the caller receives the abort error', async () => {
    const router = new Router({ fallbackStrategy: 'none' });
    const adapter = new HangingAdapter();
    router.register('a', adapter);

    const pending = router.execute(chatRequest());
    const assertion = expect(pending).rejects.toEqual(abortError);
    await tick();
    expect(adapter.signals[0]?.aborted).toBe(false);

    router.unregister('a', { abort: true });

    await assertion;
    expect(adapter.signals[0]?.aborted).toBe(true);
  });

  it('gives the caller the abort error even when the adapter wraps or swallows the abort', async () => {
    const router = new Router({ fallbackStrategy: 'none' });
    const adapter = new HangingAdapter();
    adapter.execute = async (_request, signal) => {
      try {
        await onAbort(signal);
      } catch {
        throw new Error('Provider request failed: socket hang up');
      }
      return RESPONSE;
    };
    router.register('a', adapter);

    const pending = router.execute(chatRequest());
    const assertion = expect(pending).rejects.toEqual(abortError);
    await tick();
    router.unregister('a', { abort: true });
    await assertion;
  });

  it('does not fail over: a revoked request is not answered by another backend', async () => {
    const router = new Router({ fallbackStrategy: 'sequential' });
    const a = new HangingAdapter('a');
    const b = new OkAdapter('b');
    router.register('a', a);
    router.register('b', b);

    const pending = router.execute(chatRequest('r', 'a'));
    const assertion = expect(pending).rejects.toEqual(abortError);
    await tick();
    router.unregister('a', { abort: true });

    await assertion;
    expect(b.calls).toBe(0);
  });

  it('also calls adapter.cancel(requestId, reason) once, in addition to the signal', async () => {
    const router = new Router({ fallbackStrategy: 'none' });
    const adapter = new HangingAdapter();
    router.register('a', adapter);

    const pending = router.execute(chatRequest('req-42')).catch(() => undefined);
    await tick();
    router.unregister('a', { abort: true });
    await pending;

    expect(adapter.cancelled).toHaveLength(1);
    expect(adapter.cancelled[0]?.requestId).toBe('req-42');
    expect(adapter.cancelled[0]?.reason).toEqual(abortError);
    expect(adapter.signals[0]?.aborted).toBe(true);
  });

  it('survives a cancel() that throws or rejects', async () => {
    const router = new Router({ fallbackStrategy: 'none' });
    const adapter = new HangingAdapter();
    adapter.cancelImpl = () => {
      throw new Error('far side unreachable');
    };
    router.register('a', adapter);

    const pending = router.execute(chatRequest());
    const assertion = expect(pending).rejects.toEqual(abortError);
    await tick();
    expect(() => router.unregister('a', { abort: true })).not.toThrow();
    await assertion;

    const second = new HangingAdapter('b');
    second.cancelImpl = () => Promise.reject(new Error('nope'));
    router.register('b', second);
    const pending2 = router.execute(chatRequest('r2', 'b')).catch(() => undefined);
    await tick();
    router.unregister('b', { abort: true });
    await pending2;
  });

  it('cuts only the backend that left', async () => {
    const router = new Router({ fallbackStrategy: 'none' });
    const a = new HangingAdapter('a');
    const b = new HangingAdapter('b');
    router.register('a', a);
    router.register('b', b);

    const onA = router.execute(chatRequest('ra', 'a')).catch((e) => e);
    const onB = router.execute(chatRequest('rb', 'b')).catch((e) => e);
    await tick();

    router.unregister('a', { abort: true });
    expect(await onA).toEqual(abortError);

    expect(b.signals[0]?.aborted).toBe(false);
    expect(b.cancelled).toHaveLength(0);
    router.unregister('b', { abort: true });
    expect(await onB).toEqual(abortError);
  });

  it('cuts every call in flight on the backend, not just one', async () => {
    const router = new Router({ fallbackStrategy: 'none' });
    const adapter = new HangingAdapter();
    router.register('a', adapter);

    const calls = [1, 2, 3].map((i) => router.execute(chatRequest(`r${i}`)).catch((e) => e));
    await tick();
    router.unregister('a', { abort: true });

    for (const outcome of await Promise.all(calls)) {
      expect(outcome).toEqual(abortError);
    }
    expect(adapter.cancelled.map((c) => c.requestId).sort()).toEqual(['r1', 'r2', 'r3']);
  });

  it('settles the caller even if the adapter ignores the signal entirely', async () => {
    const router = new Router({ fallbackStrategy: 'none' });
    const adapter = new HangingAdapter();
    adapter.ignoreSignal = true;
    router.register('a', adapter);

    const pending = router.execute(chatRequest());
    const assertion = expect(pending).rejects.toEqual(abortError);
    await tick();
    router.unregister('a', { abort: true });

    await assertion;
  });

  it('without abort, an in-flight call is untouched (unchanged behaviour)', async () => {
    const router = new Router({ fallbackStrategy: 'none' });
    const adapter = new HangingAdapter();
    router.register('a', adapter);

    const pending = router.execute(chatRequest());
    await tick();
    router.unregister('a');

    expect(adapter.signals[0]?.aborted).toBe(false);
    expect(adapter.cancelled).toHaveLength(0);
    pending.catch(() => undefined);
  });

  it('does not account what the cut call does afterwards', async () => {
    const router = new Router({ enableCircuitBreaker: true, circuitBreakerThreshold: 1 });
    const adapter = new HangingAdapter('old');
    router.register('peer', adapter);

    const pending = router.execute(chatRequest()).catch(() => undefined);
    await tick();
    router.unregister('peer', { abort: true });
    router.register('peer', new OkAdapter('fresh'));
    await pending;

    expect(router.isCircuitBreakerOpen('peer')).toBe(false);
    expect(router.getBackendStats('peer').failedRequests).toBe(0);
  });

  it("still honours the caller's own signal, and does not send cancel() for it", async () => {
    const router = new Router({ fallbackStrategy: 'none' });
    const adapter = new HangingAdapter();
    router.register('a', adapter);
    const controller = new AbortController();

    const pending = router.execute(chatRequest(), controller.signal);
    const assertion = expect(pending).rejects.toBeDefined();
    await tick();
    controller.abort(new DOMException('user stopped it', 'AbortError'));

    await assertion;
    expect(adapter.signals[0]?.aborted).toBe(true);
    // cancel() on caller aborts is the Bridge's job; the Router adds it only
    // for revocation, so a proxy that watches the signal is not told twice.
    expect(adapter.cancelled).toHaveLength(0);
  });

  it('passes an already-aborted caller signal through', async () => {
    const router = new Router({ fallbackStrategy: 'none' });
    const adapter = new HangingAdapter();
    router.register('a', adapter);
    const controller = new AbortController();
    controller.abort();

    await expect(router.execute(chatRequest(), controller.signal)).rejects.toBeDefined();
    expect(adapter.signals[0]?.aborted).toBe(true);
  });

  it('with drain, resolves once the cut calls have ended', async () => {
    const router = new Router({ fallbackStrategy: 'none' });
    const adapter = new HangingAdapter();
    router.register('a', adapter);

    const pending = router.execute(chatRequest()).catch(() => undefined);
    await tick();

    const result = await router.unregister('a', { abort: true, drain: 1_000 });
    expect(result).toEqual({ drained: true, inFlight: 0 });
    await pending;
  });
});

describe('unregister(name, { abort: true }): streams', () => {
  async function consume(stream: AsyncIterable<IRStreamChunk>): Promise<unknown> {
    try {
      for await (const _ of stream) {
        // drain
      }
      return undefined;
    } catch (error) {
      return error;
    }
  }

  it('aborts a stream mid-flight and the consumer receives the abort error', async () => {
    const router = new Router({ fallbackStrategy: 'none' });
    const adapter = new HangingAdapter();
    router.register('a', adapter);

    const seen: IRStreamChunk[] = [];
    const outcome = (async () => {
      try {
        for await (const chunk of router.executeStream(chatRequest())) {
          seen.push(chunk);
        }
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    await tick();
    expect(seen).toHaveLength(1);

    router.unregister('a', { abort: true });

    expect(await outcome).toEqual(abortError);
    expect(adapter.signals[0]?.aborted).toBe(true);
    expect(adapter.cancelled.map((c) => c.requestId)).toEqual(['req-1']);
  });

  it('ends a stream whose adapter ignores the signal and keeps yielding', async () => {
    const router = new Router({ fallbackStrategy: 'none' });
    const adapter = new HangingAdapter();
    adapter.executeStream = async function* () {
      yield { type: 'content', sequence: 0, delta: 'a' } as unknown as IRStreamChunk;
      await new Promise((resolve) => setTimeout(resolve, 20));
      yield { type: 'content', sequence: 1, delta: 'late' } as unknown as IRStreamChunk;
      yield { type: 'done', sequence: 2, finishReason: 'stop' } as unknown as IRStreamChunk;
    };
    router.register('a', adapter);

    const seen: string[] = [];
    const outcome = (async () => {
      try {
        for await (const chunk of router.executeStream(chatRequest())) {
          seen.push(chunk.type);
        }
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    await tick();
    router.unregister('a', { abort: true });

    expect(await outcome).toEqual(abortError);
    // Nothing the revoked backend produced after the cut reaches the consumer.
    expect(seen).toEqual(['content']);
  });

  it('does not fail a stream over to another backend', async () => {
    const router = new Router({ fallbackStrategy: 'sequential' });
    const a = new HangingAdapter('a');
    const b = new HangingAdapter('b');
    let bStreams = 0;
    b.executeStream = async function* () {
      bStreams++;
      yield { type: 'done', sequence: 0, finishReason: 'stop' } as unknown as IRStreamChunk;
    };
    router.register('a', a);
    router.register('b', b);

    const outcome = consume(router.executeStream(chatRequest('r', 'a')));
    await tick();
    router.unregister('a', { abort: true });

    expect(await outcome).toEqual(abortError);
    expect(bStreams).toBe(0);
  });
});

describe('unregister(name, { abort: true }): embed and decide', () => {
  it('aborts an embedding in flight', async () => {
    const router = new Router({ fallbackStrategy: 'none' });
    const adapter = new HangingAdapter();
    router.register('a', adapter);

    const pending = router.embed({
      input: 'x',
      metadata: { requestId: 'emb-1', timestamp: 0, provenance: {} },
    } as unknown as IREmbedRequest);
    const assertion = expect(pending).rejects.toEqual(abortError);
    await tick();
    router.unregister('a', { abort: true });

    await assertion;
    expect(adapter.cancelled.map((c) => c.requestId)).toEqual(['emb-1']);
  });

  it('aborts a decision in flight', async () => {
    const router = new Router({ fallbackStrategy: 'none' });
    const adapter = new HangingAdapter();
    router.register('a', adapter);

    const pending = router.decide({
      state: 'hello',
      questions: {
        q: { type: 'choice', instructions: 'Which?', criteria: { opt_1: 'a', opt_2: 'b' } },
      },
      metadata: { requestId: 'dec-1', timestamp: 0, provenance: {} },
    } as unknown as IRDecisionRequest);
    const assertion = expect(pending).rejects.toEqual(abortError);
    await tick();
    router.unregister('a', { abort: true });

    await assertion;
    expect(adapter.cancelled.map((c) => c.requestId)).toEqual(['dec-1']);
  });
});

describe('unregister option validation', () => {
  it('rejects a non-boolean abort', () => {
    const router = new Router();
    router.register('a', new HangingAdapter());
    expect(() => router.unregister('a', { abort: 'yes' as unknown as boolean })).toThrow(/abort/);
    expect(router.has('a')).toBe(true);
  });

  it('still throws ROUTING_FAILED for an unknown name', () => {
    const router = new Router();
    expect(() => router.unregister('nope', { abort: true })).toThrow(/not registered/);
  });

  it('is a no-op for a backend with nothing in flight', () => {
    const router = new Router();
    const adapter = new HangingAdapter();
    router.register('a', adapter);
    expect(router.unregister('a', { abort: true })).toBe(router);
    expect(adapter.cancelled).toHaveLength(0);
    vi.useRealTimers();
  });
});
