/**
 * Router Streaming Fallback & Accounting Tests
 *
 * Covers issue #54: the streaming path used to be a second-class citizen --
 * `executeStream()` yielded an error chunk where `execute()` would have failed
 * over, and `executeStreamOnBackend()` counted a request without ever
 * recording its outcome, so per-backend success rates decayed toward zero and
 * the circuit breaker was blind to streamed traffic.
 */

import { describe, it, expect, vi } from 'vitest';
import { Router } from '@johnhenry/aimatey-core';
import type {
  BackendAdapter,
  IRChatRequest,
  IRChatResponse,
  IRStreamChunk,
} from '@johnhenry/aimatey-types';

// ============================================================================
// Test Helpers
// ============================================================================

type StreamFn = (request: IRChatRequest, signal?: AbortSignal) => AsyncGenerator<IRStreamChunk>;

interface MockOptions {
  /** Override the streaming implementation entirely. */
  readonly executeStream?: StreamFn;
  /** Reject every execute() call. */
  readonly unaryFails?: boolean;
  /** Artificial delay before responding, so latency samples are non-zero. */
  readonly delayMs?: number;
  /** Fixed per-request cost reported through estimateCost(). */
  readonly cost?: number;
  /** Model this adapter falls back to (drives 'hybrid' model translation). */
  readonly defaultModel?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `start` chunk carrying nothing a consumer can render. */
function startChunk(label: string): IRStreamChunk {
  return {
    type: 'start',
    sequence: 0,
    metadata: {
      requestId: 'test-req-id',
      timestamp: Date.now(),
      provenance: { backend: label },
    },
  } as IRStreamChunk;
}

function contentChunk(label: string, sequence = 1): IRStreamChunk {
  return { type: 'content', sequence, delta: `hello from ${label}` } as IRStreamChunk;
}

function doneChunk(label: string, sequence = 2): IRStreamChunk {
  return {
    type: 'done',
    sequence,
    finishReason: 'stop',
    message: { role: 'assistant', content: `hello from ${label}` },
    metadata: {
      requestId: 'test-req-id',
      timestamp: Date.now(),
      provenance: { backend: label },
    },
  } as IRStreamChunk;
}

function errorChunk(message: string, sequence = 0): IRStreamChunk {
  return {
    type: 'error',
    sequence,
    error: { code: 'PROVIDER_ERROR', message },
  } as IRStreamChunk;
}

/**
 * Backend whose default stream is `start` -> `content` -> `done`, all tagged
 * with `label` so a test can tell which backend actually served a request.
 */
function createBackend(label: string, options: MockOptions = {}): BackendAdapter {
  const defaultStream: StreamFn = async function* () {
    if (options.delayMs) {
      await sleep(options.delayMs);
    }
    yield startChunk(label);
    yield contentChunk(label);
    yield doneChunk(label);
  };

  return {
    metadata: {
      name: label,
      version: '1.0.0',
      provider: 'Mock',
      capabilities: {
        streaming: true,
        multiModal: false,
        tools: false,
        systemMessageStrategy: 'in-messages',
        supportsMultipleSystemMessages: true,
      },
    },
    config: options.defaultModel === undefined ? undefined : { defaultModel: options.defaultModel },
    fromIR: vi.fn((request) => request),
    toIR: vi.fn((response) => response),
    execute: vi.fn(async (request: IRChatRequest) => {
      if (options.delayMs) {
        await sleep(options.delayMs);
      }
      if (options.unaryFails) {
        throw new Error(`execute failed (${label})`);
      }
      return {
        message: { role: 'assistant', content: `hello from ${label}` },
        finishReason: 'stop',
        metadata: {
          requestId: request.metadata?.requestId,
          timestamp: Date.now(),
          provenance: { backend: label },
        },
      } as IRChatResponse;
    }),
    executeStream: vi.fn(options.executeStream ?? defaultStream),
    estimateCost: options.cost === undefined ? undefined : vi.fn(async () => options.cost!),
    healthCheck: async () => true,
  } as unknown as BackendAdapter;
}

/** Backend whose stream yields `count` chunks of the normal script, then throws. */
function throwsAfter(label: string, count: number): StreamFn {
  return async function* () {
    const script = [startChunk(label), contentChunk(label), doneChunk(label)];
    for (let i = 0; i < count; i++) {
      yield script[i]!;
    }
    throw new Error(`${label} down`);
  };
}

/** Backend whose stream yields `count` normal chunks, then an in-band error chunk. */
function errorChunkAfter(label: string, count: number): StreamFn {
  return async function* () {
    const script = [startChunk(label), contentChunk(label), doneChunk(label)];
    for (let i = 0; i < count; i++) {
      yield script[i]!;
    }
    yield errorChunk(`${label} down`, count);
  };
}

function createRequest(model = 'gpt-4'): IRChatRequest {
  return {
    messages: [{ role: 'user', content: 'Hello' }],
    parameters: { model },
    stream: true,
    metadata: {
      requestId: 'test-req-id',
      timestamp: Date.now(),
      provenance: {},
    },
  };
}

async function collect(stream: AsyncIterable<IRStreamChunk>): Promise<IRStreamChunk[]> {
  const chunks: IRStreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

function textOf(chunks: readonly IRStreamChunk[]): string {
  return chunks
    .filter(
      (chunk): chunk is Extract<IRStreamChunk, { type: 'content' }> => chunk.type === 'content'
    )
    .map((chunk) => chunk.delta)
    .join('');
}

function errorsIn(chunks: readonly IRStreamChunk[]): Extract<IRStreamChunk, { type: 'error' }>[] {
  return chunks.filter(
    (chunk): chunk is Extract<IRStreamChunk, { type: 'error' }> => chunk.type === 'error'
  );
}

// ============================================================================
// Fallback before the first token
// ============================================================================

describe('Router.executeStream - fallback before commitment', () => {
  it('fails over when the primary throws before yielding anything', async () => {
    const router = new Router({ defaultBackend: 'primary', fallbackStrategy: 'sequential' });
    router.register(
      'primary',
      createBackend('primary', { executeStream: throwsAfter('primary', 0) })
    );
    router.register('backup', createBackend('backup'));
    router.setFallbackChain(['backup']);

    const chunks = await collect(router.executeStream(createRequest()));

    expect(textOf(chunks)).toBe('hello from backup');
    expect(errorsIn(chunks)).toHaveLength(0);
    expect(chunks.some((chunk) => chunk.type === 'done')).toBe(true);
  });

  it('fails over after preamble chunks, without leaking the dead backend to the consumer', async () => {
    const router = new Router({ defaultBackend: 'primary', fallbackStrategy: 'sequential' });
    // Yields only a `start` chunk (no model output) before dying.
    router.register(
      'primary',
      createBackend('primary', { executeStream: throwsAfter('primary', 1) })
    );
    router.register('backup', createBackend('backup'));
    router.setFallbackChain(['backup']);

    const chunks = await collect(router.executeStream(createRequest()));

    expect(textOf(chunks)).toBe('hello from backup');
    expect(errorsIn(chunks)).toHaveLength(0);
    // Exactly one `start` chunk reaches the consumer, and it is the backup's:
    // the primary's was held back and discarded.
    const starts = chunks.filter((chunk) => chunk.type === 'start');
    expect(starts).toHaveLength(1);
    expect(
      (starts[0] as { metadata: { provenance?: { backend?: string } } }).metadata.provenance
        ?.backend
    ).toBe('backup');
  });

  it('does NOT fail over once a content chunk has been delivered', async () => {
    const router = new Router({ defaultBackend: 'primary', fallbackStrategy: 'sequential' });
    router.register(
      'primary',
      createBackend('primary', { executeStream: throwsAfter('primary', 2) })
    );
    const backup = createBackend('backup');
    router.register('backup', backup);
    router.setFallbackChain(['backup']);

    const chunks = await collect(router.executeStream(createRequest()));

    // The consumer keeps the text it already saw, and is told the stream broke.
    expect(textOf(chunks)).toBe('hello from primary');
    expect(errorsIn(chunks)).toHaveLength(1);
    expect(errorsIn(chunks)[0]!.error.message).toContain('primary down');
    expect(backup.executeStream).not.toHaveBeenCalled();
  });

  it('treats an in-band error chunk before commitment as recoverable', async () => {
    const router = new Router({ defaultBackend: 'primary', fallbackStrategy: 'sequential' });
    router.register(
      'primary',
      createBackend('primary', { executeStream: errorChunkAfter('primary', 1) })
    );
    router.register('backup', createBackend('backup'));
    router.setFallbackChain(['backup']);

    const chunks = await collect(router.executeStream(createRequest()));

    expect(textOf(chunks)).toBe('hello from backup');
    expect(errorsIn(chunks)).toHaveLength(0);
    // ...and it still counts against the primary.
    expect(router.getBackendStats('primary')?.failedRequests).toBe(1);
  });

  it('passes an in-band error chunk through once committed', async () => {
    const router = new Router({ defaultBackend: 'primary', fallbackStrategy: 'sequential' });
    router.register(
      'primary',
      createBackend('primary', { executeStream: errorChunkAfter('primary', 2) })
    );
    const backup = createBackend('backup');
    router.register('backup', backup);
    router.setFallbackChain(['backup']);

    const chunks = await collect(router.executeStream(createRequest()));

    expect(textOf(chunks)).toBe('hello from primary');
    expect(errorsIn(chunks)).toHaveLength(1);
    expect(backup.executeStream).not.toHaveBeenCalled();
    expect(router.getBackendStats('primary')?.failedRequests).toBe(1);
  });

  it('walks the fallback chain in order until one backend streams', async () => {
    const router = new Router({ defaultBackend: 'primary', fallbackStrategy: 'sequential' });
    router.register(
      'primary',
      createBackend('primary', { executeStream: throwsAfter('primary', 0) })
    );
    router.register('second', createBackend('second', { executeStream: throwsAfter('second', 0) }));
    router.register('third', createBackend('third'));
    router.setFallbackChain(['second', 'third']);

    const chunks = await collect(router.executeStream(createRequest()));

    expect(textOf(chunks)).toBe('hello from third');
    expect(router.getStats().totalFallbacks).toBe(1);
  });

  it('yields an error chunk when every backend fails', async () => {
    const router = new Router({ defaultBackend: 'primary', fallbackStrategy: 'sequential' });
    router.register(
      'primary',
      createBackend('primary', { executeStream: throwsAfter('primary', 0) })
    );
    router.register('backup', createBackend('backup', { executeStream: throwsAfter('backup', 0) }));
    router.setFallbackChain(['backup']);

    const chunks = await collect(router.executeStream(createRequest()));

    expect(errorsIn(chunks)).toHaveLength(1);
    expect(errorsIn(chunks)[0]!.error.message).toContain('backup down');
    expect(router.getStats().failedRequests).toBe(1);
  });

  it("honours fallbackStrategy 'none'", async () => {
    const router = new Router({ defaultBackend: 'primary', fallbackStrategy: 'none' });
    router.register(
      'primary',
      createBackend('primary', { executeStream: throwsAfter('primary', 0) })
    );
    const backup = createBackend('backup');
    router.register('backup', backup);
    router.setFallbackChain(['backup']);

    const chunks = await collect(router.executeStream(createRequest()));

    expect(errorsIn(chunks)).toHaveLength(1);
    expect(backup.executeStream).not.toHaveBeenCalled();
  });

  it("consults customFallback under fallbackStrategy 'custom'", async () => {
    const customFallback = vi.fn(async () => 'chosen');
    const router = new Router({
      defaultBackend: 'primary',
      fallbackStrategy: 'custom',
      customFallback,
    });
    router.register(
      'primary',
      createBackend('primary', { executeStream: throwsAfter('primary', 0) })
    );
    router.register('ignored', createBackend('ignored'));
    router.register('chosen', createBackend('chosen'));

    const chunks = await collect(router.executeStream(createRequest()));

    expect(customFallback).toHaveBeenCalled();
    expect(textOf(chunks)).toBe('hello from chosen');
  });

  it('translates the model for the backend it falls over to', async () => {
    const router = new Router({ defaultBackend: 'primary', fallbackStrategy: 'sequential' });
    router.register(
      'primary',
      createBackend('primary', { executeStream: throwsAfter('primary', 0) })
    );
    const backup = createBackend('backup');
    router.register('backup', backup);
    router.setFallbackChain(['backup']);
    router.setBackendTranslationMapping('backup', { 'gpt-4': 'claude-sonnet-4-5' });

    await collect(router.executeStream(createRequest('gpt-4')));

    const sent = (backup.executeStream as unknown as { mock: { calls: [IRChatRequest][] } }).mock
      .calls[0]![0];
    expect(sent.parameters?.model).toBe('claude-sonnet-4-5');
  });

  it('stops buffering preamble after the held-chunk bound and streams through', async () => {
    // 40 metadata chunks exceeds MAX_HELD_STREAM_CHUNKS (32), so the router
    // flushes, gives up the option to fail over, and the failure surfaces.
    const floodThenFail: StreamFn = async function* () {
      yield startChunk('primary');
      for (let i = 0; i < 40; i++) {
        yield { type: 'metadata', sequence: i + 1, usage: { promptTokens: 1 } } as IRStreamChunk;
      }
      throw new Error('primary down');
    };

    const router = new Router({ defaultBackend: 'primary', fallbackStrategy: 'sequential' });
    router.register('primary', createBackend('primary', { executeStream: floodThenFail }));
    const backup = createBackend('backup');
    router.register('backup', backup);
    router.setFallbackChain(['backup']);

    const chunks = await collect(router.executeStream(createRequest()));

    expect(backup.executeStream).not.toHaveBeenCalled();
    expect(errorsIn(chunks)).toHaveLength(1);
    expect(chunks.filter((chunk) => chunk.type === 'metadata').length).toBeGreaterThan(32);
  });

  it('reports a preamble-only stream that never commits as truncated, not as a success', async () => {
    // Before the termination contract (#126) the silent end was credited as a
    // success. A stream that stops after its preamble, with no `done` or
    // `error`, is a cut-off stream: the consumer gets a terminal error and the
    // backend is charged with the failure.
    const preambleOnly: StreamFn = async function* () {
      yield startChunk('only');
    };

    const router = new Router({ defaultBackend: 'only' });
    router.register('only', createBackend('only', { executeStream: preambleOnly }));

    const chunks = await collect(router.executeStream(createRequest()));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.type).toBe('error');
    expect((chunks[0] as { error: { code: string } }).error.code).toBe('stream-truncated');
    expect(chunks[0]!.sequence).toBe(0);
    expect(router.getBackendStats('only')?.successfulRequests).toBe(0);
    expect(router.getBackendStats('only')?.failedRequests).toBe(1);
  });

  it('does not fail over an aborted request', async () => {
    const controller = new AbortController();
    controller.abort();

    const router = new Router({ defaultBackend: 'primary', fallbackStrategy: 'sequential' });
    router.register(
      'primary',
      createBackend('primary', { executeStream: throwsAfter('primary', 0) })
    );
    const backup = createBackend('backup');
    router.register('backup', backup);
    router.setFallbackChain(['backup']);

    const chunks = await collect(router.executeStream(createRequest(), controller.signal));

    expect(errorsIn(chunks)).toHaveLength(1);
    expect(backup.executeStream).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Per-backend accounting
// ============================================================================

describe('Router.executeStream - per-backend accounting', () => {
  it('reports the same stats shape for streamed and non-streamed traffic', async () => {
    const router = new Router({ defaultBackend: 'b', trackLatency: true });
    router.register('b', createBackend('b', { delayMs: 5 }));

    await router.execute(createRequest());
    const unary = router.getBackendStats('b')!;

    router.resetStats();
    await collect(router.executeStream(createRequest()));
    const streamed = router.getBackendStats('b')!;

    expect(streamed.totalRequests).toBe(unary.totalRequests);
    expect(streamed.successfulRequests).toBe(unary.successfulRequests);
    expect(streamed.failedRequests).toBe(unary.failedRequests);
    expect(streamed.successRate).toBe(unary.successRate);
    expect(streamed.successRate).toBe(100);

    // Latency-optimised routing is no longer blind to streamed traffic.
    expect(unary.averageLatencyMs).toBeGreaterThan(0);
    expect(streamed.averageLatencyMs).toBeGreaterThan(0);
    expect(streamed.p50LatencyMs).toBeGreaterThan(0);
  });

  it('records a streamed failure against the backend that failed', async () => {
    const router = new Router({ defaultBackend: 'primary', fallbackStrategy: 'sequential' });
    router.register(
      'primary',
      createBackend('primary', { executeStream: throwsAfter('primary', 0) })
    );
    router.register('backup', createBackend('backup'));
    router.setFallbackChain(['backup']);

    await collect(router.executeStream(createRequest()));

    const primary = router.getBackendStats('primary')!;
    expect(primary.totalRequests).toBe(1);
    expect(primary.successfulRequests).toBe(0);
    expect(primary.failedRequests).toBe(1);
    expect(primary.successRate).toBe(0);

    const backup = router.getBackendStats('backup')!;
    expect(backup.totalRequests).toBe(1);
    expect(backup.successfulRequests).toBe(1);
    expect(backup.failedRequests).toBe(0);
    expect(backup.successRate).toBe(100);
  });

  it('tracks cost for streamed requests', async () => {
    const router = new Router({ defaultBackend: 'b', trackCost: true });
    router.register('b', createBackend('b', { cost: 0.25 }));

    await collect(router.executeStream(createRequest()));

    expect(router.getBackendStats('b')?.totalCost).toBeCloseTo(0.25);
  });

  it('counts a stream the consumer abandons as completed, not failed', async () => {
    const router = new Router({ defaultBackend: 'b' });
    router.register('b', createBackend('b'));

    for await (const chunk of router.executeStream(createRequest())) {
      if (chunk.type === 'content') {
        break;
      }
    }

    const stats = router.getBackendStats('b')!;
    expect(stats.totalRequests).toBe(1);
    expect(stats.failedRequests).toBe(0);
    expect(stats.successfulRequests).toBe(1);
  });

  it('records success when the consumer stops reading at the done chunk', async () => {
    const router = new Router({ defaultBackend: 'b', trackLatency: true });
    router.register('b', createBackend('b', { delayMs: 5 }));

    for await (const chunk of router.executeStream(createRequest())) {
      if (chunk.type === 'done') {
        break;
      }
    }

    const stats = router.getBackendStats('b')!;
    expect(stats.successfulRequests).toBe(1);
    // A latency sample proves this went through recordSuccess, not the
    // "abandoned" path (which deliberately records none).
    expect(stats.averageLatencyMs).toBeGreaterThan(0);
  });

  it('does not count a stream that is created but never iterated', async () => {
    const router = new Router({ defaultBackend: 'b' });
    router.register('b', createBackend('b'));

    const stream = router.executeStream(createRequest());
    await stream.return(undefined);

    expect(router.getBackendStats('b')?.totalRequests).toBe(0);
  });
});

// ============================================================================
// Circuit breaker
// ============================================================================

describe('Router.executeStream - circuit breaker', () => {
  it('trips from streaming failures alone', async () => {
    const router = new Router({
      defaultBackend: 'primary',
      fallbackStrategy: 'none',
      enableCircuitBreaker: true,
      circuitBreakerThreshold: 2,
      circuitBreakerTimeout: 50,
    });
    router.register(
      'primary',
      createBackend('primary', { executeStream: throwsAfter('primary', 0) })
    );

    await collect(router.executeStream(createRequest()));
    expect(router.isCircuitBreakerOpen('primary')).toBe(false);

    await collect(router.executeStream(createRequest()));
    expect(router.isCircuitBreakerOpen('primary')).toBe(true);

    router.resetCircuitBreaker();
  });

  it('resets from a streaming success', async () => {
    let failNext = true;
    const flaky: StreamFn = async function* () {
      if (failNext) {
        failNext = false;
        throw new Error('flaky down');
      }
      yield startChunk('flaky');
      yield contentChunk('flaky');
      yield doneChunk('flaky');
    };

    const router = new Router({
      defaultBackend: 'flaky',
      fallbackStrategy: 'none',
      enableCircuitBreaker: true,
      circuitBreakerThreshold: 1,
      circuitBreakerTimeout: 20,
    });
    router.register('flaky', createBackend('flaky', { executeStream: flaky }));

    await collect(router.executeStream(createRequest()));
    expect(router.isCircuitBreakerOpen('flaky')).toBe(true);

    // Past the breaker timeout the next request probes the backend (half-open).
    await sleep(40);
    const chunks = await collect(router.executeStream(createRequest()));

    expect(textOf(chunks)).toBe('hello from flaky');
    expect(router.getBackendInfo('flaky')?.circuitBreakerState).toBe('closed');
  });

  it('does not count a request the open breaker refuses', async () => {
    const router = new Router({
      defaultBackend: 'primary',
      fallbackStrategy: 'none',
      enableCircuitBreaker: true,
      circuitBreakerTimeout: 10_000,
    });
    const primary = createBackend('primary');
    router.register('primary', primary);
    router.openCircuitBreaker('primary', 10_000);

    const chunks = await collect(router.executeStream(createRequest()));

    expect(errorsIn(chunks)).toHaveLength(1);
    expect(primary.executeStream).not.toHaveBeenCalled();
    expect(router.getBackendStats('primary')?.totalRequests).toBe(0);

    router.resetCircuitBreaker();
  });

  it('is not tripped by a consumer abandoning streams', async () => {
    const router = new Router({
      defaultBackend: 'b',
      enableCircuitBreaker: true,
      circuitBreakerThreshold: 1,
      circuitBreakerTimeout: 50,
    });
    router.register('b', createBackend('b'));

    for (let i = 0; i < 3; i++) {
      for await (const chunk of router.executeStream(createRequest())) {
        if (chunk.type === 'content') {
          break;
        }
      }
    }

    expect(router.isCircuitBreakerOpen('b')).toBe(false);
    expect(router.getBackendStats('b')?.totalRequests).toBe(3);
  });

  it('fails a stream over to a backend whose circuit is closed', async () => {
    const router = new Router({
      defaultBackend: 'primary',
      fallbackStrategy: 'sequential',
      enableCircuitBreaker: true,
      circuitBreakerThreshold: 1,
      circuitBreakerTimeout: 10_000,
    });
    router.register(
      'primary',
      createBackend('primary', { executeStream: throwsAfter('primary', 0) })
    );
    router.register('backup', createBackend('backup'));
    router.setFallbackChain(['backup']);

    // First streamed failure trips the primary's breaker...
    const first = await collect(router.executeStream(createRequest()));
    expect(textOf(first)).toBe('hello from backup');
    expect(router.isCircuitBreakerOpen('primary')).toBe(true);

    // ...and the second request is refused by the breaker, then failed over.
    const second = await collect(router.executeStream(createRequest()));
    expect(textOf(second)).toBe('hello from backup');
    expect(router.getBackendStats('primary')?.totalRequests).toBe(1);

    router.resetCircuitBreaker();
  });
});
