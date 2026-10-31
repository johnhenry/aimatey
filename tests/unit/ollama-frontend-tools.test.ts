/**
 * Ollama frontend: tools (`tools`, `message.tool_calls`, `role: 'tool'`
 * results), images, `format`, `options`, and `/api/chat` response objects
 * whole and streamed.
 */

import { describe, it, expect } from 'vitest';
import {
  OllamaFrontendAdapter,
  isOllamaStreamError,
  type OllamaStreamEvent,
} from '@johnhenry/aimatey-frontend';
import { OllamaBackendAdapter } from '@johnhenry/aimatey-backend';
import type { IRChatResponse, IRStreamChunk } from '@johnhenry/aimatey-types';

const adapter = new OllamaFrontendAdapter();

async function* from(chunks: IRStreamChunk[]): AsyncGenerator<IRStreamChunk, void, undefined> {
  for (const c of chunks) yield c;
}

async function collect(chunks: IRStreamChunk[]): Promise<OllamaStreamEvent[]> {
  const out: OllamaStreamEvent[] = [];
  for await (const e of adapter.fromIRStream(from(chunks))) out.push(e);
  return out;
}

const start: IRStreamChunk = {
  type: 'start',
  sequence: 0,
  metadata: {
    requestId: 'req-1',
    timestamp: 0,
    provenance: { backend: 'ollama', servedModel: 'llama3.1:8b' },
  },
};

const weatherTool = {
  type: 'function' as const,
  function: {
    name: 'get_weather',
    description: 'Weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
};

describe('OllamaFrontendAdapter.toIR', () => {
  it('maps tools, tool_calls and tool results', async () => {
    const ir = await adapter.toIR({
      model: 'llama3.1:8b',
      messages: [
        { role: 'user', content: 'Weather in Paris and Rome?' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { function: { name: 'get_weather', arguments: { city: 'Paris' } } },
            { id: 'call_x', function: { name: 'get_weather', arguments: { city: 'Rome' } } },
          ],
        },
        { role: 'tool', tool_name: 'get_weather', content: '20C' },
        { role: 'tool', tool_name: 'get_weather', tool_call_id: 'call_x', content: '25C' },
      ],
      tools: [weatherTool],
    });

    expect(ir.parameters?.model).toBe('llama3.1:8b');
    expect(ir.tools).toEqual([
      {
        name: 'get_weather',
        description: 'Weather for a city',
        parameters: weatherTool.function.parameters,
      },
    ]);
    expect(ir.messages).toEqual([
      { role: 'user', content: 'Weather in Paris and Rome?' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_0', name: 'get_weather', input: { city: 'Paris' } },
          { type: 'tool_use', id: 'call_x', name: 'get_weather', input: { city: 'Rome' } },
        ],
      },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'call_0', content: '20C' }] },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'call_x', content: '25C' }] },
    ]);
  });

  it('maps images, format and options', async () => {
    const schema = { type: 'object', properties: { a: { type: 'number' } } };
    const ir = await adapter.toIR({
      model: 'llava',
      messages: [{ role: 'user', content: 'What is this?', images: ['/9j/AAAA', 'iVBORw0K'] }],
      format: schema,
      options: {
        temperature: 0,
        top_p: 0.9,
        top_k: 40,
        num_predict: 100,
        stop: 'END',
        seed: 1,
        frequency_penalty: 0.1,
        presence_penalty: 0.2,
        repeat_penalty: 1.1,
      },
    });
    expect(ir.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image', source: { type: 'base64', mediaType: 'image/jpeg', data: '/9j/AAAA' } },
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'iVBORw0K' } },
      ],
    });
    expect(ir.responseFormat).toEqual({ type: 'json_schema', schema });
    expect(ir.parameters).toEqual({
      model: 'llava',
      temperature: 0,
      topP: 0.9,
      topK: 40,
      maxTokens: 100,
      stopSequences: ['END'],
      seed: 1,
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
      custom: { repeatPenalty: 1.1 },
    });

    const json = await adapter.toIR({ model: 'm', messages: [], format: 'json' });
    expect(json.responseFormat).toEqual({ type: 'json_schema', schema: { type: 'object' } });
  });

  it('round-trips a tool conversation through the Ollama backend', async () => {
    const ir = await adapter.toIR({
      model: 'llama3.1:8b',
      messages: [
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Paris' } } }],
        },
        { role: 'tool', tool_name: 'get_weather', content: '20C' },
      ],
      tools: [weatherTool],
    });
    const wire = new OllamaBackendAdapter({}).fromIR(ir) as unknown as {
      messages: unknown[];
      tools: unknown[];
    };
    expect(wire.messages).toEqual([
      { role: 'user', content: 'Weather?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Paris' } } }],
      },
      { role: 'tool', content: '20C', tool_name: 'get_weather' },
    ]);
    expect(wire.tools).toEqual([weatherTool]);
  });

  it('rejects a request without messages', async () => {
    await expect(adapter.toIR({ model: 'm' } as never)).rejects.toThrow(/messages/);
  });
});

