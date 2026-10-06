/**
 * Live hosted decision tests -- each block is gated on its own env var:
 *
 *   CLOUDFLARE_LIVE=1 CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
 *     npx vitest run tests/integration/hosted-decisions-live.test.ts
 *   OPENROUTER_LIVE=1 OPENROUTER_API_KEY=...
 *   PERPLEXITY_LIVE=1 PERPLEXITY_API_KEY=...
 *
 * Clef has a free Workers AI tier. Keys are read from the environment only.
 */

import { describe, it, expect } from 'vitest';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import {
  CloudflareBackendAdapter,
  OpenRouterBackendAdapter,
  PerplexityBackendAdapter,
} from '@johnhenry/aimatey-backend';
import type { IRDecisionRequest, IRDecisionResponse } from '@johnhenry/aimatey-types';

const state =
  'Subject: Duplicate charge. Body: I was billed twice this month, please refund me today.';
const questions: IRDecisionRequest['questions'] = {
  department: {
    type: 'choice',
    instructions: 'Which team should handle this?',
    criteria: { billing: 'invoices, refunds', technical: 'bugs, outages' },
  },
  refund: { type: 'noul', instructions: 'Does the user request a refund?' },
  urgency: {
    type: 'score',
    instructions: 'How urgent is this?',
    criteria: ['low', 'medium', 'high'],
  },
};

function expectTriageShape(response: IRDecisionResponse) {
  const { department, refund, urgency } = response.answers;
  expect(department?.type).toBe('choice');
  expect(['billing', 'technical']).toContain((department as { value: string }).value);
  expect(refund?.type).toBe('noul');
  const p = (refund as { value: number }).value;
  expect(p).toBeGreaterThanOrEqual(0);
  expect(p).toBeLessThanOrEqual(1);
  expect(urgency?.type).toBe('score');
  const level = (urgency as { value: number }).value;
  expect(level).toBeGreaterThanOrEqual(0);
  expect(level).toBeLessThanOrEqual(2);
}

describe.skipIf(process.env.CLOUDFLARE_LIVE !== '1')(
  'live Cloudflare Clef (CLOUDFLARE_LIVE=1)',
  () => {
    it.each(['clef-flash', 'clef'])(
      '%s answers choice + noul + score',
      async (model) => {
        const backend = new CloudflareBackendAdapter({
          apiKey: process.env.CLOUDFLARE_API_TOKEN ?? '',
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
        });
        const bridge = new Bridge(new OpenAIFrontendAdapter(), backend);
        const response = await bridge.decide(state, questions, { model });
        console.log(
          `cloudflare ${model}:`,
          JSON.stringify(response.answers),
          JSON.stringify(response.usage)
        );
        expectTriageShape(response);
        expect((response.answers.refund as { value: number }).value).toBeGreaterThan(0.5);
      },
      60_000
    );
  }
);

describe.skipIf(process.env.OPENROUTER_LIVE !== '1')(
  'live OpenRouter decisions (OPENROUTER_LIVE=1)',
  () => {
    it('answers via /api/alpha/decisions', async () => {
      const backend = new OpenRouterBackendAdapter({
        apiKey: process.env.OPENROUTER_API_KEY ?? '',
      });
      const bridge = new Bridge(new OpenAIFrontendAdapter(), backend);
      const response = await bridge.decide(state, questions);
      console.log('openrouter:', JSON.stringify(response.answers), response.id, response.provider);
      expectTriageShape(response);
    }, 60_000);
  }
);

describe.skipIf(process.env.PERPLEXITY_LIVE !== '1')(
  'live Perplexity decisions (PERPLEXITY_LIVE=1)',
  () => {
    it('answers via /v1/decisions', async () => {
      const backend = new PerplexityBackendAdapter({
        apiKey: process.env.PERPLEXITY_API_KEY ?? '',
      });
      const bridge = new Bridge(new OpenAIFrontendAdapter(), backend);
      const response = await bridge.decide(state, questions);
      console.log('perplexity:', JSON.stringify(response.answers));
      expectTriageShape(response);
    }, 60_000);
  }
);
