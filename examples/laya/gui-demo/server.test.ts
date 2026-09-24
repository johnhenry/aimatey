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
import { createRequestHandler, DEFAULT_QUESTIONS, type AppDeps } from './server.js';

// ============================================================================
// Test helpers
// ============================================================================

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
      answers: {
        category: {
          type: 'choice',
          value: 'billing',
          probabilities: { billing: 0.8, technical: 0.1, account: 0.05, other: 0.05 },
          confidence: 0.8,
        },
        urgency: {
          type: 'score',
          value: 2,
          probabilities: [0.05, 0.15, 0.6, 0.2],
          confidence: 0.6,
        },
        needsHumanEscalation: { type: 'noul', value: 0.7, confidence: 0.7 },
      },
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
  it('GET returns the default question set initially', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/questions`);
    expect(await res.json()).toEqual(DEFAULT_QUESTIONS);
  });

  it('PUT replaces the active question set and GET reflects it', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const edited = {
      category: {
        instructions: 'Custom category prompt',
        criteria: { billing: 'a', technical: 'b', account: 'c', other: 'd' },
      },
      urgency: { instructions: 'Custom urgency prompt' },
      needsHumanEscalation: { instructions: 'Custom escalation prompt' },
    };
    const putRes = await fetch(`${baseUrl}/api/questions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(edited),
    });
    expect(putRes.status).toBe(200);
    const putBody = await putRes.json();
    expect(putBody.category.instructions).toBe('Custom category prompt');
    expect(putBody.urgency.criteria).toEqual(DEFAULT_QUESTIONS.urgency.criteria);

    const getRes = await fetch(`${baseUrl}/api/questions`);
    expect((await getRes.json()).urgency.instructions).toBe('Custom urgency prompt');
  });

  it('PUT rejects a body missing a required category criterion', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/questions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: { instructions: 'x', criteria: { billing: 'a', technical: 'b', account: 'c' } }, // missing "other"
        urgency: { instructions: 'x' },
        needsHumanEscalation: { instructions: 'x' },
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/criteria\.other/);
  });

  it('POST /api/questions/reset restores the defaults after an edit', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    await fetch(`${baseUrl}/api/questions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: {
          instructions: 'changed',
          criteria: { billing: 'a', technical: 'b', account: 'c', other: 'd' },
        },
        urgency: { instructions: 'changed' },
        needsHumanEscalation: { instructions: 'changed' },
      }),
    });
    const resetRes = await fetch(`${baseUrl}/api/questions/reset`, { method: 'POST' });
    expect(await resetRes.json()).toEqual(DEFAULT_QUESTIONS);
  });
});

describe('POST /api/triage', () => {
  it('triages a single ticket and adds it to the queue', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/triage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'I was charged twice' }),
    });
    expect(res.status).toBe(200);
    const ticket = await res.json();
    expect(ticket.backend).toBe('laya');
    expect(ticket.text).toBe('I was charged twice');
    expect(ticket.answers.category.value).toBe('billing');
    expect(typeof ticket.latencyMs).toBe('number');
    expect(ticket.request.state).toEqual({ ticket: 'I was charged twice' });
    expect(ticket.rawResponse).toEqual({ mock: true, backend: 'laya' });

    const queueRes = await fetch(`${baseUrl}/api/tickets`);
    expect(await queueRes.json()).toHaveLength(1);
  });

  it('rejects an empty ticket text with 400', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/triage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/triage/batch', () => {
  it('triages every ticket in the batch and adds them all to the queue', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/triage/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: ['first ticket', 'second ticket', ''] }),
    });
    expect(res.status).toBe(200);
    const { results } = await res.json();
    // The blank entry is filtered out, not triaged.
    expect(results).toHaveLength(2);
    expect(results.map((t: { text: string }) => t.text)).toEqual(['first ticket', 'second ticket']);

    const queueRes = await fetch(`${baseUrl}/api/tickets`);
    expect(await queueRes.json()).toHaveLength(2);
  });

  it('rejects a request with no usable ticket text', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/triage/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: ['', '   '] }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/triage/compare', () => {
  it('returns a typesafeError and no typesafe result when compare is not configured', async () => {
    const baseUrl = await startServer(layaOnlyDeps());
    const res = await fetch(`${baseUrl}/api/triage/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'a ticket' }),
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
      body: JSON.stringify({ text: 'a ticket' }),
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
      body: JSON.stringify({ text: 'older' }),
    });
    await fetch(`${baseUrl}/api/triage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'newer' }),
    });

    const listed = await (await fetch(`${baseUrl}/api/tickets`)).json();
    expect(listed.map((t: { text: string }) => t.text)).toEqual(['newer', 'older']);

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
