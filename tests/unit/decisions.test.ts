/**
 * Decision tests
 *
 * Covers the decision capability guards (supportsDecisions/supportsChat/
 * supportsChatStream), Bridge.decide (middleware chain, unsupported-backend
 * error), the TypeSafe (Jev) backend adapter's request/response mapping and
 * HTTP error handling, and the TypeSafe frontend adapter's translation.
 *
 * Mirrors tests/unit/embeddings.test.ts's structure for the sibling
 * capability.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { TypeSafeBackendAdapter } from '@johnhenry/aimatey-backend';
import { TypeSafeFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { GroqBackendAdapter } from '@johnhenry/aimatey-backend';
import { supportsDecisions, supportsChat, supportsChatStream } from '@johnhenry/aimatey-utils';
import type {
  BackendAdapter,
  IRDecisionRequest,
  IRDecisionResponse,
  AdapterMetadata,
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
    expect(response.usage).toEqual({ inputTokens: 275, details: { cost: 0.00003 } });
  });

  it('sends the request to the real /systemone endpoint with a bearer token', async () => {
    mockFetch({ answers: {}, model: 'jev-1.13.0' });
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
    const ir = await adapter.toIR({
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
    const sdkResponse = await adapter.fromIR({
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
