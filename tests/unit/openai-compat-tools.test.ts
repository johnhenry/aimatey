/**
 * Native tool calling for OpenAI-compatible backend adapters (#207).
 *
 * Every adapter below serves OpenAI-style chat completions with `tools` / `tool_calls`.
 * The mapping lives in shared helpers; these tests pin the behavior per adapter with mocked HTTP.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  TogetherAIBackendAdapter,
  FireworksAIBackendAdapter,
  MistralBackendAdapter,
  XAIBackendAdapter,
  CerebrasBackendAdapter,
  DashScopeBackendAdapter,
  DeepInfraBackendAdapter,
  InceptionBackendAdapter,
  AnyscaleBackendAdapter,
  GitHubModelsBackendAdapter,
  HuggingFaceBackendAdapter,
  AI21BackendAdapter,
} from '@johnhenry/aimatey-backend';
import type { IRChatRequest, IRStreamChunk, IRTool } from '@johnhenry/aimatey-types';

const WEATHER_TOOL: IRTool = {
  name: 'get_weather',
  description: 'Get current weather for a location',
  parameters: {
    type: 'object',
    properties: { location: { type: 'string', description: 'City name' } },
    required: ['location'],
  },
};

const ADAPTERS: Array<[string, () => any]> = [
  ['Together AI', () => new TogetherAIBackendAdapter({ apiKey: 'k' })],
  ['Fireworks', () => new FireworksAIBackendAdapter({ apiKey: 'k' })],
  ['Mistral', () => new MistralBackendAdapter({ apiKey: 'k' })],
  ['xAI', () => new XAIBackendAdapter({ apiKey: 'k' })],
  ['Cerebras', () => new CerebrasBackendAdapter({ apiKey: 'k' })],
  ['DashScope', () => new DashScopeBackendAdapter({ apiKey: 'k' })],
  ['DeepInfra', () => new DeepInfraBackendAdapter({ apiKey: 'k' })],
  ['Inception', () => new InceptionBackendAdapter({ apiKey: 'k' })],
  ['AI21', () => new AI21BackendAdapter({ apiKey: 'k' })],
];

function makeRequest(overrides: Partial<IRChatRequest> = {}): IRChatRequest {
  return {
    messages: [{ role: 'user', content: 'Weather in SF?' }],
    parameters: { model: 'test-model' },
    metadata: { requestId: 'req-207', timestamp: 0, provenance: {} },
    ...overrides,
  } as IRChatRequest;
}

const encoder = new TextEncoder();

function mockSSE(frames: string[]) {
  let i = 0;
  global.fetch = vi.fn().mockResolvedValue({
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
  }) as never;
}

function mockJSON(body: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Map(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as never;
}

const frame = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

async function collect(adapter: any, req: IRChatRequest) {
  const chunks: IRStreamChunk[] = [];
  for await (const c of adapter.executeStream(req)) chunks.push(c);
  return chunks;
}

afterEach(() => vi.restoreAllMocks());

describe.each(ADAPTERS)('%s native tool calling', (_name, make) => {
  it('advertises tool support', () => {
    expect(make().metadata.capabilities.tools).toBe(true);
  });

  it('maps IR tools and toolChoice to OpenAI function schemas', () => {
    const adapter = make();
    const req = adapter.fromIR(makeRequest({ tools: [WEATHER_TOOL], toolChoice: 'auto' }));
    expect(req.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: WEATHER_TOOL.description,
          parameters: WEATHER_TOOL.parameters,
        },
      },
    ]);
    if (adapter.metadata.name === 'ai21-backend') {
      // AI21 documents `tools` only, so tool_choice is deliberately not sent.
      expect(req.tool_choice).toBeUndefined();
      return;
    }
    expect(req.tool_choice).toBe('auto');
    const named = adapter.fromIR(
      makeRequest({ tools: [WEATHER_TOOL], toolChoice: { name: 'get_weather' } })
    );
    expect(named.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
  });

  it('omits tools and tool_choice when the request has none', () => {
    const req = make().fromIR(makeRequest());
    expect(req.tools).toBeUndefined();
    expect(req.tool_choice).toBeUndefined();
  });

  it('replays a tool round trip as assistant tool_calls plus role:tool messages', () => {
    const req = make().fromIR(
      makeRequest({
        tools: [WEATHER_TOOL],
        messages: [
          { role: 'user', content: 'Weather in SF and NYC?' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { location: 'SF' } },
              { type: 'tool_use', id: 'call_2', name: 'get_weather', input: { location: 'NYC' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolUseId: 'call_1', content: '65F' },
              { type: 'tool_result', toolUseId: 'call_2', content: '50F' },
            ],
          },
        ],
      })
    );
    const assistant = req.messages.find((m: any) => m.role === 'assistant');
    expect(assistant.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"location":"SF"}' },
      },
      {
        id: 'call_2',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"location":"NYC"}' },
      },
    ]);
    expect(assistant.content === '' || assistant.content === null).toBe(true);
    const toolMsgs = req.messages.filter((m: any) => m.role === 'tool');
    expect(toolMsgs).toMatchObject([
      { tool_call_id: 'call_1', content: '65F' },
      { tool_call_id: 'call_2', content: '50F' },
    ]);
  });

  it('turns blocking tool_calls into tool_use blocks (end to end through execute)', async () => {
    mockJSON({
      id: 'c1',
      object: 'chat.completion',
      created: 0,
      model: 'test-model',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"location":"SF"}' },
              },
              {
                id: 'call_2',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"location":"NYC"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    const res = await make().execute(makeRequest({ tools: [WEATHER_TOOL] }));
    expect(res.finishReason).toBe('tool_calls');
    expect(res.message.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { location: 'SF' } },
      { type: 'tool_use', id: 'call_2', name: 'get_weather', input: { location: 'NYC' } },
    ]);
    expect(res.metadata.warnings ?? []).toEqual([]);
  });

  it('keeps plain text responses as string content', async () => {
    mockJSON({
      id: 'c1',
      object: 'chat.completion',
      created: 0,
      model: 'test-model',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const res = await make().execute(makeRequest());
    expect(res.message.content).toBe('hi');
  });

  it('assembles streamed arguments split across chunks', async () => {
    mockSSE([
      frame({ role: 'assistant', content: '' }),
      frame({
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '' },
          },
        ],
      }),
      frame({ tool_calls: [{ index: 0, function: { arguments: '{"loca' } }] }),
      frame({ tool_calls: [{ index: 0, function: { arguments: 'tion":"SF"}' } }] }),
      frame({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ]);
    const chunks = await collect(make(), makeRequest({ tools: [WEATHER_TOOL] }));
    const done = chunks.filter((c) => c.type === 'done');
    expect(done).toHaveLength(1);
    const d = done[0] as any;
    expect(d.finishReason).toBe('tool_calls');
    expect(d.message.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { location: 'SF' } },
    ]);
    expect(chunks.filter((c) => c.type === 'tool_use').length).toBe(3);
  });

  it('keeps two interleaved calls separate and ordered by index', async () => {
    mockSSE([
      frame({
        tool_calls: [
          {
            index: 0,
            id: 'a',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location":' },
          },
          {
            index: 1,
            id: 'b',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location":' },
          },
        ],
      }),
      frame({
        tool_calls: [
          { index: 1, function: { arguments: '"NYC"}' } },
          { index: 0, function: { arguments: '"SF"}' } },
        ],
      }),
      frame({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ]);
    const chunks = await collect(make(), makeRequest({ tools: [WEATHER_TOOL] }));
    const d = chunks.find((c) => c.type === 'done') as any;
    expect(d.message.content.map((b: any) => [b.id, b.input.location])).toEqual([
      ['a', 'SF'],
      ['b', 'NYC'],
    ]);
  });

  it('keeps text before a tool call and handles a whole call in one chunk', async () => {
    mockSSE([
      frame({ content: 'Checking. ' }),
      frame(
        {
          tool_calls: [
            {
              index: 0,
              id: 'x',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"location":"SF"}' },
            },
          ],
        },
        'tool_calls'
      ),
      'data: [DONE]\n\n',
    ]);
    const chunks = await collect(make(), makeRequest({ tools: [WEATHER_TOOL] }));
    const d = chunks.find((c) => c.type === 'done') as any;
    expect(d.message.content).toEqual([
      { type: 'text', text: 'Checking. ' },
      { type: 'tool_use', id: 'x', name: 'get_weather', input: { location: 'SF' } },
    ]);
  });

  it('plain text streams still finish with a string message', async () => {
    mockSSE([
      frame({ content: 'Hel' }),
      frame({ content: 'lo' }),
      frame({}, 'stop'),
      'data: [DONE]\n\n',
    ]);
    const chunks = await collect(make(), makeRequest());
    const d = chunks.find((c) => c.type === 'done') as any;
    expect(d.message.content).toBe('Hello');
    expect(d.finishReason).toBe('stop');
  });
});

describe('adapters whose provider cannot take tools stay false', () => {
  it.each([
    ['Anyscale', () => new AnyscaleBackendAdapter({ apiKey: 'k' })],
    ['GitHub Models', () => new GitHubModelsBackendAdapter({ apiKey: 'k' })],
    ['Hugging Face', () => new HuggingFaceBackendAdapter({ apiKey: 'k' })],
  ])('%s', (_name, make) => {
    expect(make().metadata.capabilities.tools).toBe(false);
  });
});
