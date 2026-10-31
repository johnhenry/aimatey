/**
 * The OpenAI frontend must surface a failed stream instead of ending it as if
 * it had finished: OpenAI-compatible servers send a final `data: {"error":
 * {...}}` frame, which the OpenAI SDKs raise as an APIError.
 */

import { describe, it, expect } from 'vitest';
import {
  OpenAIFrontendAdapter,
  isOpenAIStreamError,
  type OpenAIStreamEvent,
} from '@johnhenry/aimatey-frontend';
import { OpenAI } from '@johnhenry/aimatey-wrapper';
import { MockBackendAdapter } from '@johnhenry/aimatey-backend-browser';
import type { IRStreamChunk, BackendAdapter } from '@johnhenry/aimatey-types';

const start: IRStreamChunk = {
  type: 'start',
  sequence: 0,
  metadata: { requestId: 'req-1', timestamp: 1_700_000_000_000, provenance: {} },
};

async function collect(source: AsyncGenerator<IRStreamChunk, void, undefined>) {
  const out: OpenAIStreamEvent[] = [];
  for await (const e of new OpenAIFrontendAdapter().fromIRStream(source)) out.push(e);
  return out;
}

async function* from(chunks: IRStreamChunk[]): AsyncGenerator<IRStreamChunk, void, undefined> {
  for (const c of chunks) yield c;
}

describe('OpenAIFrontendAdapter stream errors', () => {
  it('turns an IR error chunk into a final { error } frame', async () => {
    const events = await collect(
      from([
        start,
        { type: 'content', sequence: 1, delta: 'Hel' },
        {
          type: 'error',
          sequence: 2,
          error: { code: 'PROVIDER_ERROR', message: 'upstream exploded' },
        },
        // Nothing after the error may be emitted.
        { type: 'content', sequence: 3, delta: 'lo' },
      ])
    );

    expect(events).toHaveLength(2);
    expect(isOpenAIStreamError(events[0])).toBe(false);
    expect(events[1]).toEqual({
      error: {
        message: 'upstream exploded',
        type: 'api_error',
        param: null,
        code: 'PROVIDER_ERROR',
      },
    });
    expect(isOpenAIStreamError(events[1])).toBe(true);
  });

  it("keeps an upstream OpenAI error's own type and code", async () => {
    const events = await collect(
      from([
        start,
        {
          type: 'error',
          sequence: 1,
          error: {
            code: 'PROVIDER_ERROR',
            message: 'Rate limit reached',
            details: { type: 'rate_limit_error', code: 'rate_limit_exceeded' },
          },
        },
      ])
    );
    expect(events.at(-1)).toEqual({
      error: {
        message: 'Rate limit reached',
        type: 'rate_limit_error',
        param: null,
        code: 'rate_limit_exceeded',
      },
    });
  });

  it('turns a stream that throws into a final { error } frame', async () => {
    async function* failing(): AsyncGenerator<IRStreamChunk, void, undefined> {
      yield start;
      yield { type: 'content', sequence: 1, delta: 'partial' };
      throw new Error('socket closed');
    }
    const events = await collect(failing());
    expect(events.at(-1)).toEqual({
      error: { message: 'socket closed', type: 'api_error', param: null, code: 'stream_error' },
    });
  });

  it('does not add an error frame to a stream that finished', async () => {
    const events = await collect(
      from([
        start,
        { type: 'content', sequence: 1, delta: 'ok' },
        { type: 'done', sequence: 2, finishReason: 'stop' },
      ])
    );
    expect(events.some(isOpenAIStreamError)).toBe(false);
    expect(events.at(-1)).toMatchObject({ choices: [{ finish_reason: 'stop' }] });
  });

  it('the OpenAI SDK wrapper raises the error frame', async () => {
    const backend = new MockBackendAdapter({ defaultResponse: 'x' }) as BackendAdapter;
    backend.executeStream = async function* () {
      yield start;
      yield { type: 'error', sequence: 1, error: { code: 'PROVIDER_ERROR', message: 'nope' } };
    } as BackendAdapter['executeStream'];
    const client = new OpenAI(backend);
    const stream = await client.chat.completions.create({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    await expect(
      (async () => {
        for await (const _ of stream as AsyncIterable<unknown>) {
          // drain
        }
      })()
    ).rejects.toThrow('nope');
  });
});
