/**
 * Live Router.decide fallback against a local Ollama (#145).
 *
 * Gated: runs only with `OLLAMA_LIVE=1` (and Ollama >= 0.35 serving the
 * `tev1:0.8b` decision model on localhost:11434); skipped otherwise.
 *
 *   OLLAMA_LIVE=1 npx vitest run --project integration tests/integration/router-decide-live.test.ts
 */

import { describe, it, expect } from 'vitest';
import { Router } from '@johnhenry/aimatey-core';
import { createMockDecisionBackend } from '@johnhenry/aimatey-testing';
import type {
  AdapterMetadata,
  BackendAdapter,
  IRDecisionRequest,
  IRDecisionResponse,
} from '@johnhenry/aimatey-types';

const LIVE = process.env.OLLAMA_LIVE === '1';
const BASE_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const MODEL = 'tev1:0.8b';

/**
 * Test-local stand-in for `OllamaBackendAdapter.decide()`, which lands with
 * #142. Choice questions only; delete this once that adapter is on the
 * branch and use it directly.
 */
function createOllamaSystemOneStandIn(): BackendAdapter {
  const metadata: AdapterMetadata = {
    name: 'ollama-systemone-standin',
    version: '0.0.0',
    provider: 'ollama',
    capabilities: {
      streaming: false,
      multiModal: false,
      tools: false,
      decisions: true,
      decisionTypes: ['choice'],
      decisionModels: [MODEL],
      systemMessageStrategy: 'not-supported',
      supportsMultipleSystemMessages: false,
    },
  };
  return {
    metadata,
    async decide(request: IRDecisionRequest, signal?: AbortSignal): Promise<IRDecisionResponse> {
      const response = await fetch(`${BASE_URL}/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: request.parameters?.model ?? MODEL,
          state: request.state,
          questions: request.questions,
        }),
        signal,
      });
      if (!response.ok) {
        throw new Error(`ollama systemone ${response.status}: ${await response.text()}`);
      }
      const body = (await response.json()) as {
        model: string;
        answers: Record<
          string,
          { choice: string; probabilities?: Record<string, number>; confidence?: number }
        >;
        usage?: { input_tokens: number; output_tokens?: number };
      };
      return {
        answers: Object.fromEntries(
          Object.entries(body.answers).map(([name, a]) => [
            name,
            {
              type: 'choice' as const,
              value: a.choice,
              probabilities: a.probabilities,
              confidence: a.confidence,
            },
          ])
        ),
        model: body.model,
        usage: body.usage && {
          inputTokens: body.usage.input_tokens,
          outputTokens: body.usage.output_tokens,
        },
        metadata: request.metadata,
      };
    },
  };
}

describe.skipIf(!LIVE)('Router.decide live (Ollama systemone)', () => {
  it('falls back from a failing backend to a real decision model', async () => {
    const failing = createMockDecisionBackend({
      name: 'always-fails',
      error: new Error('simulated outage'),
    });
    const router = new Router()
      .register('always-fails', failing)
      .register('ollama', createOllamaSystemOneStandIn());
    router.setFallbackChain(['always-fails', 'ollama']);

    const criteria = {
      billing: 'charges, refunds and invoices',
      technical: 'bugs, errors and outages',
    };
    const response = await router.decide({
      state: 'My card was charged twice for the same order. Please refund me.',
      questions: {
        department: { type: 'choice', instructions: 'Which team should handle this?', criteria },
      },
      parameters: { model: MODEL },
      metadata: { requestId: 'live-1', timestamp: Date.now() },
    });

    expect(failing.calls).toHaveLength(1);
    expect(router.getBackendStats('always-fails')?.failedRequests).toBe(1);
    expect(router.getBackendStats('ollama')?.successfulRequests).toBe(1);

    const answer = response.answers.department;
    expect(answer.type).toBe('choice');
    expect(Object.keys(criteria)).toContain(answer.value);
  }, 120_000);
});
