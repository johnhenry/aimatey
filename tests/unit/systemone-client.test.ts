/**
 * SystemOne client tests: request building and response parsing for every
 * dialect (systemone, openrouter, vercel-evaluate, openai-decisions,
 * cloudflare), and the shared POST helper's error mapping.
 *
 * Fixtures are hand-written from the wire shapes documented in
 * docs/plans/decision-models.md; the real Ollama replay lives in
 * ollama-decisions.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildSystemOneRequest,
  parseSystemOneResponse,
  postSystemOne,
  SYSTEMONE_DIALECTS,
} from '@johnhenry/aimatey-backend';
import { AuthenticationError } from '@johnhenry/aimatey-errors';
import type { IRDecisionRequest } from '@johnhenry/aimatey-types';

const ir: IRDecisionRequest = {
  state: 'Subject: Duplicate charge. Body: Please refund me today.',
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: { billing: 'invoices, refunds', technical: 'bugs, outages' },
    },
    urgency: {
      type: 'score',
      instructions: 'How urgent is this?',
      criteria: ['low', 'medium', 'high'],
    },
    refund: {
      type: 'noul',
      instructions: 'Does the user request a refund?',
      criteria: { true: 'asks for money back', false: 'does not' },
    },
  },
  parameters: { model: 'some-model' },
  metadata: { requestId: 'req_1', timestamp: 0 },
};

const noulOnly: IRDecisionRequest = {
  state: 'x',
  questions: { ok: { type: 'noul', instructions: 'Is it ok?' } },
  metadata: { requestId: 'req_2', timestamp: 0 },
};

const png = {
  type: 'image' as const,
  source: { type: 'base64' as const, mediaType: 'image/png', data: 'AAAA' },
};

// ============================================================================
// buildSystemOneRequest
// ============================================================================

describe('buildSystemOneRequest', () => {
  it("'systemone' sends {model, state, questions} with types, nothing else", () => {
    const body = buildSystemOneRequest(ir, { dialect: 'systemone' });
    expect(body).toEqual({ model: 'some-model', state: ir.state, questions: ir.questions });
  });

  it('opts.model overrides parameters.model', () => {
    const body = buildSystemOneRequest(ir, { dialect: 'systemone', model: 'override' });
    expect(body.model).toBe('override');
  });

  it('includeType: false strips `type` from every question', () => {
    const body = buildSystemOneRequest(ir, { dialect: 'systemone', includeType: false });
    const questions = body.questions as Record<string, Record<string, unknown>>;
    for (const q of Object.values(questions)) expect(q).not.toHaveProperty('type');
    expect(questions.department.criteria).toEqual({ billing: 'invoices, refunds', technical: 'bugs, outages' });
  });

  it('sends base64 images as bare base64 strings only when sendImages is set', () => {
    const withImages = { ...ir, images: [png] };
    expect(buildSystemOneRequest(withImages, { dialect: 'systemone' })).not.toHaveProperty(
      'images'
    );
    expect(
      buildSystemOneRequest(withImages, { dialect: 'systemone', sendImages: true }).images
    ).toEqual(['AAAA']);
  });

  it('rejects url image sources with a non-retryable ProviderError', () => {
    const urlImage = {
      type: 'image' as const,
      source: { type: 'url' as const, url: 'https://example.com/a.png' },
    };
    expect(() =>
      buildSystemOneRequest(
        { ...ir, images: [urlImage] },
        { dialect: 'systemone', sendImages: true, backendName: 'ollama-backend' }
      )
    ).toThrow(/url.*base64|base64.*url/i);
  });

  it('forwards parameters.custom.keepAlive as keep_alive', () => {
    const body = buildSystemOneRequest(
      { ...ir, parameters: { custom: { keepAlive: '10m' } } },
      { dialect: 'systemone', model: 'm' }
    );
    expect(body.keep_alive).toBe('10m');
  });

  it("'openrouter' adds provider, trace and session_id from parameters.custom", () => {
    const body = buildSystemOneRequest(
      {
        ...ir,
        parameters: {
          custom: { provider: { order: ['typesafe'] }, trace: true, sessionId: 's-1' },
        },
      },
      { dialect: 'openrouter', model: 'typesafe/jev-1.13.0' }
    );
    expect(body.provider).toEqual({ order: ['typesafe'] });
    expect(body.trace).toBe(true);
    expect(body.session_id).toBe('s-1');
    expect(body.model).toBe('typesafe/jev-1.13.0');
  });

  it("'openrouter' omits the extras when absent", () => {
    const body = buildSystemOneRequest(ir, { dialect: 'openrouter' });
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('trace');
    expect(body).not.toHaveProperty('session_id');
  });

  it("'vercel-evaluate' renames noul to boolean", () => {
    const body = buildSystemOneRequest(ir, { dialect: 'vercel-evaluate' });
    const questions = body.questions as Record<string, { type: string }>;
    expect(questions.refund.type).toBe('boolean');
    expect(questions.department.type).toBe('choice');
    expect(questions.urgency.type).toBe('score');
  });

  it("'openai-decisions' renames noul to predicate and score to rubric", () => {
    const body = buildSystemOneRequest(ir, { dialect: 'openai-decisions' });
    const questions = body.questions as Record<string, { type: string }>;
    expect(questions.refund.type).toBe('predicate');
    expect(questions.urgency.type).toBe('rubric');
    expect(questions.department.type).toBe('choice');
  });

  it("'cloudflare' keeps the model out of the body (it is in the URL)", () => {
    const body = buildSystemOneRequest(ir, { dialect: 'cloudflare', model: 'clef' });
    expect(body).not.toHaveProperty('model');
    expect(body.state).toBe(ir.state);
  });

  it('exposes a data-driven dialect table covering every dialect', () => {
    expect(Object.keys(SYSTEMONE_DIALECTS).sort()).toEqual([
      'cloudflare',
      'openai-decisions',
      'openrouter',
      'systemone',
      'vercel-evaluate',
    ]);
  });
});

// ============================================================================
// parseSystemOneResponse
// ============================================================================

describe('parseSystemOneResponse', () => {
  const opts = { dialect: 'systemone' as const, backendName: 'test-backend' };

  it('parses the TypeSafe example (no `type` on answers, array probabilities)', () => {
    const res = parseSystemOneResponse(
      {
        id: 'dec_1',
        answers: {
          department: { choice: 'billing', probabilities: { billing: 0.9, technical: 0.1 }, confidence: 0.9 },
          urgency: { score: 1.2, probabilities: [0.1, 0.3, 0.6], confidence: 0.6 },
          refund: { noul: 0.98 },
        },
        model: 'jev-1.13.0',
        usage: { input_tokens: 275, output_tokens: 20, cost: 0.00003 },
      },
      ir,
      opts
    );
    expect(res.answers.department).toEqual({
      type: 'choice',
      value: 'billing',
      probabilities: { billing: 0.9, technical: 0.1 },
      confidence: 0.9,
    });
    expect(res.answers.urgency).toEqual({
      type: 'score',
      value: 1.2,
      probabilities: [0.1, 0.3, 0.6],
      confidence: 0.6,
    });
    // Jev reports no noul confidence, and none is fabricated.
    expect(res.answers.refund).toEqual({ type: 'noul', value: 0.98 });
    expect(res.id).toBe('dec_1');
    expect(res.model).toBe('jev-1.13.0');
    expect(res.usage).toEqual({
      inputTokens: 275,
      outputTokens: 20,
      cost: 0.00003,
      details: { cost: 0.00003 },
    });
    expect(res.metadata.provenance?.backend).toBe('test-backend');
  });

  it('parses the Ollama example: `type` present, `legend` ignored, object score probabilities', () => {
    const res = parseSystemOneResponse(
      {
        model: 'tev1:0.8b',
        answers: {
          department: {
            type: 'choice',
            choice: 'billing',
            probabilities: { billing: 0.99, technical: 0.01 },
            confidence: 0.91,
          },
          refund: { type: 'noul', noul: 0.995 },
          urgency: {
            type: 'score',
            score: 1.5,
            legend: { '0': 'low', '1': 'medium', '2': 'high' },
            // Out of numeric order on purpose, and "10"-style keys sort numerically.
            probabilities: { '2': 0.57, '0': 0.06, '1': 0.37 },
            confidence: 0.21,
          },
        },
        usage: { input_tokens: 670, output_tokens: 4 },
      },
      ir,
      { ...opts, dialect: 'systemone' }
    );
    expect(res.answers.urgency).toEqual({
      type: 'score',
      value: 1.5,
      probabilities: [0.06, 0.37, 0.57],
      confidence: 0.21,
    });
    expect((res.answers.urgency as any).legend).toBeUndefined();
    expect(res.usage).toEqual({ inputTokens: 670, outputTokens: 4 });
  });

  it('orders object probabilities numerically, not lexically', () => {
    const levels = Array.from({ length: 11 }, (_, i) => `l${i}`);
    const req: IRDecisionRequest = {
      ...noulOnly,
      questions: { q: { type: 'score', instructions: 'x', criteria: levels } },
    };
    const probs: Record<string, number> = {};
    levels.forEach((_, i) => (probs[String(i)] = i / 55));
    const res = parseSystemOneResponse(
      { model: 'm', answers: { q: { score: 10, probabilities: probs } } },
      req,
      opts
    );
    const out = (res.answers.q as any).probabilities as number[];
    expect(out).toHaveLength(11);
    expect(out[10]).toBeCloseTo(10 / 55);
    expect(out[2]).toBeCloseTo(2 / 55);
  });

  it('leaves probabilities/confidence absent when the provider sends neither (OpenRouter optional fields)', () => {
    const res = parseSystemOneResponse(
      {
        id: 'or-dec-9',
        provider: 'Typesafe',
        model: 'typesafe/jev-1.13.0',
        answers: {
          department: { type: 'choice', choice: 'technical' },
          urgency: { type: 'score', score: 2 },
          refund: { type: 'noul', noul: 0.1 },
        },
        usage: { input_tokens: 100, output_tokens: 0, cost: 0.0000042 },
      },
      ir,
      { ...opts, dialect: 'openrouter' }
    );
    expect(res.answers.department).toEqual({ type: 'choice', value: 'technical' });
    expect(res.answers.urgency).toEqual({ type: 'score', value: 2 });
    expect(res.id).toBe('or-dec-9');
    expect(res.provider).toBe('Typesafe');
    expect(res.usage?.cost).toBe(0.0000042);
  });

  it('falls back to opts.provider when the body names none', () => {
    const res = parseSystemOneResponse(
      { model: 'm', answers: { ok: { noul: 0.5 } } },
      noulOnly,
      { ...opts, provider: 'typesafe' }
    );
    expect(res.provider).toBe('typesafe');
  });

  it('only derives noul confidence when asked to', () => {
    const body = { model: 'm', answers: { ok: { noul: 0.2 } } };
    expect(parseSystemOneResponse(body, noulOnly, opts).answers.ok).toEqual({
      type: 'noul',
      value: 0.2,
    });
    const derived = parseSystemOneResponse(body, noulOnly, { ...opts, deriveNoulConfidence: true });
    expect((derived.answers.ok as any).confidence).toBeCloseTo(0.8);
    // A provider-reported confidence always wins over derivation.
    const reported = parseSystemOneResponse(
      { model: 'm', answers: { ok: { noul: 0.2, confidence: 0.5 } } },
      noulOnly,
      { ...opts, deriveNoulConfidence: true }
    );
    expect((reported.answers.ok as any).confidence).toBe(0.5);
  });

  it("parses the Vercel example: `boolean` + `probability`, camelCase usage", () => {
    const res = parseSystemOneResponse(
      {
        model: 'typesafe/jev-1.13.0',
        answers: {
          department: {
            type: 'choice',
            choice: 'billing',
            probabilities: { billing: 0.8, technical: 0.2 },
            confidence: 0.8,
          },
          urgency: { type: 'score', score: 0, probabilities: [0.7, 0.2, 0.1], confidence: 0.7 },
          refund: { type: 'boolean', probability: 0.93 },
        },
        usage: { inputTokens: 210, outputTokens: 0 },
        providerMetadata: { gateway: { routing: { finalProvider: 'typesafe' } } },
      },
      ir,
      { ...opts, dialect: 'vercel-evaluate' }
    );
    expect(res.answers.refund).toEqual({ type: 'noul', value: 0.93 });
    expect(res.usage).toEqual({ inputTokens: 210, outputTokens: 0 });
    expect(res.raw?.providerMetadata).toBeDefined();
  });

  it("unwraps Cloudflare's `result` envelope", () => {
    const res = parseSystemOneResponse(
      {
        success: true,
        errors: [],
        result: {
          model: '@cf/cloudflare/clef',
          answers: { ok: { type: 'noul', noul: 0.77 } },
          usage: { input_tokens: 12, output_tokens: 1 },
        },
      },
      noulOnly,
      { ...opts, dialect: 'cloudflare' }
    );
    expect(res.answers.ok).toEqual({ type: 'noul', value: 0.77 });
    expect(res.model).toBe('@cf/cloudflare/clef');
    expect(res.usage?.inputTokens).toBe(12);
  });

  it("maps OpenAI's predicate/rubric answer types back (unverified dialect)", () => {
    const res = parseSystemOneResponse(
      {
        model: 'm',
        answers: {
          department: { type: 'choice', choice: 'billing' },
          urgency: { type: 'rubric', score: 1 },
          refund: { type: 'predicate', probability: 0.4 },
        },
      },
      ir,
      { ...opts, dialect: 'openai-decisions' }
    );
    expect(res.answers.urgency).toEqual({ type: 'score', value: 1 });
    expect(res.answers.refund).toEqual({ type: 'noul', value: 0.4 });
  });

  it('retains the raw body and falls back to the request model', () => {
    const body = { answers: { ok: { noul: 0.5 } }, extra: 1 };
    const res = parseSystemOneResponse(body, { ...noulOnly, parameters: { model: 'asked' } }, opts);
    expect(res.raw).toEqual(body);
    expect(res.model).toBe('asked');
  });

  it('throws a ProviderError naming the question when an answer is missing', () => {
    expect(() =>
      parseSystemOneResponse({ model: 'm', answers: { department: { choice: 'billing' } } }, ir, opts)
    ).toThrow(/urgency/);
  });

  it('throws naming the question when an answer has the wrong shape', () => {
    expect(() =>
      parseSystemOneResponse({ model: 'm', answers: { ok: { choice: 'x' } } }, noulOnly, opts)
    ).toThrow(/ok/);
  });

  it('throws when the declared answer type contradicts the question', () => {
    expect(() =>
      parseSystemOneResponse(
        { model: 'm', answers: { ok: { type: 'choice', noul: 0.5 } } },
        noulOnly,
        opts
      )
    ).toThrow(/ok/);
  });

  it('surfaces validateDecisionResponse warnings on metadata.warnings', () => {
    const res = parseSystemOneResponse(
      {
        model: 'm',
        answers: {
          department: { choice: 'billing', probabilities: { billing: 0.2, technical: 0.2 } },
          urgency: { score: 1 },
          refund: { noul: 0.5 },
        },
      },
      ir,
      opts
    );
    expect(res.metadata.warnings?.some((w) => w.category === 'response-malformed')).toBe(true);
  });

  it('rejects a choice that is not one of the question criteria (validation)', () => {
    expect(() =>
      parseSystemOneResponse(
        {
          model: 'm',
          answers: {
            department: { choice: 'legal' },
            urgency: { score: 1 },
            refund: { noul: 0.5 },
          },
        },
        ir,
        opts
      )
    ).toThrow(/legal/);
  });

  it('keeps request warnings and appends extra ones', () => {
    const res = parseSystemOneResponse(
      { model: 'm', answers: { ok: { noul: 0.5 } } },
      {
        ...noulOnly,
        metadata: {
          ...noulOnly.metadata,
          warnings: [
            { category: 'parameter-normalized', severity: 'info', message: 'earlier', source: 's' },
          ],
        },
      },
      {
        ...opts,
        warnings: [
          { category: 'capability-unsupported', severity: 'warning', message: 'extra', source: 's' },
        ],
      }
    );
    expect(res.metadata.warnings?.map((w) => w.message)).toEqual(['earlier', 'extra']);
  });
});

// ============================================================================
// postSystemOne
// ============================================================================

describe('postSystemOne', () => {
  const okFetch = (json: unknown, ok = true, status = 200) =>
    vi.fn().mockResolvedValueOnce({
      ok,
      status,
      statusText: ok ? 'OK' : 'Err',
      json: async () => json,
      text: async () => JSON.stringify(json),
    });

  it('POSTs JSON with the supplied headers and signal, returning the parsed body', async () => {
    const fetchImpl = okFetch({ answers: {} });
    const controller = new AbortController();
    const out = await postSystemOne(
      'http://x/v1/systemone',
      { state: 's', questions: {} },
      {
        headers: { Authorization: 'Bearer k' },
        signal: controller.signal,
        backendName: 'b',
        fetchImpl,
      }
    );
    expect(out).toEqual({ answers: {} });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://x/v1/systemone');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers.Authorization).toBe('Bearer k');
    expect(init.signal).toBe(controller.signal);
    expect(JSON.parse(init.body)).toEqual({ state: 's', questions: {} });
  });

  it('maps HTTP errors through the shared error helper (401 -> authentication)', async () => {
    const fetchImpl = okFetch({ error: 'bad key' }, false, 401);
    await expect(
      postSystemOne('http://x', {}, { backendName: 'b', fetchImpl })
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('wraps network failures in a retryable ProviderError', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(postSystemOne('http://x', {}, { backendName: 'b', fetchImpl })).rejects.toMatchObject(
      { isRetryable: true, message: expect.stringContaining('fetch failed') }
    );
  });

  it('lets an abort through unchanged', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const fetchImpl = vi.fn().mockRejectedValueOnce(abort);
    await expect(postSystemOne('http://x', {}, { backendName: 'b', fetchImpl })).rejects.toBe(abort);
  });

  it('throws a ProviderError when the body is not JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
      text: async () => '<html>',
    });
    await expect(postSystemOne('http://x', {}, { backendName: 'b', fetchImpl })).rejects.toThrow(
      /not valid JSON|Unexpected token/
    );
  });
});
