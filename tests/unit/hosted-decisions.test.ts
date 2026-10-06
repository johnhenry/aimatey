/**
 * Hosted decision backends (#143): `decide()` on the Cloudflare (Clef),
 * OpenRouter, Perplexity and Inception adapters. Fixtures are hand-built from
 * the wire shapes in docs/plans/decision-models.md. The URL tests for
 * Cloudflare and OpenRouter matter most: both endpoints live outside the
 * adapters' chat base URLs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CloudflareBackendAdapter,
  OpenRouterBackendAdapter,
  PerplexityBackendAdapter,
  InceptionBackendAdapter,
} from '@johnhenry/aimatey-backend';
import { ProviderError } from '@johnhenry/aimatey-errors';
import { supportsDecisions } from '@johnhenry/aimatey-utils';
import type { IRDecisionRequest } from '@johnhenry/aimatey-types';

const request: IRDecisionRequest = {
  state: 'Subject: Duplicate charge. Body: I was billed twice, please refund me today.',
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: { billing: 'invoices, refunds', technical: 'bugs, outages' },
    },
    refund: {
      type: 'noul',
      instructions: 'Does the user request a refund?',
      criteria: { true: 'asks for money back', false: 'does not' },
    },
    urgency: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'medium', 'high'] },
  },
  metadata: { requestId: 'req_1', timestamp: 0 },
};

const answers = {
  department: {
    type: 'choice',
    choice: 'billing',
    probabilities: { billing: 0.97, technical: 0.03 },
    confidence: 0.9,
  },
  refund: { type: 'noul', noul: 0.99 },
  urgency: { type: 'score', score: 2, probabilities: [0.05, 0.15, 0.8], confidence: 0.8 },
};

const image = {
  type: 'image' as const,
  source: { type: 'base64' as const, mediaType: 'image/jpeg', data: 'QUJD' },
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

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

// ============================================================================
// Cloudflare (Clef)
// ============================================================================

describe('CloudflareBackendAdapter decisions (Clef)', () => {
  const wrapped = {
    success: true,
    errors: [],
    messages: [],
    result: {
      model: 'clef-flash',
      answers,
      usage: { input_tokens: 120, output_tokens: 3 },
    },
  };
  const make = () => new CloudflareBackendAdapter({ apiKey: 'tok', accountId: 'acct123' });

  it('is a decision backend that still chats, with Clef capabilities', () => {
    const backend = make();
    expect(supportsDecisions(backend)).toBe(true);
    expect(backend.execute).toBeDefined();
    const caps = backend.metadata.capabilities;
    expect(caps.decisions).toBe(true);
    expect(caps.decisionTypes).toEqual(['choice', 'score', 'noul']);
    expect(caps.decisionImages).toBe(true);
    expect(caps.decisionModels).toEqual(['clef', 'clef-flash']);
    expect(caps.decisionLimits).toEqual({
      maxQuestions: 64,
      maxChoiceOptions: 255,
      maxScoreLevels: 10,
      maxImages: 4,
      maxStateTokens: 65536,
    });
  });

  it('POSTs to /ai/run/@cf/cloudflare/<model>, not under the /ai/v1 chat base', async () => {
    const fetchMock = mockFetch(wrapped);
    await make().decide({ ...request, parameters: { model: 'clef' } });
    expect(callOf(fetchMock).url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/@cf/cloudflare/clef'
    );
  });

  it('derives the run URL from a custom baseURL ending in /ai/v1', async () => {
    const fetchMock = mockFetch(wrapped);
    const backend = new CloudflareBackendAdapter({
      apiKey: 'tok',
      baseURL: 'https://gw.example.test/client/v4/accounts/zzz/ai/v1/',
    });
    await backend.decide(request);
    expect(callOf(fetchMock).url).toBe(
      'https://gw.example.test/client/v4/accounts/zzz/ai/run/@cf/cloudflare/clef-flash'
    );
  });

  it('falls back to accountId when baseURL is not an /ai/v1 URL', async () => {
    const fetchMock = mockFetch(wrapped);
    const backend = new CloudflareBackendAdapter({
      apiKey: 'tok',
      accountId: 'acct9',
      baseURL: 'https://proxy.example.test',
    });
    await backend.decide(request);
    expect(callOf(fetchMock).url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct9/ai/run/@cf/cloudflare/clef-flash'
    );
  });

  it('rejects a baseURL it cannot derive the run URL from', async () => {
    const backend = new CloudflareBackendAdapter({ apiKey: 'tok', baseURL: 'https://x.test/v1' });
    await expect(backend.decide(request)).rejects.toThrow(/cannot derive/);
  });

  it('defaults to clef-flash and sends the short model name, bearer auth, and typed questions', async () => {
    const fetchMock = mockFetch(wrapped);
    const response = await make().decide(request);
    const { url, init, body } = callOf(fetchMock);
    expect(url.endsWith('/ai/run/@cf/cloudflare/clef-flash')).toBe(true);
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(body.model).toBe('clef-flash');
    expect(body.questions.refund.type).toBe('noul');
    expect(body.questions.refund.criteria).toEqual({
      true: 'asks for money back',
      false: 'does not',
    });
    expect(body).not.toHaveProperty('images');

    expect(response.answers.department).toEqual({
      type: 'choice',
      value: 'billing',
      probabilities: { billing: 0.97, technical: 0.03 },
      confidence: 0.9,
    });
    expect(response.answers.refund).toEqual({ type: 'noul', value: 0.99 });
    expect(response.answers.urgency).toMatchObject({ type: 'score', value: 2 });
    expect(response.usage?.inputTokens).toBe(120);
    expect(response.metadata.provenance?.backend).toBe('cloudflare-backend');
  });

  it.each([
    ['@cf/cloudflare/clef', 'clef'],
    ['@cf/cloudflare/clef-flash', 'clef-flash'],
    ['clef', 'clef'],
  ])('maps model alias %s to %s in both URL and body', async (alias, short) => {
    const fetchMock = mockFetch(wrapped);
    await make().decide({ ...request, parameters: { model: alias } });
    const { url, body } = callOf(fetchMock);
    expect(url.endsWith(`/ai/run/@cf/cloudflare/${short}`)).toBe(true);
    expect(body.model).toBe(short);
  });

  it('rejects other models with a ProviderError listing the valid names, without calling out', async () => {
    const fetchMock = mockFetch(wrapped);
    const err = await make()
      .decide({ ...request, parameters: { model: '@cf/meta/llama-3.1-8b-instruct' } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toMatch(/clef and clef-flash/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts the Workers-binding unwrapped response shape', async () => {
    mockFetch(wrapped.result);
    const response = await make().decide(request);
    expect(response.answers.refund).toEqual({ type: 'noul', value: 0.99 });
  });

  it('sends images as data URLs and rejects url sources and more than four', async () => {
    const fetchMock = mockFetch(wrapped);
    await make().decide({ ...request, images: [image] });
    expect(callOf(fetchMock).body.images).toEqual(['data:image/jpeg;base64,QUJD']);

    await expect(
      make().decide({
        ...request,
        images: [{ type: 'image', source: { type: 'url', url: 'https://x.test/a.png' } }],
      })
    ).rejects.toThrow(/base64/);
    await expect(
      make().decide({ ...request, images: [image, image, image, image, image] })
    ).rejects.toThrow(/at most 4/);
  });

  it('surfaces the 5006 invalid-model error envelope (HTTP 400)', async () => {
    mockFetch(
      {
        success: false,
        errors: [{ code: 5006, message: 'Error: oneOf at "/" not met, 0 matches' }],
        messages: [],
        result: null,
      },
      400
    );
    const err = await make()
      .decide(request)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('ValidationError');
  });

  it('surfaces an error envelope delivered with a 2xx status', async () => {
    mockFetch({ success: false, errors: [{ code: 5006, message: 'invalid model' }], result: null });
    await expect(make().decide(request)).rejects.toThrow(/5006: invalid model/);
  });

  it('estimates cost from registry pricing ($0.24 clef, $0.09 clef-flash, per 1M input)', async () => {
    const backend = make();
    const clef = await backend.estimateDecisionCost({ ...request, parameters: { model: 'clef' } });
    const flash = await backend.estimateDecisionCost(request);
    expect(clef).toBeGreaterThan(0);
    expect(clef! / flash!).toBeCloseTo(0.24 / 0.09, 5);
  });
});

// ============================================================================
// OpenRouter
// ============================================================================

describe('OpenRouterBackendAdapter decisions', () => {
  // OpenRouter's envelope; the answers carry no probabilities / confidence.
  const envelope = {
    id: 'dec_abc123',
    provider: 'TypeSafe',
    model: 'typesafe/jev-1.13',
    answers: {
      department: { type: 'choice', choice: 'billing' },
      refund: { type: 'noul', noul: 0.97 },
      urgency: { type: 'score', score: 1 },
    },
    usage: { input_tokens: 210, output_tokens: 4, cost: 0.0000088 },
  };
  const make = (extra = {}) =>
    new OpenRouterBackendAdapter({
      apiKey: 'or-key',
      siteUrl: 'https://app.example.test',
      siteName: 'Example',
      ...extra,
    });

  it('declares typed-decision capabilities without images', () => {
    const caps = make().metadata.capabilities;
    expect(supportsDecisions(make())).toBe(true);
    expect(caps.decisionTypes).toEqual(['choice', 'score', 'noul']);
    expect(caps.decisionImages).toBe(false);
    expect(caps.decisionModels).toEqual([
      'typesafe/jev-1.13',
      '~typesafe/jev-latest',
      'jaredpalmer/kev-4b',
      'inception/mercury-decide',
    ]);
    expect(caps.decisionLimits).toMatchObject({
      maxChoiceOptions: 255,
      maxScoreLevels: 10,
      maxStateTokens: 32000,
    });
  });

  it('POSTs to /api/alpha/decisions (the /v1 suffix is replaced, not appended to)', async () => {
    const fetchMock = mockFetch(envelope);
    await make().decide(request);
    expect(callOf(fetchMock).url).toBe('https://openrouter.ai/api/alpha/decisions');
  });

  it('honours a custom baseURL for the alpha endpoint', async () => {
    const fetchMock = mockFetch(envelope);
    await make({ baseURL: 'https://or-proxy.test/api/v1/' }).decide(request);
    expect(callOf(fetchMock).url).toBe('https://or-proxy.test/api/alpha/decisions');
  });

  it("falls back to /api/v1/systemone with decisionsEndpoint: 'systemone'", async () => {
    const fetchMock = mockFetch(envelope);
    await make({ decisionsEndpoint: 'systemone' }).decide(request);
    expect(callOf(fetchMock).url).toBe('https://openrouter.ai/api/v1/systemone');
  });

  it('sends the chat headers including site headers', async () => {
    const fetchMock = mockFetch(envelope);
    await make().decide(request);
    const { headers } = callOf(fetchMock).init;
    expect(headers.Authorization).toBe('Bearer or-key');
    expect(headers['HTTP-Referer']).toBe('https://app.example.test');
    expect(headers['X-Title']).toBe('Example');
  });

  it('defaults the model and passes provider / trace / session_id through; forwards noul criteria', async () => {
    const fetchMock = mockFetch(envelope);
    await make().decide({
      ...request,
      parameters: {
        custom: {
          provider: { order: ['TypeSafe'], allow_fallbacks: false },
          trace: { name: 'triage' },
          session_id: 's-1',
          user: 'u-9',
        },
      },
    });
    const { body } = callOf(fetchMock);
    expect(body.model).toBe('typesafe/jev-1.13');
    expect(body.provider).toEqual({ order: ['TypeSafe'], allow_fallbacks: false });
    expect(body.trace).toEqual({ name: 'triage' });
    expect(body.session_id).toBe('s-1');
    expect(body.user).toBe('u-9');
    expect(body.questions.refund.criteria).toEqual({
      true: 'asks for money back',
      false: 'does not',
    });
  });

  it('maps id / provider / usage.cost and leaves absent probabilities absent', async () => {
    mockFetch(envelope);
    const response = await make().decide(request);
    expect(response.id).toBe('dec_abc123');
    expect(response.provider).toBe('TypeSafe');
    expect(response.usage).toMatchObject({ inputTokens: 210, outputTokens: 4, cost: 0.0000088 });
    expect(response.answers.department).toEqual({ type: 'choice', value: 'billing' });
    expect(response.answers.urgency).toEqual({ type: 'score', value: 1 });
  });

  it('honours probabilities and confidence when present', async () => {
    mockFetch({
      ...envelope,
      answers: {
        ...envelope.answers,
        department: {
          type: 'choice',
          choice: 'billing',
          probabilities: { billing: 0.9, technical: 0.1 },
          confidence: 0.8,
        },
      },
    });
    const response = await make().decide(request);
    expect(response.answers.department).toMatchObject({
      probabilities: { billing: 0.9, technical: 0.1 },
      confidence: 0.8,
    });
  });

  it('drops images with a capability-unsupported warning', async () => {
    const fetchMock = mockFetch(envelope);
    const response = await make().decide({ ...request, images: [image] });
    expect(callOf(fetchMock).body).not.toHaveProperty('images');
    expect(response.metadata.warnings?.some((w) => w.category === 'capability-unsupported')).toBe(
      true
    );
  });
});

// ============================================================================
// Perplexity
// ============================================================================

describe('PerplexityBackendAdapter decisions', () => {
  const make = () => new PerplexityBackendAdapter({ apiKey: 'pplx-key' });
  const wire = {
    model: 'pplx-decider-v1-27b',
    answers,
    usage: { input_tokens: 90, output_tokens: 2 },
  };

  it('declares decision capabilities with images', () => {
    const caps = make().metadata.capabilities;
    expect(supportsDecisions(make())).toBe(true);
    expect(caps.decisionModels).toEqual(['pplx-decider-v1-27b']);
    expect(caps.decisionImages).toBe(true);
    expect(caps.decisionTypes).toEqual(['choice', 'score', 'noul']);
  });

  it('POSTs to <baseURL>/v1/decisions with the default model and parses answers', async () => {
    const fetchMock = mockFetch(wire);
    const response = await make().decide(request);
    const { url, init, body } = callOf(fetchMock);
    expect(url).toBe('https://api.perplexity.ai/v1/decisions');
    expect(init.headers.Authorization).toBe('Bearer pplx-key');
    expect(body.model).toBe('pplx-decider-v1-27b');
    expect(response.answers.refund).toEqual({ type: 'noul', value: 0.99 });
    expect(response.answers.urgency).toMatchObject({ type: 'score', value: 2 });
    expect(response.usage?.inputTokens).toBe(90);
    expect(response.provider).toBe('perplexity');
  });

  it('sends images as data URLs', async () => {
    const fetchMock = mockFetch(wire);
    await make().decide({ ...request, images: [image] });
    expect(callOf(fetchMock).body.images).toEqual(['data:image/jpeg;base64,QUJD']);
  });

  it('estimates $0.04 per 1M input tokens', async () => {
    const cost = await make().estimateDecisionCost(request);
    const tokens = Math.ceil(
      JSON.stringify({ state: request.state, questions: request.questions }).length / 4
    );
    expect(cost).toBeCloseTo((tokens / 1_000_000) * 0.04, 12);
  });
});

// ============================================================================
// Inception (Mercury Decide; native endpoint unverified)
// ============================================================================

describe('InceptionBackendAdapter decisions', () => {
  const make = () => new InceptionBackendAdapter({ apiKey: 'inc-key' });
  const wire = { model: 'mercury-decide', answers };

  it('declares mercury-decide and still chats', () => {
    const backend = make();
    expect(supportsDecisions(backend)).toBe(true);
    expect(backend.execute).toBeDefined();
    expect(backend.metadata.capabilities.decisionModels).toEqual(['mercury-decide']);
    expect(backend.metadata.capabilities.decisionImages).toBe(false);
  });

  it('POSTs System One to <baseURL>/systemone with the default model', async () => {
    const fetchMock = mockFetch(wire);
    const response = await make().decide(request);
    const { url, init, body } = callOf(fetchMock);
    expect(url).toBe('https://api.inceptionlabs.ai/v1/systemone');
    expect(init.headers.Authorization).toBe('Bearer inc-key');
    expect(body.model).toBe('mercury-decide');
    expect(response.answers.department).toMatchObject({ type: 'choice', value: 'billing' });
    expect(response.provider).toBe('inception');
  });

  it('drops images with a warning', async () => {
    const fetchMock = mockFetch(wire);
    const response = await make().decide({ ...request, images: [image] });
    expect(callOf(fetchMock).body).not.toHaveProperty('images');
    expect(response.metadata.warnings?.some((w) => w.category === 'capability-unsupported')).toBe(
      true
    );
  });

  it('prices mercury-decide from the registry (free)', async () => {
    expect(await make().estimateDecisionCost(request)).toBe(0);
  });
});
