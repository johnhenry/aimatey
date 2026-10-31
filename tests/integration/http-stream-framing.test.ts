/**
 * Per-API stream framing end to end: a real Node server (NodeHTTPListener)
 * and the Hono adapter, with the Gemini, Ollama and OpenAI frontends.
 *
 * - Gemini: `:streamGenerateContent?alt=sse` -> SSE data lines, no [DONE];
 *   without alt=sse -> one JSON array. Gemini streams by URL, with no
 *   `stream` field in the body.
 * - Ollama: `/api/chat` -> NDJSON, no [DONE].
 * - OpenAI: `/v1/chat/completions` -> SSE ending with `data: [DONE]`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { NodeHTTPListener, HonoMiddleware } from '@johnhenry/aimatey-http';
import { Bridge } from '@johnhenry/aimatey-core';
import {
  GeminiFrontendAdapter,
  OllamaFrontendAdapter,
  OllamaGenerateFrontendAdapter,
  OpenAIFrontendAdapter,
} from '@johnhenry/aimatey-frontend';
import type {
  BackendAdapter,
  FrontendAdapter,
  IRChatRequest,
  IRChatResponse,
} from '@johnhenry/aimatey-types';

/** The model of the last request the mock backend received. */
let lastModel: string | undefined;

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

  async execute(req: IRChatRequest): Promise<IRChatResponse> {
    lastModel = req.parameters?.model;
    return {
      message: { role: 'assistant', content: 'x' },
      finishReason: 'stop',
      metadata: { requestId: req.metadata.requestId, timestamp: Date.now() },
    };
  }

  async *executeStream(req: IRChatRequest): AsyncGenerator<any> {
    lastModel = req.parameters?.model;
    yield {
      type: 'start',
      sequence: 0,
      metadata: {
        requestId: req.metadata.requestId,
        timestamp: Date.now(),
        provenance: { backend: 'mock' },
      },
    };
    yield { type: 'content', sequence: 1, delta: 'Hello' };
    yield { type: 'content', sequence: 2, delta: ' world' };
    yield {
      type: 'done',
      sequence: 3,
      finishReason: 'stop',
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    };
  }
}

const bridgeFor = (frontend: FrontendAdapter) =>
  new Bridge(frontend as never, new StreamingBackend());

const geminiBody = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
const ollamaBody = { model: 'llama3', messages: [{ role: 'user', content: 'hi' }], stream: true };
const openaiBody = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: true };

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

async function serve(frontend: FrontendAdapter): Promise<number> {
  server = createServer(NodeHTTPListener(bridgeFor(frontend), { streaming: true }));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

function post(
  port: number,
  path: string,
  body: unknown
): Promise<{ status: number; contentType: string; body: string; ended: boolean }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers['content-type'] ?? ''),
            body: text,
            ended: true,
          })
        );
      }
    );
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

const sseData = (body: string) =>
  body
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6));

describe('Node listener stream framing', () => {
  it('Gemini alt=sse: SSE GenerateContentResponse lines, no [DONE]', async () => {
    const port = await serve(new GeminiFrontendAdapter());
    const res = await post(
      port,
      '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
      geminiBody
    );
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/event-stream');
    expect(res.body).not.toContain('[DONE]');
    const events = sseData(res.body).map((d) => JSON.parse(d));
    expect(events.map((e) => e.candidates[0].content.parts[0].text)).toEqual([
      'Hello',
      ' world',
      '',
    ]);
    expect(events.at(-1).candidates[0].finishReason).toBe('STOP');
    expect(events.at(-1).usageMetadata).toEqual({
      promptTokenCount: 3,
      candidatesTokenCount: 2,
      totalTokenCount: 5,
    });
  });

  it('Gemini without alt=sse: one JSON array', async () => {
    const port = await serve(new GeminiFrontendAdapter());
    const res = await post(
      port,
      '/v1beta/models/gemini-2.5-flash:streamGenerateContent',
      geminiBody
    );
    expect(res.contentType).toContain('application/json');
    const arr = JSON.parse(res.body);
    expect(Array.isArray(arr)).toBe(true);
    expect(arr).toHaveLength(3);
    expect(arr[2].candidates[0].finishReason).toBe('STOP');
  });

  it('Ollama /api/chat: NDJSON, no [DONE]', async () => {
    const port = await serve(new OllamaFrontendAdapter());
    const res = await post(port, '/api/chat', ollamaBody);
    expect(res.contentType).toContain('application/x-ndjson');
    expect(res.body).not.toContain('[DONE]');
    expect(res.body).not.toContain('data:');
    const lines = res.body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.message.content)).toEqual(['Hello', ' world', '']);
    expect(lines.at(-1)).toMatchObject({
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 3,
      eval_count: 2,
    });
  });

  it('Ollama /api/generate: NDJSON in the generate shape', async () => {
    const port = await serve(new OllamaGenerateFrontendAdapter());
    const res = await post(port, '/api/generate', { model: 'llama3', prompt: 'hi', stream: true });
    expect(res.contentType).toContain('application/x-ndjson');
    const lines = res.body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.response)).toEqual(['Hello', ' world', '']);
    expect(lines.every((l) => !('message' in l))).toBe(true);
    expect(lines.at(-1)).toMatchObject({ done: true, done_reason: 'stop' });
  });

  it('OpenAI /v1/chat/completions: SSE ending with [DONE]', async () => {
    const port = await serve(new OpenAIFrontendAdapter());
    const res = await post(port, '/v1/chat/completions', openaiBody);
    expect(res.contentType).toContain('text/event-stream');
    const data = sseData(res.body);
    expect(data.at(-1)).toBe('[DONE]');
    expect(JSON.parse(data[0]!).object).toBe('chat.completion.chunk');
  });
});

