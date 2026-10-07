/**
 * Live Ollama locality check -- gated on OLLAMA_LIVE=1.
 *
 * A real `OllamaBackendAdapter` on loopback must report its hop as
 * `locality: 'same-host'` (#174), registered behind a `Router` like any
 * application would. Skipped unless OLLAMA_LIVE=1; the box is shared and the
 * first call may have to load the model, so the timeouts are generous.
 *
 *   OLLAMA_LIVE=1 npx vitest run tests/integration/ollama-locality-live.test.ts
 *
 * Env: OLLAMA_URL (default http://localhost:11434), OLLAMA_LIVE_MODEL
 * (default qwen2.5:3b).
 */

import { describe, it, expect } from 'vitest';
import { Router } from '@johnhenry/aimatey-core';
import { OllamaBackendAdapter } from '@johnhenry/aimatey-backend';
import { resolveEgress } from '@johnhenry/aimatey-types';
import type { IRChatRequest, IRStreamChunk } from '@johnhenry/aimatey-types';

const live = process.env.OLLAMA_LIVE === '1';
const baseURL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const model = process.env.OLLAMA_LIVE_MODEL ?? 'qwen2.5:3b';

const request = (): IRChatRequest =>
  ({
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    parameters: { model, maxTokens: 8, temperature: 0 },
    metadata: { requestId: 'live-locality', timestamp: Date.now(), provenance: {} },
  }) as unknown as IRChatRequest;

describe.skipIf(!live)('Ollama locality (live)', () => {
  it('a loopback Ollama reports same-host, through a Router', async () => {
    const router = new Router({ routingStrategy: 'explicit', fallbackStrategy: 'none' });
    router.register('ollama', new OllamaBackendAdapter({ baseURL }));

    const response = await router.execute(request(), AbortSignal.timeout(300_000));

    const hop = response.metadata.provenance;
    expect(hop?.backend).toBe('ollama-backend');
    expect(hop?.locality).toBe('same-host');
    expect(hop?.servedBy).toBe(new URL(baseURL).host);
    expect(resolveEgress(hop!)).toEqual({ locality: 'same-host', declared: true });
  }, 320_000);

  it('declares it on the stream too', async () => {
    const adapter = new OllamaBackendAdapter({ baseURL });
    const chunks: IRStreamChunk[] = [];
    for await (const chunk of adapter.executeStream(request(), AbortSignal.timeout(300_000))) {
      chunks.push(chunk);
    }
    const start = chunks.find((c) => c.type === 'start') as unknown as {
      metadata: { provenance: { locality?: string } };
    };
    expect(start.metadata.provenance.locality).toBe('same-host');
  }, 320_000);
});
