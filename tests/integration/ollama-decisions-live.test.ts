/**
 * Live Ollama decision tests -- gated on OLLAMA_LIVE=1.
 *
 * Runs `Bridge.decide()` against a real Ollama (>= 0.35) serving
 * `/v1/systemone`. Skipped unless OLLAMA_LIVE=1, since it needs the models
 * pulled and is slow on CPU (tev1:0.8b ~7 s/call after load; nimble ~2 min).
 *
 *   OLLAMA_LIVE=1 npx vitest run tests/integration/ollama-decisions-live.test.ts
 *
 * Env: OLLAMA_URL (default http://localhost:11434), OLLAMA_LIVE_NIMBLE=1 to
 * also run the nimble call, OLLAMA_LIVE_CAPTURE=1 to (re)write the replay
 * fixtures in fixtures/decisions-ollama/ from what the server returned.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent } from 'undici';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { OllamaBackendAdapter, SystemOneBackendAdapter } from '@johnhenry/aimatey-backend';
import type { IRDecisionRequest, IRDecisionResponse } from '@johnhenry/aimatey-types';

const live = process.env.OLLAMA_LIVE === '1';
const baseURL = process.env.OLLAMA_URL ?? 'http://localhost:11434';

const state = 'Subject: Duplicate charge. Body: I was billed twice this month, please refund me today.';
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

/** Run the call through Bridge.decide() while recording the wire exchange. */
async function decideAndRecord(model: string) {
  const realFetch = global.fetch;
  let providerRequest: unknown;
  let providerResponse: unknown;
  // Node's fetch abandons a response after 5 minutes without headers
  // (undici's default); a cold nimble load plus a ~2 min CPU decision can hit
  // that, so this test lifts the limit for its own calls.
  const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  global.fetch = (async (url: string, init?: RequestInit) => {
    const res = await realFetch(url, { ...init, dispatcher } as RequestInit);
    if (String(url).endsWith('/v1/systemone')) {
      providerRequest = JSON.parse(String(init?.body));
      providerResponse = await res.clone().json();
    }
    return res;
  }) as typeof fetch;

  const bridge = new Bridge(new OpenAIFrontendAdapter(), new OllamaBackendAdapter({ baseURL }));
  const started = Date.now();
  const response = await bridge.decide(state, questions, { model });
  return { response, providerRequest, providerResponse, ms: Date.now() - started };
}

async function capture(
  scenario: string,
  model: string,
  r: Awaited<ReturnType<typeof decideAndRecord>>
) {
  if (process.env.OLLAMA_LIVE_CAPTURE !== '1') return;
  const dir = join(process.cwd(), 'fixtures', 'decisions-ollama');
  await mkdir(dir, { recursive: true });
  const request: IRDecisionRequest = {
    state,
    questions,
    parameters: { model },
    metadata: { requestId: `fixture-${scenario}`, timestamp: 0 },
  };
  const fixture = {
    metadata: {
      provider: 'decisions-ollama',
      scenario,
      model,
      apiVersion: 'ollama-0.35.1 /v1/systemone',
      capturedAt: new Date().toISOString(),
      description: `Real /v1/systemone response from ${model}: choice + noul + score`,
      tags: ['decision', 'systemone', 'live-capture'],
    },
    request,
    response: { ...r.response, metadata: { requestId: request.metadata.requestId, timestamp: 0 } },
    providerRequest: r.providerRequest,
    providerResponse: r.providerResponse,
  };
  await writeFile(join(dir, `${scenario}.json`), JSON.stringify(fixture, null, 2) + '\n');
}

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
  if (urgency?.type === 'score' && urgency.probabilities) {
    expect(urgency.probabilities).toHaveLength(3);
  }
  expect(response.usage?.inputTokens).toBeGreaterThan(0);
}

describe.skipIf(!live)('live Ollama /v1/systemone (OLLAMA_LIVE=1)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('tev1:0.8b answers choice + noul + score through Bridge.decide()', async () => {
    const r = await decideAndRecord('tev1:0.8b');
    console.log(`tev1:0.8b (${r.ms} ms):`, JSON.stringify(r.response.answers));
    expectTriageShape(r.response);
    expect(r.response.model).toContain('tev1');
    expect((r.response.answers.refund as { value: number }).value).toBeGreaterThan(0.5);
    await capture('tev1-0.8b-triage', 'tev1:0.8b', r);
  }, 300_000);

  it('SystemOneBackendAdapter pointed at Ollama answers the same questions', async () => {
    const backend = new SystemOneBackendAdapter({
      baseURL: `${baseURL}/v1`,
      name: 'ollama-systemone',
      defaultModel: 'tev1:0.8b',
      timeout: 120_000, // the health check is a real decision call
    });
    expect(await backend.healthCheck()).toBe(true);
    const bridge = new Bridge(new OpenAIFrontendAdapter(), backend);
    const response = await bridge.decide(state, questions);
    console.log('systemone->ollama:', JSON.stringify(response.answers));
    expectTriageShape(response);
  }, 300_000);

  it.skipIf(process.env.OLLAMA_LIVE_NIMBLE !== '1')(
    'nimble answers the same questions (about two minutes on CPU)',
    async () => {
      const r = await decideAndRecord('nimble');
      console.log(`nimble (${r.ms} ms):`, JSON.stringify(r.response.answers));
      expectTriageShape(r.response);
      await capture('nimble-triage', 'nimble', r);
    },
    900_000
  );
});
