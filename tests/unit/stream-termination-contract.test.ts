/**
 * Stream termination contract (#126)
 *
 * An `IRChatStream` must end with exactly one `done` or `error` chunk. Before
 * this contract an iterator that simply completed -- a socket that closed
 * cleanly mid-answer -- looked like a finished reply, and `Router.trackStream`
 * credited it as a success, so the circuit breaker could not open on the very
 * failure mode that most resembles a healthy one.
 *
 * The contract is enforced where streams enter the library:
 * `withTerminationGuard()` (utils), applied by `Bridge` to every backend stream
 * and by `Router` to every backend it drives.
 */

import { describe, it, expect, vi } from 'vitest';
import { Bridge, Router } from '@johnhenry/aimatey-core';
import {
  validateChunkSequence,
  validateStreamContract,
  withTerminationGuard,
} from '@johnhenry/aimatey-utils';
import type {
  BackendAdapter,
  IRChatRequest,
  IRChatStream,
  IRStreamChunk,
  StreamContractViolation,
} from '@johnhenry/aimatey-types';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';

// ============================================================================
// Helpers
// ============================================================================

function createRequest(): IRChatRequest {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    parameters: { model: 'test-model' },
    metadata: { requestId: 'req-term', timestamp: 1, provenance: {} },
  } as IRChatRequest;
}

const start = (sequence = 0): IRStreamChunk =>
  ({ type: 'start', sequence, metadata: createRequest().metadata }) as IRStreamChunk;
const content = (sequence: number, delta = 'x'): IRStreamChunk =>
  ({ type: 'content', sequence, delta, role: 'assistant' }) as IRStreamChunk;
const done = (sequence: number, text = 'x'): IRStreamChunk =>
  ({
    type: 'done',
    sequence,
    finishReason: 'stop',
    message: { role: 'assistant', content: text },
  }) as IRStreamChunk;
const errorChunk = (sequence: number): IRStreamChunk =>
  ({
    type: 'error',
    sequence,
    error: { code: 'PROVIDER_ERROR', message: 'boom' },
  }) as IRStreamChunk;

async function* from(chunks: IRStreamChunk[]): IRChatStream {
  for (const chunk of chunks) {
    yield chunk;
  }
}

async function collect(stream: AsyncIterable<unknown>): Promise<any[]> {
  const out: any[] = [];
  for await (const chunk of stream) {
    out.push(chunk);
  }
  return out;
}

function backend(name: string, stream: () => IRChatStream): BackendAdapter {
  return {
    metadata: {
      name,
      version: '1.0.0',
      provider: name,
      capabilities: {
        streaming: true,
        multiModal: false,
        tools: false,
        systemMessageStrategy: 'in-messages',
        supportsMultipleSystemMessages: true,
      },
    },
    execute: vi.fn(),
    executeStream: vi.fn(() => stream()),
  } as unknown as BackendAdapter;
}

/** A backend whose iterator returns early: the socket closed cleanly mid-answer. */
const truncatedBackend = (name = 'cutoff') =>
  backend(name, () => from([start(0), content(1, 'Hel'), content(2, 'lo')]));

// ============================================================================
// withTerminationGuard
// ============================================================================

describe('withTerminationGuard', () => {
  it('passes a stream that already honours the contract through untouched', async () => {
    const chunks = [start(0), content(1), done(2)];
    expect(await collect(withTerminationGuard(from(chunks)))).toEqual(chunks);
  });

  it('passes an error-terminated stream through untouched', async () => {
    const chunks = [start(0), content(1), errorChunk(2)];
    expect(await collect(withTerminationGuard(from(chunks)))).toEqual(chunks);
  });

  it('closes a silent end with a stream-truncated error, numbered as the next sequence', async () => {
    const seen: StreamContractViolation[] = [];
    const out = await collect(
      withTerminationGuard(from([start(0), content(1), content(2)]), {
        onViolation: (v) => seen.push(v),
        backend: 'cutoff',
      })
    );

    const terminal = out.at(-1);
    expect(terminal.type).toBe('error');
    expect(terminal.error.code).toBe('stream-truncated');
    expect(terminal.sequence).toBe(3);
    expect(terminal.error.details).toMatchObject({ lastSequence: 2, chunks: 3, backend: 'cutoff' });
    expect(validateChunkSequence(out).valid).toBe(true);
    expect(validateStreamContract(out).valid).toBe(true);
    expect(seen.map((v) => v.code)).toEqual(['missing-terminal']);
  });

  it('closes an empty stream, starting the numbering at 0', async () => {
    const out = await collect(withTerminationGuard(from([])));
    expect(out).toHaveLength(1);
    expect(out[0].sequence).toBe(0);
    expect(out[0].error.code).toBe('stream-truncated');
  });

  it('leaves a cancelled stream alone: stopping is not truncation', async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await collect(
      withTerminationGuard(from([start(0), content(1)]), { signal: controller.signal })
    );
    expect(out.map((c) => c.type)).toEqual(['start', 'content']);
  });

  it('drops anything after the terminal chunk, so a second terminal cannot follow', async () => {
    const seen: StreamContractViolation[] = [];
    const out = await collect(
      withTerminationGuard(from([start(0), done(1, ''), errorChunk(2)]), {
        onViolation: (v) => seen.push(v),
      })
    );
    expect(out.map((c) => c.type)).toEqual(['start', 'done']);
    expect(seen.map((v) => v.code)).toEqual(['chunk-after-terminal']);
  });

  it('still drains the source after the terminal chunk, so its own epilogue runs', async () => {
    let epilogue = false;
    async function* withEpilogue(): IRChatStream {
      yield start(0);
      yield done(1, '');
      epilogue = true;
    }
    await collect(withTerminationGuard(withEpilogue()));
    expect(epilogue).toBe(true);
  });

  it('does not intercept a throwing source', async () => {
    async function* failing(): IRChatStream {
      yield start(0);
      throw new Error('socket reset');
    }
    await expect(collect(withTerminationGuard(failing()))).rejects.toThrow('socket reset');
  });
});

