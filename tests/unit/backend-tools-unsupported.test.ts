/**
 * Adapters that don't implement tool/function-calling mapping now advertise
 * `capabilities.tools: false` (rather than silently dropping tools) and
 * surface a `tool-unsupported` IRWarning when `request.tools` is set (#17).
 */

import { describe, it, expect } from 'vitest';
import {
  AzureOpenAIBackendAdapter,
  CloudflareBackendAdapter,
} from '@johnhenry/aimatey-backend';

const ADAPTERS: Array<[string, () => { metadata: { capabilities: { tools?: boolean } } }]> = [
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