describe('Hono adapter stream framing', () => {
  async function honoFetch(
    frontend: FrontendAdapter,
    path: string,
    body: unknown
  ): Promise<Response> {
    const app = new Hono();
    app.use('*', HonoMiddleware(bridgeFor(frontend), { streaming: true }));
    return app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('Ollama: NDJSON', async () => {
    const res = await honoFetch(new OllamaFrontendAdapter(), '/api/chat', ollamaBody);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const text = await res.text();
    expect(text).not.toContain('[DONE]');
    expect(
      text
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .at(-1).done
    ).toBe(true);
  });

  it('Gemini alt=sse: no [DONE]', async () => {
    const res = await honoFetch(
      new GeminiFrontendAdapter(),
      '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
      geminiBody
    );
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).not.toContain('[DONE]');
    expect(sseData(text)).toHaveLength(3);
  });

  it('OpenAI: [DONE]', async () => {
    const res = await honoFetch(new OpenAIFrontendAdapter(), '/v1/chat/completions', openaiBody);
    expect(sseData(await res.text()).at(-1)).toBe('[DONE]');
  });
});

describe('Node listener: how each API asks for a stream, and Gemini models in the URL', () => {
  const ndjson = (body: string) =>
    body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

  it('Ollama /api/chat streams when the body has no stream field (Ollama defaults to true)', async () => {
    const port = await serve(new OllamaFrontendAdapter());
    const { stream: _omit, ...body } = ollamaBody;
    const res = await post(port, '/api/chat', body);
    expect(res.contentType).toContain('application/x-ndjson');
    expect(ndjson(res.body).map((l) => l.done)).toEqual([false, false, true]);
  });

  it('Ollama /api/generate streams when the body has no stream field', async () => {
    const port = await serve(new OllamaGenerateFrontendAdapter());
    const res = await post(port, '/api/generate', { model: 'llama3', prompt: 'hi' });
    expect(res.contentType).toContain('application/x-ndjson');
    expect(ndjson(res.body).at(-1)).toMatchObject({ done: true });
  });

  it('Ollama stream: false answers with one JSON response', async () => {
    const port = await serve(new OllamaFrontendAdapter());
    const res = await post(port, '/api/chat', { ...ollamaBody, stream: false });
    expect(res.contentType).toContain('application/json');
    expect(JSON.parse(res.body)).toMatchObject({ done: true, message: { content: 'x' } });
  });

  it('OpenAI without a stream field still answers with one JSON response', async () => {
    const port = await serve(new OpenAIFrontendAdapter());
    const { stream: _omit, ...body } = openaiBody;
    const res = await post(port, '/v1/chat/completions', body);
    expect(res.contentType).toContain('application/json');
    expect(JSON.parse(res.body).choices[0].message.content).toBe('x');
  });

  it('Gemini :streamGenerateContent takes the model from the URL', async () => {
    lastModel = undefined;
    const port = await serve(new GeminiFrontendAdapter());
    await post(port, '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse', geminiBody);
    expect(lastModel).toBe('gemini-2.5-flash');
  });

  it('Gemini :generateContent takes the model from the URL', async () => {
    lastModel = undefined;
    const port = await serve(new GeminiFrontendAdapter());
    const res = await post(port, '/v1beta/models/gemini-2.5-pro:generateContent', geminiBody);
    expect(JSON.parse(res.body).candidates[0].content.parts[0].text).toBe('x');
    expect(lastModel).toBe('gemini-2.5-pro');
  });

  it('a model in the Gemini body wins over the URL', async () => {
    lastModel = undefined;
    const port = await serve(new GeminiFrontendAdapter());
    await post(port, '/v1beta/models/gemini-2.5-pro:generateContent', {
      ...geminiBody,
      model: 'models/gemini-2.0-flash',
    });
    expect(lastModel).toBe('gemini-2.0-flash');
  });
});
