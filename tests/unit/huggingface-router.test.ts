/**
 * Hugging Face adapter on the router's OpenAI-compatible chat completions (#216).
 *
 * Tool calling itself is covered by the shared table in openai-compat-tools.test.ts; this file pins
 * the transport: URL, auth, wire body, real SSE streaming, and the baseURL migration path.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { HuggingFaceBackendAdapter } from '@johnhenry/aimatey-backend';
import type { IRChatRequest, IRStreamChunk } from '@johnhenry/aimatey-types';

function makeRequest(overrides: Partial<IRChatRequest> = {}): IRChatRequest {
  return {
    messages: [{ role: 'user', content: 'Hello!' }],
    parameters: { model: 'meta-llama/Llama-3.1-8B-Instruct' },
    metadata: { requestId: 'req-216', timestamp: 0, provenance: {} },
    ...overrides,
  } as IRChatRequest;
}

const okJSON = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 0,
  model: 'meta-llama/Llama-3.1-8B-Instruct',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hi!' } }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
};

function mockJSON(body: unknown = okJSON) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Map(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  global.fetch = fetchMock as never;
  return fetchMock;
}

const encoder = new TextEncoder();
function mockSSE(frames: string[]) {
  let i = 0;
  const fetchMock = vi.fn().mockResolvedValue({
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
        releaseLock() {},
        cancel: async () => {},
      }),
    },
  });
  global.fetch = fetchMock as never;
  return fetchMock;
}

const frame = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

async function collect(adapter: HuggingFaceBackendAdapter, req: IRChatRequest) {
  const chunks: IRStreamChunk[] = [];
  for await (const c of adapter.executeStream(req)) chunks.push(c);
  return chunks;
}

afterEach(() => vi.restoreAllMocks());

describe('Hugging Face chat completions transport', () => {
  it('posts to the router /v1/chat/completions with a bearer token and a messages array', async () => {
    const fetchMock = mockJSON();
    const res = await new HuggingFaceBackendAdapter({ apiKey: 'hf_abc' }).execute(
      makeRequest({
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'Hello!' },
        ],
        parameters: {
          model: 'meta-llama/Llama-3.1-8B-Instruct',
          temperature: 0,
          maxTokens: 64,
          topP: 0.9,
          frequencyPenalty: 0.5,
          seed: 7,
          stopSequences: ['END'],
        },
      })
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://router.huggingface.co/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer hf_abc');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      model: 'meta-llama/Llama-3.1-8B-Instruct',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hello!' },
      ],
      temperature: 0,
      max_tokens: 64,
      top_p: 0.9,
      frequency_penalty: 0.5,
      seed: 7,
      stop: ['END'],
    });
    expect(body).not.toHaveProperty('inputs');
    expect(res.message.content).toBe('Hi!');
    expect(res.usage).toEqual({ promptTokens: 5, completionTokens: 2, totalTokens: 7 });
  });

  it('keeps the default model when none is given', () => {
    const body = new HuggingFaceBackendAdapter({ apiKey: 'k' }).fromIR(
      makeRequest({ parameters: {} as never })
    );
    expect(body.model).toBe('Qwen/Qwen3.5-9B');
  });

  it('streams real SSE deltas with usage on the done chunk', async () => {
    const fetchMock = mockSSE([
      frame({ role: 'assistant', content: 'Hel' }),
      frame({ content: 'lo' }),
      frame({}, 'stop'),
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`,
      'data: [DONE]\n\n',
    ]);
    const chunks = await collect(new HuggingFaceBackendAdapter({ apiKey: 'k' }), makeRequest());
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.stream).toBe(true);
    expect(chunks.map((c) => c.type)).toEqual(['start', 'content', 'content', 'done']);
    expect(chunks.map((c) => c.sequence)).toEqual([0, 1, 2, 3]);
    const done = chunks.at(-1) as any;
    expect(done.message.content).toBe('Hello');
    expect(done.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  });

  it('reports a stream that ends without a finish_reason as an error', async () => {
    mockSSE([frame({ content: 'Hel' })]);
    const chunks = await collect(new HuggingFaceBackendAdapter({ apiKey: 'k' }), makeRequest());
    expect(chunks.at(-1)!.type).toBe('error');
  });

  it('surfaces an in-stream error event', async () => {
    mockSSE([frame({ content: 'a' }), 'data: {"error":{"message":"overloaded"}}\n\n']);
    const chunks = await collect(new HuggingFaceBackendAdapter({ apiKey: 'k' }), makeRequest());
    const last = chunks.at(-1) as any;
    expect(last.type).toBe('error');
    expect(last.error.message).toContain('overloaded');
  });
});

describe('baseURL migration path', () => {
  const urlFor = async (baseURL?: string) => {
    const fetchMock = mockJSON();
    await new HuggingFaceBackendAdapter({ apiKey: 'k', baseURL }).execute(makeRequest());
    return fetchMock.mock.calls[0]![0] as string;
  };

  it('maps the retired api-inference host to the router', async () => {
    expect(await urlFor('https://api-inference.huggingface.co')).toBe(
      'https://router.huggingface.co/v1/chat/completions'
    );
  });

  it('appends /v1 to a bare dedicated endpoint origin', async () => {
    expect(await urlFor('https://abc.aws.endpoints.huggingface.cloud')).toBe(
      'https://abc.aws.endpoints.huggingface.cloud/v1/chat/completions'
    );
    expect(await urlFor('https://abc.aws.endpoints.huggingface.cloud/')).toBe(
      'https://abc.aws.endpoints.huggingface.cloud/v1/chat/completions'
    );
  });

  it('uses a base URL that already has a path as given', async () => {
    expect(await urlFor('https://abc.endpoints.huggingface.cloud/v1/')).toBe(
      'https://abc.endpoints.huggingface.cloud/v1/chat/completions'
    );
    expect(await urlFor('http://localhost:8080/proxy/v1')).toBe(
      'http://localhost:8080/proxy/v1/chat/completions'
    );
  });
});

describe('Hugging Face request id (#213)', () => {
  it('keeps x-request-id from an error response', async () => {
    global.fetch = vi.fn(
      async () =>
        new Response('{"error":"bad token"}', {
          status: 401,
          headers: { 'x-request-id': 'req_hf' },
        })
    ) as never;
    const adapter = new HuggingFaceBackendAdapter({ apiKey: 'bad' });
    const e: any = await adapter.execute(makeRequest()).catch((err) => err);
    expect(e.details.requestId).toBe('req_hf');
  });
});
