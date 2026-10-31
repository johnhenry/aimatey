/**
 * SSE streaming over the Node/Fastify/Koa HTTP adapters (issue #89).
 *
 * These tests drive REAL servers over REAL sockets. The existing adapter
 * suites in tests/http/adapters/ build hand-rolled mock req/res objects, and
 * that is precisely why this bug survived them: the mock `res` has no
 * `headersSent` property at all, so the `!res.headersSent` term in the old
 * writability guard read `!undefined` -> `true`, the loop guard passed, and
 * the mock happily recorded chunks. A test written against those mocks passes
 * identically with and without the fix and proves nothing. Same lesson as #43.
 *
 * Every case asserts all three symptoms from the report, because any one of
 * them alone can pass against a broken adapter:
 *
 *   1. data lines actually arrive (the loop wrote something),
 *   2. the stream's tail is written (`message_stop` for Anthropic paths, which
 *      the handler frames as Anthropic does; `[DONE]` for a bare adapter),
 *   3. the response actually ends (res.end() was reached, so the client is
 *      not left holding an open socket).
 *
 * (3) is the one a chunk-count assertion misses: `res.on('end')` only fires
 * once the server terminates the chunked body, so a hanging connection shows
 * up here as `ended: false` rather than as a passing test.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, request, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { NodeHTTPListener, FastifyHandler, KoaResponseAdapter } from '@johnhenry/aimatey-http';
import { Bridge } from '@johnhenry/aimatey-core';
import { AnthropicFrontendAdapter } from '@johnhenry/aimatey-frontend';
import type { BackendAdapter, IRChatRequest, IRChatResponse } from '@johnhenry/aimatey-types';

/** Backend that streams two real IR content chunks and a terminal done chunk. */
class StreamingBackend implements BackendAdapter {
  metadata = {
    name: 'mock-backend',
    version: '1.0.0',
    provider: 'mock' as const,
    capabilities: {
      streaming: true,
      multiModal: false,
      tools: false,
      maxContextTokens: 4096,
      systemMessageStrategy: 'in-messages' as const,
      supportsMultipleSystemMessages: true,
    },
  };

  async execute(request_: IRChatRequest): Promise<IRChatResponse> {
    return {
      message: { role: 'assistant', content: 'Mock response' },
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      metadata: {
        requestId: request_.metadata.requestId,
        timestamp: Date.now(),
        provenance: { backend: this.metadata.name },
      },
    } as IRChatResponse;
  }

  async *executeStream(request_: IRChatRequest): AsyncGenerator<any> {
    yield {
      type: 'start',
      sequence: 0,
      metadata: {
        requestId: request_.metadata.requestId,
        timestamp: Date.now(),
        provenance: { backend: this.metadata.name },
      },
    };
    yield { type: 'content', sequence: 1, delta: 'Hello' };
    yield { type: 'content', sequence: 2, delta: ' world' };
    yield {
      type: 'done',
      sequence: 3,
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    };
  }
}

interface SSEResult {
  status: number | null;
  body: string;
  /** Payload of every `data: ` line, in order. */
  dataLines: string[];
  /** True only when the server terminated the response body itself. */
  ended: boolean;
}

const REQUEST_BODY = JSON.stringify({
  model: 'claude-3',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 16,
  stream: true,
});

/**
 * Issue an SSE request and read it to completion.
 *
 * Resolves with `ended: true` only if the response stream emitted `end` --
 * i.e. the server closed the body. A server that writes headers and then
 * hangs resolves with `ended: false` once the timeout fires.
 */
function collectSSE(port: number, path = '/v1/messages', timeoutMs = 3000): Promise<SSEResult> {
  return new Promise((resolve) => {
    let body = '';
    let status: number | null = null;
    let settled = false;

    const finish = (ended: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        status,
        body,
        dataLines: body
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice('data: '.length).trim()),
        ended,
      });
    };

    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(REQUEST_BODY),
        },
      },
      (res) => {
        status = res.statusCode ?? null;
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => finish(true));
        res.on('error', () => finish(false));
      }
    );

    const timer = setTimeout(() => {
      req.destroy();
      finish(false);
    }, timeoutMs);

    req.on('error', () => finish(false));
    req.end(REQUEST_BODY);
  });
}

