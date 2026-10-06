/**
 * Live decision-wrapper test -- gated on OLLAMA_LIVE=1.
 *
 * Runs the AI SDK `decide()` wrapper against a real Ollama (>= 0.35) serving
 * `/v1/systemone` (tev1:0.8b, ~7 s/call on CPU).
 *
 *   OLLAMA_LIVE=1 npx vitest run tests/integration/decision-frontends-live.test.ts
 *
 * Env: OLLAMA_URL (default http://localhost:11434).
 */

import { describe, it, expect } from 'vitest';
import { Bridge } from '@johnhenry/aimatey-core';
import { VercelDecideFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { OllamaBackendAdapter } from '@johnhenry/aimatey-backend';
import { createDecide } from '@johnhenry/aimatey-wrapper';

const live = process.env.OLLAMA_LIVE === '1';
const baseURL = process.env.OLLAMA_URL ?? 'http://localhost:11434';

describe.skipIf(!live)('createDecide against live Ollama', () => {
  it('answers choice and boolean questions in the AI SDK shape', async () => {
    const decide = createDecide(
      new Bridge(new VercelDecideFrontendAdapter(), new OllamaBackendAdapter({ baseURL }))
    );

    const result = await decide({
      model: 'tev1:0.8b',
      state:
        'Subject: Duplicate charge. Body: I was billed twice this month, please refund me today.',
      questions: {
        team: {
          type: 'choice',
          instructions: 'Which team should handle this?',
          criteria: { billing: 'invoices, refunds', technical: 'bugs, outages' },
        },
        refund: { type: 'boolean', instructions: 'Does the user request a refund?' },
      },
    });

    console.log('live answers:', JSON.stringify(result.answers), JSON.stringify(result.usage));
    expect(result.answers.team.type).toBe('choice');
    expect(result.answers.refund.type).toBe('boolean');
    const refund = result.answers.refund;
    expect(typeof (refund as { probability: number }).probability).toBe('number');
    expect(result.response.modelId).toBeTruthy();
  }, 180_000);
});
