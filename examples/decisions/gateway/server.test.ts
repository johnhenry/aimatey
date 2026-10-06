/**
 * Tests for the demo decision gateway.
 *
 * Run standalone (not part of the root `npm test`):
 *
 *   cd examples/decisions/gateway && npx vitest run
 *
 * `createGateway()` takes its backends as parameters, so every test here
 * injects mock decision backends instead of needing Ollama. The live smoke
 * test at the bottom runs the real server against a local Ollama and is
 * opt-in:
 *
 *   OLLAMA_LIVE=1 npx vitest run
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  SYSTEMONE_DIALECTS,
  buildSystemOneRequest,
  parseSystemOneResponse,
} from '@johnhenry/aimatey-backend';
import { ProviderError, RateLimitError } from '@johnhenry/aimatey-errors';
import { createMockDecisionBackend } from '@johnhenry/aimatey-testing';
import { ErrorCode } from '@johnhenry/aimatey-types';
import type { IRDecisionAnswer, IRDecisionRequest } from '@johnhenry/aimatey-types';
import { createGateway, createGatewayDepsFromEnv, MAX_BODY_BYTES, type GatewayDeps } from './server.js';

// ============================================================================
// Helpers
// ============================================================================

const servers: http.Server[] = [];

async function start(deps: Partial<GatewayDeps> & Pick<GatewayDeps, 'backends'>) {
  const gateway = createGateway({ log: () => {}, ...deps });
  const server = http.createServer(gateway.handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    gateway,
    post: (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    get: (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers }),
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
  );
});

const questions = {
  team: {
    type: 'choice',
    instructions: 'Which team?',
    criteria: { billing: 'invoices', technical: 'bugs' },
  },
  urgency: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'mid', 'high'] },
  refund: { type: 'noul', instructions: 'Is a refund requested?' },
} as const;

const answers: Record<string, IRDecisionAnswer> = {
  team: { type: 'choice', value: 'billing', probabilities: { billing: 0.9, technical: 0.1 }, confidence: 0.9 },
  urgency: { type: 'score', value: 2, probabilities: [0.05, 0.15, 0.8], confidence: 0.8 },
  refund: { type: 'noul', value: 0.95 },
};

const ticket = { state: 'Duplicate charge on my card, please refund me.', model: 'tev1:0.8b' };

function mock(overrides: Parameters<typeof createMockDecisionBackend>[0] = {}) {
  return createMockDecisionBackend({
    name: 'primary',
    model: 'tev1:0.8b',
    answers,
    ...overrides,
  });
}

/** The wire body for `questions` in a dialect (vercel spells noul `boolean`). */
function wireBody(dialect: 'systemone' | 'openrouter' | 'vercel-evaluate', only?: string[]) {
  const picked = Object.fromEntries(
    Object.entries(questions).filter(([name]) => !only || only.includes(name))
  );
  const ir: IRDecisionRequest = {
    ...ticket,
    questions: picked as IRDecisionRequest['questions'],
    parameters: { model: ticket.model },
    metadata: { requestId: 'x', timestamp: 0 },
  };
  return buildSystemOneRequest(ir, { dialect });
}

const ROUTES = [
  ['/v1/systemone', 'systemone'],
  ['/typesafe/v1/systemone', 'systemone'],
  ['/v1/decisions', 'openrouter'],
  ['/v1/evaluate', 'vercel-evaluate'],
] as const;

// ============================================================================
// Routes x question types
// ============================================================================

describe.each(ROUTES)('POST %s (%s)', (path, dialect) => {
  it.each(['team', 'urgency', 'refund'])('answers a %s question the client parser reads back', async (name) => {
    const primary = mock();
    const { post } = await start({ backends: { primary } });

    const res = await post(path, wireBody(dialect, [name]));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    const parsed = parseSystemOneResponse(
      body,
      { ...ticket, questions: { [name]: questions[name as keyof typeof questions] }, metadata: { requestId: 'x', timestamp: 0 } } as IRDecisionRequest,
      { dialect, backendName: 'gateway' }
    );
    expect(parsed.answers[name]).toEqual(answers[name]);
    expect(parsed.model).toBe('tev1:0.8b');
    expect(primary.calls).toHaveLength(1);
    expect(Object.keys(primary.calls[0]!.questions)).toEqual([name]);
  });

  it('answers all three question types in one call', async () => {
    const { post } = await start({ backends: { primary: mock() } });
    const body = await (await post(path, wireBody(dialect))).json();
    expect(Object.keys(body.answers)).toEqual(['team', 'urgency', 'refund']);
  });
});