describe('OllamaFrontendAdapter.fromIR', () => {
  it('returns tool_calls with object arguments, done_reason and counts', async () => {
    const response: IRChatResponse = {
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
        ],
      },
      finishReason: 'tool_calls',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      metadata: { requestId: 'r', timestamp: 0, provenance: { servedModel: 'llama3.1:8b' } },
    };
    const out = await adapter.fromIR(response);
    expect(out).toEqual({
      model: 'llama3.1:8b',
      created_at: expect.any(String),
      message: {
        role: 'assistant',
        content: 'Checking.',
        tool_calls: [
          {
            id: 'call_1',
            function: { index: 0, name: 'get_weather', arguments: { city: 'Paris' } },
          },
        ],
      },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 10,
      eval_count: 5,
    });
  });

  it("reports done_reason 'length' when the token limit was hit", async () => {
    const out = await adapter.fromIR({
      message: { role: 'assistant', content: 'trunc' },
      finishReason: 'length',
      metadata: { requestId: 'r', timestamp: 0 },
    });
    expect(out.done_reason).toBe('length');
    expect(out.message).toEqual({ role: 'assistant', content: 'trunc' });
  });
});

describe('OllamaFrontendAdapter.fromIRStream', () => {
  it('yields response objects: text deltas, then the final done one', async () => {
    const events = await collect([
      start,
      { type: 'content', sequence: 1, delta: 'Hi' },
      {
        type: 'done',
        sequence: 2,
        finishReason: 'stop',
        usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
      },
    ]);
    expect(events).toEqual([
      {
        model: 'llama3.1:8b',
        created_at: expect.any(String),
        message: { role: 'assistant', content: 'Hi' },
        done: false,
      },
      {
        model: 'llama3.1:8b',
        created_at: expect.any(String),
        message: { role: 'assistant', content: '' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 3,
        eval_count: 1,
      },
    ]);
  });

  it('sends streamed tool calls whole before the final response', async () => {
    const events = await collect([
      start,
      { type: 'tool_use', sequence: 1, id: 'c1', name: 'get_weather', inputDelta: '{"city":' },
      { type: 'tool_use', sequence: 2, id: 'c1', name: 'get_weather', inputDelta: '"Paris"}' },
      { type: 'done', sequence: 3, finishReason: 'tool_calls' },
    ]);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', function: { index: 0, name: 'get_weather', arguments: { city: 'Paris' } } },
        ],
      },
      done: false,
    });
    expect(events[1]).toMatchObject({ done: true, done_reason: 'stop' });
  });

  it('ends with { error } on an IR error chunk', async () => {
    const events = await collect([
      start,
      { type: 'error', sequence: 1, error: { code: 'PROVIDER_ERROR', message: 'model not found' } },
      { type: 'content', sequence: 2, delta: 'x' },
    ]);
    expect(events).toEqual([{ error: 'model not found' }]);
    expect(isOllamaStreamError(events[0])).toBe(true);
  });
});
