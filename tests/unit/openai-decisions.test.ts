/**
 * OpenAI Decisions API (#180): `OpenAIBackendAdapter.decide()` against
 * `POST /v1/decisions`, the request builder and response parser in
 * `decisions/openai-decisions.ts`, and replay of the live probe fixtures in
 * fixtures/decisions-openai/ (recorded from the real API, 2026-10-06).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  OpenAIBackendAdapter,
  InceptionBackendAdapter,
  LMStudioBackendAdapter,
  OmniRouteBackendAdapter,
  GroqBackendAdapter,
  buildOpenAIDecisionsRequest,
  parseOpenAIDecisionsResponse,
} from '@johnhenry/aimatey-backend';
import { ProviderError } from '@johnhenry/aimatey-errors';
import { supportsDecisions } from '@johnhenry/aimatey-utils';
import { loadFixture } from '@johnhenry/aimatey-testing';
import type { IRDecisionRequest } from '@johnhenry/aimatey-types';

const MODEL = 'gpt-6-luna';

const request: IRDecisionRequest = {
  state: 'Subject: Duplicate charge. Body: I was billed twice this month, please refund me today.',
  questions: {
    team: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: {
        billing: 'invoices, refunds, charges',
        technical: 'bugs, outages',
        account: 'logins, profile changes',
      },
    },
    refund: { type: 'noul', instructions: 'Does the customer ask for a refund?' },
    urgency: {
      type: 'score',
      instructions: 'How urgent is this?',
      criteria: ['routine', 'soon', 'urgent'],
    },
  },
  parameters: { model: MODEL },
  metadata: { requestId: 'req_1', timestamp: 0 },
};

const image = {
  type: 'image' as const,
  source: { type: 'base64' as const, mediaType: 'image/png', data: 'QUJD' },
};

function mockFetch(response: unknown, status = 200) {
  const ok = status >= 200 && status < 300;
  const fn = vi.fn().mockResolvedValueOnce({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => response,
    text: async () => JSON.stringify(response),
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const callOf = (fn: ReturnType<typeof mockFetch>) => {
  const [url, init] = fn.mock.calls[0]!;
  return { url: url as string, init, body: JSON.parse(init.body) };
};

const usage = {
  input_tokens: 403,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  output_tokens: 0,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 403,
};

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

// ============================================================================
// Request building
// ============================================================================

describe('buildOpenAIDecisionsRequest', () => {
  it('sends a string state as `input` and questions as a named array', () => {
    const body = buildOpenAIDecisionsRequest(request, { model: MODEL });
    expect(body).toEqual({
      model: MODEL,
      input: request.state,
      questions: [
        {
          name: 'team',
          type: 'choice',
          instructions: 'Which team should handle this?',
          choices: [
            { value: 'billing', description: 'invoices, refunds, charges' },
            { value: 'technical', description: 'bugs, outages' },
            { value: 'account', description: 'logins, profile changes' },
          ],
        },
        { name: 'refund', type: 'predicate', instructions: 'Does the customer ask for a refund?' },
        {
          name: 'urgency',
          type: 'score',
          instructions: 'How urgent is this?',
          levels: [
            { label: 'routine', description: 'routine' },
            { label: 'soon', description: 'soon' },
            { label: 'urgent', description: 'urgent' },
          ],
        },
      ],
    });
  });

  it('never sends the System One keys (state, rubric, noul, object questions)', () => {
    const body = buildOpenAIDecisionsRequest(request, { model: MODEL });
    expect('state' in body).toBe(false);
    expect(Array.isArray(body.questions)).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/"noul"|"rubric"|"criteria"/);
  });

  it('serializes an object or array state as JSON text (the API rejects raw objects)', () => {
    const doc = { subject: 'Duplicate charge', lines: [1, 2] };
    expect(buildOpenAIDecisionsRequest({ ...request, state: doc }, { model: MODEL }).input).toBe(
      JSON.stringify(doc)
    );
    expect(buildOpenAIDecisionsRequest({ ...request, state: [1, 2] }, { model: MODEL }).input).toBe(
      '[1,2]'
    );
  });

  it('keeps an empty string state as an empty string', () => {
    expect(buildOpenAIDecisionsRequest({ ...request, state: '' }, { model: MODEL }).input).toBe('');
  });

  it('wraps text and base64 images in a user message with data URLs', () => {
    const body = buildOpenAIDecisionsRequest(
      {
        ...request,
        images: [image, { ...image, source: { ...image.source, mediaType: 'image/jpeg' } }],
      },
      { model: MODEL }
    );
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: request.state },
          { type: 'input_image', image_url: 'data:image/png;base64,QUJD' },
          { type: 'input_image', image_url: 'data:image/jpeg;base64,QUJD' },
        ],
      },
    ]);
  });

  it('rejects a url image source (the API accepts only data: URLs)', () => {
    expect(() =>
      buildOpenAIDecisionsRequest(
        {
          ...request,
          images: [{ type: 'image', source: { type: 'url', url: 'https://x.test/a.png' } }],
        },
        { model: MODEL }
      )
    ).toThrow(ProviderError);
    expect(() =>
      buildOpenAIDecisionsRequest(
        {
          ...request,
          images: [{ type: 'image', source: { type: 'url', url: 'https://x.test/a.png' } }],
        },
        { model: MODEL }
      )
    ).toThrow(/data/);
  });

  it('folds noul criteria into the instructions', () => {
    const body = buildOpenAIDecisionsRequest(
      {
        ...request,
        questions: {
          refund: {
            type: 'noul',
            instructions: 'Wants a refund?',
            criteria: { true: 'asks for money back', false: 'does not' },
          },
        },
      },
      { model: MODEL }
    );
    const q = body.questions[0] as { instructions: string; criteria?: unknown };
    expect(q.instructions).toContain('Wants a refund?');
    expect(q.instructions).toContain('asks for money back');
    expect(q.instructions).toContain('does not');
    expect('criteria' in q).toBe(false);
  });

  it("splits score levels written as 'label: description'", () => {
    const body = buildOpenAIDecisionsRequest(
      {
        ...request,
        questions: {
          urgency: {
            type: 'score',
            instructions: 'How urgent?',
            criteria: ['low: can wait a week', 'high: needs action today', 'plain'],
          },
        },
      },
      { model: MODEL }
    );
    expect((body.questions[0] as { levels: unknown }).levels).toEqual([
      { label: 'low', description: 'can wait a week' },
      { label: 'high', description: 'needs action today' },
      { label: 'plain', description: 'plain' },
    ]);
  });
});

// ============================================================================
// Response parsing
// ============================================================================

const triageWire = {
  model: MODEL,
  answers: [
    {
      type: 'choice',
      name: 'team',
      choice: 'billing',
      probabilities: [
        { value: 'billing', probability: 0.97 },
        { value: 'technical', probability: 0.01 },
        { value: 'account', probability: 0.02 },
      ],
      confidence: 0.96,
    },
    { type: 'predicate', name: 'refund', probability: 1.0 },
    {
      type: 'score',
      name: 'urgency',
      score: 1.56,
      probabilities: [
        // Deliberately out of order: the parser must order by `value`.
        { value: 2, label: 'urgent', probability: 0.6 },
        { value: 0, label: 'routine', probability: 0.04 },
        { value: 1, label: 'soon', probability: 0.36 },
      ],
      confidence: 0.34,
    },
  ],
  usage,
};

describe('parseOpenAIDecisionsResponse', () => {
  const parse = (body: unknown, ir: IRDecisionRequest = request) =>
    parseOpenAIDecisionsResponse(body, ir, { backendName: 'openai-backend' });

  it('maps answers by name, probabilities to the IR shapes, and passes confidence through', () => {
    const res = parse(triageWire);
    expect(res.answers.team).toEqual({
      type: 'choice',
      value: 'billing',
      probabilities: { billing: 0.97, technical: 0.01, account: 0.02 },
      confidence: 0.96,
    });
    expect(res.answers.refund).toEqual({ type: 'noul', value: 1 });
    expect(res.answers.urgency).toEqual({
      type: 'score',
      value: 1.56,
      probabilities: [0.04, 0.36, 0.6],
      confidence: 0.34,
    });
  });

  it('matches by name, not position', () => {
    const res = parse({ ...triageWire, answers: [...triageWire.answers].reverse() });
    expect(res.answers.team).toMatchObject({ value: 'billing' });
    expect(res.answers.refund).toMatchObject({ value: 1 });
  });

  it('does not fabricate a noul confidence', () => {
    const res = parse(triageWire);
    expect('confidence' in res.answers.refund).toBe(false);
  });

  it('reports usage with both *_details objects, provider openai, and keeps raw', () => {
    const res = parse(triageWire);
    expect(res.model).toBe(MODEL);
    expect(res.provider).toBe('openai');
    expect(res.usage).toEqual({
      inputTokens: 403,
      outputTokens: 0,
      details: {
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    });
    expect(res.raw).toBe(triageWire);
    expect(res.metadata.provenance?.backend).toBe('openai-backend');
  });

  it('throws a ProviderError naming a question the response left unanswered', () => {
    const body = { ...triageWire, answers: triageWire.answers.filter((a) => a.name !== 'refund') };
    expect(() => parse(body)).toThrow(ProviderError);
    expect(() => parse(body)).toThrow(/'refund'/);
  });

  it('throws when an answer has the wrong type for its question', () => {
    const body = {
      ...triageWire,
      answers: triageWire.answers.map((a) =>
        a.name === 'refund' ? { type: 'choice', name: 'refund', choice: 'x' } : a
      ),
    };
    expect(() => parse(body)).toThrow(/'refund'/);
  });

  it('throws when the body has no answers array', () => {
    expect(() => parse({ model: MODEL })).toThrow(/answers/);
  });

  it('tolerates a missing probabilities array and missing usage', () => {
    const res = parse(
      {
        model: MODEL,
        answers: [{ type: 'choice', name: 'team', choice: 'billing' }],
      },
      { ...request, questions: { team: request.questions.team! } }
    );
    expect(res.answers.team).toEqual({ type: 'choice', value: 'billing' });
    expect(res.usage).toBeUndefined();
  });
});

// ============================================================================
// Adapter
// ============================================================================

describe('OpenAIBackendAdapter decisions', () => {
  const make = (config: Record<string, unknown> = {}) =>
    new OpenAIBackendAdapter({ apiKey: 'sk-test', ...config });

  it('declares decision capabilities on api.openai.com', () => {
    const adapter = make();
    const caps = adapter.metadata.capabilities;
    expect(supportsDecisions(adapter)).toBe(true);
    expect(caps.decisions).toBe(true);
    expect(caps.decisionTypes).toEqual(['choice', 'score', 'noul']);
    expect(caps.decisionImages).toBe(true);
    expect(caps.decisionModels).toEqual([MODEL]);
    // Verified live 2026-10-06 (fixtures/decisions-openai/limit-probes.json).
    expect(caps.decisionLimits).toMatchObject({
      maxChoiceOptions: 255,
      maxScoreLevels: 10,
      maxQuestions: 200,
    });
  });

  it('POSTs to <baseURL>/decisions with bearer auth and the wire body', async () => {
    const fn = mockFetch(triageWire);
    const res = await make().decide(request);
    const { url, init, body } = callOf(fn);
    expect(url).toBe('https://api.openai.com/v1/decisions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(body).toEqual(buildOpenAIDecisionsRequest(request, { model: MODEL }));
    expect(res.answers.team).toMatchObject({ type: 'choice', value: 'billing' });
    expect(res.metadata.provenance).toMatchObject({ backend: 'openai-backend' });
  });

  it('forwards configured headers (organization, project) and uses a custom baseURL', async () => {
    const fn = mockFetch(triageWire);
    await make({
      baseURL: 'https://proxy.test/v1',
      decisions: true,
      headers: { 'OpenAI-Organization': 'org_1', 'OpenAI-Project': 'proj_1' },
    }).decide(request);
    const { url, init } = callOf(fn);
    expect(url).toBe('https://proxy.test/v1/decisions');
    expect(init.headers['OpenAI-Organization']).toBe('org_1');
    expect(init.headers['OpenAI-Project']).toBe('proj_1');
  });

  it('defaults the model to gpt-6-luna, honours defaultModel, and prefers the request', async () => {
    const noModel = { ...request, parameters: undefined };
    let fn = mockFetch(triageWire);
    await make().decide(noModel);
    expect(callOf(fn).body.model).toBe(MODEL);
    fn = mockFetch(triageWire);
    await make({ defaultModel: 'gpt-6-sol' }).decide(noModel);
    expect(callOf(fn).body.model).toBe('gpt-6-sol');
    fn = mockFetch(triageWire);
    await make({ defaultModel: 'gpt-6-sol' }).decide({ ...request, parameters: { model: 'x' } });
    expect(callOf(fn).body.model).toBe('x');
  });

  it('sends images as an input message', async () => {
    const fn = mockFetch(triageWire);
    await make().decide({ ...request, images: [image] });
    const { body } = callOf(fn);
    expect(body.input[0].content[1]).toEqual({
      type: 'input_image',
      image_url: 'data:image/png;base64,QUJD',
    });
  });

  it('maps HTTP errors through the shared error mapper', async () => {
    mockFetch({ error: { message: 'bad key' } }, 401);
    await expect(make().decide(request)).rejects.toThrow();
    mockFetch(
      { error: { message: "Invalid 'questions': array too long", code: 'array_above_max_length' } },
      400
    );
    await expect(make().decide(request)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('rethrows an abort untouched', async () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    global.fetch = vi.fn().mockRejectedValue(err) as unknown as typeof fetch;
    await expect(make().decide(request, new AbortController().signal)).rejects.toBe(err);
  });

  it('returns null from estimateDecisionCost: OpenAI has not published a price', async () => {
    await expect(make().estimateDecisionCost(request)).resolves.toBeNull();
  });
});

describe('decisions stay off for OpenAI-compatible subclasses', () => {
  it('LM Studio, OmniRoute and other OpenAI-compatible adapters do not gain decide()', () => {
    for (const adapter of [
      new LMStudioBackendAdapter({}),
      new OmniRouteBackendAdapter({}),
      new GroqBackendAdapter({ apiKey: 'k' }),
    ]) {
      expect(adapter.metadata.capabilities.decisions).toBeFalsy();
      expect(supportsDecisions(adapter)).toBe(false);
      expect(typeof (adapter as { decide?: unknown }).decide).not.toBe('function');
    }
  });

  it("Inception keeps its own System One decide() (not OpenAI's /decisions)", async () => {
    const adapter = new InceptionBackendAdapter({ apiKey: 'k' });
    expect(supportsDecisions(adapter)).toBe(true);
    expect(adapter.metadata.capabilities.decisionModels).toEqual(['mercury-decide']);
    const fn = mockFetch({
      model: 'mercury-decide',
      answers: { team: { choice: 'billing' }, refund: { noul: 0.5 }, urgency: { score: 1 } },
    });
    await adapter.decide(request);
    expect(callOf(fn).url).toMatch(/\/systemone$/);
  });

  it('an OpenAI-compatible server opts in with decisions: true', () => {
    const adapter = new OpenAIBackendAdapter({
      apiKey: 'k',
      baseURL: 'http://localhost:1234/v1',
      decisions: true,
    });
    expect(supportsDecisions(adapter)).toBe(true);
    const off = new OpenAIBackendAdapter({ apiKey: 'k', baseURL: 'http://localhost:1234/v1' });
    expect(supportsDecisions(off)).toBe(false);
    expect(off.metadata.capabilities.decisions).toBeFalsy();
  });

  it('decisions: false turns it off even on api.openai.com', () => {
    const adapter = new OpenAIBackendAdapter({ apiKey: 'k', decisions: false });
    expect(supportsDecisions(adapter)).toBe(false);
  });
});

// ============================================================================
// Fixture replay (live probes, 2026-10-06)
// ============================================================================

interface OpenAIFixture {
  request: IRDecisionRequest;
  providerRequest?: unknown;
  providerResponse: unknown;
  limitProbes?: Array<{ what: string; status: number; message?: string }>;
}

describe('replay of fixtures/decisions-openai', () => {
  const load = async (scenario: string) =>
    (await loadFixture('decisions-openai', scenario)) as unknown as OpenAIFixture;

  for (const scenario of [
    'choice-single',
    'score-single',
    'predicate-blank',
    'triage-choice-predicate-score',
    'live-triage',
    'live-image',
  ]) {
    it(`${scenario}: the builder reproduces the recorded wire request and the parser the answers`, async () => {
      const fixture = await load(scenario);
      expect(buildOpenAIDecisionsRequest(fixture.request, { model: MODEL })).toEqual(
        fixture.providerRequest
      );
      const fn = mockFetch(fixture.providerResponse);
      const res = await new OpenAIBackendAdapter({ apiKey: 'k' }).decide(fixture.request);
      expect(callOf(fn).body).toEqual(fixture.providerRequest);
      expect(Object.keys(res.answers)).toEqual(Object.keys(fixture.request.questions));
      expect(res.usage?.inputTokens).toBeGreaterThan(0);
      expect(res.usage?.outputTokens).toBe(0);
    });
  }

  it('triage: parses the recorded choice, predicate and score answers', async () => {
    const fixture = await load('triage-choice-predicate-score');
    const res = parseOpenAIDecisionsResponse(fixture.providerResponse, fixture.request, {
      backendName: 'openai-backend',
    });
    expect(res.answers.team).toEqual({
      type: 'choice',
      value: 'billing',
      probabilities: { billing: 0.97, technical: 0.01, account: 0.02 },
      confidence: 0.96,
    });
    expect(res.answers.refund).toEqual({ type: 'noul', value: 1 });
    expect(res.answers.urgency).toEqual({
      type: 'score',
      value: 1.56,
      probabilities: [0.04, 0.36, 0.6],
      confidence: 0.34,
    });
    expect(res.usage?.inputTokens).toBe(403);
  });

  it('predicate-unnamed: a request without `name` comes back with name null, which the parser rejects', async () => {
    // We always send `name`, so this only documents what the API does without it.
    const fixture = await load('predicate-unnamed');
    expect(
      (fixture.providerResponse as { answers: Array<{ name: unknown }> }).answers[0]!.name
    ).toBeNull();
    expect(() =>
      parseOpenAIDecisionsResponse(fixture.providerResponse, fixture.request, {
        backendName: 'openai-backend',
      })
    ).toThrow(/'refund'/);
  });

  it('choice-limit: nine choices are accepted (secondary sources claimed 2 to 8)', async () => {
    const fixture = await load('choice-limit-9');
    expect(Object.values(fixture.request.questions)[0]).toMatchObject({ type: 'choice' });
    const res = parseOpenAIDecisionsResponse(fixture.providerResponse, fixture.request, {
      backendName: 'openai-backend',
    });
    const answer = Object.values(res.answers)[0]!;
    expect(answer.type).toBe('choice');
    expect(Object.keys((answer as { probabilities: object }).probabilities)).toHaveLength(9);
  });

  it('limit-probes: records what the API enforced', async () => {
    const fixture = await load('limit-probes');
    const by = Object.fromEntries(fixture.limitProbes!.map((p) => [p.what, p]));
    expect(by['choices=2']!.status).toBe(200);
    expect(by['choices=1']!.status).toBe(400);
    expect(by['choices=255']!.status).toBe(200);
    expect(by['choices=256']!.status).toBe(400);
    expect(by['levels=10']!.status).toBe(200);
    expect(by['levels=11']!.status).toBe(400);
    expect(by['questions=200']!.status).toBe(200);
    expect(by['questions=201']!.status).toBe(400);
    expect(by['image=https-url']!.status).toBe(400);
    expect(by['input=object']!.status).toBe(400);
    expect(by['role=system']!.status).toBe(400);
  });
});
