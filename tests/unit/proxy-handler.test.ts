/**
 * Proxy server HTTP handler tests
 *
 * Covers `createHandler` in packages/cli/src/proxy.ts: CORS/OPTIONS
 * handling, method gating, the non-streaming request -> IR -> backend ->
 * provider-format response cycle (via the real frontend adapters), SSE
 * streaming, and the error paths (malformed body, backend failure,
 * unsupported format).
 *
 * The HTTP layer is exercised without a real socket: `createHandler`
 * returns a plain `(req, res) => Promise<void>` function, so we hand it
 * minimal IncomingMessage/ServerResponse doubles (same technique as
 * http-core-fixes.test.ts) and assert on what was written.
 */

import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHandler } from '../../packages/cli/src/proxy.js';
import { FunctionBackendAdapter } from '@johnhenry/aimatey-backend-browser';
import type { IRChatRequest, IRChatResponse, IRStreamChunk } from '@johnhenry/aimatey-types';

// ============================================================================
// Test Helpers
// ============================================================================

function createMockRequest(body: string, method = 'POST'): IncomingMessage {
  const readable = Readable.from([Buffer.from(body, 'utf-8')]);
  (readable as unknown as { method: string }).method = method;
  return readable as unknown as IncomingMessage;
}

function createMockResponse() {
  const headers: Record<string, string> = {};
  const writes: string[] = [];
  let statusCode: number | undefined;

  const res = {
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value;
    }),
    writeHead: vi.fn((code: number, hdrs?: Record<string, string>) => {
      statusCode = code;
      if (hdrs) Object.assign(headers, hdrs);
    }),
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
    end: vi.fn((chunk?: string) => {
      if (typeof chunk === 'string') writes.push(chunk);
    }),
  };

  return {
    res: res as unknown as ServerResponse,
    spies: res,
    getHeaders: () => headers,
    getBody: () => writes.join(''),
    getStatusCode: () => statusCode,
  };
}

function makeBackend(overrides: {
  execute?: FunctionBackendAdapter['execute'];
  executeStream?: (request: IRChatRequest) => AsyncIterable<IRStreamChunk>;
} = {}) {
  const execute =
    overrides.execute ??
    (async (request: IRChatRequest): Promise<IRChatResponse> => ({
      message: { role: 'assistant', content: 'Hello from backend' },
      finishReason: 'stop',
      usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
      metadata: {
        requestId: request.metadata.requestId,
        timestamp: 1_700_000_000_000,
        provenance: {},
      },
    }));

  return new FunctionBackendAdapter({
    execute,
    executeStream: overrides.executeStream,
    metadata: { name: 'test-backend' },
  });
}

// ============================================================================
// CORS / OPTIONS / Method Gating
// ============================================================================

describe('createHandler: CORS and method handling', () => {
  it('responds to OPTIONS with 200 and CORS headers, no body', async () => {
    const handler = createHandler(makeBackend(), 'openai', false);
    const req = createMockRequest('', 'OPTIONS');
    const { res, getHeaders, getStatusCode, getBody } = createMockResponse();

    await handler(req, res);

    expect(getStatusCode()).toBe(200);
    expect(getHeaders()['Access-Control-Allow-Origin']).toBe('*');
    expect(getHeaders()['Access-Control-Allow-Methods']).toBe('GET, POST, OPTIONS');
    expect(getHeaders()['Access-Control-Allow-Headers']).toBe('Content-Type, Authorization');
    expect(getBody()).toBe('');
  });

  it('sets CORS headers on every request, not just OPTIONS', async () => {
    const handler = createHandler(makeBackend(), 'openai', false);
    const req = createMockRequest(JSON.stringify({ model: 'gpt-4o', messages: [] }));
    const { res, getHeaders } = createMockResponse();

    await handler(req, res);

    expect(getHeaders()['Access-Control-Allow-Origin']).toBe('*');
  });

  it('rejects non-POST, non-OPTIONS methods with 405', async () => {
    const handler = createHandler(makeBackend(), 'openai', false);
    const req = createMockRequest('', 'GET');
    const { res, getStatusCode, getBody } = createMockResponse();

    await handler(req, res);

    expect(getStatusCode()).toBe(405);
    expect(JSON.parse(getBody())).toEqual({ error: 'Method not allowed' });
  });
});

