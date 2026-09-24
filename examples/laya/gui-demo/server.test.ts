/**
 * Tests for the Laya triage dashboard's HTTP API.
 *
 * Deliberately not wired into this repo's centralized `npm test` (see
 * `vitest.workspace.ts`'s `tests/**` project globs) -- run standalone:
 *
 *   npx vitest run examples/laya/gui-demo/server.test.ts
 *
 * `createRequestHandler()` takes its backends as a parameter rather than
 * constructing a real `LayaBackendAdapter` itself, so these tests inject
 * a mock `BackendAdapter` (same pattern as `tests/unit/decisions.test.ts`)
 * instead of loading the real ~1.7GB model -- fast, and independent of
 * whether `@receptron/laya` is even installed.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Bridge } from '@johnhenry/aimatey-core';
import { createGenericFrontend } from '@johnhenry/aimatey-frontend';
import type {
  BackendAdapter,
  AdapterMetadata,
  IRDecisionRequest,
  IRDecisionResponse,
} from '@johnhenry/aimatey-types';
import {
  createRequestHandler,
  DEFAULT_QUESTIONS,
  DEFAULT_PRIORITY_QUESTION,
  DEFAULT_STATE_FIELDS,
  type AppDeps,
} from './server.js';

// ============================================================================
// Test helpers
// ============================================================================

/**
 * Builds a plausible answer for whatever question was actually asked,
 * rather than a fixed canned set -- so tests can exercise a fully custom
 * question schema (not just the default category/urgency/escalation
 * names) and still get back sensible, type-correct answers.
 */
function answerFor(question: IRDecisionRequest['questions'][string]) {
  if (question.type === 'choice') {
    const keys = Object.keys(question.criteria);
    const probabilities = Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.7 : 0.3 / (keys.length - 1)]));
    return { type: 'choice' as const, value: keys[0], probabilities, confidence: 0.7 };
  }
  if (question.type === 'score') {
    const levels = question.criteria.length;
    const middle = Math.floor(levels / 2);
    const probabilities = Array.from({ length: levels }, (_, i) => (i === middle ? 0.6 : 0.4 / (levels - 1)));
    return { type: 'score' as const, value: middle, probabilities, confidence: 0.6 };
  }
  return { type: 'noul' as const, value: 0.7, confidence: 0.7 };
}

function makeMockBackend(name: string): BackendAdapter {
  const metadata: AdapterMetadata = {
    name,
    version: '1.0.0',
    provider: 'Mock',
    capabilities: {
      streaming: false,
      multiModal: false,
      tools: false,
      decisions: true,
      systemMessageStrategy: 'not-supported',
      supportsMultipleSystemMessages: false,
    },
  };

  return {
    metadata,
    // eslint-disable-next-line @typescript-eslint/require-await -- mock interface
    decide: async (request: IRDecisionRequest): Promise<IRDecisionResponse> => ({
      answers: Object.fromEntries(
        Object.entries(request.questions).map(([name_, question]) => [name_, answerFor(question)])
      ),
      model: `${name}-mock`,
      metadata: {
        ...request.metadata,
        provenance: { ...request.metadata.provenance, backend: name },
      },
      raw: { mock: true, backend: name },
    }),
  };
}

let activeServer: http.Server | undefined;

async function startServer(deps: AppDeps): Promise<string> {
  const server = http.createServer(createRequestHandler(deps));
  activeServer = server;
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return `http://localhost:${port}`;
}

afterEach(async () => {
  if (activeServer) {
    await new Promise<void>((resolve) => activeServer!.close(() => resolve()));
    activeServer = undefined;
  }
});

function layaOnlyDeps(): AppDeps {
  return { layaBridge: new Bridge(createGenericFrontend(), makeMockBackend('laya')) };
}

