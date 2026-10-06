/**
 * Decision tests
 *
 * Covers the decision capability guards (supportsDecisions/supportsChat/
 * supportsChatStream), Bridge.decide (middleware chain, unsupported-backend
 * error), the TypeSafe (Jev) backend adapter's request/response mapping and
 * HTTP error handling, the TypeSafe frontend adapter's translation, and the
 * Laya frontend adapter's translation (no backend yet -- see laya.ts).
 *
 * Mirrors tests/unit/embeddings.test.ts's structure for the sibling
 * capability.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { TypeSafeBackendAdapter } from '@johnhenry/aimatey-backend';
import { TypeSafeFrontendAdapter, LayaFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { GroqBackendAdapter } from '@johnhenry/aimatey-backend';
import {
  supportsDecisions,
  supportsChat,
  supportsChatStream,
  supportsChatFrontend,
  supportsDecisionFrontend,
  getModelEntry,
} from '@johnhenry/aimatey-utils';
import { createMockDecisionBackend } from '@johnhenry/aimatey-testing';
import { LayaBackendAdapter } from '@johnhenry/aimatey-native-laya';
import { AdapterError, ErrorCode } from '@johnhenry/aimatey-errors';
import type {
  BackendAdapter,
  IRDecisionRequest,
  IRDecisionResponse,
  AdapterMetadata,
  FrontendAdapter,
} from '@johnhenry/aimatey-types';

// ============================================================================
// Test helpers
// ============================================================================

function makeDecisionBackend(options: {
  name?: string;
  fail?: boolean;
}): BackendAdapter & { decideCalls: IRDecisionRequest[] } {
  const decideCalls: IRDecisionRequest[] = [];

  const metadata: AdapterMetadata = {
    name: options.name ?? 'mock-decision',
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
    decideCalls,
    // Deliberately no fromIR/toIR/execute/executeStream -- a decision-only
    // backend, the whole point of making them optional.
    // eslint-disable-next-line @typescript-eslint/require-await -- mock interface
    decide: async (request: IRDecisionRequest): Promise<IRDecisionResponse> => {
      if (options.fail) {
        throw new Error('decide failed');
      }
      decideCalls.push(request);
      return {
        answers: {
          urgent: { type: 'noul', value: 0.9 },
        },
        model: 'mock-decision-model',
        metadata: request.metadata,
      };
    },
  };
}

function makeBridge(backend: BackendAdapter): Bridge {
  return new Bridge(new OpenAIFrontendAdapter(), backend);
}

const mockFetch = (response: any, ok = true, status = 200) => {
  global.fetch = vi.fn().mockResolvedValueOnce({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => response,
    text: async () => JSON.stringify(response),
  });
};

// ============================================================================
// Capability detection
// ============================================================================

describe('decision capability guards', () => {
  it('detects decision support', () => {
    expect(supportsDecisions(makeDecisionBackend({}))).toBe(true);
    expect(supportsDecisions(new GroqBackendAdapter({ apiKey: 'k' }))).toBe(false);
    expect(supportsDecisions(new TypeSafeBackendAdapter({ apiKey: 'k' }))).toBe(true);
  });

  it('detects chat support, now that it is optional', () => {
    expect(supportsChat(new GroqBackendAdapter({ apiKey: 'k' }))).toBe(true);
    expect(supportsChatStream(new GroqBackendAdapter({ apiKey: 'k' }))).toBe(true);
    // A decision-only backend implements neither.
    expect(supportsChat(makeDecisionBackend({}))).toBe(false);
    expect(supportsChatStream(makeDecisionBackend({}))).toBe(false);
    expect(supportsChat(new TypeSafeBackendAdapter({ apiKey: 'k' }))).toBe(false);
  });
});

// ============================================================================
// Bridge.decide
// ============================================================================

describe('Bridge.decide', () => {
  it('answers typed questions', async () => {
    const backend = makeDecisionBackend({});
    const response = await makeBridge(backend).decide(
      { subject: 'Refund please' },
      { urgent: { type: 'noul', instructions: 'Is this urgent?' } }
    );

    expect(response.answers.urgent).toEqual({ type: 'noul', value: 0.9 });
    expect(backend.decideCalls).toHaveLength(1);
    expect(backend.decideCalls[0]?.state).toEqual({ subject: 'Refund please' });
  });

  it('stamps backend provenance on the response', async () => {
    const backend = makeDecisionBackend({ name: 'my-decision-backend' });
    const response = await makeBridge(backend).decide('state', {
      urgent: { type: 'noul', instructions: 'Is this urgent?' },
    });

    expect(response.metadata.provenance?.backend).toBe('my-decision-backend');
  });

  it('throws UNSUPPORTED_FEATURE for non-decision backends', async () => {
    const backend = new GroqBackendAdapter({ apiKey: 'k' });
    await expect(
      makeBridge(backend).decide('state', { q: { type: 'noul', instructions: 'x' } })
    ).rejects.toThrow(/does not support typed decisions/);
  });

  it('runs decision middleware around execution', async () => {
    const backend = makeDecisionBackend({});
    const order: string[] = [];
    const bridge = makeBridge(backend)
      .useDecision(async (request, next) => {
        order.push('outer-before');
        const response = await next(request);
        order.push('outer-after');
        return response;
      })
      .useDecision(async (request, next) => {
        order.push('inner-before');
        const response = await next(request);
        order.push('inner-after');
        return response;
      });

    await bridge.decide('state', { q: { type: 'noul', instructions: 'x' } });
    expect(order).toEqual(['outer-before', 'inner-before', 'inner-after', 'outer-after']);
  });

  it('passes principal through to metadata', async () => {
    const backend = makeDecisionBackend({});
    await makeBridge(backend).decide(
      'state',
      { q: { type: 'noul', instructions: 'x' } },
      { principal: 'tenant-7:user-42' }
    );

    expect(backend.decideCalls[0]?.metadata.principal).toBe('tenant-7:user-42');
  });
});

// ============================================================================
// TypeSafe (Jev) backend adapter
// ============================================================================

describe('TypeSafeBackendAdapter', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  const baseRequest: IRDecisionRequest = {
    state: { subject: 'Duplicate charge', body: 'Please refund me today.' },
    questions: {
      department: {
        type: 'choice',
        instructions: 'Which team should handle this?',
        criteria: { billing: 'invoices, refunds', technical: 'bugs, outages' },
      },
      frustration: {
        type: 'score',
        instructions: 'How frustrated is the customer?',
        criteria: ['calm', 'annoyed', 'furious'],
      },
      refundRequested: { type: 'noul', instructions: 'Does the user request a refund?' },
    },
    metadata: { requestId: 'req_1', timestamp: 0 },
  };

  it('maps choice/score/noul answers from the wire format', async () => {
    mockFetch({
      answers: {
        department: { choice: 'billing', probabilities: { billing: 0.9, technical: 0.1 }, confidence: 0.9 },
        frustration: { score: 1.2, probabilities: [0.1, 0.3, 0.6], confidence: 0.6 },
        refundRequested: { noul: 0.98 },
      },
      model: 'jev-1.13.0',
      usage: { input_tokens: 275, output_tokens: 20, cost: 0.00003 },
    });

    const backend = new TypeSafeBackendAdapter({ apiKey: 'sk-test' });
    const response = await backend.decide(baseRequest);

    expect(response.answers.department).toEqual({
      type: 'choice',
      value: 'billing',
      probabilities: { billing: 0.9, technical: 0.1 },
      confidence: 0.9,
    });
    expect(response.answers.frustration).toEqual({
      type: 'score',
      value: 1.2,
      probabilities: [0.1, 0.3, 0.6],
      confidence: 0.6,
    });
    expect(response.answers.refundRequested).toEqual({ type: 'noul', value: 0.98 });
    expect(response.model).toBe('jev-1.13.0');
    // `details.cost` is kept alongside the promoted `cost` for one release.
    expect(response.usage).toEqual({
      inputTokens: 275,
      outputTokens: 20,
      cost: 0.00003,
      details: { cost: 0.00003 },
    });
    expect(response.provider).toBe('typesafe');
  });

  it('sends the request to the real /systemone endpoint with a bearer token', async () => {
    mockFetch({
      answers: {
        department: { choice: 'billing', probabilities: { billing: 1, technical: 0 }, confidence: 1 },
        frustration: { score: 0, probabilities: [1, 0, 0], confidence: 1 },
        refundRequested: { noul: 0.5 },
      },
      model: 'jev-1.13.0',
    });
    const backend = new TypeSafeBackendAdapter({ apiKey: 'sk-test' });
    await backend.decide(baseRequest);

    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body);
    expect(body.state).toEqual(baseRequest.state);
    expect(body.questions).toEqual(baseRequest.questions);
  });

  it('maps a non-ok HTTP response to a real error', async () => {
    mockFetch({ error: 'invalid api key' }, false, 401);
    const backend = new TypeSafeBackendAdapter({ apiKey: 'bad-key' });
    await expect(backend.decide(baseRequest)).rejects.toThrow();
  });

  it('throws a clear error when the provider answers with a shape mismatch', async () => {
    mockFetch({
      answers: { department: { noul: 0.5 } }, // wrong shape for a `choice` question
      model: 'jev-1.13.0',
    });
    const backend = new TypeSafeBackendAdapter({ apiKey: 'sk-test' });
    await expect(backend.decide(baseRequest)).rejects.toThrow(/department/);
  });

  it('throws, naming the question, when the provider omits an answer', async () => {
    mockFetch({
      answers: {
        department: { choice: 'billing', probabilities: { billing: 1, technical: 0 }, confidence: 1 },
        refundRequested: { noul: 0.98 },
      },
      model: 'jev-1.13.0',
    });
    const backend = new TypeSafeBackendAdapter({ apiKey: 'sk-test' });
    await expect(backend.decide(baseRequest)).rejects.toThrow(/frustration/);
  });

  it('advertises decisions capability and no chat capability', () => {
    const backend = new TypeSafeBackendAdapter({ apiKey: 'sk-test' });
    expect(backend.metadata.capabilities.decisions).toBe(true);
    expect(backend.metadata.capabilities.streaming).toBe(false);
    expect(backend.execute).toBeUndefined();
    expect(backend.executeStream).toBeUndefined();
  });
});

// ============================================================================
// TypeSafe (Jev) frontend adapter
// ============================================================================

describe('TypeSafeFrontendAdapter', () => {
  it('translates an @typesafe-ai/sdk-shaped call into IR', async () => {
    const adapter = new TypeSafeFrontendAdapter();
    const ir = await adapter.decisionToIR({
      state: { document: 'I was charged twice.' },
      questions: { urgent: { type: 'noul', instructions: 'Is this urgent?' } },
      model: 'jev-1.13.0',
    });

    expect(ir.state).toEqual({ document: 'I was charged twice.' });
    expect(ir.questions.urgent).toEqual({ type: 'noul', instructions: 'Is this urgent?' });
    expect(ir.parameters?.model).toBe('jev-1.13.0');
    expect(ir.metadata.provenance?.frontend).toBe('typesafe-frontend');
  });

  it('translates an IR decision response back into SDK response shape', async () => {
    const adapter = new TypeSafeFrontendAdapter();
    const sdkResponse = await adapter.decisionFromIR({
      answers: {
        department: { type: 'choice', value: 'billing', probabilities: { billing: 0.9 }, confidence: 0.9 },
        urgent: { type: 'noul', value: 0.98 },
      },
      model: 'jev-1.13.0',
      metadata: { requestId: 'r', timestamp: 0 },
    });

    expect(sdkResponse.answers.department).toEqual({
      choice: 'billing',
      probabilities: { billing: 0.9 },
      confidence: 0.9,
    });
    expect(sdkResponse.answers.urgent).toEqual({ noul: 0.98 });
    expect(sdkResponse.model).toBe('jev-1.13.0');
  });
});

// ============================================================================
// Laya frontend adapter (no backend yet -- see packages/frontend/src/adapters/laya.ts)
// ============================================================================

describe('LayaFrontendAdapter', () => {
  it('translates a Router.predict()-shaped call into IR, routing hints into custom', async () => {
    const adapter = new LayaFrontendAdapter();
    const ir = await adapter.decisionToIR({
      state: { message: 'I was charged twice' },
      questions: { urgent: { type: 'noul', instructions: 'Is this urgent?' } },
      model: 'multilingual',
      task: 'customer_service',
      lang: 'de',
    });

    expect(ir.state).toEqual({ message: 'I was charged twice' });
    expect(ir.parameters?.model).toBe('multilingual');
    expect(ir.parameters?.custom).toEqual({ task: 'customer_service', lang: 'de' });
    expect(ir.metadata.provenance?.frontend).toBe('laya-frontend');
  });

  it('omits custom entirely when no routing hints are given', async () => {
    const adapter = new LayaFrontendAdapter();
    const ir = await adapter.decisionToIR({
      state: 'hello',
      questions: { q: { type: 'noul', instructions: 'x' } },
    });
    expect(ir.parameters?.custom).toEqual({});
  });

  it('reconstructs a choice answer as-is', async () => {
    const adapter = new LayaFrontendAdapter();
    const laya = await adapter.decisionFromIR({
      answers: {
        department: { type: 'choice', value: 'billing', probabilities: { billing: 0.9, technical: 0.1 }, confidence: 0.9 },
      },
      model: 'laya-rl-agent',
      metadata: { requestId: 'r', timestamp: 0 },
    });

    expect(laya.answers.department).toEqual({
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.9, technical: 0.1 },
      confidence: 0.9,
    });
    expect(laya.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('reconstructs a score answer, using the original question to build a real legend', async () => {
    const adapter = new LayaFrontendAdapter();
    const originalRequest = {
      state: 'x',
      questions: {
        frustration: {
          type: 'score' as const,
          instructions: 'How frustrated?',
          criteria: ['calm', 'annoyed', 'furious'],
        },
      },
      metadata: { requestId: 'r', timestamp: 0 },
    };
    const laya = await adapter.decisionFromIR(
      {
        answers: {
          frustration: { type: 'score', value: 1.2, probabilities: [0.1, 0.3, 0.6], confidence: 0.6 },
        },
        model: 'laya-rl-agent',
        metadata: { requestId: 'r', timestamp: 0 },
      },
      originalRequest
    );

    expect(laya.answers.frustration).toEqual({
      type: 'score',
      score: 1.2,
      legend: { '0': 'calm', '1': 'annoyed', '2': 'furious' },
      probabilities: { '0': 0.1, '1': 0.3, '2': 0.6 },
      confidence: 0.6,
    });
  });

  it('falls back to numeric-string labels for a score legend without the original request', async () => {
    const adapter = new LayaFrontendAdapter();
    const laya = await adapter.decisionFromIR({
      answers: {
        frustration: { type: 'score', value: 1.2, probabilities: [0.1, 0.3, 0.6], confidence: 0.6 },
      },
      model: 'laya-rl-agent',
      metadata: { requestId: 'r', timestamp: 0 },
    });

    expect(laya.answers.frustration).toMatchObject({
      legend: { '0': '0', '1': '1', '2': '2' },
      probabilities: { '0': 0.1, '1': 0.3, '2': 0.6 },
    });
  });

  it('derives noul confidence when the source backend did not report one (e.g. Jev)', async () => {
    const adapter = new LayaFrontendAdapter();
    const laya = await adapter.decisionFromIR({
      answers: { refund: { type: 'noul', value: 0.98 } }, // no confidence, like Jev's answers
      model: 'jev-1.13.0',
      metadata: { requestId: 'r', timestamp: 0 },
    });

    expect(laya.answers.refund).toEqual({ type: 'noul', noul: 0.98, confidence: 0.98 });
  });

  it('passes noul confidence through as-is when the source backend already reported one', async () => {
    const adapter = new LayaFrontendAdapter();
    const laya = await adapter.decisionFromIR({
      answers: { refund: { type: 'noul', value: 0.6, confidence: 0.6 } },
      model: 'laya-rl-agent',
      metadata: { requestId: 'r', timestamp: 0 },
    });

    expect(laya.answers.refund).toEqual({ type: 'noul', noul: 0.6, confidence: 0.6 });
  });
});

// ============================================================================
// IR v2: optional probabilities/confidence, images, criteria, reasoning
// ============================================================================

describe('IR v2 answer fields', () => {
  const bare: IRDecisionResponse = {
    answers: {
      department: { type: 'choice', value: 'billing', reasoning: 'mentions a charge' },
      frustration: { type: 'score', value: 1, reasoning: 'mild' },
      urgent: { type: 'noul', value: 0.7, reasoning: 'deadline' },
    },
    model: 'llm-emulated',
    id: 'dec_123',
    provider: 'openrouter',
    usage: { inputTokens: 10, outputTokens: 4, cost: 0.001 },
    metadata: { requestId: 'r', timestamp: 0 },
  };

  it('flows an answer with no probabilities or confidence through Bridge.decide', async () => {
    const backend = createMockDecisionBackend({ handler: () => bare });
    const response = await makeBridge(backend).decide('s', {
      department: { type: 'choice', instructions: 'x', criteria: { billing: 'b' } },
    });
    expect(response.answers.department).toEqual({
      type: 'choice',
      value: 'billing',
      reasoning: 'mentions a charge',
    });
    expect(response.id).toBe('dec_123');
    expect(response.provider).toBe('openrouter');
    expect(response.usage?.outputTokens).toBe(4);
  });

  it('TypeSafe frontend omits probabilities/confidence it was never given', async () => {
    const sdk = await new TypeSafeFrontendAdapter().decisionFromIR(bare);
    expect(sdk.answers.department).toEqual({ choice: 'billing' });
    expect(sdk.answers.frustration).toEqual({ score: 1 });
    expect(sdk.answers.urgent).toEqual({ noul: 0.7 });
  });

  it('Laya frontend omits probabilities/confidence it was never given, and still builds a legend', async () => {
    const original: IRDecisionRequest = {
      state: 's',
      questions: {
        frustration: { type: 'score', instructions: 'x', criteria: ['calm', 'annoyed', 'furious'] },
      },
      metadata: { requestId: 'r', timestamp: 0 },
    };
    const laya = await new LayaFrontendAdapter().decisionFromIR(bare, original);
    expect(laya.answers.department).toEqual({ type: 'choice', choice: 'billing' });
    expect(laya.answers.frustration).toEqual({
      type: 'score',
      score: 1,
      legend: { '0': 'calm', '1': 'annoyed', '2': 'furious' },
    });
  });

  it('TypeSafe backend passes through answers that lack probabilities/confidence', async () => {
    mockFetch({
      answers: { department: { choice: 'billing' }, frustration: { score: 1 }, urgent: { noul: 0.7 } },
      model: 'jev-1.13.0',
    });
    const request: IRDecisionRequest = {
      state: 's',
      questions: {
        department: { type: 'choice', instructions: 'x', criteria: { billing: 'b' } },
        frustration: { type: 'score', instructions: 'x', criteria: ['a', 'b'] },
        urgent: { type: 'noul', instructions: 'x' },
      },
      metadata: { requestId: 'r', timestamp: 0 },
    };
    const response = await new TypeSafeBackendAdapter({ apiKey: 'k' }).decide(request);
    expect(response.answers.department).toEqual({ type: 'choice', value: 'billing' });
    expect('probabilities' in response.answers.department!).toBe(false);
    expect(response.answers.frustration).toEqual({ type: 'score', value: 1 });
  });

  it('noul questions carry criteria labels through the TypeSafe wire request', async () => {
    mockFetch({ answers: { q: { noul: 0.5 } }, model: 'jev-1.13.0' });
    const request: IRDecisionRequest = {
      state: 's',
      questions: {
        q: { type: 'noul', instructions: 'x', criteria: { true: 'approve', false: 'reject' } },
      },
      metadata: { requestId: 'r', timestamp: 0 },
    };
    await new TypeSafeBackendAdapter({ apiKey: 'k' }).decide(request);
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.questions.q.criteria).toEqual({ true: 'approve', false: 'reject' });
  });

  it('TypeSafe warns, rather than silently dropping, images it cannot send', async () => {
    mockFetch({ answers: { q: { noul: 0.5 } }, model: 'jev-1.13.0' });
    const request: IRDecisionRequest = {
      state: 's',
      questions: { q: { type: 'noul', instructions: 'x' } },
      images: [{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } }],
      metadata: { requestId: 'r', timestamp: 0 },
    };
    const response = await new TypeSafeBackendAdapter({ apiKey: 'k' }).decide(request);
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.images).toBeUndefined();
    expect(response.metadata.warnings?.[0]).toMatchObject({
      category: 'capability-unsupported',
      field: 'images',
    });
  });

  it('Laya warns, rather than silently dropping, images it cannot take', async () => {
    const backend = new LayaBackendAdapter();
    (backend as unknown as { instance: unknown }).instance = {
      systemOne: async () => ({
        model: 'laya',
        answers: { q: { type: 'noul', noul: 0.5 } },
        usage: { input_tokens: 1, output_tokens: 0 },
      }),
    };
    const response = await backend.decide({
      state: 's',
      questions: { q: { type: 'noul', instructions: 'x' } },
      images: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }],
      metadata: { requestId: 'r', timestamp: 0 },
    });
    expect(response.metadata.warnings?.map((w) => w.field)).toEqual(['images']);
    expect(response.provider).toBe('laya');
  });
});

describe('decision capability limits', () => {
  it('TypeSafe declares all three types, its limits, and no image support', () => {
    const { capabilities } = new TypeSafeBackendAdapter({ apiKey: 'k' }).metadata;
    expect(capabilities.decisionTypes).toEqual(['choice', 'score', 'noul']);
    expect(capabilities.decisionLimits).toEqual({
      maxChoiceOptions: 255,
      maxScoreLevels: 10,
      maxStateTokens: 32000,
      maxImages: 0,
    });
    expect(capabilities.decisionImages).toBe(false);
  });

  it('Laya declares all three types, its limits, and no image support', () => {
    const { capabilities } = new LayaBackendAdapter().metadata;
    expect(capabilities.decisionTypes).toEqual(['choice', 'score', 'noul']);
    expect(capabilities.decisionLimits).toEqual({
      maxChoiceOptions: 20,
      maxScoreLevels: 10,
      maxStateTokens: 512,
      maxImages: 0,
    });
    expect(capabilities.decisionImages).toBe(false);
  });
});

// ============================================================================
// Decision frontends are real FrontendAdapters; Bridge.decideFrom uses them
// ============================================================================

describe('decision frontends', () => {
  it('implement FrontendAdapter with the decision hooks and no chat members', () => {
    for (const adapter of [new TypeSafeFrontendAdapter(), new LayaFrontendAdapter()]) {
      const frontend: FrontendAdapter<any, any> = adapter;
      expect(typeof frontend.decisionToIR).toBe('function');
      expect(typeof frontend.decisionFromIR).toBe('function');
      expect(supportsDecisionFrontend(frontend)).toBe(true);
      expect(supportsChatFrontend(frontend)).toBe(false);
    }
    expect(supportsChatFrontend(new OpenAIFrontendAdapter())).toBe(true);
    expect(supportsDecisionFrontend(new OpenAIFrontendAdapter())).toBe(false);
  });
});

describe('Bridge.decideFrom', () => {
  const sdkAnswers = {
    urgent: { type: 'noul', value: 0.9 },
    team: {
      type: 'choice',
      value: 'billing',
      probabilities: { billing: 0.8, technical: 0.2 },
      confidence: 0.8,
    },
  } as const;

  it('runs TypeSafe-shaped input through the backend and back out in SDK shape', async () => {
    const backend = createMockDecisionBackend({ answers: sdkAnswers });
    const bridge = new Bridge(new TypeSafeFrontendAdapter(), backend);

    const response = await bridge.decideFrom({
      state: { subject: 'Double charge' },
      questions: {
        urgent: { type: 'noul', instructions: 'Urgent?' },
        team: { type: 'choice', instructions: 'Team?', criteria: { billing: 'b', technical: 't' } },
      },
      model: 'jev-1.13.0',
    });

    expect(response.answers.urgent).toEqual({ noul: 0.9 });
    expect(response.answers.team).toEqual({
      choice: 'billing',
      probabilities: { billing: 0.8, technical: 0.2 },
      confidence: 0.8,
    });
    expect(backend.calls[0]?.parameters?.model).toBe('jev-1.13.0');
    expect(backend.calls[0]?.metadata.provenance?.frontend).toBe('typesafe-frontend');
    expect(backend.calls[0]?.metadata.provenance?.backend).toBeUndefined();
  });

  it('runs Laya-shaped input, with routing hints, and back out in Laya shape', async () => {
    const backend = createMockDecisionBackend({ answers: sdkAnswers });
    const bridge = new Bridge(new LayaFrontendAdapter(), backend);

    const response = await bridge.decideFrom({
      state: 'x',
      questions: {
        urgent: { type: 'noul', instructions: 'Urgent?' },
        team: { type: 'choice', instructions: 'Team?', criteria: { billing: 'b', technical: 't' } },
      },
      task: 'customer_service',
    });

    expect(backend.calls[0]?.parameters?.custom).toEqual({ task: 'customer_service' });
    expect(response.answers.urgent).toEqual({ type: 'noul', noul: 0.9, confidence: 0.9 });
    expect(response.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('runs decision middleware, and passes the original request to decisionFromIR', async () => {
    const backend = createMockDecisionBackend({
      answers: { frustration: { type: 'score', value: 1, probabilities: [0.2, 0.6, 0.2], confidence: 0.6 } },
    });
    const seen: string[] = [];
    const bridge = new Bridge(new LayaFrontendAdapter(), backend).useDecision(async (req, next) => {
      seen.push(Object.keys(req.questions).join());
      return next(req);
    });

    const response = await bridge.decideFrom({
      state: 'x',
      questions: {
        frustration: { type: 'score', instructions: 'x', criteria: ['calm', 'annoyed', 'furious'] },
      },
    });

    expect(seen).toEqual(['frustration']);
    // The legend is only reconstructable because the original request reached decisionFromIR.
    expect((response.answers.frustration as { legend: unknown }).legend).toEqual({
      '0': 'calm',
      '1': 'annoyed',
      '2': 'furious',
    });
  });

  it('forwards options.signal and principal', async () => {
    const backend = createMockDecisionBackend({ answers: sdkAnswers });
    const bridge = new Bridge(new TypeSafeFrontendAdapter(), backend);
    const controller = new AbortController();
    controller.abort();
    await expect(
      bridge.decideFrom({ state: 'x', questions: {} }, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });

    await bridge.decideFrom(
      { state: 'x', questions: { urgent: { type: 'noul', instructions: 'u' } } },
      { principal: 'tenant-1' }
    );
    expect(backend.calls.at(-1)?.metadata.principal).toBe('tenant-1');
  });

  it('throws UNSUPPORTED_FEATURE when the frontend lacks the decision hooks', async () => {
    const bridge = new Bridge(new OpenAIFrontendAdapter(), createMockDecisionBackend({ answers: sdkAnswers }));
    const error = await bridge.decideFrom({ model: 'x', messages: [] } as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe(ErrorCode.UNSUPPORTED_FEATURE);
  });

  it('throws UNSUPPORTED_FEATURE when the backend cannot decide', async () => {
    const bridge = new Bridge(new TypeSafeFrontendAdapter(), new GroqBackendAdapter({ apiKey: 'k' }));
    await expect(bridge.decideFrom({ state: 'x', questions: {} })).rejects.toThrow(
      /does not support typed decisions/
    );
  });

  it('chat() on a decision-only frontend throws UNSUPPORTED_FEATURE instead of calling a missing toIR', async () => {
    const bridge = new Bridge(new TypeSafeFrontendAdapter(), new GroqBackendAdapter({ apiKey: 'k' }));
    const error = await bridge.chat({ state: 'x', questions: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe(ErrorCode.UNSUPPORTED_FEATURE);
    expect((error as AdapterError).message).toMatch(/chat/);
  });

  it('chatStream() on a decision-only frontend throws UNSUPPORTED_FEATURE', async () => {
    const bridge = new Bridge(new TypeSafeFrontendAdapter(), new GroqBackendAdapter({ apiKey: 'k' }));
    const consume = async () => {
      for await (const _chunk of bridge.chatStream({ state: 'x', questions: {} })) {
        // drain
      }
    };
    await expect(consume()).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED_FEATURE });
  });
});

// ============================================================================
// Registry seeds
// ============================================================================

describe('decision model registry seeds', () => {
  it.each([
    ['jev-1.13.0', 'typesafe', 0.042],
    ['clef', 'cloudflare', 0.24],
    ['clef-flash', 'cloudflare', 0.09],
    ['pplx-decider-v1-27b', 'perplexity', 0.04],
    ['nimble', 'ollama', 0],
    ['tev1', 'together', 0.042],
    ['kev-4b', 'openrouter', 0.042],
    ['mercury-decide', 'inception', 0],
  ])('%s is a seeded decision model on %s priced at %d per 1M input', (id, provider, input) => {
    const entry = getModelEntry(id);
    expect(entry?.id).toBe(id);
    expect(entry?.kind).toBe('decision');
    expect(entry?.provider).toBe(provider);
    expect(entry?.pricing).toEqual({ inputPer1M: input, outputPer1M: 0 });
  });

  it('gives the Clef models their 64k context window', () => {
    expect(getModelEntry('clef')?.contextWindow).toBe(65536);
    expect(getModelEntry('clef-flash')?.contextWindow).toBe(65536);
  });

  it('resolves the jev aliases', () => {
    for (const alias of ['jev-latest', '~typesafe/jev-latest', 'typesafe/jev-1.13']) {
      expect(getModelEntry(alias)?.id).toBe('jev-1.13.0');
    }
  });
});
