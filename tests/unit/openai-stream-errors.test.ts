/**
 * OpenAI SSE streaming: in-stream errors and truncation (#195)
 *
 * Before the fix, executeStream (shared by every OpenAI-compatible subclass):
 *  1. logged and skipped a `data: {"error":{...}}` event, then completed normally;
 *  2. logged and skipped a malformed `data:` line the same way;
 *  3. turned a body that ended with neither finish_reason nor [DONE] into a
 *     normal `done`.
 * A consumer could not tell a complete answer from a cut one, so it could not
 * retry or fail over. Each case must now end the stream with an `error` chunk.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAIBackendAdapter, GroqBackendAdapter } from '@johnhenry/aimatey-backend';
import type { IRChatRequest, IRStreamChunk } from '@johnhenry/aimatey-types';

const encoder = new TextEncoder();

function request(): IRChatRequest {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    parameters: { model: 'test-model' },
    metadata: { requestId: 'req-195', timestamp: 0, provenance: {} },
  } as IRChatRequest;
}

function okResponse(frames: string[]): unknown {
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

async function run(frames: string[], adapter = new OpenAIBackendAdapter({ apiKey: 'k' })) {
  global.fetch = vi.fn().mockResolvedValue(okResponse(frames)) as never;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const chunks: IRStreamChunk[] = [];
  for await (const c of adapter.executeStream(request())) chunks.push(c);
  return chunks;
}

const content = (t: string) => `data: {"choices":[{"delta":{"content":"${t}"},"index":0}]}\n\n`;

afterEach(() => vi.restoreAllMocks());

describe('OpenAI executeStream in-stream failures (#195)', () => {
  it('surfaces an in-stream error event with its message, and no done', async () => {
    const chunks = await run([
      content('Hel'),
      'data: {"error":{"message":"overloaded","type":"server_error"}}\n\n',
      content('lo'),
      'data: [DONE]\n\n',
    ]);
    const last = chunks.at(-1)!;
    expect(last.type).toBe('error');
    if (last.type === 'error') {
      expect(last.error.message).toContain('overloaded');
      expect(last.error.code).toBe('PROVIDER_ERROR');
    }
    expect(chunks.some((c) => c.type === 'done')).toBe(false);
    expect(chunks.map((c) => c.sequence)).toEqual(chunks.map((_, i) => i));
  });

  it('surfaces a malformed data line as STREAM_PARSE_ERROR', async () => {
    const chunks = await run([content('Hel'), 'data: {not json\n\n', 'data: [DONE]\n\n']);
    const last = chunks.at(-1)!;
    expect(last.type).toBe('error');
    if (last.type === 'error') expect(last.error.code).toBe('STREAM_PARSE_ERROR');
    expect(chunks.some((c) => c.type === 'done')).toBe(false);
  });

  it('reports a body that ends without finish_reason or [DONE] as STREAM_INTERRUPTED', async () => {
    const chunks = await run([content('Hel'), content('lo')]);
    const last = chunks.at(-1)!;
    expect(last.type).toBe('error');
    if (last.type === 'error') {
      expect(last.error.code).toBe('STREAM_INTERRUPTED');
      expect(last.error.details?.retryable).toBe(true);
    }
    expect(chunks.some((c) => c.type === 'done')).toBe(false);
  });

  it('still completes normally with finish_reason but no [DONE]', async () => {
    const chunks = await run([
      content('Hi'),
      'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
    ]);
    expect(chunks.at(-1)!.type).toBe('done');
  });

  it('still completes normally with [DONE] and no trailing newline', async () => {
    const chunks = await run([content('Hi'), 'data: [DONE]']);
    expect(chunks.at(-1)!.type).toBe('done');
  });

  it('OpenAI-compatible subclasses inherit the behaviour', async () => {
    const chunks = await run([content('Hel')], new GroqBackendAdapter({ apiKey: 'k' }) as never);
    expect(chunks.at(-1)!.type).toBe('error');
  });
});
