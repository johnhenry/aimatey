/**
 * Gemini frontend parity with the Anthropic/OpenAI frontends: model, tools
 * (functionDeclarations, functionCall/functionResponse parts, toolConfig),
 * systemInstruction, generationConfig (incl. structured output), and
 * GenerateContentResponse objects (finishReason, usageMetadata) both whole
 * and streamed.
 */

import { describe, it, expect } from 'vitest';
import {
  GeminiFrontendAdapter,
  isGeminiStreamError,
  type GeminiRequest,
  type GeminiStreamEvent,
} from '@johnhenry/aimatey-frontend';
import { GeminiBackendAdapter } from '@johnhenry/aimatey-backend';
import type { IRChatResponse, IRStreamChunk } from '@johnhenry/aimatey-types';

const adapter = new GeminiFrontendAdapter();

async function* from(chunks: IRStreamChunk[]): AsyncGenerator<IRStreamChunk, void, undefined> {
  for (const c of chunks) yield c;
}

async function collect(chunks: IRStreamChunk[]): Promise<GeminiStreamEvent[]> {
  const out: GeminiStreamEvent[] = [];
  for await (const e of adapter.fromIRStream(from(chunks))) out.push(e);
  return out;
}

const start: IRStreamChunk = {
  type: 'start',
  sequence: 0,
  metadata: {
    requestId: 'req-1',
    timestamp: 1_700_000_000_000,
    provenance: { backend: 'gemini', servedModel: 'gemini-2.5-flash' },
  },
};