// ============================================================================
// Non-streaming request -> IR -> backend -> provider-format response
// ============================================================================

describe('createHandler: non-streaming conversion cycle', () => {
  it('converts an OpenAI-format request through the backend and back to OpenAI format', async () => {
    const backend = makeBackend();
    const handler = createHandler(backend, 'openai', false);
    const req = createMockRequest(
      JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    );
    const { res, getStatusCode, getHeaders, getBody } = createMockResponse();

    await handler(req, res);

    expect(getStatusCode()).toBe(200);
    expect(getHeaders()['Content-Type']).toBe('application/json');

    const body = JSON.parse(getBody());
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('test-backend'); // provenance.backend, no servedModel reported
    expect(body.choices[0].message.content).toBe('Hello from backend');
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
  });

  it('converts the same backend response into Ollama format when format=ollama', async () => {
    const backend = makeBackend();
    const handler = createHandler(backend, 'ollama', false);
    const req = createMockRequest(
      JSON.stringify({ model: 'llama3.1', messages: [{ role: 'user', content: 'hi' }] })
    );
    const { res, getBody } = createMockResponse();

    await handler(req, res);

    const body = JSON.parse(getBody());
    // Ollama's non-chunked response shape nests the reply under `message`.
    expect(body.message.content).toBe('Hello from backend');
    expect(body.done).toBe(true);
  });

  it('passes the parsed request through to backend.execute as IR', async () => {
    const executeSpy = vi.fn(
      async (request: IRChatRequest): Promise<IRChatResponse> => ({
        message: { role: 'assistant', content: 'ok' },
        finishReason: 'stop',
        metadata: { requestId: request.metadata.requestId, timestamp: Date.now(), provenance: {} },
      })
    );
    const backend = makeBackend({ execute: executeSpy });
    const handler = createHandler(backend, 'openai', false);
    const req = createMockRequest(
      JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], temperature: 0.42 })
    );
    const { res } = createMockResponse();

    await handler(req, res);

    expect(executeSpy).toHaveBeenCalledTimes(1);
    const irRequestArg = executeSpy.mock.calls[0]![0];
    expect(irRequestArg.parameters?.temperature).toBe(0.42);
    expect(irRequestArg.parameters?.model).toBe('gpt-4o');
  });
});

// ============================================================================
// SSE Streaming
// ============================================================================