describe('dialect specifics', () => {
  it("/v1/evaluate maps 'boolean' <-> noul exactly as SYSTEMONE_DIALECTS['vercel-evaluate'] says", async () => {
    const primary = mock();
    const { post } = await start({ backends: { primary } });
    const wireType = SYSTEMONE_DIALECTS['vercel-evaluate'].wireTypes.noul;
    expect(wireType).toBe('boolean');

    const res = await post('/v1/evaluate', {
      ...ticket,
      questions: { refund: { type: wireType, instructions: 'Is a refund requested?' } },
    });
    const body = await res.json();

    expect(primary.calls[0]!.questions.refund?.type).toBe('noul');
    expect(body.answers.refund).toEqual({ type: wireType, probability: 0.95 });
    expect(body.usage).toBeUndefined(); // mock reports none
  });

  it('/v1/evaluate answers in camelCase usage and providerMetadata.gateway.routing', async () => {
    const primary = mock({
      handler: (request) => ({
        answers,
        model: 'tev1:0.8b',
        usage: { inputTokens: 40, outputTokens: 2 },
        metadata: request.metadata,
      }),
    });
    const { post } = await start({ backends: { primary } });
    const body = await (await post('/v1/evaluate', wireBody('vercel-evaluate'))).json();

    expect(body.usage.inputTokens).toBe(40);
    expect(body.usage.outputTokens).toBe(2);
    expect(body.providerMetadata.gateway.routing.modelAttempts[0]).toMatchObject({
      model: 'tev1:0.8b',
      success: true,
    });
  });

  it('/v1/decisions accepts provider/trace/session_id/user and adds id, provider and usage.cost', async () => {
    const primary = mock({
      handler: (request) => ({
        answers,
        model: 'tev1:0.8b',
        usage: { inputTokens: 40 },
        metadata: { ...request.metadata, provenance: { backend: 'primary' } },
      }),
    });
    const { post } = await start({ backends: { primary } });

    const res = await post('/v1/decisions', {
      ...wireBody('openrouter'),
      provider: { order: ['ollama'] },
      trace: { trace_id: 't1' },
      session_id: 's1',
      user: 'u1',
    });
    const body = await res.json();

    expect(primary.calls[0]!.parameters?.custom).toEqual({
      provider: { order: ['ollama'] },
      trace: { trace_id: 't1' },
      sessionId: 's1',
      user: 'u1',
    });
    expect(typeof body.id).toBe('string');
    expect(body.provider).toBe('primary');
    expect(body.usage).toEqual({ input_tokens: 40, cost: expect.any(Number) });
  });

  it('/v1/systemone passes images and keep_alive through to the backend', async () => {
    const primary = mock();
    (primary.metadata.capabilities as { decisionImages?: boolean }).decisionImages = true;
    const { post } = await start({ backends: { primary } });

    await post('/v1/systemone', { ...wireBody('systemone'), images: ['iVBORw0KGgo='], keep_alive: '10m' });

    const request = primary.calls[0]!;
    expect(request.images).toEqual([
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo=' } },
    ]);
    expect(request.parameters?.custom?.keepAlive).toBe('10m');
  });
});

// ============================================================================
// Escalation
// ============================================================================