describe('GeminiFrontendAdapter.toIR', () => {
  it('reads the model (with or without models/ prefix) and stream flag', async () => {
    const ir = await adapter.toIR({
      model: 'models/gemini-2.5-pro',
      contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
      stream: true,
    });
    expect(ir.parameters?.model).toBe('gemini-2.5-pro');
    expect(ir.stream).toBe(true);

    const plain = await adapter.toIR({
      model: 'gemini-2.5-flash',
      contents: [{ parts: [{ text: 'Hi' }] }],
    });
    expect(plain.parameters?.model).toBe('gemini-2.5-flash');
    expect(plain.stream).toBe(false);
    expect(plain.messages).toEqual([{ role: 'user', content: 'Hi' }]);
  });

  it('maps systemInstruction, generationConfig and structured output', async () => {
    const schema = { type: 'object', properties: { city: { type: 'string' } } };
    const ir = await adapter.toIR({
      contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
      systemInstruction: { parts: [{ text: 'Be ' }, { text: 'brief.' }] },
      generationConfig: {
        temperature: 0,
        topP: 0.9,
        topK: 40,
        maxOutputTokens: 256,
        stopSequences: ['END'],
        seed: 7,
        presencePenalty: 0.1,
        frequencyPenalty: 0.2,
        responseMimeType: 'application/json',
        responseSchema: schema,
      },
    });
    expect(ir.messages[0]).toEqual({ role: 'system', content: 'Be brief.' });
    expect(ir.parameters).toEqual({
      temperature: 0,
      topP: 0.9,
      topK: 40,
      maxTokens: 256,
      stopSequences: ['END'],
      seed: 7,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
    });
    expect(ir.responseFormat).toEqual({ type: 'json_schema', schema });
  });

  it('maps functionDeclarations and toolConfig', async () => {
    const base: GeminiRequest = {
      contents: [{ role: 'user', parts: [{ text: 'Weather?' }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: 'Weather',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
            { name: 'get_time', parametersJsonSchema: { type: 'object' } },
          ],
        },
      ],
    };
    const ir = await adapter.toIR(base);
    expect(ir.tools).toEqual([
      {
        name: 'get_weather',
        description: 'Weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
      { name: 'get_time', description: '', parameters: { type: 'object' } },
    ]);
    expect(ir.toolChoice).toBeUndefined();

    const choice = async (
      functionCallingConfig: NonNullable<GeminiRequest['toolConfig']>['functionCallingConfig']
    ) => (await adapter.toIR({ ...base, toolConfig: { functionCallingConfig } })).toolChoice;
    expect(await choice({ mode: 'AUTO' })).toBe('auto');
    expect(await choice({ mode: 'NONE' })).toBe('none');
    expect(await choice({ mode: 'ANY' })).toBe('required');
    expect(await choice({ mode: 'ANY', allowedFunctionNames: ['get_time'] })).toEqual({
      name: 'get_time',
    });
  });

  it('warns when allowedFunctionNames or candidateCount cannot be honoured', async () => {
    const ir = await adapter.toIR({
      contents: [{ role: 'user', parts: [{ text: 'Weather?' }] }],
      tools: [{ functionDeclarations: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['a', 'b'] } },
      generationConfig: { candidateCount: 3 },
    });
    expect(ir.toolChoice).toBe('required');
    expect(ir.metadata.warnings?.map((w) => [w.category, w.field])).toEqual([
      ['parameter-unsupported', 'toolConfig.functionCallingConfig.allowedFunctionNames'],
      ['parameter-unsupported', 'generationConfig.candidateCount'],
    ]);

    const plain = await adapter.toIR({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { candidateCount: 1 },
    });
    expect(plain.metadata.warnings).toBeUndefined();
  });

  it('maps functionCall and functionResponse parts, matching by id or by name', async () => {
    const ir = await adapter.toIR({
      contents: [
        { role: 'user', parts: [{ text: 'Weather in Paris and Rome?' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: { id: 'fc-1', name: 'get_weather', args: { city: 'Paris' } },
              thoughtSignature: 'sig-1',
            },
            { functionCall: { name: 'get_weather', args: { city: 'Rome' } } },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { id: 'fc-1', name: 'get_weather', response: { temp: 20 } } },
            { functionResponse: { name: 'get_weather', response: { error: 'unavailable' } } },
          ],
        },
      ],
    });

    expect(ir.messages[1]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'fc-1',
          name: 'get_weather',
          input: { city: 'Paris' },
          providerMetadata: { gemini: { thoughtSignature: 'sig-1', callId: 'fc-1' } },
        },
        { type: 'tool_use', id: 'call_0', name: 'get_weather', input: { city: 'Rome' } },
      ],
    });
    expect(ir.messages[2]).toEqual({
      role: 'tool',
      content: [
        { type: 'tool_result', toolUseId: 'fc-1', content: '{"temp":20}' },
        {
          type: 'tool_result',
          toolUseId: 'call_0',
          content: '{"error":"unavailable"}',
          isError: true,
        },
      ],
    });
  });

  it('maps inlineData and fileData parts, and accepts snake_case', async () => {
    const ir = await adapter.toIR({
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Compare' },
            { inline_data: { mime_type: 'image/png', data: 'AAAA' } },
            { file_data: { mime_type: 'application/pdf', file_uri: 'https://example.com/a.pdf' } },
          ],
        },
      ],
      system_instruction: { parts: [{ text: 'sys' }] },
      generation_config: { max_output_tokens: 10 },
    } as unknown as GeminiRequest);
    expect(ir.messages).toEqual([
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Compare' },
          { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } },
          { type: 'document', source: { type: 'url', url: 'https://example.com/a.pdf' } },
        ],
      },
    ]);
    expect(ir.parameters?.maxTokens).toBe(10);
  });

  it('round-trips a tool conversation through the Gemini backend', async () => {
    const ir = await adapter.toIR({
      model: 'gemini-2.5-flash',
      contents: [
        { role: 'user', parts: [{ text: 'Weather?' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'get_weather', args: { city: 'Paris' } },
              thoughtSignature: 'sig',
            },
          ],
        },
        {
          role: 'user',
          parts: [{ functionResponse: { name: 'get_weather', response: { temp: 20 } } }],
        },
      ],
      tools: [{ functionDeclarations: [{ name: 'get_weather', parameters: { type: 'object' } }] }],
    });
    const backendRequest = new GeminiBackendAdapter({ apiKey: 'k' }).fromIR(
      ir
    ) as unknown as GeminiRequest;
    expect(backendRequest.contents).toEqual([
      { role: 'user', parts: [{ text: 'Weather?' }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: { name: 'get_weather', args: { city: 'Paris' } },
            thoughtSignature: 'sig',
          },
        ],
      },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'get_weather', response: { temp: 20 } } }],
      },
    ]);
  });

  it('rejects a request without contents', async () => {
    await expect(adapter.toIR({} as GeminiRequest)).rejects.toThrow(/contents/);
  });
});

