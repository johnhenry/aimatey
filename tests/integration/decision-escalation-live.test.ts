/**
 * Live escalation test -- gated on OLLAMA_LIVE=1.
 *
 * A mock decision backend answers with low confidence, so createDecisionEscalation
 * reruns the whole request on the LLM emulation over a local Ollama chat model.
 * Slow on a CPU-only box (a few tokens per minute under load), hence the
 * 10-minute timeout.
 *
 *   OLLAMA_LIVE=1 npx vitest run tests/integration/decision-escalation-live.test.ts
 *
 * Env: OLLAMA_URL (default http://localhost:11434), OLLAMA_CHAT_MODEL (default qwen2.5:3b).
 */

import { describe, it, expect } from 'vitest';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { OllamaBackendAdapter } from '@johnhenry/aimatey-backend';
import {
  createDecisionEscalation,
  createEmulatedDecisionBackend,
} from '@johnhenry/aimatey-patterns';
import { createMockDecisionBackend } from '@johnhenry/aimatey-testing';

const live = process.env.OLLAMA_LIVE === '1';
const baseURL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const model = process.env.OLLAMA_CHAT_MODEL ?? 'qwen2.5:3b';

describe.skipIf(!live)('live escalation to an emulated Ollama fallback (OLLAMA_LIVE=1)', () => {
  it('reruns the whole request on the fallback when the primary is not confident', async () => {
    const primary = createMockDecisionBackend({
      name: 'unsure-primary',
      model: 'mock-primary',
      answers: {
        team: {
          type: 'choice',
          value: 'other',
          probabilities: { billing: 0.34, auth: 0.33, other: 0.33 },
          confidence: 0.01,
        },
        refund: { type: 'noul', value: 0.5 },
      },
    });
    const fallback = createEmulatedDecisionBackend(new OllamaBackendAdapter({ baseURL }), {
      model,
    });

    const bridge = new Bridge(new OpenAIFrontendAdapter(), primary);
    bridge.useDecision(
      createDecisionEscalation({
        fallback,
        when: {
          any: [{ question: 'team', confidenceBelow: 0.5 }, { probabilityBetween: [0.4, 0.6] }],
        },
      })
    );

    const started = Date.now();
    const response = await bridge.decide(
      'Subject: charged twice. Body: I was billed two times this month, please refund me today.',
      {
        team: {
          type: 'choice',
          instructions: 'Which team should handle this?',
          criteria: {
            billing: 'charges, invoices, refunds',
            auth: 'login problems',
            other: 'anything else',
          },
        },
        refund: { type: 'noul', instructions: 'Does the user ask for a refund?' },
      },
      { signal: AbortSignal.timeout(600_000) }
    );
    console.log(
      `escalated in ${Date.now() - started} ms:`,
      JSON.stringify({
        answers: response.answers,
        escalation: response.metadata.custom?.escalation,
      })
    );

    const escalation = response.metadata.custom?.escalation as {
      triggeredBy: Array<{ question: string; reason: string }>;
      primaryModel: string;
    };
    expect(escalation.triggeredBy.length).toBeGreaterThan(0);
    expect(escalation.triggeredBy.map((t) => t.question)).toContain('team');
    expect(escalation.primaryModel).toBe('mock-primary');
    expect(['billing', 'auth', 'other']).toContain(
      (response.answers.team as { value: string }).value
    );
    expect([0, 1]).toContain((response.answers.refund as { value: number }).value);
    expect(response.model).toContain(model.split(':')[0]);
  }, 630_000);
});
