/**
 * Decision frontend tests: Vercel `decide()` and OpenRouter `/alpha/decisions`
 * frontend adapters, round-tripped through `Bridge.decideFrom()` against
 * `createMockDecisionBackend`.
 */

import { describe, it, expect } from 'vitest';
import { Bridge } from '@johnhenry/aimatey-core';
import {
  VercelDecideFrontendAdapter,
  OpenRouterDecisionsFrontendAdapter,
  type VercelDecideRequest,
  type OpenRouterDecisionsRequest,
} from '@johnhenry/aimatey-frontend';
import { createMockDecisionBackend } from '@johnhenry/aimatey-testing';
import { supportsDecisionFrontend, supportsChatFrontend } from '@johnhenry/aimatey-utils';

const state = { subject: 'Duplicate charge', body: 'Please refund me today.' };

// ============================================================================
// Vercel
// ============================================================================

describe('VercelDecideFrontendAdapter', () => {
  const request: VercelDecideRequest = {
    model: 'tev1:0.8b',
    state,
    questions: {
      team: {
        type: 'choice',
        instructions: 'Which team?',
        criteria: { billing: 'refunds', technical: 'outages' },
      },
      refund: {
        type: 'boolean',
        instructions: 'Wants a refund?',
        criteria: { true: 'asks for money back', false: 'does not' },
      },
      plain: { type: 'boolean', instructions: 'Is it polite?' },
      urgency: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'mid', 'high'] },
    },
  };

  it('implements only the decision hooks', () => {
    const adapter = new VercelDecideFrontendAdapter();
    expect(supportsDecisionFrontend(adapter)).toBe(true);
    expect(supportsChatFrontend(adapter)).toBe(false);
    expect(adapter.metadata.capabilities.decisions).toBe(true);
  });

  it('maps boolean to noul (with and without criteria) and passes the rest through', async () => {
    const ir = await new VercelDecideFrontendAdapter().decisionToIR(request);
    expect(ir.state).toEqual(state);
    expect(ir.parameters?.model).toBe('tev1:0.8b');
    expect(ir.questions.refund).toEqual({
      type: 'noul',
      instructions: 'Wants a refund?',
      criteria: { true: 'asks for money back', false: 'does not' },
    });
    expect(ir.questions.plain).toEqual({ type: 'noul', instructions: 'Is it polite?' });
    expect('criteria' in ir.questions.plain).toBe(false);
    expect(ir.questions.team).toEqual({
      type: 'choice',
      instructions: 'Which team?',
      criteria: { billing: 'refunds', technical: 'outages' },
    });
    expect(ir.questions.urgency.type).toBe('score');
    expect(ir.metadata.provenance?.frontend).toBe('vercel-decide-frontend');
  });

  it('puts providerOptions in parameters.custom.providerOptions', async () => {
    const ir = await new VercelDecideFrontendAdapter().decisionToIR({
      ...request,
      providerOptions: { gateway: { order: ['a', 'b'] } },
    });
    expect(ir.parameters?.custom).toEqual({ providerOptions: { gateway: { order: ['a', 'b'] } } });
    const bare = await new VercelDecideFrontendAdapter().decisionToIR(request);
    expect(bare.parameters?.custom).toBeUndefined();
  });

  it('round-trips every answer type with probabilities and confidence present', async () => {
    const backend = createMockDecisionBackend({
      model: 'tev1:0.8b-served',
      answers: {
        team: {
          type: 'choice',
          value: 'billing',
          probabilities: { billing: 0.9, technical: 0.1 },
          confidence: 0.9,
        },
        refund: { type: 'noul', value: 0.93 },
        plain: { type: 'noul', value: 0.2 },
        urgency: { type: 'score', value: 1.4, probabilities: [0.2, 0.5, 0.3], confidence: 0.5 },
      },
      handler: undefined,
    });
    const bridge = new Bridge(new VercelDecideFrontendAdapter(), backend);
    const res = await bridge.decideFrom(request);

    expect(res.answers.team).toEqual({
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.9, technical: 0.1 },
      confidence: 0.9,
    });
    expect(res.answers.refund).toEqual({ type: 'boolean', probability: 0.93 });
    expect(res.answers.plain).toEqual({ type: 'boolean', probability: 0.2 });
    expect(res.answers.urgency).toEqual({
      type: 'score',
      score: 1.4,
      probabilities: { low: 0.2, mid: 0.5, high: 0.3 },
      confidence: 0.5,
    });
    expect(res.response).toEqual({ modelId: 'tev1:0.8b-served' });
    expect(backend.calls[0].questions.refund.type).toBe('noul');
  });

  it('omits probabilities and confidence when the backend reported none', async () => {
    const backend = createMockDecisionBackend({
      answers: {
        team: { type: 'choice', value: 'technical' },
        refund: { type: 'noul', value: 0.5 },
        plain: { type: 'noul', value: 0.5 },
        urgency: { type: 'score', value: 2 },
      },
    });
    const res = await new Bridge(new VercelDecideFrontendAdapter(), backend).decideFrom(request);
    expect(res.answers.team).toEqual({ type: 'choice', choice: 'technical' });
    expect(res.answers.urgency).toEqual({ type: 'score', score: 2 });
    expect('probabilities' in res.answers.urgency).toBe(false);
    expect('confidence' in res.answers.team).toBe(false);
  });

  it('reports camelCase usage, defaulting missing counts to 0', async () => {
    const adapter = new VercelDecideFrontendAdapter();
    const ir = await adapter.decisionToIR(request);
    const base = {
      answers: { team: { type: 'choice' as const, value: 'billing' } },
      model: 'm',
      metadata: ir.metadata,
    };
    expect((await adapter.decisionFromIR({ ...base })).usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(
      (await adapter.decisionFromIR({ ...base, usage: { inputTokens: 42, outputTokens: 3 } })).usage
    ).toEqual({ inputTokens: 42, outputTokens: 3 });
    expect((await adapter.decisionFromIR({ ...base, usage: { inputTokens: 42 } })).usage).toEqual({
      inputTokens: 42,
      outputTokens: 0,
    });
  });

  it('surfaces providerMetadata.gateway from raw, and the serving provider', async () => {
    const adapter = new VercelDecideFrontendAdapter();
    const ir = await adapter.decisionToIR(request);
    const base = {
      answers: { team: { type: 'choice' as const, value: 'billing' } },
      model: 'm',
      metadata: ir.metadata,
    };

    expect(await adapter.decisionFromIR(base)).not.toHaveProperty('providerMetadata');

    const withRaw = await adapter.decisionFromIR({
      ...base,
      raw: {
        providerMetadata: { gateway: { routing: { finalProvider: 'typesafe' }, cost: '0.001' } },
      },
    });
    expect(withRaw.providerMetadata).toEqual({
      gateway: { routing: { finalProvider: 'typesafe' }, cost: '0.001' },
    });

    const withProvider = await adapter.decisionFromIR({ ...base, provider: 'typesafe' });
    expect(withProvider.providerMetadata).toEqual({ gateway: { provider: 'typesafe' } });
  });

  it('rejects chat on a decision-only frontend', async () => {
    const bridge = new Bridge(new VercelDecideFrontendAdapter(), createMockDecisionBackend({}));
    await expect(bridge.chat({} as never)).rejects.toMatchObject({ code: 'UNSUPPORTED_FEATURE' });
  });
});

