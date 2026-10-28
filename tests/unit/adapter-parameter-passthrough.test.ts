/**
 * Parameters that used to be dropped on the way through:
 *
 * - the Ollama backend now forwards seed and the penalties
 *   (plus `custom.repeatPenalty` as Ollama's own `repeat_penalty`);
 * - the OpenAI frontend now maps `top_k` and `response_format` into the IR;
 * - the middleware root bundles without the optional OpenTelemetry peers.
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { OllamaBackendAdapter } from '@johnhenry/aimatey-backend';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import type { IRChatRequest } from '@johnhenry/aimatey-types';

function makeRequest(overrides: Partial<IRChatRequest> = {}): IRChatRequest {
  return {
    messages: [{ role: 'user', content: 'Hi' }],
    parameters: { model: 'test-model' },
    metadata: { requestId: 'req-1', timestamp: Date.now(), provenance: {} },
    ...overrides,
  };
}

describe('Ollama backend sampling parameters', () => {
  const adapter = new OllamaBackendAdapter({});

  it('forwards seed, frequency/presence penalty and repeat_penalty', () => {
    const req = adapter.fromIR(
      makeRequest({
        parameters: {
          model: 'test-model',
          seed: 42,
          frequencyPenalty: 0.5,
          presencePenalty: -0.25,
          custom: { repeatPenalty: 1.1 },
        },
      })
    );
    expect(req.options).toMatchObject({
      seed: 42,
      frequency_penalty: 0.5,
      presence_penalty: -0.25,
      repeat_penalty: 1.1,
    });
  });

  it('advertises the parameters it now supports', () => {
    const caps = adapter.metadata.capabilities;
    expect(caps.supportsSeed).toBe(true);
    expect(caps.supportsFrequencyPenalty).toBe(true);
    expect(caps.supportsPresencePenalty).toBe(true);
  });

  it('ignores a non-numeric repeatPenalty', () => {
    const req = adapter.fromIR(
      makeRequest({ parameters: { model: 'test-model', custom: { repeatPenalty: 'high' } } })
    );
    expect(req.options?.repeat_penalty).toBeUndefined();
  });
});

describe('OpenAI frontend top_k and response_format', () => {
  const frontend = new OpenAIFrontendAdapter();
  const base = { model: 'gpt-x', messages: [{ role: 'user' as const, content: 'Hi' }] };

  it('maps top_k to parameters.topK', async () => {
    const ir = await frontend.toIR({ ...base, top_k: 40 });
    expect(ir.parameters?.topK).toBe(40);
  });

  it('maps a json_schema response_format', async () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    const ir = await frontend.toIR({
      ...base,
      response_format: { type: 'json_schema', json_schema: { name: 'x', schema, strict: true } },
    });
    expect(ir.responseFormat).toEqual({ type: 'json_schema', schema, strict: true });
  });

  it('maps json_object to an object schema', async () => {
    const ir = await frontend.toIR({ ...base, response_format: { type: 'json_object' } });
    expect(ir.responseFormat).toEqual({ type: 'json_schema', schema: { type: 'object' } });
  });

  it('leaves responseFormat unset for text', async () => {
    const ir = await frontend.toIR({ ...base, response_format: { type: 'text' } });
    expect(ir.responseFormat).toBeUndefined();
  });
});

describe('middleware root bundling', () => {
  it('bundles without the optional OpenTelemetry packages being resolvable', async () => {
    const entry = fileURLToPath(
      new URL('../../packages/middleware/dist/esm/index.js', import.meta.url)
    );
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      platform: 'neutral',
      format: 'esm',
      logLevel: 'silent',
      // Mark everything except OpenTelemetry external, so only the optional
      // peers' resolution is under test.
      plugins: [
        {
          name: 'externals',
          setup(b) {
            b.onResolve({ filter: /^[^./]/ }, (args) =>
              args.path.startsWith('@opentelemetry/')
                ? { errors: [{ text: `tried to resolve ${args.path}` }] }
                : { path: args.path, external: true }
            );
          },
        },
      ],
    });
    expect(result.errors).toEqual([]);
  });
});
