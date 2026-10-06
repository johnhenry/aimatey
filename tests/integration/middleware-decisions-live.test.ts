/**
 * Live decision-middleware test against a local Ollama (#146).
 *
 * Gated on `OLLAMA_LIVE=1` (skipped otherwise, so CI and offline runs are
 * unaffected). Needs Ollama >= 0.35 on localhost:11434 with the `tev1:0.8b`
 * decision model pulled (about 7 s per call once warm; do not point this at
 * `nimble`, which takes minutes per call).
 *
 *   OLLAMA_LIVE=1 npx vitest run tests/integration/middleware-decisions-live.test.ts
 *
 * The backend below is a test-local STAND-IN for the Ollama decision adapter
 * (#142, `OllamaBackendAdapter.decide`). Delete it and import the real
 * adapter once that lands; the assertions are about the middleware and do not
 * depend on how the backend is built.
 */

import { describe, it, expect } from 'vitest';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import {
  createDecisionCachingMiddleware,
  createDecisionCostTrackingMiddleware,
  createDecisionLoggingMiddleware,
  type CostCalculation,
  type Logger,
} from '@johnhenry/aimatey-middleware';
import type {
  BackendAdapter,
  IRDecisionAnswer,
  IRDecisionRequest,
  IRDecisionResponse,
} from '@johnhenry/aimatey-types';

const OLLAMA_URL = process.env['OLLAMA_URL'] ?? 'http://localhost:11434';
const MODEL = 'tev1:0.8b';

/** Minimal `/v1/systemone` client: just enough wire format for choice/noul/score. */
function createStandInOllamaDecisionBackend(): BackendAdapter & { httpCalls: number } {
  const backend = {
    httpCalls: 0,
    metadata: {
      name: 'ollama-systemone-standin',
      version: '0.0.0',
      provider: 'ollama',
      capabilities: {
        streaming: false,
        multiModal: false,
        tools: false,
        decisions: true,
        systemMessageStrategy: 'not-supported',
        supportsMultipleSystemMessages: false,
      },
    },
    async decide(request: IRDecisionRequest, signal?: AbortSignal): Promise<IRDecisionResponse> {
      backend.httpCalls++;
      const res = await fetch(`${OLLAMA_URL}/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: request.parameters?.model ?? MODEL,
          state: request.state,
          questions: request.questions,
        }),
        signal,
      });
      if (!res.ok) {
        throw new Error(`ollama /v1/systemone ${res.status}: ${await res.text()}`);
      }
      const body = (await res.json()) as {
        model: string;
        answers: Record<string, Record<string, any>>;
        usage?: { input_tokens: number; output_tokens?: number };
      };

      const answers: Record<string, IRDecisionAnswer> = {};
      for (const [name, a] of Object.entries(body.answers)) {
        if (a['type'] === 'choice') {
          answers[name] = {
            type: 'choice',
            value: a['choice'],
            probabilities: a['probabilities'],
            confidence: a['confidence'],
          };
        } else if (a['type'] === 'score') {
          answers[name] = {
            type: 'score',
            value: a['score'],
            probabilities: a['probabilities'],
            confidence: a['confidence'],
          };
        } else {
          answers[name] = { type: 'noul', value: a['noul'], confidence: a['confidence'] };
        }
      }

      return {
        answers,
        model: body.model,
        usage: body.usage && {
          inputTokens: body.usage.input_tokens,
          outputTokens: body.usage.output_tokens,
        },
        metadata: {
          ...request.metadata,
          provenance: { ...request.metadata.provenance, backend: 'ollama-systemone-standin' },
        },
      };
    },
  };
  return backend as unknown as BackendAdapter & { httpCalls: number };
}

describe.skipIf(!process.env['OLLAMA_LIVE'])('decision middleware against live Ollama', () => {
  it('caches the second identical decision (no HTTP call), bills once, and logs', async () => {
    const backend = createStandInOllamaDecisionBackend();
    const bridge = new Bridge(new OpenAIFrontendAdapter(), backend);

    const logs: Array<[string, string, unknown]> = [];
    const record = (level: string) => (message: string, data?: unknown) => {
      logs.push([level, message, data]);
    };
    const logger: Logger = {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    };
    const costs: CostCalculation[] = [];

    bridge.useDecision(createDecisionCachingMiddleware());
    bridge.useDecision(createDecisionLoggingMiddleware({ logger }));
    bridge.useDecision(
      createDecisionCostTrackingMiddleware({
        logger,
        // `tev1:0.8b` is a tag of the registry's `tev1`; price it explicitly.
        models: [{ model: 'tev1', pricing: { inputCostPer1M: 0.042, outputCostPer1M: 0 } }],
        onCost: (cost) => void costs.push(cost),
      })
    );

    const questions = {
      team: {
        type: 'choice' as const,
        instructions: 'Which team should handle this ticket?',
        criteria: { billing: 'invoices, charges, refunds', technical: 'bugs, outages, errors' },
      },
    };
    const ask = () =>
      bridge.decide('I was charged twice this month, please refund me.', questions, {
        model: MODEL,
        principal: 'live-test',
      });

    const first = await ask();
    expect(backend.httpCalls).toBe(1);
    expect(first.answers['team']?.type).toBe('choice');
    expect(['billing', 'technical']).toContain(first.answers['team']?.value);
    expect(first.metadata.custom?.cacheHit).toBe(false);

    const second = await ask();
    expect(backend.httpCalls).toBe(1); // served from cache: no HTTP call
    expect(second.metadata.custom?.cacheHit).toBe(true);
    expect(second.answers).toEqual(first.answers);
    expect(second.metadata.requestId).not.toBe(first.metadata.requestId);

    // Cost: billed for the one real call only.
    expect(costs).toHaveLength(1);
    expect(costs[0]!.inputTokens).toBeGreaterThan(0);
    expect(costs[0]!.totalCost).toBeGreaterThan(0);

    // Logging sits inside the cache, so it saw the miss only; the response
    // line carries the per-question summary and no state.
    const responses = logs.filter(([, message]) => /Response/.test(message));
    expect(responses).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain('charged twice');
  }, 180_000);
});