describe('GeminiFrontendAdapter.fromIR', () => {
  it('returns a GenerateContentResponse with function calls, finishReason and usage', async () => {
    const response: IRChatResponse = {
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.' },
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'get_weather',
            input: { city: 'Paris' },
            providerMetadata: { gemini: { thoughtSignature: 'sig' } },
          },
        ],
      },
      finishReason: 'tool_calls',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      metadata: {
        requestId: 'req-9',
        providerResponseId: 'resp-9',
        timestamp: 0,
        provenance: { backend: 'gemini', servedModel: 'gemini-2.5-flash' },
      },
    };
    const out = await adapter.fromIR(response);
    expect(out).toEqual({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'Checking.' },
              {
                functionCall: { id: 'call_1', name: 'get_weather', args: { city: 'Paris' } },
                thoughtSignature: 'sig',
              },
            ],
          },
          finishReason: 'STOP',
          index: 0,
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      modelVersion: 'gemini-2.5-flash',
      responseId: 'resp-9',
    });
  });

  it('maps finish reasons', async () => {
    const reason = async (finishReason: IRChatResponse['finishReason']) =>
      (
        await adapter.fromIR({
          message: { role: 'assistant', content: 'x' },
          finishReason,
          metadata: { requestId: 'r', timestamp: 0 },
        })
      ).candidates[0]!.finishReason;
    expect(await reason('stop')).toBe('STOP');
    expect(await reason('length')).toBe('MAX_TOKENS');
    expect(await reason('content_filter')).toBe('SAFETY');
    expect(await reason('error')).toBe('OTHER');
  });
});

describe('GeminiFrontendAdapter.fromIRStream', () => {
  it('yields GenerateContentResponse objects, ending with finishReason and usageMetadata', async () => {
    const events = await collect([
      start,
      { type: 'content', sequence: 1, delta: 'Hel' },
      { type: 'content', sequence: 2, delta: 'lo' },
      {
        type: 'done',
        sequence: 3,
        finishReason: 'stop',
        usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
      },
    ]);
    expect(events.every((e) => typeof e === 'object')).toBe(true);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      candidates: [{ content: { role: 'model', parts: [{ text: 'Hel' }] }, index: 0 }],
      responseId: 'req-1',
      modelVersion: 'gemini-2.5-flash',
    });
    expect(
      (events[0] as { candidates: Array<Record<string, unknown>> }).candidates[0]
    ).not.toHaveProperty('finishReason');
    expect(events[2]).toMatchObject({
      candidates: [
        { content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP', index: 0 },
      ],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
    });
  });

  it('sends streamed tool calls whole in the final chunk', async () => {
    const events = await collect([
      start,
      {
        type: 'tool_use',
        sequence: 1,
        id: 'c1',
        name: 'get_weather',
        inputDelta: '{"city":',
        providerMetadata: { gemini: { thoughtSignature: 's' } },
      },
      { type: 'tool_use', sequence: 2, id: 'c1', name: 'get_weather', inputDelta: '"Paris"}' },
      { type: 'tool_use', sequence: 3, id: 'c2', name: 'get_time', inputDelta: '{}' },
      { type: 'done', sequence: 4, finishReason: 'tool_calls' },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: { id: 'c1', name: 'get_weather', args: { city: 'Paris' } },
                thoughtSignature: 's',
              },
              { functionCall: { id: 'c2', name: 'get_time', args: {} } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    });
  });

  it('takes tool calls from the done message when none were streamed', async () => {
    const events = await collect([
      start,
      {
        type: 'done',
        sequence: 1,
        finishReason: 'tool_calls',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'c9', name: 'f', input: { a: 1 } }],
        },
      },
    ]);
    expect(events[0]).toMatchObject({
      candidates: [
        { content: { parts: [{ functionCall: { id: 'c9', name: 'f', args: { a: 1 } } }] } },
      ],
    });
  });

  it('uses usage from metadata chunks when done has none', async () => {
    const events = await collect([
      start,
      { type: 'metadata', sequence: 1, usage: { promptTokens: 3, completionTokens: 1 } },
      { type: 'done', sequence: 2, finishReason: 'length' },
    ]);
    expect(events.at(-1)).toMatchObject({
      candidates: [{ finishReason: 'MAX_TOKENS' }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
    });
  });

  it('ends with a Google-style error on an IR error chunk', async () => {
    const events = await collect([
      start,
      { type: 'content', sequence: 1, delta: 'a' },
      { type: 'error', sequence: 2, error: { code: 'RATE_LIMIT_EXCEEDED', message: 'slow down' } },
      { type: 'content', sequence: 3, delta: 'b' },
    ]);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      error: { code: 429, message: 'slow down', status: 'RESOURCE_EXHAUSTED' },
    });
    expect(isGeminiStreamError(events[1])).toBe(true);
    expect(isGeminiStreamError(events[0])).toBe(false);
  });

  it('ends with an INTERNAL error when the stream throws', async () => {
    async function* failing(): AsyncGenerator<IRStreamChunk, void, undefined> {
      yield start;
      throw new Error('boom');
    }
    const events: GeminiStreamEvent[] = [];
    for await (const e of adapter.fromIRStream(failing())) events.push(e);
    expect(events).toEqual([{ error: { code: 500, message: 'boom', status: 'INTERNAL' } }]);
  });
});
