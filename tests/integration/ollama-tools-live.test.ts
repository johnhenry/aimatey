/**
 * Live Ollama tool-calling test (#168) -- gated on OLLAMA_LIVE=1.
 *
 *   OLLAMA_LIVE=1 npx vitest run tests/integration/ollama-tools-live.test.ts
 *
 * Env: OLLAMA_URL (default http://localhost:11434), OLLAMA_TOOLS_MODEL
 * (default qwen2.5:3b, any tool-capable model), OLLAMA_LIVE_CAPTURE=1 to
 * (re)write fixtures/ollama-tools/round-trip.json from the recorded wire exchange.
 */

import { describe, it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent } from 'undici';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { OllamaBackendAdapter } from '@johnhenry/aimatey-backend';

const live = process.env.OLLAMA_LIVE === '1';
const baseURL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const model = process.env.OLLAMA_TOOLS_MODEL ?? 'qwen2.5:3b';

describe.skipIf(!live)('Ollama tool calling (live)', () => {
  it('produces a tool call and answers from the fed-back result', async () => {
    const exchanges: Array<{ request: unknown; response: unknown }> = [];
    const realFetch = global.fetch;
    const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
    global.fetch = (async (url: string, init?: RequestInit) => {
      const res = await realFetch(url, { ...init, dispatcher } as RequestInit);
      if (String(url).endsWith('/api/chat')) {
        exchanges.push({
          request: JSON.parse(String(init?.body)),
          response: await res.clone().json(),
        });
      }
      return res;
    }) as typeof fetch;

    try {
      const bridge = new Bridge(
        new OpenAIFrontendAdapter(),
        new OllamaBackendAdapter({ baseURL, defaultModel: model })
      );
      let executed: unknown;
      const result = await bridge.runTools({
        model,
        prompt: 'What is the weather in Paris right now? Use the tool.',
        tools: {
          get_weather: {
            description: 'Get the current weather for a city',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string', description: 'City name' } },
              required: ['city'],
            },
            execute: (args: { city: string }) => {
              executed = args;
              return Promise.resolve({ city: args.city, temperature_c: 18, conditions: 'cloudy' });
            },
          },
        },
      });

      console.log(JSON.stringify(exchanges, null, 2));
      expect(String((executed as { city?: string } | undefined)?.city).toLowerCase()).toContain(
        'paris'
      );
      expect(result.steps.length).toBeGreaterThanOrEqual(2);
      expect(result.text.length).toBeGreaterThan(0);

      if (process.env.OLLAMA_LIVE_CAPTURE === '1') {
        const dir = join(process.cwd(), 'fixtures', 'ollama-tools');
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, 'round-trip.json'),
          JSON.stringify(
            {
              metadata: {
                provider: 'ollama',
                scenario: 'tools-round-trip',
                capturedAt: new Date().toISOString(),
                description:
                  'Real /api/chat exchanges: tool call, then final answer from the tool result',
                tags: ['tools', 'ollama', 'live'],
              },
              // `request`/`response` (first exchange) satisfy the shared fixture
              // loader's shape; `exchanges` holds the whole round trip.
              request: exchanges[0]?.request,
              response: exchanges[0]?.response,
              exchanges,
            },
            null,
            2
          ) + '\n'
        );
      }
    } finally {
      global.fetch = realFetch;
      await dispatcher.close();
    }
  }, 600_000);
});
