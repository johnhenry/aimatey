/**
 * Cohere adapter on the v2 Chat API with native tool calling (#215). Mocked HTTP only.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { CohereBackendAdapter } from '@johnhenry/aimatey-backend';
import { AdapterError } from '@johnhenry/aimatey-errors';
import type { IRChatRequest, IRStreamChunk, IRTool } from '@johnhenry/aimatey-types';

const WEATHER_TOOL: IRTool = {
  name: 'get_weather',
  description: 'Get current weather for a location',
  parameters: {
    type: 'object',
    properties: { location: { type: 'string' } },
    required: ['location'],
  },
};
const TIME_TOOL: IRTool = {
  name: 'get_time',
  description: 'Get the time',
  parameters: { type: 'object', properties: { tz: { type: 'string' } } },
};

function makeRequest(overrides: Partial<IRChatRequest> = {}): IRChatRequest {
  return {
    messages: [{ role: 'user', content: 'Weather in SF?' }],
    parameters: { model: 'command-a-03-2025' },
    metadata: { requestId: 'req-215', timestamp: 0, provenance: {} },
    ...overrides,
  } as IRChatRequest;
}

const make = () => new CohereBackendAdapter({ apiKey: 'k' });
const encoder = new TextEncoder();

function mockJSON(body: unknown) {
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

const ev = (type: string, extra: object = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
const text = (t: string) =>
  ev('content-delta', { index: 0, delta: { message: { content: { text: t } } } });
const callStart = (index: number, id: string, name: string) =>
  ev('tool-call-start', {
    index,
    delta: {
      message: { tool_calls: { id, type: 'function', function: { name, arguments: '' } } },
    },
  });
const callDelta = (index: number, args: string) =>
  ev('tool-call-delta', {
    index,
    delta: { message: { tool_calls: { function: { arguments: args } } } },
  });
const end = (finish: string) =>
  ev('message-end', {
    delta: {
      finish_reason: finish,
      usage: {
        billed_units: { input_tokens: 5, output_tokens: 7 },
        tokens: { input_tokens: 70, output_tokens: 7 },
      },
    },
  });

async function collect(req: IRChatRequest) {
  const chunks: IRStreamChunk[] = [];
  for await (const c of make().executeStream(req)) chunks.push(c);
  return chunks;
}

afterEach(() => vi.restoreAllMocks());

describe('Cohere v2 transport', () => {
  it('advertises tools and posts to /v2/chat with bearer auth', async () => {
    const adapter = make();
    expect(adapter.metadata.capabilities.tools).toBe(true);
    const fetchMock = mockJSON({
      id: 'r1',
      finish_reason: 'COMPLETE',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] },
      usage: { billed_units: { input_tokens: 3, output_tokens: 2 } },
    });
    const res = await adapter.execute(
      makeRequest({
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hey' },
          { role: 'user', content: 'Again' },
        ],
        parameters: { model: 'command-a-03-2025', temperature: 0.2, seed: 4, topP: 0.9, topK: 5 },
      })
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.cohere.com/v2/chat');
    expect(init.headers.Authorization).toBe('Bearer k');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      model: 'command-a-03-2025',
      stream: false,
      temperature: 0.2,
      seed: 4,
      p: 0.9,
      k: 5,
    });
    expect(body.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hey' },
      { role: 'user', content: 'Again' },
    ]);
    expect(body).not.toHaveProperty('message');
    expect(body).not.toHaveProperty('chat_history');
    expect(body).not.toHaveProperty('preamble');
    expect(res.message).toEqual({ role: 'assistant', content: 'Hi!' });
    expect(res.finishReason).toBe('stop');
    expect(res.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
    expect(res.metadata.providerResponseId).toBe('r1');
  });

  it('allows a conversation that does not end on a user message', () => {
    const body = make().fromIR(
      makeRequest({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      })
    );
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('migrates baseURL: /v1 becomes /v2, bare origin gets /v2, other paths are kept', () => {
    const url = (baseURL: string) =>
      (new CohereBackendAdapter({ apiKey: 'k', baseURL }).metadata.config as any).baseURL;
    expect(url('https://api.cohere.ai/v1')).toBe('https://api.cohere.ai/v2');
    expect(url('https://api.cohere.com/v1/')).toBe('https://api.cohere.com/v2');
    expect(url('https://proxy.example.com')).toBe('https://proxy.example.com/v2');
    expect(url('https://proxy.example.com/cohere/v2')).toBe('https://proxy.example.com/cohere/v2');
  });

  it('keeps listModels and embed on their endpoints after the migration', async () => {
    const adapter = new CohereBackendAdapter({ apiKey: 'k', baseURL: 'https://api.cohere.ai/v1' });
    const fetchMock = mockJSON({ embeddings: { float: [[1, 2]] }, meta: {} });
    await adapter.embed({
      input: 'x',
      parameters: { model: 'embed-v4.0' },
      metadata: { requestId: 'e', timestamp: 0, provenance: {} },
    } as never);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.cohere.ai/v2/embed');
    const models = mockJSON({ models: [{ name: 'command-r7b', endpoints: ['chat'] }] });
    adapter.invalidateModelCache();
    await adapter.listModels({ forceRefresh: true });
    expect(models.mock.calls[0]![0]).toBe('https://api.cohere.ai/v1/models');
  });

  it('streams text over SSE without tools and reports usage', async () => {
    const fetchMock = mockSSE([
      ev('message-start', { id: 'm1', delta: { message: { role: 'assistant' } } }),
      ev('content-start', {
        index: 0,
        delta: { message: { content: { type: 'text', text: '' } } },
      }),
      text('Hel'),
      text('lo'),
      ev('content-end', { index: 0 }),
      end('COMPLETE'),
    ]);
    const chunks = await collect(makeRequest({ stream: true }));
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).stream).toBe(true);
    expect(chunks.map((c) => c.type)).toEqual(['start', 'content', 'content', 'done']);
    const done = chunks.at(-1) as any;
    expect(done.finishReason).toBe('stop');
    expect(done.message).toEqual({ role: 'assistant', content: 'Hello' });
    expect(done.usage).toEqual({ promptTokens: 5, completionTokens: 7, totalTokens: 12 });
  });

  it('copes with SSE frames split across reads and CRLF', async () => {
    const whole = text('Hi') + end('COMPLETE');
    const cut = Math.floor(whole.length / 2);
    mockSSE([whole.slice(0, cut), whole.slice(cut).replace(/\n/g, '\r\n')]);
    const chunks = await collect(makeRequest({ stream: true }));
    expect((chunks.at(-1) as any).message.content).toBe('Hi');
  });

  it('maps citations and documents', async () => {
    const adapter = make();
    expect(
      adapter.fromIR(
        makeRequest({
          parameters: { model: 'm', custom: { documents: [{ id: 'd1', data: { text: 'x' } }] } },
        })
      ).documents
    ).toEqual([{ id: 'd1', data: { text: 'x' } }]);
    const citation = { start: 0, end: 2, text: 'ab', sources: [{ type: 'document', id: 'd1' }] };
    mockJSON({
      id: 'r',
      finish_reason: 'COMPLETE',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'ab' }],
        citations: [citation],
      },
    });
    const res = await adapter.execute(makeRequest());
    expect(res.metadata.custom?.citations).toEqual([citation]);
    mockSSE([
      text('ab'),
      ev('citation-start', { index: 0, delta: { message: { citations: citation } } }),
      ev('citation-end', { index: 0 }),
      end('COMPLETE'),
    ]);
    const done = (await collect(makeRequest({ stream: true }))).at(-1) as any;
    expect(done.citations).toEqual([citation]);
  });

  it.each([
    ['MAX_TOKENS', 'length'],
    ['STOP_SEQUENCE', 'stop'],
    ['TOOL_CALL', 'tool_calls'],
    ['TIMEOUT', 'error'],
  ])('maps finish_reason %s to %s', async (cohere, ir) => {
    mockJSON({
      id: 'r',
      finish_reason: cohere,
      message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
    });
    expect((await make().execute(makeRequest())).finishReason).toBe(ir);
  });
});

describe('Cohere v2 tool calling', () => {
  it('maps IR tools to function schemas and toolChoice to REQUIRED / NONE', () => {
    const adapter = make();
    const base = adapter.fromIR(makeRequest({ tools: [WEATHER_TOOL, TIME_TOOL] }));
    expect(base.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: WEATHER_TOOL.description,
          parameters: WEATHER_TOOL.parameters,
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_time',
          description: TIME_TOOL.description,
          parameters: TIME_TOOL.parameters,
        },
      },
    ]);
    expect(base.tool_choice).toBeUndefined();
    const choice = (toolChoice: IRChatRequest['toolChoice']) =>
      adapter.fromIR(makeRequest({ tools: [WEATHER_TOOL, TIME_TOOL], toolChoice })).tool_choice;
    expect(choice('auto')).toBeUndefined();
    expect(choice('required')).toBe('REQUIRED');
    expect(choice('none')).toBe('NONE');
    // v2 cannot name a tool: it forces tool use and offers only the named tool.
    const named = adapter.fromIR(
      makeRequest({ tools: [WEATHER_TOOL, TIME_TOOL], toolChoice: { name: 'get_time' } })
    );
    expect(named.tool_choice).toBe('REQUIRED');
    expect(named.tools?.map((t) => t.function.name)).toEqual(['get_time']);
  });

  it('omits tools when the request has none', () => {
    const body = make().fromIR(makeRequest());
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('blocking: tool_calls (with a tool_plan) become tool_use blocks', async () => {
    mockJSON({
      id: 'r',
      finish_reason: 'TOOL_CALL',
      message: {
        role: 'assistant',
        tool_plan: 'I will look up the weather.',
        tool_calls: [
          {
            id: 'call_a',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location":"SF"}' },
          },
          {
            id: 'call_b',
            type: 'function',
            function: { name: 'get_time', arguments: '{"tz":"PT"}' },
          },
        ],
      },
      usage: { billed_units: { input_tokens: 9, output_tokens: 4 } },
    });
    const res = await make().execute(makeRequest({ tools: [WEATHER_TOOL, TIME_TOOL] }));
    expect(res.finishReason).toBe('tool_calls');
    expect(res.message.content).toEqual([
      { type: 'tool_use', id: 'call_a', name: 'get_weather', input: { location: 'SF' } },
      { type: 'tool_use', id: 'call_b', name: 'get_time', input: { tz: 'PT' } },
    ]);
    expect(res.usage?.totalTokens).toBe(13);
  });

  it('blocking: text alongside tool calls keeps a leading text block; bad arguments become {}', async () => {
    mockJSON({
      id: 'r',
      finish_reason: 'TOOL_CALL',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Checking' }],
        tool_calls: [{ id: 'c', function: { name: 'get_weather', arguments: '{oops' } }],
      },
    });
    const res = await make().execute(makeRequest({ tools: [WEATHER_TOOL] }));
    expect(res.message.content).toEqual([
      { type: 'text', text: 'Checking' },
      { type: 'tool_use', id: 'c', name: 'get_weather', input: {} },
    ]);
  });

  it('round trip: tool_use history and tool_result blocks become tool_calls and role:tool messages', () => {
    const body = make().fromIR(
      makeRequest({
        tools: [WEATHER_TOOL],
        messages: [
          { role: 'user', content: 'Weather in SF and the time?' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'call_a', name: 'get_weather', input: { location: 'SF' } },
              { type: 'tool_use', id: 'call_b', name: 'get_time', input: {} },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolUseId: 'call_a', content: '{"temp":61}' },
              {
                type: 'tool_result',
                toolUseId: 'call_b',
                content: [{ type: 'text', text: '9am' }],
              },
            ],
          },
        ] as never,
      })
    );
    expect(body.messages).toEqual([
      { role: 'user', content: 'Weather in SF and the time?' },
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_a',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location":"SF"}' },
          },
          { id: 'call_b', type: 'function', function: { name: 'get_time', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: '{"temp":61}' },
      { role: 'tool', tool_call_id: 'call_b', content: '9am' },
    ]);
  });

  it('streams a tool call with arguments fragmented mid-JSON', async () => {
    mockSSE([
      ev('tool-plan-delta', { delta: { message: { tool_plan: 'I will ' } } }),
      callStart(0, 'call_a', 'get_weather'),
      callDelta(0, '{\n  "loc'),
      callDelta(0, 'ation": "S'),
      callDelta(0, 'F"}'),
      ev('tool-call-end', { index: 0 }),
      end('TOOL_CALL'),
    ]);
    const chunks = await collect(makeRequest({ stream: true, tools: [WEATHER_TOOL] }));
    const toolChunks = chunks.filter((c) => c.type === 'tool_use') as any[];
    expect(toolChunks.map((c) => c.inputDelta)).toEqual(['', '{\n  "loc', 'ation": "S', 'F"}']);
    for (const c of toolChunks) {
      expect(c).toMatchObject({ id: 'call_a', name: 'get_weather', index: 0 });
    }
    expect(chunks.some((c) => c.type === 'content')).toBe(false);
    const done = chunks.at(-1) as any;
    expect(done.finishReason).toBe('tool_calls');
    expect(done.message.content).toEqual([
      { type: 'tool_use', id: 'call_a', name: 'get_weather', input: { location: 'SF' } },
    ]);
    const sequences = chunks.map((c) => c.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it('streams interleaved calls keyed by index, plus leading text', async () => {
    mockSSE([
      text('Let me check. '),
      callStart(0, 'call_a', 'get_weather'),
      callStart(1, 'call_b', 'get_time'),
      callDelta(0, '{"location":'),
      callDelta(1, '{"tz":"PT"}'),
      callDelta(0, '"SF"}'),
      ev('tool-call-end', { index: 0 }),
      ev('tool-call-end', { index: 1 }),
      end('TOOL_CALL'),
    ]);
    const chunks = await collect(makeRequest({ stream: true, tools: [WEATHER_TOOL, TIME_TOOL] }));
    const calls = (chunks.filter((c) => c.type === 'tool_use') as any[]).map(
      (c) => `${c.index}:${c.id}:${c.inputDelta}`
    );
    expect(calls).toEqual([
      '0:call_a:',
      '1:call_b:',
      '0:call_a:{"location":',
      '1:call_b:{"tz":"PT"}',
      '0:call_a:"SF"}',
    ]);
    const done = chunks.at(-1) as any;
    expect(done.message.content).toEqual([
      { type: 'text', text: 'Let me check. ' },
      { type: 'tool_use', id: 'call_a', name: 'get_weather', input: { location: 'SF' } },
      { type: 'tool_use', id: 'call_b', name: 'get_time', input: { tz: 'PT' } },
    ]);
  });

  it('a stream that ends before message-end is an error chunk', async () => {
    mockSSE([text('partial')]);
    const chunks = await collect(makeRequest({ stream: true }));
    expect(chunks.at(-1)?.type).toBe('error');
  });
});

describe('Cohere v2 errors', () => {
  function stub(status: number, headers: Record<string, string>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: 'invalid api token' }), { status, headers })
      )
    );
  }
  afterEach(() => vi.unstubAllGlobals());

  it.each([401, 429, 500])('execute %i keeps status, message and request id', async (status) => {
    stub(status, { 'x-request-id': 'req_cohere' });
    const e = (await make()
      .execute(makeRequest())
      .catch((err: unknown) => err)) as AdapterError;
    expect(e).toBeInstanceOf(AdapterError);
    expect(e.details).toMatchObject({ statusCode: status, requestId: 'req_cohere' });
    expect(e.message).toContain('invalid api token');
  });

  it.each([401, 429, 500])('executeStream %i passes them in error details', async (status) => {
    stub(status, { 'x-request-id': 'req_cohere' });
    const chunks = await collect(makeRequest({ stream: true }));
    const err = chunks.find((c) => c.type === 'error') as any;
    expect(err.error.details).toMatchObject({ statusCode: status, requestId: 'req_cohere' });
    expect(err.error.message).toContain('invalid api token');
  });
});