/**
 * The three assertions the report calls for, applied together.
 *
 * `framing: 'anthropic'` is for /v1/messages through the request handler,
 * which streams as Anthropic does: named events, ending with `message_stop`,
 * no `[DONE]`. `'generic'` is a bare adapter stream: `data:` lines ending in
 * `data: [DONE]`.
 */
function expectCompleteSSEStream(
  result: SSEResult,
  framing: 'anthropic' | 'generic' = 'anthropic'
): void {
  expect(result.status).toBe(200);

  // 1. Data lines actually arrived. Before the fix this was 0: the loop guard
  //    was false on its first iteration, so nothing was ever written.
  const payloadLines = result.dataLines.filter((line) => line !== '[DONE]');
  expect(payloadLines.length).toBeGreaterThan(0);
  expect(result.body).toContain('Hello');

  // 2. The tail after the loop was written.
  if (framing === 'anthropic') {
    expect(result.dataLines).not.toContain('[DONE]');
    expect(result.body).toContain('event: message_start\n');
    expect(JSON.parse(result.dataLines[result.dataLines.length - 1]!).type).toBe('message_stop');
  } else {
    expect(result.dataLines).toContain('[DONE]');
    expect(result.dataLines[result.dataLines.length - 1]).toBe('[DONE]');
  }

  // 3. The server ended the response. A chunk-count assertion alone would
  //    still pass against a socket left hanging open.
  expect(result.ended).toBe(true);
}

function makeBridge(): Bridge {
  return new Bridge(new AnthropicFrontendAdapter(), new StreamingBackend());
}

// ============================================================================
// Node http.Server -- the adapter reported in #89
// ============================================================================

describe('Node HTTP adapter SSE streaming (#89)', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer(NodeHTTPListener(makeBridge(), { cors: true, streaming: true }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('delivers Anthropic SSE events, ends with message_stop, and closes the response', async () => {
    expectCompleteSSEStream(await collectSSE(port));
  });

  it('serves a second streaming request, so the first left nothing wedged', async () => {
    expectCompleteSSEStream(await collectSSE(port));
  });

  it('stops writing when the client hangs up mid-stream', async () => {
    // Exercises the widened guard from the other side: dropping `headersSent`
    // must not mean the loop writes on regardless. `writable`/`destroyed` go
    // false when the peer vanishes, which is what should stop it now.
    const payload =
      `POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(REQUEST_BODY)}\r\n` +
      `\r\n${REQUEST_BODY}`;

    await new Promise<void>((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(payload);
        setTimeout(() => sock.destroy(), 20);
      });
      sock.on('close', () => resolve());
      sock.on('error', () => resolve());
    });

    // The server must still be serving afterwards.
    expectCompleteSSEStream(await collectSSE(port));
  });
});

// ============================================================================
// Fastify -- same defect, same few lines, confirmed against a real server
// ============================================================================

describe('Fastify adapter SSE streaming (#89)', () => {
  let app: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    app = Fastify();
    app.post('/v1/messages', FastifyHandler(makeBridge(), { cors: true, streaming: true }) as any);
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  it('delivers Anthropic SSE events, ends with message_stop, and closes the response', async () => {
    expectCompleteSSEStream(await collectSSE(port));
  });
});

// ============================================================================
// Koa -- same defect. `koa` itself is not a dependency of this repo, so the
// context is assembled by hand, but every part the defect turns on is real:
// `ctx.res` IS the http.Server's ServerResponse, and `headerSent` / `writable`
// are live getters over it rather than the frozen `false` the existing koa
// mock uses. That is what lets this case fail before the fix.
// ============================================================================

describe('Koa adapter SSE streaming (#89)', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer(async (_req, res: ServerResponse) => {
      const ctx: any = {
        res,
        respond: true,
        get writable() {
          return res.writable && !res.writableEnded && !res.destroyed;
        },
        response: {
          get headerSent() {
            return res.headersSent;
          },
        },
        set(name: string, value: string) {
          res.setHeader(name, value);
        },
        get status() {
          return res.statusCode;
        },
        set status(code: number) {
          res.statusCode = code;
        },
        body: null,
      };

      const adapter = new KoaResponseAdapter(ctx);
      async function* chunks(): AsyncGenerator<any> {
        yield { text: 'Hello' };
        yield { text: ' world' };
      }
      await adapter.stream(chunks());
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('delivers SSE chunks, the [DONE] sentinel, and closes the response', async () => {
    expectCompleteSSEStream(await collectSSE(port), 'generic');
  });
});