function withCompareDeps(): AppDeps {
  return {
    layaBridge: new Bridge(createGenericFrontend(), makeMockBackend('laya')),
    typesafeBridge: new Bridge(createGenericFrontend(), makeMockBackend('typesafe')),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/backends', () => {
  it('reports typesafe unavailable when no typesafeBridge is configured', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/backends`);
    expect(await res.json()).toEqual({ laya: true, typesafe: false });
  });

  it('reports typesafe available when configured', async () => {
    const baseUrl = await startServer(withCompareDeps());
    const res = await fetch(`${baseUrl}/api/backends`);
    expect(await res.json()).toEqual({ laya: true, typesafe: true });
  });
});

describe('GET/PUT/POST /api/questions', () => {
  it('GET returns the default question set and priority question initially', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/questions`);
    expect(await res.json()).toEqual({
      questions: DEFAULT_QUESTIONS,
      priorityQuestion: DEFAULT_PRIORITY_QUESTION,
    });
  });

  it('PUT replaces the active question set and GET reflects it', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const edited = {
      questions: {
        category: {
          type: 'choice',
          instructions: 'Custom category prompt',
          criteria: { billing: 'a', technical: 'b', account: 'c', other: 'd' },
        },
        urgency: { type: 'score', instructions: 'Custom urgency prompt', criteria: ['low', 'high'] },
      },
      priorityQuestion: 'urgency',
    };
    const putRes = await fetch(`${baseUrl}/api/questions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(edited),
    });
    expect(putRes.status).toBe(200);
    const putBody = await putRes.json();
    expect(putBody.questions.category.instructions).toBe('Custom category prompt');
    expect(putBody.priorityQuestion).toBe('urgency');

    const getRes = await fetch(`${baseUrl}/api/questions`);
    expect((await getRes.json()).questions.urgency.instructions).toBe('Custom urgency prompt');
  });

  it('supports adding, removing, and renaming questions -- not just editing prompt text', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/questions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        questions: {
          sentiment: {
            type: 'choice',
            instructions: 'What is the overall tone?',
            criteria: { positive: 'p', neutral: 'n', negative: 'g' },
          },
          severity: { type: 'score', instructions: 'How severe?', criteria: ['minor', 'major', 'critical'] },
        },
        priorityQuestion: 'severity',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.questions)).toEqual(['sentiment', 'severity']);
    expect(body.priorityQuestion).toBe('severity');
  });

  it('PUT rejects a choice question with fewer than 2 options', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/questions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        questions: { category: { type: 'choice', instructions: 'x', criteria: { billing: 'a' } } },
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at least 2 options/);
  });

  it('PUT rejects a score question with fewer than 2 levels', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/questions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        questions: { urgency: { type: 'score', instructions: 'x', criteria: ['only-one'] } },
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at least 2 level labels/);
  });

  it('PUT rejects an unknown question type', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/questions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questions: { x: { type: 'essay', instructions: 'x' } } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/type must be/);
  });

  it('PUT rejects an empty questions object', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/questions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questions: {} }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at least one question/);
  });

  it('PUT rejects a priorityQuestion that names a nonexistent question', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/questions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        questions: { category: { type: 'choice', instructions: 'x', criteria: { a: 'a', b: 'b' } } },
        priorityQuestion: 'nonexistent',
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not one of the submitted questions/);
  });

  it('PUT rejects a priorityQuestion pointing at a choice question', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/questions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        questions: { category: { type: 'choice', instructions: 'x', criteria: { a: 'a', b: 'b' } } },
        priorityQuestion: 'category',
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/must be a "score" or "noul" question/);
  });

  it('allows priorityQuestion to be null (no priority question configured)', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/questions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        questions: { category: { type: 'choice', instructions: 'x', criteria: { a: 'a', b: 'b' } } },
        priorityQuestion: null,
      }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).priorityQuestion).toBeNull();
  });

  it('POST /api/questions/reset restores the defaults after an edit', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    await fetch(`${baseUrl}/api/questions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        questions: { x: { type: 'noul', instructions: 'changed' } },
        priorityQuestion: 'x',
      }),
    });
    const resetRes = await fetch(`${baseUrl}/api/questions/reset`, { method: 'POST' });
    expect(await resetRes.json()).toEqual({
      questions: DEFAULT_QUESTIONS,
      priorityQuestion: DEFAULT_PRIORITY_QUESTION,
    });
  });
});

