/**
 * Adapters that don't implement tool/function-calling mapping now advertise
 * `capabilities.tools: false` (rather than silently dropping tools) and
 * surface a `tool-unsupported` IRWarning when `request.tools` is set (#17).
 */

import { describe, it, expect } from 'vitest';
import {
  MistralBackendAdapter,
  GeminiBackendAdapter,
  AzureOpenAIBackendAdapter,
  CerebrasBackendAdapter,
  CloudflareBackendAdapter,
  DeepInfraBackendAdapter,
  FireworksAIBackendAdapter,
  TogetherAIBackendAdapter,
  XAIBackendAdapter,
} from '@johnhenry/aimatey-backend';

const ADAPTERS: Array<[string, () => { metadata: { capabilities: { tools?: boolean } } }]> = [
  ['Mistral', () => new MistralBackendAdapter({ apiKey: 'test-key' })],
  ['Gemini', () => new GeminiBackendAdapter({ apiKey: 'test-key' })],
  [
    'Azure OpenAI',
    () => new AzureOpenAIBackendAdapter({ apiKey: 'test-key', baseURL: 'https://example.test' }),
  ],
  ['Cerebras', () => new CerebrasBackendAdapter({ apiKey: 'test-key' })],
  [
    'Cloudflare',
    () => new CloudflareBackendAdapter({ apiKey: 'test-key', baseURL: 'https://example.test' }),
  ],
  ['DeepInfra', () => new DeepInfraBackendAdapter({ apiKey: 'test-key' })],
  ['Fireworks', () => new FireworksAIBackendAdapter({ apiKey: 'test-key' })],
  ['Together AI', () => new TogetherAIBackendAdapter({ apiKey: 'test-key' })],
  ['xAI', () => new XAIBackendAdapter({ apiKey: 'test-key' })],
];

describe('Adapters with no tool-calling implementation advertise tools: false', () => {
  it.each(ADAPTERS)('%s', (_name, make) => {
    expect(make().metadata.capabilities.tools).toBe(false);
  });
});

const WEATHER_TOOL = {
  name: 'get_weather',
  description: 'Get current weather for a location',
  parameters: { type: 'object' as const, properties: { location: { type: 'string' as const } } },
};

describe('Mistral backend tool-unsupported warning', () => {
  const adapter = new MistralBackendAdapter({ apiKey: 'test-key' });

  it('adds a tool-unsupported warning when tools were requested', () => {
    const response = adapter.toIR(
      {
        id: 'resp_1',
        object: 'chat.completion',
        created: 0,
        model: 'test-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      {
        messages: [{ role: 'user', content: 'weather in SF?' }],
        tools: [WEATHER_TOOL],
        metadata: { requestId: 'req-1', timestamp: Date.now(), provenance: {} },
      },
      10
    );

    expect(response.metadata.warnings).toEqual([
      expect.objectContaining({ category: 'tool-unsupported', field: 'tools' }),
    ]);
  });

  it('omits warnings when no tools were requested', () => {
    const response = adapter.toIR(
      {
        id: 'resp_1',
        object: 'chat.completion',
        created: 0,
        model: 'test-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      {
        messages: [{ role: 'user', content: 'hi' }],
        metadata: { requestId: 'req-1', timestamp: Date.now(), provenance: {} },
      },
      10
    );

    expect(response.metadata.warnings).toBeUndefined();
  });
});

describe('Gemini backend tool-unsupported warning', () => {
  const adapter = new GeminiBackendAdapter({ apiKey: 'test-key' });

  it('adds a tool-unsupported warning when tools were requested', () => {
    const response = adapter.toIR(
      {
        candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
      },
      {
        messages: [{ role: 'user', content: 'weather in SF?' }],
        tools: [WEATHER_TOOL],
        metadata: { requestId: 'req-1', timestamp: Date.now(), provenance: {} },
      },
      10
    );

    expect(response.metadata.warnings).toEqual([
      expect.objectContaining({ category: 'tool-unsupported', field: 'tools' }),
    ]);
  });
});
