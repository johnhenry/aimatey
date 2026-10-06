/**
 * Authoritative stream text (#119) and resumption (#125)
 *
 * A reply reaches a consumer through three channels: the `delta`s, the optional
 * `accumulated` copy, and the optional `done.message`. Nothing said how they
 * relate, so a consumer could not tell a transport fault (a dropped or
 * corrupted chunk) from a model quirk. The contract:
 *
 * - the deltas are the text;
 * - `accumulated`, when present, equals the running sum of the deltas;
 * - `done.message`, when present, is authoritative and equals their total, so a
 *   disagreement is a transport fault.
 *
 * Resumption: a `resumedFrom` marker continues the numbering, never restarts it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  OpenAIBackendAdapter,
  OllamaBackendAdapter,
  GeminiBackendAdapter,
  AnthropicBackendAdapter,
} from '@johnhenry/aimatey-backend';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import {
  getMessageText,
  monitorStreamContract,
  validateChunkSequence,
  validateStreamContract,
} from '@johnhenry/aimatey-utils';
import type {
  BackendAdapter,
  IRChatRequest,
  IRChatStream,
  IRStreamChunk,
  StreamContractViolation,
} from '@johnhenry/aimatey-types';

const encoder = new TextEncoder();

function createRequest(extra: Partial<IRChatRequest> = {}): IRChatRequest {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    parameters: { model: 'test-model' },
    metadata: { requestId: 'req-text', timestamp: 1, provenance: {} },
    ...extra,
  } as IRChatRequest;
}

const content = (sequence: number, delta: string, accumulated?: string): IRStreamChunk =>
  ({
    type: 'content',
    sequence,
    delta,
    ...(accumulated !== undefined ? { accumulated } : {}),
  }) as IRStreamChunk;
const done = (sequence: number, text?: string): IRStreamChunk =>
  ({
    type: 'done',
    sequence,
    finishReason: 'stop',
    ...(text !== undefined ? { message: { role: 'assistant', content: text } } : {}),
  }) as IRStreamChunk;

async function collect(stream: AsyncIterable<IRStreamChunk>): Promise<IRStreamChunk[]> {
  const out: IRStreamChunk[] = [];
  for await (const chunk of stream) {
    out.push(chunk);
  }
  return out;
}

async function* from(chunks: IRStreamChunk[]): IRChatStream {
  yield* chunks;
}

function codes(chunks: IRStreamChunk[]): string[] {
  return validateStreamContract(chunks).violations.map((v) => v.code);
}

// ============================================================================
// The validator
// ============================================================================

describe('validateStreamContract: text channels', () => {
  it('accepts deltas, a matching accumulated, and a matching done.message', () => {
    expect(
      validateStreamContract([
        content(0, 'Hel', 'Hel'),
        content(1, 'lo', 'Hello'),
        done(2, 'Hello'),
      ]).valid
    ).toBe(true);
  });

  it('accepts a delta-only stream with no done.message (the deltas are all there is)', () => {
    expect(validateStreamContract([content(0, 'Hi'), done(1)]).valid).toBe(true);
  });

  it('rejects an accumulated that is not the running sum of the deltas', () => {
    expect(codes([content(0, 'Hel', 'Hel'), content(1, 'lo', 'Hallo'), done(2)])).toEqual([
      'accumulated-mismatch',
    ]);
  });

  it('rejects an accumulated that lags behind (a dropped delta upstream)', () => {
    expect(codes([content(0, 'Hel', 'Hel'), content(1, 'lo', 'Hel'), done(2)])).toEqual([
      'accumulated-mismatch',
    ]);
  });

  it('treats a done.message that disagrees with the deltas as a transport fault', () => {
    // The delta sum is "Hllo": a dropped chunk. done.message is the reply.
    const result = validateStreamContract([content(0, 'H'), content(1, 'llo'), done(2, 'Hello')]);
    expect(result.violations.map((v) => v.code)).toEqual(['done-message-mismatch']);
    expect(result.violations[0]!.message).toContain('delta-built text is damaged');
  });

  it('compares the text blocks of a structured done.message, ignoring tool calls', () => {
    const message = {
      role: 'assistant' as const,
      content: [
        { type: 'text' as const, text: 'Let me ' },
        { type: 'text' as const, text: 'check.' },
        { type: 'tool_use' as const, id: 't1', name: 'f', input: {} },
      ],
    };
    expect(getMessageText(message)).toBe('Let me check.');
    expect(
      validateStreamContract([
        content(0, 'Let me check.'),
        { type: 'done', sequence: 1, finishReason: 'tool_calls', message } as IRStreamChunk,
      ]).valid
    ).toBe(true);
  });
});

// ============================================================================
// Resumption
// ============================================================================

describe('resumption (#125): a resumed stream continues its numbering', () => {
  const resumed = (sequence: number, from: number): IRStreamChunk =>
    ({ ...content(sequence, 'b'), resumedFrom: { sequence: from } }) as IRStreamChunk;

  it('accepts a marker whose chunk follows the last sequence the consumer held', () => {
    const chunks = [content(0, 'a'), content(1, 'a'), resumed(2, 1), done(3, 'aab')];
    expect(validateStreamContract(chunks).valid).toBe(true);
    // The marker changes nothing about sequence validation: still 0, 1, 2, 3.
    expect(validateChunkSequence(chunks).valid).toBe(true);
  });

  it('rejects a resumption that restarts the numbering', () => {
    expect(codes([content(0, 'a'), content(1, 'a'), resumed(0, 1), done(1, 'aab')])).toContain(
      'resumed-sequence-mismatch'
    );
  });

  it('rejects a marker that claims a different join than the numbering shows', () => {
    expect(codes([content(0, 'a'), resumed(2, 0), done(3, 'ab')])).toContain(
      'resumed-sequence-mismatch'
    );
  });

  it('is absent on every stream that was never interrupted', () => {
    const chunks = [content(0, 'a'), done(1, 'a')];
    expect(chunks.some((c) => 'resumedFrom' in c)).toBe(false);
  });
});

// ============================================================================
// The live monitor
// ============================================================================

describe('monitorStreamContract', () => {
  it('reports without altering the stream', async () => {
    const seen: StreamContractViolation[] = [];
    const source = [content(0, 'H'), content(1, 'llo'), done(2, 'Hello')];
    const out = await collect(monitorStreamContract(from(source), (v) => seen.push(v)));
    expect(out).toEqual(source);
    expect(seen.map((v) => v.code)).toEqual(['done-message-mismatch']);
  });
});

describe('Bridge dev-mode check', () => {
  function backendEmitting(chunks: IRStreamChunk[]): BackendAdapter {
    return {
      metadata: {
        name: 'mock',
        version: '1',
        provider: 'mock',
        capabilities: {
          streaming: true,
          multiModal: false,
          tools: false,
          systemMessageStrategy: 'in-messages',
          supportsMultipleSystemMessages: true,
        },
      },
      execute: vi.fn(),
      executeStream: () => from(chunks),
    } as unknown as BackendAdapter;
  }

  it('warns when done.message disagrees with the deltas, and still delivers the stream', async () => {
    const seen: StreamContractViolation[] = [];
    const bridge = new Bridge(
      new OpenAIFrontendAdapter(),
      backendEmitting([content(0, 'H'), content(1, 'llo'), done(2, 'Hello')]),
      { onContractViolation: (v) => seen.push(v) }
    );

    const out = await collect(bridge.executeIRStream(createRequest()));

    expect(out).toHaveLength(3);
    expect(seen.map((v) => v.code)).toEqual(['done-message-mismatch']);
  });

  it('does nothing, and costs nothing, when no callback is set', async () => {
    const bridge = new Bridge(
      new OpenAIFrontendAdapter(),
      backendEmitting([content(0, 'H'), content(1, 'llo'), done(2, 'Hello')])
    );
    expect(await collect(bridge.executeIRStream(createRequest()))).toHaveLength(3);
  });

  it('survives a throwing callback', async () => {
    const bridge = new Bridge(
      new OpenAIFrontendAdapter(),
      backendEmitting([content(0, 'H'), done(1, 'X')]),
      {
        onContractViolation: () => {
          throw new Error('hook bug');
        },
      }
    );
    expect(await collect(bridge.executeIRStream(createRequest()))).toHaveLength(2);
  });
});

// ============================================================================
// Shipped adapters keep the contract in accumulated mode
// ============================================================================

function bodyResponse(frames: string[]): unknown {
  let i = 0;
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Map(),
    body: {
      getReader: () => ({
        read: async () =>
          i < frames.length
            ? { done: false, value: encoder.encode(frames[i++]!) }
            : { done: true, value: undefined },
        releaseLock: () => {},
        cancel: async () => {},
      }),
    },
  };
}

describe('shipped adapters satisfy the text contract with accumulated on', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const request = createRequest({ streamMode: 'accumulated' });

  it('OpenAI', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        bodyResponse([
          'data: {"choices":[{"delta":{"content":"He"},"index":0}]}\n',
          'data: {"choices":[{"delta":{"content":"llo"},"index":0}]}\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n',
          'data: [DONE]\n',
        ])
      ) as never;
    const chunks = await collect(new OpenAIBackendAdapter({ apiKey: 'k' }).executeStream(request));
    expect(chunks.some((c) => c.type === 'content' && c.accumulated === 'Hello')).toBe(true);
    expect(validateStreamContract(chunks)).toEqual({ valid: true, violations: [] });
  });

  it('Ollama', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        bodyResponse([
          '{"message":{"content":"He"}}\n',
          '{"message":{"content":"llo"}}\n',
          '{"done":true,"done_reason":"stop"}\n',
        ])
      ) as never;
    const chunks = await collect(new OllamaBackendAdapter({}).executeStream(request));
    expect(chunks.some((c) => c.type === 'content' && c.accumulated === 'Hello')).toBe(true);
    expect(validateStreamContract(chunks)).toEqual({ valid: true, violations: [] });
  });

  it('Gemini', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        bodyResponse([
          'data: {"candidates":[{"content":{"parts":[{"text":"He"}]}}]}\n\n',
          'data: {"candidates":[{"content":{"parts":[{"text":"llo"}]},"finishReason":"STOP"}]}\n\n',
        ])
      ) as never;
    const chunks = await collect(new GeminiBackendAdapter({ apiKey: 'k' }).executeStream(request));
    expect(chunks.some((c) => c.type === 'content' && c.accumulated === 'Hello')).toBe(true);
    expect(validateStreamContract(chunks)).toEqual({ valid: true, violations: [] });
  });

  it('Anthropic', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        bodyResponse([
          'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1}}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"He"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"llo"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ])
      ) as never;
    const chunks = await collect(
      new AnthropicBackendAdapter({ apiKey: 'k' }).executeStream(request)
    );
    expect(chunks.some((c) => c.type === 'content' && c.accumulated === 'Hello')).toBe(true);
    expect(validateStreamContract(chunks)).toEqual({ valid: true, violations: [] });
  });
});