describe('GET/PUT/POST /api/state-fields', () => {
  it('GET returns the default single "ticket" text field initially', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/state-fields`);
    expect(await res.json()).toEqual({ stateFields: DEFAULT_STATE_FIELDS });
  });

  it('PUT replaces the active field set with multiple, differently-typed fields', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/state-fields`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stateFields: {
          ticket: { label: 'Ticket Text', type: 'text' },
          accountAgeDays: { label: 'Account Age (days)', type: 'number' },
          isPremium: { label: 'Premium Customer?', type: 'boolean' },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.stateFields)).toEqual(['ticket', 'accountAgeDays', 'isPremium']);
    expect(body.stateFields.accountAgeDays.type).toBe('number');

    const getRes = await fetch(`${baseUrl}/api/state-fields`);
    expect((await getRes.json()).stateFields.isPremium.type).toBe('boolean');
  });

  it('PUT rejects a field with an unknown type', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/state-fields`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stateFields: { x: { label: 'X', type: 'date' } } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/type must be/);
  });

  it('PUT rejects a field missing a label', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/state-fields`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stateFields: { x: { type: 'text' } } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/label must be/);
  });

  it('PUT rejects an empty field set', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/state-fields`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stateFields: {} }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at least one field/);
  });

  it('POST /api/state-fields/reset restores the default after an edit', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    await fetch(`${baseUrl}/api/state-fields`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stateFields: { x: { label: 'X', type: 'number' } } }),
    });
    const resetRes = await fetch(`${baseUrl}/api/state-fields/reset`, { method: 'POST' });
    expect(await resetRes.json()).toEqual({ stateFields: DEFAULT_STATE_FIELDS });
  });
});

describe('POST /api/triage', () => {
  it('triages a single ticket and adds it to the queue', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/triage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { ticket: 'I was charged twice' } }),
    });
    expect(res.status).toBe(200);
    const ticket = await res.json();
    expect(ticket.backend).toBe('laya');
    expect(ticket.answers.category.value).toBe('billing');
    expect(typeof ticket.latencyMs).toBe('number');
    expect(ticket.request.state).toEqual({ ticket: 'I was charged twice' });
    expect(ticket.rawResponse).toEqual({ mock: true, backend: 'laya' });
    // Mock's urgency answer is value: 2 across 4 levels -- normalized to
    // 2 / (4 - 1) = 0.6667 for the default priority question ("urgency").
    expect(ticket.priorityValue).toBeCloseTo(0.6667, 4);

    const queueRes = await fetch(`${baseUrl}/api/tickets`);
    expect(await queueRes.json()).toHaveLength(1);
  });

  it('rejects an empty ticket text with 400', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/triage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { ticket: '   ' } }),
    });
    expect(res.status).toBe(400);
  });

  it('builds state from multiple, differently-typed fields, not just one text field', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    await fetch(`${baseUrl}/api/state-fields`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stateFields: {
          ticket: { label: 'Ticket Text', type: 'text' },
          accountAgeDays: { label: 'Account Age (days)', type: 'number' },
          isPremium: { label: 'Premium Customer?', type: 'boolean' },
        },
      }),
    });

    const res = await fetch(`${baseUrl}/api/triage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { ticket: 'a ticket', accountAgeDays: '42', isPremium: true } }),
    });
    expect(res.status).toBe(200);
    const ticket = await res.json();
    // accountAgeDays submitted as a numeric string -- coerced to a real number.
    expect(ticket.request.state).toEqual({ ticket: 'a ticket', accountAgeDays: 42, isPremium: true });
  });

  it('rejects a triage request missing a configured field', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    await fetch(`${baseUrl}/api/state-fields`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stateFields: {
          ticket: { label: 'Ticket Text', type: 'text' },
          isPremium: { label: 'Premium Customer?', type: 'boolean' },
        },
      }),
    });

    const res = await fetch(`${baseUrl}/api/triage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { ticket: 'a ticket' } }), // isPremium missing
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/"isPremium" must be a boolean/);
  });

  it('computes priorityValue against a fully custom question schema, not just the defaults', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    await fetch(`${baseUrl}/api/questions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        questions: {
          sentiment: {
            type: 'choice',
            instructions: 'tone?',
            criteria: { positive: 'p', negative: 'n' },
          },
          severity: {
            type: 'score',
            instructions: 'how severe?',
            criteria: ['minor', 'moderate', 'major', 'critical', 'catastrophic'],
          },
        },
        priorityQuestion: 'severity',
      }),
    });

    const res = await fetch(`${baseUrl}/api/triage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { ticket: 'a ticket' } }),
    });
    const ticket = await res.json();
    expect(Object.keys(ticket.answers)).toEqual(['sentiment', 'severity']);
    // 5 levels -> middle index 2 -> 2 / (5 - 1) = 0.5.
    expect(ticket.priorityValue).toBeCloseTo(0.5, 4);
  });

  it('reports priorityValue: null when no priority question is configured', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    await fetch(`${baseUrl}/api/questions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        questions: { feedback: { type: 'noul', instructions: 'is this positive?' } },
        priorityQuestion: null,
      }),
    });

    const res = await fetch(`${baseUrl}/api/triage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { ticket: 'a ticket' } }),
    });
    expect((await res.json()).priorityValue).toBeNull();
  });
});

describe('POST /api/triage/batch', () => {
  it('triages every line in the batch and adds them all to the queue', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/triage/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: ['first ticket', 'second ticket', ''] }),
    });
    expect(res.status).toBe(200);
    const { results } = await res.json();
    // The blank entry is filtered out, not triaged.
    expect(results).toHaveLength(2);
    expect(results.map((t: { request: { state: { ticket: string } } }) => t.request.state.ticket)).toEqual([
      'first ticket',
      'second ticket',
    ]);

    const queueRes = await fetch(`${baseUrl}/api/tickets`);
    expect(await queueRes.json()).toHaveLength(2);
  });

  it('rejects a request with no usable lines', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/triage/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: ['', '   '] }),
    });
    expect(res.status).toBe(400);
  });

  it('is unavailable when more than one state field is configured', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    await fetch(`${baseUrl}/api/state-fields`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stateFields: {
          ticket: { label: 'Ticket Text', type: 'text' },
          isPremium: { label: 'Premium Customer?', type: 'boolean' },
        },
      }),
    });
    const res = await fetch(`${baseUrl}/api/triage/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: ['a ticket'] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/exactly one state field/);
  });

  it('is unavailable when the sole state field is not type "text"', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    await fetch(`${baseUrl}/api/state-fields`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stateFields: { age: { label: 'Age', type: 'number' } } }),
    });
    const res = await fetch(`${baseUrl}/api/triage/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: ['42'] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/exactly one state field/);
  });
});

describe('POST /api/triage/compare', () => {
  it('returns a typesafeError and no typesafe result when compare is not configured', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/triage/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { ticket: 'a ticket' } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.laya.backend).toBe('laya');
    expect(body.typesafe).toBeNull();
    expect(body.typesafeError).toMatch(/TYPESAFE_API_KEY/);
  });

  it('returns both results when a typesafeBridge is configured', async () => {
    const baseUrl = await startServer(withCompareDeps());
    const res = await fetch(`${baseUrl}/api/triage/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { ticket: 'a ticket' } }),
    });
    const body = await res.json();
    expect(body.laya.backend).toBe('laya');
    expect(body.typesafe.backend).toBe('typesafe');
    expect(body.typesafeError).toBeUndefined();
  });
});

describe('GET/DELETE /api/tickets', () => {
  it('lists tickets newest-first and clears them on DELETE', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    await fetch(`${baseUrl}/api/triage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { ticket: 'older' } }),
    });
    await fetch(`${baseUrl}/api/triage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { ticket: 'newer' } }),
    });

    const listed = await (await fetch(`${baseUrl}/api/tickets`)).json();
    expect(listed.map((t: { request: { state: { ticket: string } } }) => t.request.state.ticket)).toEqual([
      'newer',
      'older',
    ]);

    const deleteRes = await fetch(`${baseUrl}/api/tickets`, { method: 'DELETE' });
    expect(await deleteRes.json()).toEqual({ ok: true });
    expect(await (await fetch(`${baseUrl}/api/tickets`)).json()).toEqual([]);
  });
});

describe('static file serving', () => {
  it('serves index.html at /', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('returns 404 for an unknown path', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
  });
});
