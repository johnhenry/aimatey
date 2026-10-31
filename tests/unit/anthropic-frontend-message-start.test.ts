/**
 * The Anthropic frontend's stream must match Anthropic's real event stream:
 * `message_start` carries the whole message skeleton (`content: []`, null
 * stop fields, `usage`), which Anthropic's SDKs read on the first event.
 */

import { describe, it, expect } from 'vitest';
import { AnthropicFrontendAdapter, type AnthropicStreamEvent } from '@johnhenry/aimatey-frontend';
import type { IRStreamChunk } from '@johnhenry/aimatey-types';

async function* irStream(chunks: IRStreamChunk[]): AsyncGenerator<IRStreamChunk, void, undefined> {
  for (const c of chunks) yield c;
}

async function collect(chunks: IRStreamChunk[]): Promise<AnthropicStreamEvent[]> {
  const out: AnthropicStreamEvent[] = [];
  for await (const e of new AnthropicFrontendAdapter().fromIRStream(irStream(chunks))) out.push(e);
  return out;
}

const start: IRStreamChunk = {
  type: 'start',
  sequence: 0,
  metadata: {
    requestId: 'req-1',
    timestamp: 1_700_000_000_000,
    provenance: { backend: 'anthropic', model: 'claude-sonnet-4-5' },
  },
};

describe('AnthropicFrontendAdapter stream shape', () => {
  it('message_start carries content: [], null stop fields and usage', async () => {
    const events = await collect([
      start,
      { type: 'content', sequence: 1, delta: 'Hi' },
      {
        type: 'done',
        sequence: 2,
        finishReason: 'stop',
        usage: { promptTokens: 25, completionTokens: 3, totalTokens: 28 },
      },
    ]);

    expect(events[0]).toEqual({
      type: 'message_start',
      message: {
        id: 'req-1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: expect.any(String),
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
  });

  it('message_delta reports input and output tokens when known', async () => {
    const events = await collect([
      start,
      {
        type: 'done',
        sequence: 1,
        finishReason: 'stop',
        usage: { promptTokens: 25, completionTokens: 3, totalTokens: 28 },
      },
    ]);
    const delta = events.find((e) => e.type === 'message_delta');
    expect(delta).toMatchObject({
      delta: { stop_reason: 'end_turn' },
      usage: { input_tokens: 25, output_tokens: 3 },
    });
  });

  it('message_delta omits input_tokens when usage is unknown', async () => {
    const events = await collect([start, { type: 'done', sequence: 1, finishReason: 'stop' }]);
    const delta = events.find((e) => e.type === 'message_delta');
    expect(delta).toMatchObject({ usage: { output_tokens: 0 } });
    expect((delta as { usage: Record<string, unknown> }).usage).not.toHaveProperty('input_tokens');
  });

  it('an IR error becomes an Anthropic error event with an Anthropic error type, and ends the stream', async () => {
    const events = await collect([
      start,
      { type: 'content', sequence: 1, delta: 'Hi' },
      {
        type: 'error',
        sequence: 2,
        error: { code: 'RATE_LIMIT_EXCEEDED', message: 'slow down' },
      },
      // Nothing after the error may be emitted.
      { type: 'done', sequence: 3, finishReason: 'stop' },
    ]);
    expect(events.at(-1)).toEqual({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'slow down' },
    });
    expect(events.map((e) => e.type)).not.toContain('message_stop');
  });

  it.each([
    ['PROVIDER_OVERLOADED', 'overloaded_error'],
    ['INVALID_REQUEST', 'invalid_request_error'],
    ['INVALID_API_KEY', 'authentication_error'],
    ['SOMETHING_ELSE', 'api_error'],
  ])('maps IR code %s to %s', async (code, type) => {
    const events = await collect([
      start,
      { type: 'error', sequence: 1, error: { code, message: 'x' } } as IRStreamChunk,
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { type } });
  });

  it('a stream that throws ends with an api_error event', async () => {
    async function* broken(): AsyncGenerator<IRStreamChunk, void, undefined> {
      yield start;
      throw new Error('socket closed');
    }
    const out: AnthropicStreamEvent[] = [];
    for await (const e of new AnthropicFrontendAdapter().fromIRStream(broken())) out.push(e);
    expect(out.at(-1)).toEqual({
      type: 'error',
      error: { type: 'api_error', message: 'socket closed' },
    });
  });
});
