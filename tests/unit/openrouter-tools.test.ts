/**
 * OpenRouter tool calling (clawser#423)
 *
 * The OpenRouter adapter declared `tools: false` and never mapped request.tools, tool_use /
 * tool_result messages, tool_calls in the reply, or streamed tool_calls deltas, although OpenRouter's
 * chat completions API is OpenAI-compatible and takes all of them. A caller with tools got a model
 * that was never shown any, and (streamed) a `done` with no tool call.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenRouterBackendAdapter } from '@johnhenry/aimatey-backend';
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

function makeRequest(overrides: Partial<IRChatRequest> = {}): IRChatRequest {
  return {
    messages: [{ role: 'user', content: 'Weather in SF?' }],
    parameters: { model: 'meta-llama/llama-3.3-70b-instruct' },
    metadata: { requestId: 'req-423', timestamp: 0, provenance: {} },
    ...overrides,
  } as IRChatRequest;
}

describe('OpenRouter request mapping', () => {
  const adapter = new OpenRouterBackendAdapter({ apiKey: 'k' });

  it('advertises tool support', () => {
    expect(adapter.metadata.capabilities.tools).toBe(true);
  });

  it('maps IR tools and toolChoice to OpenAI function schemas', () => {
    const req = adapter.fromIR(makeRequest({ tools: [WEATHER_TOOL], toolChoice: 'auto' })) as any;
    expect(req.tools).toEqual([
      { type: 'function', function: { name: 'get_weather', description: WEATHER_TOOL.description, parameters: WEATHER_TOOL.parameters } },
    ]);
    expect(req.tool_choice).toBe('auto');
    const named = adapter.fromIR(makeRequest({ tools: [WEATHER_TOOL], toolChoice: { name: 'get_weather' } })) as any;
    expect(named.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
  });

  it('omits tools and tool_choice when the request has none', () => {
    const req = adapter.fromIR(makeRequest()) as any;
    expect(req.tools).toBeUndefined();
    expect(req.tool_choice).toBeUndefined();
  });

  it('replays a tool round trip: assistant tool_use becomes tool_calls, tool_result a role:tool message', () => {
    const req = adapter.fromIR(
      makeRequest({
        tools: [WEATHER_TOOL],
        messages: [
          { role: 'user', content: 'Weather in SF?' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { location: 'SF' } }] },
          { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_1', content: '65F' }] },
        ],
      })
    ) as any;
    const assistant = req.messages.find((m: any) => m.role === 'assistant');
    expect(assistant.tool_calls).toEqual([{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"location":"SF"}' } }]);
    expect(req.messages.find((m: any) => m.role === 'tool')).toMatchObject({ tool_call_id: 'call_1', content: '65F' });
  });
});

describe('OpenRouter response mapping', () => {
  it('turns tool_calls into tool_use blocks with parsed input and finishReason tool_calls', () => {
    const adapter = new OpenRouterBackendAdapter({ apiKey: 'k' });
    const res = adapter.toIR(
      {
        id: 'gen-1', object: 'chat.completion', created: 0, model: 'meta-llama/llama-3.3-70b-instruct',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"location":"SF"}' } }] } }],
      } as any,
      makeRequest({ tools: [WEATHER_TOOL] }),
      5
    );
    expect(res.finishReason).toBe('tool_calls');
    expect(res.message.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { location: 'SF' } }]);
    expect(res.metadata.warnings ?? []).toEqual([]);
  });
});

describe('OpenRouter streamed tool calls', () => {
  const encoder = new TextEncoder();
  afterEach(() => vi.restoreAllMocks());

  const frame = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: 'gen-1', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

  async function run(frames: string[]) {
    let i = 0;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', headers: new Map(),
      body: { getReader: () => ({ read: async () => (i < frames.length ? { done: false, value: encoder.encode(frames[i++]!) } : { done: true, value: undefined }), releaseLock() {}, cancel: async () => {} }) },
    }) as never;
    const adapter = new OpenRouterBackendAdapter({ apiKey: 'k' });
    const chunks: IRStreamChunk[] = [];
    for await (const c of adapter.executeStream(makeRequest({ tools: [WEATHER_TOOL] }))) chunks.push(c);
    return chunks;
  }

  it('assembles fragmented arguments, ignores keep-alive comments and the trailing usage chunk', async () => {
    const chunks = await run([
      ': OPENROUTER PROCESSING\n\n',
      frame({ role: 'assistant', content: '' }),
      frame({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }),
      frame({ tool_calls: [{ index: 0, function: { arguments: '{"loca' } }] }),
      frame({ tool_calls: [{ index: 0, function: { arguments: 'tion":"SF"}' } }] }),
      frame({}, 'tool_calls'),
      `data: ${JSON.stringify({ id: 'gen-1', model: 'm', choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`,
      'data: [DONE]\n\n',
    ]);
    const done = chunks.filter((c) => c.type === 'done');
    expect(done).toHaveLength(1);
    const d = done[0] as any;
    expect(d.finishReason).toBe('tool_calls');
    expect(d.message.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { location: 'SF' } }]);
    expect(d.usage).toMatchObject({ promptTokens: 3, completionTokens: 2 });
    expect(chunks.filter((c) => c.type === 'tool_use').length).toBeGreaterThan(0);
  });

  it('keeps two interleaved calls separate', async () => {
    const chunks = await run([
      frame({ tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'get_weather', arguments: '{"location":' } }, { index: 1, id: 'b', type: 'function', function: { name: 'get_weather', arguments: '{"location":' } }] }),
      frame({ tool_calls: [{ index: 1, function: { arguments: '"NYC"}' } }, { index: 0, function: { arguments: '"SF"}' } }] }),
      frame({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ]);
    const d = chunks.find((c) => c.type === 'done') as any;
    expect(d.message.content.map((b: any) => [b.id, b.input.location])).toEqual([['a', 'SF'], ['b', 'NYC']]);
  });

  it('plain text streams still work', async () => {
    const chunks = await run([frame({ content: 'Hel' }), frame({ content: 'lo' }), frame({}, 'stop'), 'data: [DONE]\n\n']);
    const d = chunks.find((c) => c.type === 'done') as any;
    expect(d.message.content).toBe('Hello');
    expect(d.finishReason).toBe('stop');
  });
});
