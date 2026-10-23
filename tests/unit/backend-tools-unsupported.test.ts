/**
 * Adapters that don't implement tool/function-calling mapping now advertise
 * `capabilities.tools: false` (rather than silently dropping tools) and
 * surface a `tool-unsupported` IRWarning when `request.tools` is set (#17).
 */

import { describe, it, expect } from 'vitest';
import {
  GeminiBackendAdapter,
  AzureOpenAIBackendAdapter,
  CloudflareBackendAdapter,
} from '@johnhenry/aimatey-backend';

const ADAPTERS: Array<[string, () => { metadata: { capabilities: { tools?: boolean } } }]> = [
  ['Gemini', () => new GeminiBackendAdapter({ apiKey: 'test-key' })],
  [
    'Azure OpenAI',
    () => new AzureOpenAIBackendAdapter({ apiKey: 'test-key', baseURL: 'https://example.test' }),
  ],
  [
    'Cloudflare',
    () => new CloudflareBackendAdapter({ apiKey: 'test-key', baseURL: 'https://example.test' }),
  ],
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