describe('createHandler: streaming', () => {
  async function* twoChunkStream(): AsyncGenerator<IRStreamChunk> {
    yield { type: 'content', sequence: 0, delta: 'Hel' };
    yield { type: 'content', sequence: 1, delta: 'lo' };
    yield { type: 'done', sequence: 2, finishReason: 'stop' };
  }

  it('emits text/event-stream headers and SSE-framed content chunks ending in [DONE]', async () => {
    const backend = makeBackend({ executeStream: twoChunkStream });
    const handler = createHandler(backend, 'openai', false);
    const req = createMockRequest(
      JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: true })
    );
    const { res, getHeaders, getBody, getStatusCode } = createMockResponse();

    await handler(req, res);

    expect(getStatusCode()).toBe(200);
    expect(getHeaders()['Content-Type']).toBe('text/event-stream');
    expect(getHeaders()['Cache-Control']).toBe('no-cache');
    expect(getHeaders().Connection).toBe('keep-alive');

    const events = getBody()
      .split('\n\n')
      .filter((s) => s.length > 0);

    // Two content chunks, one final ("done"-derived) chunk, then [DONE].
    expect(events).toHaveLength(4);
    expect(events[3]).toBe('data: [DONE]');

    const firstPayload = JSON.parse(events[0]!.replace(/^data: /, ''));
    expect(firstPayload.object).toBe('chat.completion.chunk');
    expect(firstPayload.choices[0].delta.content).toBe('Hel');

    const secondPayload = JSON.parse(events[1]!.replace(/^data: /, ''));
    expect(secondPayload.choices[0].delta.content).toBe('lo');

    const finalPayload = JSON.parse(events[2]!.replace(/^data: /, ''));
    expect(finalPayload.choices[0].delta).toEqual({});
    expect(finalPayload.choices[0].finish_reason).toBe('stop');
  });

  it('defaults finish_reason to "stop" when the done chunk omits it', async () => {
    async function* noReasonStream(): AsyncGenerator<IRStreamChunk> {
      yield { type: 'content', sequence: 0, delta: 'hi' };
      yield { type: 'done', sequence: 1 } as IRStreamChunk;
    }
    const backend = makeBackend({ executeStream: noReasonStream });
    const handler = createHandler(backend, 'openai', false);
    const req = createMockRequest(
      JSON.stringify({ model: 'gpt-4o', messages: [], stream: true })
    );
    const { res, getBody } = createMockResponse();

    await handler(req, res);

    const events = getBody().split('\n\n').filter((s) => s.length > 0);
    const finalPayload = JSON.parse(events[1]!.replace(/^data: /, ''));
    expect(finalPayload.choices[0].finish_reason).toBe('stop');
  });

  it('streams an error chunk and ends the response on stream error', async () => {
    async function* errorStream(): AsyncGenerator<IRStreamChunk> {
      yield { type: 'content', sequence: 0, delta: 'partial' };
      yield {
        type: 'error',
        sequence: 1,
        error: { code: 'UPSTREAM_FAILURE', message: 'backend blew up' },
      };
    }
    const backend = makeBackend({ executeStream: errorStream });
    const handler = createHandler(backend, 'openai', false);
    const req = createMockRequest(
      JSON.stringify({ model: 'gpt-4o', messages: [], stream: true })
    );
    const { res, getBody } = createMockResponse();

    await handler(req, res);

    const events = getBody().split('\n\n').filter((s) => s.length > 0);
    const errorPayload = JSON.parse(events[1]!.replace(/^data: /, ''));
    expect(errorPayload.error).toEqual({ code: 'UPSTREAM_FAILURE', message: 'backend blew up' });
  });
});

// ============================================================================
// Error Paths
// ============================================================================

describe('createHandler: error paths', () => {
  it('returns 500 with the error message when the backend rejects', async () => {
    const backend = makeBackend({
      execute: async () => {
        throw new Error('backend unavailable');
      },
    });
    const handler = createHandler(backend, 'openai', false);
    const req = createMockRequest(
      JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    );
    const { res, getStatusCode, getBody } = createMockResponse();

    await handler(req, res);

    expect(getStatusCode()).toBe(500);
    const body = JSON.parse(getBody());
    expect(body.error.message).toBe('backend unavailable');
    expect(body.error.type).toBe('internal_error');
  });

  it('returns 500 for a malformed (non-JSON) request body', async () => {
    const backend = makeBackend();
    const handler = createHandler(backend, 'openai', false);
    const req = createMockRequest('{not valid json');
    const { res, getStatusCode, getBody } = createMockResponse();

    await handler(req, res);

    expect(getStatusCode()).toBe(500);
    expect(JSON.parse(getBody()).error.type).toBe('internal_error');
  });

  it('returns 500 with "Unsupported format" for an unrecognized target format', async () => {
    const backend = makeBackend();
    const handler = createHandler(backend, 'not-a-real-format', false);
    const req = createMockRequest(JSON.stringify({ model: 'gpt-4o', messages: [] }));
    const { res, getStatusCode, getBody } = createMockResponse();

    await handler(req, res);

    expect(getStatusCode()).toBe(500);
    expect(JSON.parse(getBody()).error.message).toBe('Unsupported format: not-a-real-format');
  });
});