// ============================================================================
// OpenRouter
// ============================================================================

describe('OpenRouterDecisionsFrontendAdapter', () => {
  const request: OpenRouterDecisionsRequest = {
    model: 'typesafe/jev-1.13',
    state,
    questions: {
      team: {
        type: 'choice',
        instructions: 'Which team?',
        criteria: { billing: 'refunds', technical: 'outages' },
      },
      refund: {
        type: 'noul',
        instructions: 'Wants a refund?',
        criteria: { true: 'asks for money back', false: 'does not' },
      },
      urgency: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'mid', 'high'] },
    },
  };

  it('implements only the decision hooks', () => {
    const adapter = new OpenRouterDecisionsFrontendAdapter();
    expect(supportsDecisionFrontend(adapter)).toBe(true);
    expect(supportsChatFrontend(adapter)).toBe(false);
  });

  it('maps the request, keeping noul criteria and moving routing extras to custom', async () => {
    const adapter = new OpenRouterDecisionsFrontendAdapter();
    const ir = await adapter.decisionToIR({
      ...request,
      provider: { order: ['typesafe'], allow_fallbacks: false },
      trace: { trace_id: 't1' },
      session_id: 's1',
      user: 'u1',
    });
    expect(ir.parameters?.model).toBe('typesafe/jev-1.13');
    expect(ir.questions).toEqual(request.questions);
    expect(ir.parameters?.custom).toEqual({
      provider: { order: ['typesafe'], allow_fallbacks: false },
      trace: { trace_id: 't1' },
      sessionId: 's1',
      user: 'u1',
    });
    const bare = await adapter.decisionToIR(request);
    expect(bare.parameters?.custom).toBeUndefined();
  });

  it('round-trips all types with optional fields present, plus id/provider/usage.cost', async () => {
    const backend = createMockDecisionBackend({
      handler: (req) => ({
        id: 'dec_123',
        provider: 'typesafe',
        model: 'typesafe/jev-1.13',
        answers: {
          team: {
            type: 'choice',
            value: 'billing',
            probabilities: { billing: 0.8, technical: 0.2 },
            confidence: 0.8,
          },
          refund: { type: 'noul', value: 0.9, confidence: 0.9 },
          urgency: { type: 'score', value: 1.2, probabilities: [0.1, 0.7, 0.2], confidence: 0.7 },
        },
        usage: { inputTokens: 55, outputTokens: 0, cost: 0.0000023 },
        metadata: req.metadata,
      }),
    });
    const res = await new Bridge(new OpenRouterDecisionsFrontendAdapter(), backend).decideFrom(
      request
    );

    expect(res.id).toBe('dec_123');
    expect(res.provider).toBe('typesafe');
    expect(res.model).toBe('typesafe/jev-1.13');
    expect(res.usage).toEqual({ input_tokens: 55, output_tokens: 0, cost: 0.0000023 });
    expect(res.answers.team).toEqual({
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.8, technical: 0.2 },
      confidence: 0.8,
    });
    expect(res.answers.refund).toEqual({ type: 'noul', noul: 0.9, confidence: 0.9 });
    expect(res.answers.urgency).toEqual({
      type: 'score',
      score: 1.2,
      legend: { '0': 'low', '1': 'mid', '2': 'high' },
      probabilities: { '0': 0.1, '1': 0.7, '2': 0.2 },
      confidence: 0.7,
    });
  });

  it('omits optional fields, id, provider and cost when absent', async () => {
    const backend = createMockDecisionBackend({
      answers: {
        team: { type: 'choice', value: 'technical' },
        refund: { type: 'noul', value: 0.4 },
        urgency: { type: 'score', value: 0 },
      },
    });
    const res = await new Bridge(new OpenRouterDecisionsFrontendAdapter(), backend).decideFrom(
      request
    );
    expect(res).not.toHaveProperty('id');
    expect(res).not.toHaveProperty('provider');
    expect(res.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(res.answers.team).toEqual({ type: 'choice', choice: 'technical' });
    expect(res.answers.refund).toEqual({ type: 'noul', noul: 0.4 });
    expect(res.answers.urgency).toEqual({
      type: 'score',
      score: 0,
      legend: { '0': 'low', '1': 'mid', '2': 'high' },
    });
  });

  it('forwards extras to the backend IR through decideFrom', async () => {
    const backend = createMockDecisionBackend({
      answers: {
        team: { type: 'choice', value: 'technical' },
        refund: { type: 'noul', value: 0.4 },
        urgency: { type: 'score', value: 0 },
      },
    });
    await new Bridge(new OpenRouterDecisionsFrontendAdapter(), backend).decideFrom({
      ...request,
      session_id: 's9',
    });
    expect(backend.calls[0].parameters?.custom).toEqual({ sessionId: 's9' });
  });
});
