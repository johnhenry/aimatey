/**
 * `Bridge.chatStream(req, { throwBeforeFirstChunk: true })`: a backend that
 * fails before its first chunk fails the call with its own error (code and
 * status kept); without the option the frontend's in-band error frame is
 * yielded, as before. Failures after the first chunk are frames either way.
 */

import { describe, it, expect } from 'vitest';
import { Bridge } from '@johnhenry/aimatey-core';
import { FunctionBackendAdapter } from '@johnhenry/aimatey-backend-browser';
import { OpenAIFrontendAdapter, isOpenAIStreamError } from '@johnhenry/aimatey-frontend';
import { AdapterError, RateLimitError } from '@johnhenry/aimatey-errors';
import type { IRStreamChunk } from '@johnhenry/aimatey-types';

type Script = (req: { metadata: { requestId: string } }) => AsyncGenerator<IRStreamChunk>;

function bridgeWith(script: Script) {
  const backend = new FunctionBackendAdapter({
    execute: async () => {
      throw new Error('not used');
    },
    executeStream: script as never,
  });
  return new Bridge(new OpenAIFrontendAdapter(), backend as never);
}

const request = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }], stream: true };

async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

const start = (req: { metadata: { requestId: string } }): IRStreamChunk => ({
  type: 'start',
  sequence: 0,
  metadata: { requestId: req.metadata.requestId, timestamp: 0 },
});

describe('Bridge.chatStream throwBeforeFirstChunk', () => {
  // eslint-disable-next-line require-yield
  const throwsAtOnce: Script = async function* () {
    throw new RateLimitError({ message: 'slow down', statusCode: 429 });
  };

  it('throws the backend error when it fails before the first chunk', async () => {
    const err = await drain(
      bridgeWith(throwsAtOnce).chatStream(request, { throwBeforeFirstChunk: true })
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('throws when the first chunk is an IR error chunk, keeping its code', async () => {
    const err = await drain(
      bridgeWith(async function* () {
        yield {
          type: 'error',
          sequence: 0,
          error: { code: 'INVALID_API_KEY', message: 'bad key' },
        } as IRStreamChunk;
      }).chatStream(request, { throwBeforeFirstChunk: true })
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).code).toBe('INVALID_API_KEY');
    expect((err as Error).message).toBe('bad key');
  });

  it('without the option, yields the in-band error frame as before', async () => {
    const chunks = await drain(bridgeWith(throwsAtOnce).chatStream(request));
    expect(chunks).toHaveLength(1);
    expect(isOpenAIStreamError(chunks[0])).toBe(true);
  });

  it('a failure after the first chunk is still an error frame', async () => {
    const chunks = await drain(
      bridgeWith(async function* (req) {
        yield start(req);
        yield { type: 'content', sequence: 1, delta: 'Hel' };
        throw new Error('reset');
      }).chatStream(request, { throwBeforeFirstChunk: true })
    );
    expect(isOpenAIStreamError(chunks.at(-1))).toBe(true);
  });

  it('an empty stream (no done or error chunk) fails before the first chunk too', async () => {
    const err = await drain(
      // eslint-disable-next-line require-yield
      bridgeWith(async function* () {
        return;
      }).chatStream(request, { throwBeforeFirstChunk: true })
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as Error).message).toMatch(/without producing any chunk/);
  });
});
