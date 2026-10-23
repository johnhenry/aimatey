/**
 * Native function calling for the Gemini backend adapter (#214), plus the
 * `alt=sse` streaming fix. Mocked HTTP only.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { GeminiBackendAdapter } from '@johnhenry/aimatey-backend';
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
    parameters: { model: 'gemini-test' },
    metadata: { requestId: 'req-214', timestamp: 0, provenance: {} },
    ...overrides,
  } as IRChatRequest;
}

const encoder = new TextEncoder();

function mockSSE(frames: string[]) {
  let i = 0;
  const fn = vi.fn().mockResolvedValue({
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
  global.fetch = fn as never;
  return fn;
}

function mockJSON(body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Map(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  global.fetch = fn as never;
  return fn;
}

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

async function collect(stream: AsyncIterable<IRStreamChunk>): Promise<any[]> {
  const out: any[] = [];
  for await (const c of stream) {
    out.push(c);
  }
  return out;
}

const adapter = () => new GeminiBackendAdapter({ apiKey: 'k' });
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe('Gemini capabilities', () => {
  it('advertises native tools', () => {
    expect(adapter().metadata.capabilities.tools).toBe(true);
  });
});

describe('Gemini fromIR tools', () => {
  it('maps tools to functionDeclarations', () => {
    const req = adapter().fromIR(makeRequest({ tools: [WEATHER_TOOL] }));
    expect(req.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Get current weather for a location',
            parametersJsonSchema: WEATHER_TOOL.parameters,
          },
        ],
      },
    ]);
    expect(req.toolConfig).toBeUndefined();
  });

  it.each([
    ['auto', { mode: 'AUTO' }],
    ['none', { mode: 'NONE' }],
    ['required', { mode: 'ANY' }],
    [{ name: 'get_weather' }, { mode: 'ANY', allowedFunctionNames: ['get_weather'] }],
  ] as const)('maps toolChoice %j', (choice, expected) => {
    const req = adapter().fromIR(makeRequest({ tools: [WEATHER_TOOL], toolChoice: choice as any }));
    expect(req.toolConfig).toEqual({ functionCallingConfig: expected });
  });

  it('omits tools when none are given', () => {
    const req = adapter().fromIR(makeRequest());
    expect(req.tools).toBeUndefined();
    expect(req.toolConfig).toBeUndefined();
  });

  it('serialises tool_use + tool_result history, resolving the name from the id', () => {
    const req = adapter().fromIR(
      makeRequest({
        tools: [WEATHER_TOOL],
        messages: [
          { role: 'user', content: 'Weather in SF?' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Checking.' },
              {
                type: 'tool_use',
                id: 'call_0',
                name: 'get_weather',
                input: { location: 'SF' },
                providerMetadata: { gemini: { thoughtSignature: 'SIG-A' } },
              },
              { type: 'tool_use', id: 'call_1', name: 'get_time', input: { tz: 'PST' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolUseId: 'call_0', content: '{"temp":61}' },
              { type: 'tool_result', toolUseId: 'call_1', content: 'noon', isError: false },
            ],
          },
        ],
      })
    );
    expect(req.contents).toEqual([
      { role: 'user', parts: [{ text: 'Weather in SF?' }] },
      {
        role: 'model',
        parts: [
          { text: 'Checking.' },
          {
            functionCall: { name: 'get_weather', args: { location: 'SF' } },
            thoughtSignature: 'SIG-A',
          },
          { functionCall: { name: 'get_time', args: { tz: 'PST' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'get_weather', response: { temp: 61 } } },
          { functionResponse: { name: 'get_time', response: { output: 'noon' } } },
        ],
      },
    ]);
  });

  it('merges parallel results sent as separate messages into one user turn', () => {
    const req = adapter().fromIR(
      makeRequest({
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'a', name: 'f', input: {} },
              { type: 'tool_use', id: 'b', name: 'g', input: {} },
            ],
          },
          { role: 'user', content: [{ type: 'tool_result', toolUseId: 'a', content: 'x' }] },
          { role: 'user', content: [{ type: 'tool_result', toolUseId: 'b', content: 'y' }] },
        ],
      })
    );
    expect(req.contents).toHaveLength(3);
    expect(req.contents[2]!.parts).toHaveLength(2);
  });

  it('reports errors under an error key and rejects unknown ids', () => {
    const history = (toolUseId: string) =>
      makeRequest({
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'f', input: {} }] },
          {
            role: 'user',
            content: [{ type: 'tool_result', toolUseId, content: 'boom', isError: true }],
          },
        ],
      });
    expect(adapter().fromIR(history('a')).contents[1]!.parts).toEqual([
      { functionResponse: { name: 'f', response: { error: 'boom' } } },
    ]);
    expect(() => adapter().fromIR(history('zzz'))).toThrow(/unknown tool_use id/);
  });

  it('echoes a native Gemini call id', () => {
    const req = adapter().fromIR(
      makeRequest({
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'native-1',
                name: 'f',
                input: {},
                providerMetadata: { gemini: { callId: 'native-1' } },
              },
            ],
          },
        ],
      })
    );
    expect(req.contents[0]!.parts[0]).toEqual({
      functionCall: { id: 'native-1', name: 'f', args: {} },
    });
  });
});

describe('Gemini blocking function calls', () => {
  it('turns parallel functionCall parts into tool_use blocks with thoughtSignature', async () => {
    mockJSON({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'On it.' },
              {
                functionCall: { name: 'get_weather', args: { location: 'SF' } },
                thoughtSignature: 'SIG-1',
              },
              { functionCall: { name: 'get_time', args: { tz: 'PST' } } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    });
    const res = await adapter().execute(makeRequest({ tools: [WEATHER_TOOL, TIME_TOOL] }));
    expect(res.finishReason).toBe('tool_calls');
    expect(res.message.content).toEqual([
      { type: 'text', text: 'On it.' },
      {
        type: 'tool_use',
        id: 'call_0',
        name: 'get_weather',
        input: { location: 'SF' },
        providerMetadata: { gemini: { thoughtSignature: 'SIG-1' } },
      },
      { type: 'tool_use', id: 'call_1', name: 'get_time', input: { tz: 'PST' } },
    ]);
    expect(res.metadata.warnings).toBeUndefined();
  });

  it('round-trips the thoughtSignature on the next request', async () => {
    mockJSON({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: { name: 'get_weather', args: { location: 'SF' } },
                thoughtSignature: 'SIG-RT',
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    });
    const first = await adapter().execute(makeRequest({ tools: [WEATHER_TOOL] }));
    const block = (first.message.content as any[])[0];

    const fetchMock = mockJSON({
      candidates: [
        { content: { role: 'model', parts: [{ text: 'Sunny' }] }, finishReason: 'STOP' },
      ],
    });
    const second = await adapter().execute(
      makeRequest({
        tools: [WEATHER_TOOL],
        messages: [
          { role: 'user', content: 'Weather in SF?' },
          { role: 'assistant', content: [block] },
          {
            role: 'user',
            content: [{ type: 'tool_result', toolUseId: block.id, content: '{"t":60}' }],
          },
        ],
      })
    );
    expect(second.message.content).toBe('Sunny');
    expect(second.finishReason).toBe('stop');
    const sent = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(sent.contents[1]).toEqual({
      role: 'model',
      parts: [
        {
          functionCall: { name: 'get_weather', args: { location: 'SF' } },
          thoughtSignature: 'SIG-RT',
        },
      ],
    });
    expect(sent.contents[2]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'get_weather', response: { t: 60 } } }],
    });
  });

  it('keeps plain text responses unchanged', async () => {
    mockJSON({
      candidates: [
        { content: { role: 'model', parts: [{ text: 'Hello' }] }, finishReason: 'STOP' },
      ],
    });
    const res = await adapter().execute(makeRequest());
    expect(res.message).toEqual({ role: 'assistant', content: 'Hello' });
    expect(res.finishReason).toBe('stop');
  });
});

describe('Gemini streaming', () => {
  it('requests alt=sse (regression: without it Gemini returns a JSON array, not SSE)', async () => {
    const fetchMock = mockSSE([
      frame({ candidates: [{ content: { parts: [{ text: 'Hi' }] }, finishReason: 'STOP' }] }),
    ]);
    await collect(adapter().executeStream(makeRequest()));
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain(':streamGenerateContent?');
    expect(new URL(url).searchParams.get('alt')).toBe('sse');
    expect(new URL(url).searchParams.get('key')).toBe('k');
  });

  it('streams plain text unchanged', async () => {
    mockSSE([
      frame({ candidates: [{ content: { parts: [{ text: 'He' }] } }] }),
      frame({ candidates: [{ content: { parts: [{ text: 'llo' }] }, finishReason: 'STOP' }] }),
    ]);
    const chunks = await collect(adapter().executeStream(makeRequest()));
    expect(chunks.filter((c) => c.type === 'content').map((c) => c.delta)).toEqual(['He', 'llo']);
    const done = chunks.at(-1);
    expect(done.type).toBe('done');
    expect(done.finishReason).toBe('stop');
    expect(done.message).toEqual({ role: 'assistant', content: 'Hello' });
  });

  it('assembles whole functionCall parts into tool_use chunks and blocks', async () => {
    mockSSE([
      frame({ candidates: [{ content: { parts: [{ text: 'Checking. ' }] } }] }),
      frame({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: 'get_weather', args: { location: 'SF' } },
                  thoughtSignature: 'SIG-S',
                },
                { functionCall: { name: 'get_time', args: { tz: 'PST' } } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
      }),
    ]);
    const chunks = await collect(
      adapter().executeStream(makeRequest({ tools: [WEATHER_TOOL, TIME_TOOL] }))
    );
    expect(chunks.map((c) => c.sequence)).toEqual(chunks.map((_, i) => i));
    const tools = chunks.filter((c) => c.type === 'tool_use');
    expect(tools).toEqual([
      expect.objectContaining({
        id: 'call_0',
        name: 'get_weather',
        inputDelta: '{"location":"SF"}',
        index: 0,
        providerMetadata: { gemini: { thoughtSignature: 'SIG-S' } },
      }),
      expect.objectContaining({
        id: 'call_1',
        name: 'get_time',
        inputDelta: '{"tz":"PST"}',
        index: 1,
      }),
    ]);
    const done = chunks.at(-1);
    expect(done.type).toBe('done');
    expect(done.finishReason).toBe('tool_calls');
    expect(done.usage.totalTokens).toBe(3);
    expect(done.message.content).toEqual([
      { type: 'text', text: 'Checking. ' },
      {
        type: 'tool_use',
        id: 'call_0',
        name: 'get_weather',
        input: { location: 'SF' },
        providerMetadata: { gemini: { thoughtSignature: 'SIG-S' } },
      },
      { type: 'tool_use', id: 'call_1', name: 'get_time', input: { tz: 'PST' } },
    ]);
  });

  it('handles a call arriving in a later chunk than the text, across frames split mid-line', async () => {
    const f = frame({
      candidates: [
        {
          content: { parts: [{ functionCall: { name: 'get_weather', args: {} } }] },
          finishReason: 'STOP',
        },
      ],
    });
    mockSSE([f.slice(0, 20), f.slice(20)]);
    const chunks = await collect(adapter().executeStream(makeRequest({ tools: [WEATHER_TOOL] })));
    expect(chunks.filter((c) => c.type === 'tool_use')).toHaveLength(1);
    expect(chunks.at(-1).finishReason).toBe('tool_calls');
  });
});