describe('escalation', () => {
  const unsure: Record<string, IRDecisionAnswer> = {
    ...answers,
    team: { type: 'choice', value: 'billing', probabilities: { billing: 0.5, technical: 0.5 }, confidence: 0.5 },
  };

  it.each(ROUTES)('%s reruns on the fallback when confidence is below the threshold', async (path, dialect) => {
    const primary = mock({ answers: unsure });
    const fallback = createMockDecisionBackend({
      name: 'fallback',
      model: 'qwen2.5:3b',
      answers: { ...answers, team: { type: 'choice', value: 'technical' } },
    });
    const { post } = await start({ backends: { primary }, fallback, escalateBelow: 0.6 });

    const res = await post(path, wireBody(dialect));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(primary.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(1);
    expect(body.model).toBe('qwen2.5:3b');
    expect(body.answers.team.choice).toBe('technical');

    const meta = dialect === 'vercel-evaluate' ? body.providerMetadata : body.provider_metadata;
    expect(meta.gateway.routing.modelAttempts[0]).toMatchObject({
      model: 'tev1:0.8b',
      triggeredBy: [{ question: 'team', reason: 'confidence_below' }],
    });
    expect(meta.gateway.routing.modelAttempts[1].model).toBe('qwen2.5:3b');

    expect(res.headers.get('x-aimatey-decision-fallback-triggered')).toBe('true');
    expect(res.headers.get('x-aimatey-decision-fallback-primary-model')).toBe('tev1:0.8b');
    expect(res.headers.get('x-aimatey-decision-fallback-model')).toBe('qwen2.5:3b');
    expect(res.headers.get('x-aimatey-decision-fallback-triggered-by')).toBe('team:confidence_below');
  });

  it('does not touch the fallback, or set headers, when the primary is confident', async () => {
    const primary = mock();
    const fallback = createMockDecisionBackend({ name: 'fallback', answers });
    const { post } = await start({ backends: { primary }, fallback });

    const res = await post('/v1/systemone', wireBody('systemone'));

    expect(fallback.calls).toHaveLength(0);
    expect(res.headers.get('x-aimatey-decision-fallback-triggered')).toBeNull();
    expect((await res.json()).provider_metadata).toBeUndefined();
  });

  it('reads the threshold from the dependency (default 0.6)', async () => {
    const primary = mock({ answers: unsure });
    const fallback = createMockDecisionBackend({ name: 'fallback', answers });
    const { post } = await start({ backends: { primary }, fallback, escalateBelow: 0.4 });
    await post('/v1/systemone', wireBody('systemone'));
    expect(fallback.calls).toHaveLength(0);
  });
});

// ============================================================================
// Middleware
// ============================================================================

describe('caching', () => {
  it('serves a repeated request from the in-memory cache', async () => {
    const primary = mock();
    const { post } = await start({ backends: { primary } });
    const body = wireBody('systemone');

    const first = await (await post('/v1/systemone', body)).json();
    const second = await (await post('/v1/systemone', body)).json();

    expect(primary.calls).toHaveLength(1);
    expect(second.answers).toEqual(first.answers);
  });
});

describe('logging', () => {
  it('logs question names and answers but never the state', async () => {
    const lines: string[] = [];
    const gateway = createGateway({
      backends: { primary: mock() },
      log: (line) => lines.push(line),
    });
    const server = http.createServer(gateway.handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await fetch(`${base}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...wireBody('systemone'), state: 'SECRET-TICKET-TEXT' }),
    });

    const logged = lines.join('\n');
    expect(logged).toContain('team');
    expect(logged).not.toContain('SECRET-TICKET-TEXT');
  });
});

// ============================================================================
// Errors
// ============================================================================

describe('error envelopes', () => {
  it('400 for an unparseable body, in each dialect’s envelope', async () => {
    const { post } = await start({ backends: { primary: mock() } });

    const ts = await post('/v1/systemone', '{nope');
    expect(ts.status).toBe(400);
    expect(typeof (await ts.json()).error).toBe('string');

    const or = await post('/v1/decisions', '{nope');
    expect(or.status).toBe(400);
    expect((await or.json()).error).toEqual({ code: 400, message: expect.any(String) });

    const vc = await post('/v1/evaluate', '{nope');
    expect(vc.status).toBe(400);
    expect((await vc.json()).error).toEqual({ type: 'invalid_request_error', message: expect.any(String) });
  });

  it('400 for a well-formed JSON body that is not a decision request', async () => {
    const { post } = await start({ backends: { primary: mock() } });
    const res = await post('/v1/systemone', { state: 'x' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/questions/);
  });

  it('400 for images when no backend accepts them', async () => {
    const { post } = await start({ backends: { primary: mock() } });
    const res = await post('/v1/systemone', { ...wireBody('systemone'), images: ['iVBORw0KGgo='] });
    expect(res.status).toBe(400);
  });

  it('400 when the request exceeds the backend’s declared limits', async () => {
    const primary = mock();
    (primary.metadata.capabilities as { decisionLimits?: object }).decisionLimits = { maxQuestions: 1 };
    const { post } = await start({ backends: { primary } });
    const res = await post('/v1/systemone', wireBody('systemone'));
    expect(res.status).toBe(400);
  });

  it('404 for a model no backend serves', async () => {
    const primary = mock({
      error: new ProviderError({ code: ErrorCode.UNSUPPORTED_MODEL, message: "model 'nope' not found" }),
    });
    // UNSUPPORTED_MODEL arrives from a provider as its own category; map by code.
    const { post } = await start({ backends: { primary } });
    const res = await post('/v1/systemone', { ...wireBody('systemone'), model: 'nope' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/nope/);
  });

  it('413 over 64 KiB, in the dialect envelope, without reaching the backend', async () => {
    const primary = mock();
    const { post } = await start({ backends: { primary } });
    const big = JSON.stringify({ ...wireBody('systemone'), state: 'x'.repeat(MAX_BODY_BYTES) });
    expect(Buffer.byteLength(big)).toBeGreaterThan(MAX_BODY_BYTES);

    const ts = await post('/v1/systemone', big);
    expect(ts.status).toBe(413);
    expect(typeof (await ts.json()).error).toBe('string');

    const or = await post('/v1/decisions', big);
    expect(or.status).toBe(413);
    expect((await or.json()).error.code).toBe(413);

    const vc = await post('/v1/evaluate', big);
    expect(vc.status).toBe(413);
    expect((await vc.json()).error.type).toBe('payload_too_large');

    expect(primary.calls).toHaveLength(0);
  });

  it('accepts a body of exactly 64 KiB', async () => {
    const primary = mock();
    const { post } = await start({ backends: { primary } });
    const skeleton = JSON.stringify({ ...wireBody('systemone'), state: '' });
    const exact = JSON.stringify({
      ...wireBody('systemone'),
      state: 'x'.repeat(MAX_BODY_BYTES - Buffer.byteLength(skeleton)),
    });
    expect(Buffer.byteLength(exact)).toBe(MAX_BODY_BYTES);
    expect((await post('/v1/systemone', exact)).status).toBe(200);
  });

  it('429 from a rate-limited backend', async () => {
    const primary = mock({
      error: new RateLimitError({ code: ErrorCode.RATE_LIMIT_EXCEEDED, message: 'slow down' }),
    });
    const { post } = await start({ backends: { primary } });
    const res = await post('/v1/decisions', wireBody('openrouter'));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toEqual({ code: 429, message: expect.stringContaining('slow down') });
  });

  it('502 when the upstream backend fails', async () => {
    const primary = mock({
      error: new ProviderError({ code: ErrorCode.PROVIDER_ERROR, message: 'upstream down' }),
    });
    const { post } = await start({ backends: { primary } });
    const res = await post('/v1/evaluate', wireBody('vercel-evaluate'));
    expect(res.status).toBe(502);
    expect((await res.json()).error.type).toBe('upstream_error');
  });

  it('500 for an unexpected error', async () => {
    const primary = mock({ error: new Error('boom') });
    const { post } = await start({ backends: { primary } });
    const res = await post('/v1/systemone', wireBody('systemone'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: expect.stringContaining('boom') });
  });

  it('405 for GET on a decision route', async () => {
    const { get } = await start({ backends: { primary: mock() } });
    const res = await get('/v1/systemone');
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST, OPTIONS');
  });
});

// ============================================================================
// Auth, models, health, delegation
// ============================================================================

describe('GATEWAY_API_KEY auth', () => {
  it('is off when no key is configured', async () => {
    const { post } = await start({ backends: { primary: mock() } });
    expect((await post('/v1/systemone', wireBody('systemone'))).status).toBe(200);
  });

  it('requires a matching bearer token when a key is configured', async () => {
    const primary = mock();
    const { post, get } = await start({ backends: { primary }, apiKey: 'sekret' });
    const body = wireBody('systemone');

    expect((await post('/v1/systemone', body)).status).toBe(401);
    expect((await post('/v1/systemone', body, { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await post('/v1/systemone', body, { authorization: 'sekret' })).status).toBe(401);
    expect(primary.calls).toHaveLength(0);

    const ok = await post('/v1/systemone', body, { authorization: 'Bearer sekret' });
    expect(ok.status).toBe(200);

    expect((await get('/v1/models')).status).toBe(401);
    expect((await get('/v1/models', { authorization: 'Bearer sekret' })).status).toBe(200);
  });

  it('uses the dialect envelope for a 401 on a decision route, and leaves /health open', async () => {
    const { post, get } = await start({ backends: { primary: mock() }, apiKey: 'sekret' });
    expect((await (await post('/v1/decisions', {})).json()).error).toEqual({
      code: 401,
      message: expect.any(String),
    });
    expect((await (await post('/v1/evaluate', {})).json()).error.type).toBe('authentication_error');
    expect((await get('/health')).status).toBe(200);
  });
});

describe('GET /v1/models and /health', () => {
  it('lists decision-capable backends and their models', async () => {
    const a = mock({ name: 'a' });
    (a.metadata.capabilities as { decisionModels?: string[] }).decisionModels = ['tev1:0.8b', 'nimble'];
    const b = mock({ name: 'b' });
    const { get } = await start({ backends: { a, b } });

    const body = await (await get('/v1/models')).json();

    expect(body.object).toBe('list');
    expect(body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'tev1:0.8b', owned_by: 'a', kind: 'decision' }),
        expect.objectContaining({ id: 'nimble', owned_by: 'a' }),
        expect.objectContaining({ id: 'b', owned_by: 'b' }),
      ])
    );
  });

  it('reports ok and the backends on /health', async () => {
    const { get } = await start({ backends: { primary: mock() }, fallback: mock({ name: 'fb' }) });
    const res = await get('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', backends: ['primary'], fallback: 'fb' });
  });
});

describe('delegation to the core HTTP handler', () => {
  it('hands non-decision paths to CoreHTTPHandler instead of answering them itself', async () => {
    const { get, post } = await start({ backends: { primary: mock() } });
    const unknown = await get('/definitely/not/a/route');
    expect(unknown.status).toBe(404);
    // The core handler, not the decision code, answers chat: this gateway has no chat backend.
    const chat = await post('/v1/chat/completions', { model: 'x', messages: [{ role: 'user', content: 'hi' }] });
    expect(chat.status).toBeGreaterThanOrEqual(400);
  });
});

describe('createGatewayDepsFromEnv', () => {
  it('builds Ollama as the primary and the emulated model as the escalation fallback', () => {
    const deps = createGatewayDepsFromEnv({});
    expect(Object.keys(deps.backends)).toEqual(['ollama']);
    expect(deps.fallback?.metadata.name).toMatch(/decisions/);
    expect(deps.escalateBelow).toBe(0.6);
    expect(deps.apiKey).toBeUndefined();
  });

  it('adds hosted backends only when their keys are present, and reads the knobs', () => {
    const deps = createGatewayDepsFromEnv({
      TYPESAFE_API_KEY: 'k1',
      OPENROUTER_API_KEY: 'k2',
      CLOUDFLARE_ACCOUNT_ID: 'acct',
      CLOUDFLARE_API_TOKEN: 'k3',
      ESCALATE_BELOW: '0.8',
      GATEWAY_API_KEY: 'gw',
    });
    expect(Object.keys(deps.backends)).toEqual(['ollama', 'typesafe', 'openrouter', 'cloudflare']);
    expect(deps.escalateBelow).toBe(0.8);
    expect(deps.apiKey).toBe('gw');
  });
});

// ============================================================================
// Live smoke (opt-in): the real server against a local Ollama
// ============================================================================

describe.skipIf(process.env.OLLAMA_LIVE !== '1')('live smoke against Ollama', () => {
  it(
    'answers the same ticket on all three dialects with equivalent answers',
    async () => {
      const deps = createGatewayDepsFromEnv({
        OLLAMA_URL: process.env.OLLAMA_URL ?? 'http://localhost:11434',
        DECISION_MODEL: process.env.DECISION_MODEL ?? 'tev1:0.8b',
        ESCALATE_BELOW: '0', // never escalate: this checks the dialects, not the fallback
      });
      const { post } = await start(deps);
      const q = {
        refund: { type: 'noul', instructions: 'Is the customer asking for a refund?' },
        team: {
          type: 'choice',
          instructions: 'Which team should handle this?',
          criteria: { billing: 'payments, charges, refunds', technical: 'bugs, outages, errors' },
        },
      };
      const state = 'I was charged twice for my subscription this month. Please refund the duplicate charge.';
      const bodyFor = (noul: string) => ({
        state,
        questions: { ...q, refund: { ...q.refund, type: noul } },
      });

      const [ts, or, vc] = await Promise.all([
        post('/v1/systemone', bodyFor('noul')).then((r) => r.json()),
        post('/v1/decisions', bodyFor('noul')).then((r) => r.json()),
        post('/v1/evaluate', bodyFor('boolean')).then((r) => r.json()),
      ]);
      console.log('LIVE /v1/systemone', JSON.stringify(ts));
      console.log('LIVE /v1/decisions', JSON.stringify(or));
      console.log('LIVE /v1/evaluate', JSON.stringify(vc));

      // Same ticket, same model: same choice and the same side of 0.5 on every dialect.
      expect(ts.answers.team.choice).toBe(or.answers.team.choice);
      expect(ts.answers.team.choice).toBe(vc.answers.team.choice);
      const side = (p: number) => p >= 0.5;
      expect(side(ts.answers.refund.noul)).toBe(side(or.answers.refund.noul));
      expect(side(ts.answers.refund.noul)).toBe(side(vc.answers.refund.probability));
    },
    300_000
  );
});
