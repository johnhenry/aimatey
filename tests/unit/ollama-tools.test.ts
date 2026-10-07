/**
 * Ollama tool calling (#168): `request.tools` / `toolChoice` forwarded to
 * `/api/chat`, `message.tool_calls` mapped to IR `tool_use`, `tool_result`
 * sent back as `role: 'tool'` messages, streaming tool calls, and a
 * `Bridge.runTools` round trip over a mock `fetch`. Wire payloads are
 * hand-built from Ollama's documented shapes.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { OllamaBackendAdapter } from '@johnhenry/aimatey-backend';
import type { IRChatRequest, IRStreamChunk, IRTool } from '@johnhenry/aimatey-types';

const WEATHER: IRTool = {
  name: 'get_weather',
  description: 'Get the weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
};

function makeRequest(overrides: Partial<IRChatRequest> = {}): IRChatRequest {
  return {
    messages: [{ role: 'user', content: 'Weather in Paris?' }],
    parameters: { model: 'tool-model' },
    metadata: { requestId: 'req-1', timestamp: 0, provenance: {} },
    ...overrides,
  };
}

const adapter = () => new OllamaBackendAdapter({ defaultModel: 'tool-model' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('capabilities', () => {
  it('declares tools: true', () => {
    expect(adapter().metadata.capabilities.tools).toBe(true);
  });
});

describe('fromIR: tools', () => {
  it('forwards tools as Ollama function definitions', () => {
    const wire = adapter().fromIR(makeRequest({ tools: [WEATHER] }));
    expect(wire.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the weather for a city',
          parameters: WEATHER.parameters,
        },
      },
    ]);
  });

  it('omits tools when none are given', () => {
    expect('tools' in adapter().fromIR(makeRequest())).toBe(false);
    expect('tools' in adapter().fromIR(makeRequest({ tools: [] }))).toBe(false);
  });

  it("toolChoice 'none' withholds the tools", () => {
    const wire = adapter().fromIR(makeRequest({ tools: [WEATHER], toolChoice: 'none' }));
    expect(wire.tools).toBeUndefined();
  });

  it('maps tool_use to assistant tool_calls with object arguments and tool_result to role tool', () => {
    const wire = adapter().fromIR(
      makeRequest({
        tools: [WEATHER],
        messages: [
          { role: 'user', content: 'Weather in Paris?' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Checking.' },
              { type: 'tool_use', id: 'call_0', name: 'get_weather', input: { city: 'Paris' } },
            ],
          },
          {
            role: 'tool',
            content: [
              { type: 'tool_result', toolUseId: 'call_0', content: '{"temp":18}' },
              {
                type: 'tool_result',
                toolUseId: 'unknown',
                content: [{ type: 'text', text: 'boom' }],
                isError: true,
              },
            ],
          },
        ],
      })
    );
    expect(wire.messages).toEqual([
      { role: 'user', content: 'Weather in Paris?' },
      {
        role: 'assistant',
        content: 'Checking.',
        tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Paris' } } }],
      },
      { role: 'tool', content: '{"temp":18}', tool_name: 'get_weather' },
      { role: 'tool', content: 'boom' },
    ]);
  });
});

describe('toolChoice warnings', () => {
  const wireResponse = {
    model: 'tool-model',
    created_at: '2026-01-01T00:00:00Z',
    message: { role: 'assistant' as const, content: 'hi' },
    done: true,
  };

  it.each([['required' as const], [{ name: 'get_weather' }]])(
    'warns parameter-unsupported for %j',
    (toolChoice) => {
      const req = makeRequest({ tools: [WEATHER], toolChoice });
      const res = adapter().toIR(wireResponse, req, 1);
      expect(res.metadata.warnings).toHaveLength(1);
      expect(res.metadata.warnings![0]).toMatchObject({
        category: 'parameter-unsupported',
        field: 'toolChoice',
      });
    }
  );

  it.each([['auto' as const], ['none' as const], [undefined]])(
    'no warning for %j',
    (toolChoice) => {
      const req = makeRequest({ tools: [WEATHER], toolChoice });
      expect(adapter().toIR(wireResponse, req, 1).metadata.warnings).toBeUndefined();
    }
  );
});

describe('toIR: tool_calls', () => {
  it('maps tool_calls to tool_use with finishReason tool_calls', () => {
    const res = adapter().toIR(
      {
        model: 'tool-model',
        created_at: '2026-01-01T00:00:00Z',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { function: { name: 'get_weather', arguments: { city: 'Paris' } } },
            {
              id: 'call_abc',
              function: { index: 1, name: 'get_weather', arguments: { city: 'Rome' } },
            },
            { function: { name: 'get_weather' } },
          ],
        },
        done: true,
        done_reason: 'stop',
      },
      makeRequest({ tools: [WEATHER] }),
      5
    );
    expect(res.finishReason).toBe('tool_calls');
    expect(res.message.content).toEqual([
      { type: 'tool_use', id: 'call_0', name: 'get_weather', input: { city: 'Paris' } },
      { type: 'tool_use', id: 'call_abc', name: 'get_weather', input: { city: 'Rome' } },
      { type: 'tool_use', id: 'call_2', name: 'get_weather', input: {} },
    ]);
  });

  it('keeps leading text before tool calls', () => {
    const res = adapter().toIR(
      {
        model: 'm',
        created_at: '',
        message: {
          role: 'assistant',
          content: 'Let me look.',
          tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'X' } } }],
        },
        done: true,
      },
      makeRequest(),
      1
    );
    expect((res.message.content as unknown[])[0]).toEqual({ type: 'text', text: 'Let me look.' });
  });

  it('plain replies stay string/stop', () => {
    const res = adapter().toIR(
      { model: 'm', created_at: '', message: { role: 'assistant', content: 'hi' }, done: true },
      makeRequest(),
      1
    );
    expect(res.message.content).toBe('hi');
    expect(res.finishReason).toBe('stop');
  });
});

// ----------------------------------------------------------------------------
// Streaming + round trip over a mock fetch
// ----------------------------------------------------------------------------

function ndjsonResponse(lines: unknown[]): Response {
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

describe('streaming', () => {
  it('emits tool_use chunks and a done chunk carrying the assembled tool calls', async () => {
    const call = (city: string) => ({
      model: 'm',
      created_at: '',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'get_weather', arguments: { city } } }],
      },
      done: false,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          ndjsonResponse([
            call('Paris'),
            call('Rome'),
            {
              model: 'm',
              created_at: '',
              message: { role: 'assistant', content: '' },
              done: true,
              done_reason: 'stop',
              prompt_eval_count: 10,
              eval_count: 4,
            },
          ])
        )
      )
    );
    const chunks: IRStreamChunk[] = [];
    for await (const c of adapter().executeStream(
      makeRequest({ tools: [WEATHER], stream: true })
    )) {
      chunks.push(c);
    }
    expect(chunks.filter((c) => c.type === 'tool_use')).toMatchObject([
      { id: 'call_0', name: 'get_weather', inputDelta: '{"city":"Paris"}', index: 0 },
      { id: 'call_1', name: 'get_weather', inputDelta: '{"city":"Rome"}', index: 1 },
    ]);
    const done = chunks.at(-1)!;
    expect(done).toMatchObject({ type: 'done', finishReason: 'tool_calls' });
    expect((done as unknown as { message: { content: unknown } }).message.content).toEqual([
      { type: 'tool_use', id: 'call_0', name: 'get_weather', input: { city: 'Paris' } },
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Rome' } },
    ]);
  });
});

describe('Bridge.runTools round trip', () => {
  it('sends tools, receives tool_calls, feeds the result back as a tool message, returns text', async () => {
    const bodies: any[] = [];
    const replies = [
      {
        model: 'tool-model',
        created_at: '',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Paris' } } }],
        },
        done: true,
        done_reason: 'stop',
      },
      {
        model: 'tool-model',
        created_at: '',
        message: { role: 'assistant', content: 'It is 18C in Paris.' },
        done: true,
        done_reason: 'stop',
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return Promise.resolve(
          new Response(JSON.stringify(replies[bodies.length - 1]), { status: 200 })
        );
      })
    );

    const bridge = new Bridge(new OpenAIFrontendAdapter(), adapter());
    const result = await bridge.runTools({
      prompt: 'Weather in Paris?',
      tools: {
        get_weather: {
          description: WEATHER.description,
          parameters: WEATHER.parameters,
          execute: ({ city }: { city: string }) => Promise.resolve({ city, tempC: 18 }),
        },
      },
    });

    expect(result.text).toBe('It is 18C in Paris.');
    expect(result.steps).toHaveLength(2);
    expect(bodies[0].tools[0].function.name).toBe('get_weather');
    const toolMsg = bodies[1].messages.find((m: any) => m.role === 'tool');
    expect(toolMsg).toEqual({
      role: 'tool',
      content: '{"city":"Paris","tempC":18}',
      tool_name: 'get_weather',
    });
    const assistantMsg = bodies[1].messages.find((m: any) => m.tool_calls);
    expect(assistantMsg.tool_calls[0].function.arguments).toEqual({ city: 'Paris' });
  });
});

describe('captured live exchange (fixtures/ollama-tools/round-trip.json)', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('../../fixtures/ollama-tools/round-trip.json', import.meta.url), 'utf8')
  ) as { exchanges: Array<{ request: any; response: any }> };

  it('request mapping reproduces the recorded wire request', () => {
    const [first] = fixture.exchanges;
    const wire = adapter().fromIR(
      makeRequest({
        parameters: { model: first!.request.model },
        messages: [{ role: 'user', content: first!.request.messages[0].content }],
        tools: first!.request.tools.map((t: any) => t.function),
      })
    );
    expect(wire.tools).toEqual(first!.request.tools);
    expect(wire.messages).toEqual(first!.request.messages);
  });

  it('the real tool-call response maps to tool_use keeping the server-supplied id', () => {
    const res = adapter().toIR(fixture.exchanges[0]!.response, makeRequest(), 1);
    expect(res.finishReason).toBe('tool_calls');
    expect(res.message.content).toEqual([
      {
        type: 'tool_use',
        id: fixture.exchanges[0]!.response.message.tool_calls[0].id,
        name: 'get_weather',
        input: { city: 'Paris' },
      },
    ]);
  });

  it('the real final response is plain text', () => {
    const res = adapter().toIR(fixture.exchanges[1]!.response, makeRequest(), 1);
    expect(res.finishReason).toBe('stop');
    expect(typeof res.message.content).toBe('string');
  });
});