// ============================================================================
// validateStreamContract
// ============================================================================

describe('validateStreamContract: termination', () => {
  it('reports a recorded stream with no terminal chunk', () => {
    const result = validateStreamContract([start(0), content(1)]);
    expect(result.valid).toBe(false);
    expect(result.violations.map((v) => v.code)).toEqual(['missing-terminal']);
  });

  it('reports a chunk after the terminal chunk', () => {
    const result = validateStreamContract([start(0), done(1, ''), content(2)]);
    expect(result.violations.map((v) => v.code)).toEqual(['chunk-after-terminal']);
  });
});

// ============================================================================
// Bridge
// ============================================================================

describe('Bridge applies the termination contract to a backend that ends early', () => {
  it('executeIRStream() delivers a terminal stream-truncated error and reports it', async () => {
    const seen: StreamContractViolation[] = [];
    const bridge = new Bridge(new OpenAIFrontendAdapter(), truncatedBackend(), {
      onContractViolation: (v) => seen.push(v),
    });

    const chunks = await collect(bridge.executeIRStream(createRequest()));

    expect(chunks.at(-1).type).toBe('error');
    expect(chunks.at(-1).error.code).toBe('stream-truncated');
    expect(validateStreamContract(chunks).valid).toBe(true);
    expect(validateChunkSequence(chunks).valid).toBe(true);
    expect(seen.map((v) => v.code)).toContain('missing-terminal');
  });

  it('applies the guard even when no callback is configured', async () => {
    const bridge = new Bridge(new OpenAIFrontendAdapter(), truncatedBackend());
    const chunks = await collect(bridge.executeIRStream(createRequest()));
    expect(chunks.at(-1).error.code).toBe('stream-truncated');
  });

  it('leaves a well-formed stream byte-for-byte alone', async () => {
    const bridge = new Bridge(
      new OpenAIFrontendAdapter(),
      backend('ok', () => from([start(0), content(1, 'Hi'), done(2, 'Hi')]))
    );
    const chunks = await collect(bridge.executeIRStream(createRequest()));
    expect(chunks.map((c) => c.type)).toEqual(['start', 'content', 'done']);
  });

  it('applies on chatStream() too, and reports it', async () => {
    const seen: StreamContractViolation[] = [];
    const bridge = new Bridge(new OpenAIFrontendAdapter(), truncatedBackend(), {
      onContractViolation: (v) => seen.push(v),
    });
    await collect(
      bridge.chatStream({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })
    );
    expect(seen.map((v) => v.code)).toContain('missing-terminal');
  });
});

// ============================================================================
// Router
// ============================================================================

describe('Router no longer credits a silent end as a success', () => {
  it('counts it as a failure and delivers a stream-truncated error once committed', async () => {
    const router = new Router({ defaultBackend: 'cutoff', fallbackStrategy: 'none' });
    router.register('cutoff', truncatedBackend());

    const chunks = await collect(router.executeStream(createRequest()));

    expect(chunks.at(-1).error.code).toBe('stream-truncated');
    expect(validateChunkSequence(chunks).valid).toBe(true);
    expect(router.getBackendStats('cutoff')?.failedRequests).toBe(1);
    expect(router.getBackendStats('cutoff')?.successfulRequests).toBe(0);
  });

  it('lets repeated truncation open the circuit breaker', async () => {
    const router = new Router({
      defaultBackend: 'cutoff',
      fallbackStrategy: 'none',
      enableCircuitBreaker: true,
      circuitBreakerThreshold: 2,
    });
    router.register('cutoff', truncatedBackend());

    await collect(router.executeStream(createRequest()));
    await collect(router.executeStream(createRequest()));

    expect(router.getBackendInfo('cutoff')?.circuitBreakerState).toBe('open');
  });

  it('fails over, as for any failure, when the truncated stream never committed', async () => {
    const router = new Router({ defaultBackend: 'cutoff', fallbackStrategy: 'sequential' });
    router.register(
      'cutoff',
      backend('cutoff', () => from([start(0)]))
    );
    router.register(
      'good',
      backend('good', () => from([start(0), content(1, 'ok'), done(2, 'ok')]))
    );
    router.setFallbackChain(['good']);

    const chunks = await collect(router.executeStream(createRequest()));

    expect(chunks.map((c) => c.type)).toEqual(['start', 'content', 'done']);
    expect(router.getBackendStats('cutoff')?.failedRequests).toBe(1);
  });

  it('still treats a cancelled stream as abandoned, not failed', async () => {
    const controller = new AbortController();
    const router = new Router({ defaultBackend: 'cutoff', fallbackStrategy: 'none' });
    router.register(
      'cutoff',
      backend('cutoff', async function* () {
        yield start(0);
        controller.abort();
      })
    );

    await collect(router.executeStream(createRequest(), controller.signal));

    expect(router.getBackendStats('cutoff')?.failedRequests).toBe(0);
  });
});
