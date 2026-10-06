/**
 * Decision SDK wrapper tests: `createTypeSafeClient` and the AI SDK
 * `createDecide` / `createDecisionModel`, against `createMockDecisionBackend`.
 */

import { describe, it, expect } from 'vitest';
import { Bridge } from '@johnhenry/aimatey-core';
import {
  OpenAIFrontendAdapter,
  TypeSafeFrontendAdapter,
  VercelDecideFrontendAdapter,
  LayaFrontendAdapter,
} from '@johnhenry/aimatey-frontend';
import { createMockDecisionBackend } from '@johnhenry/aimatey-testing';
import {
  createTypeSafeClient,
  createDecide,
  createDecisionModel,
} from '@johnhenry/aimatey-wrapper';

/** A backend with no decision support at all. */
function chatOnlyBackend() {
  const { metadata } = createMockDecisionBackend();
  return {
    metadata: { ...metadata, capabilities: { ...metadata.capabilities, decisions: false } },
  } as never;
}

const state = 'Duplicate charge, please refund me today.';
const answers = {
  team: {
    type: 'choice' as const,
    value: 'billing',
    probabilities: { billing: 0.9, technical: 0.1 },
    confidence: 0.9,
  },
  refund: { type: 'noul' as const, value: 0.95 },
  urgency: { type: 'score' as const, value: 1, probabilities: [0.2, 0.6, 0.2] },
};

describe('createTypeSafeClient', () => {
  const questions = {
    team: {
      type: 'choice' as const,
      instructions: 'Which team?',
      criteria: { billing: 'refunds', technical: 'outages' },
    },
    refund: { type: 'noul' as const, instructions: 'Refund?' },
    urgency: { type: 'score' as const, instructions: 'Urgent?', criteria: ['low', 'mid', 'high'] },
  };

  for (const [label, makeBridge] of [
    [
      'typesafe-frontend bridge (decideFrom)',
      (b: ReturnType<typeof createMockDecisionBackend>) =>
        new Bridge(new TypeSafeFrontendAdapter(), b),
    ],
    [
      'other-frontend bridge (bridge.decide + internal adapter)',
      (b: ReturnType<typeof createMockDecisionBackend>) => new Bridge(new LayaFrontendAdapter(), b),
    ],
  ] as const) {
    describe(label, () => {
      it('sends the right IR and returns the SDK response shape exactly', async () => {
        const backend = createMockDecisionBackend({ answers, model: 'jev-1.13' });
        const client = createTypeSafeClient(makeBridge(backend));
        const res = await client.systemOne({ model: 'jev-1.13', state, questions });

        expect(backend.calls).toHaveLength(1);
        expect(backend.calls[0].state).toBe(state);
        expect(backend.calls[0].questions).toEqual(questions);
        expect(backend.calls[0].parameters?.model).toBe('jev-1.13');
        expect(res).toEqual({
          answers: {
            team: {
              choice: 'billing',
              probabilities: { billing: 0.9, technical: 0.1 },
              confidence: 0.9,
            },
            refund: { noul: 0.95 },
            urgency: { score: 1, probabilities: [0.2, 0.6, 0.2] },
          },
          model: 'jev-1.13',
        });
      });

      it('exposes decide as an alias of systemOne', async () => {
        const backend = createMockDecisionBackend({ answers });
        const client = createTypeSafeClient(makeBridge(backend));
        expect(await client.decide({ state, questions })).toEqual(
          await client.systemOne({ state, questions })
        );
      });

      it('falls back to opts.defaultModel when the request has none', async () => {
        const backend = createMockDecisionBackend({ answers });
        const client = createTypeSafeClient(makeBridge(backend), { defaultModel: 'jev-1.13' });
        await client.systemOne({ state, questions });
        expect(backend.calls[0].parameters?.model).toBe('jev-1.13');
        await client.systemOne({ state, questions, model: 'other' });
        expect(backend.calls[1].parameters?.model).toBe('other');
      });

      it('propagates the abort signal to the backend', async () => {
        const backend = createMockDecisionBackend({ answers, latencyMs: 200 });
        const client = createTypeSafeClient(makeBridge(backend));
        const controller = new AbortController();
        const pending = client.systemOne({ state, questions }, { signal: controller.signal });
        controller.abort();
        await expect(pending).rejects.toThrow();
        const already = AbortSignal.abort();
        await expect(client.systemOne({ state, questions }, { signal: already })).rejects.toThrow();
      });

      it('lets backend errors through unchanged', async () => {
        const boom = new Error('backend down');
        const client = createTypeSafeClient(makeBridge(createMockDecisionBackend({ error: boom })));
        await expect(client.systemOne({ state, questions })).rejects.toBe(boom);
      });

      it('maps a decision-incapable backend to UNSUPPORTED_FEATURE', async () => {
        const client = createTypeSafeClient(makeBridge(chatOnlyBackend()));
        await expect(client.systemOne({ state, questions })).rejects.toMatchObject({
          code: 'UNSUPPORTED_FEATURE',
        });
      });
    });
  }

  it('round-trips images on the fallback path when the backend takes images', async () => {
    const mock = createMockDecisionBackend({ answers });
    const backend = {
      ...mock,
      metadata: {
        ...mock.metadata,
        capabilities: { ...mock.metadata.capabilities, decisionImages: true },
      },
    };
    const client = createTypeSafeClient(new Bridge(new LayaFrontendAdapter(), backend));
    const result = await client.systemOne({
      state,
      questions,
      images: [{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } }],
    });
    expect(result).toBeDefined();
    expect(mock.calls[0].images).toHaveLength(1);
  });

  it('rejects images on the fallback path when the backend cannot take them', async () => {
    const client = createTypeSafeClient(
      new Bridge(new LayaFrontendAdapter(), createMockDecisionBackend({ answers }))
    );
    await expect(
      client.systemOne({
        state,
        questions,
        images: [
          { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } },
        ],
      })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('forwards images on the decideFrom path', async () => {
    const mock = createMockDecisionBackend({ answers });
    const backend = {
      ...mock,
      metadata: {
        ...mock.metadata,
        capabilities: { ...mock.metadata.capabilities, decisionImages: true },
      },
    };
    const client = createTypeSafeClient(new Bridge(new TypeSafeFrontendAdapter(), backend));
    await client.systemOne({
      state,
      questions,
      images: [{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } }],
    });
    expect(mock.calls[0].images).toHaveLength(1);
  });

  it('throws at construction for something that is not a bridge', () => {
    expect(() => createTypeSafeClient({} as never)).toThrow(/Bridge/);
  });
});

describe('createDecide / createDecisionModel', () => {
  const request = {
    model: 'tev1:0.8b',
    state,
    questions: {
      team: {
        type: 'choice' as const,
        instructions: 'Which team?',
        criteria: { billing: 'refunds', technical: 'outages' },
      },
      refund: { type: 'boolean' as const, instructions: 'Refund?' },
      urgency: {
        type: 'score' as const,
        instructions: 'Urgent?',
        criteria: ['low', 'mid', 'high'],
      },
    },
  };

  for (const [label, makeBridge] of [
    [
      'vercel-frontend bridge (decideFrom)',
      (b: ReturnType<typeof createMockDecisionBackend>) =>
        new Bridge(new VercelDecideFrontendAdapter(), b),
    ],
    [
      'other-frontend bridge (bridge.decide + internal adapter)',
      (b: ReturnType<typeof createMockDecisionBackend>) =>
        new Bridge(new OpenAIFrontendAdapter(), b),
    ],
  ] as const) {
    describe(label, () => {
      it('sends boolean as noul and returns the Vercel response shape exactly', async () => {
        const backend = createMockDecisionBackend({ answers, model: 'tev1:0.8b' });
        const decide = createDecide(makeBridge(backend));
        const res = await decide({
          ...request,
          providerOptions: { gateway: { order: ['x'] } },
        });

        expect(backend.calls[0].questions.refund).toEqual({
          type: 'noul',
          instructions: 'Refund?',
        });
        expect(backend.calls[0].parameters?.model).toBe('tev1:0.8b');
        expect(backend.calls[0].parameters?.custom).toEqual({
          providerOptions: { gateway: { order: ['x'] } },
        });
        expect(res).toEqual({
          answers: {
            team: {
              type: 'choice',
              choice: 'billing',
              probabilities: { billing: 0.9, technical: 0.1 },
              confidence: 0.9,
            },
            refund: { type: 'boolean', probability: 0.95 },
            urgency: {
              type: 'score',
              score: 1,
              probabilities: { low: 0.2, mid: 0.6, high: 0.2 },
            },
          },
          usage: { inputTokens: 0, outputTokens: 0 },
          response: { modelId: 'tev1:0.8b' },
        });
      });

      it('applies opts.defaultModel', async () => {
        const backend = createMockDecisionBackend({ answers });
        const decide = createDecide(makeBridge(backend), { defaultModel: 'tev1:0.8b' });
        await decide({ state, questions: request.questions });
        expect(backend.calls[0].parameters?.model).toBe('tev1:0.8b');
      });

      it('propagates abortSignal', async () => {
        const backend = createMockDecisionBackend({ answers, latencyMs: 200 });
        const decide = createDecide(makeBridge(backend));
        const controller = new AbortController();
        const pending = decide({ ...request, abortSignal: controller.signal });
        controller.abort();
        await expect(pending).rejects.toThrow();
      });

      it('lets backend errors through and maps unsupported backends', async () => {
        const boom = new Error('nope');
        await expect(
          createDecide(makeBridge(createMockDecisionBackend({ error: boom })))(request)
        ).rejects.toBe(boom);
        await expect(createDecide(makeBridge(chatOnlyBackend()))(request)).rejects.toMatchObject({
          code: 'UNSUPPORTED_FEATURE',
        });
      });
    });
  }

  it('createDecisionModel binds a model id and exposes decide()', async () => {
    const backend = createMockDecisionBackend({ answers, model: 'tev1:0.8b' });
    const model = createDecisionModel(
      new Bridge(new VercelDecideFrontendAdapter(), backend),
      'tev1:0.8b'
    );
    expect(model.modelId).toBe('tev1:0.8b');
    expect(model.provider).toBe('aimatey');
    const res = await model.decide({ state, questions: request.questions });
    expect(res.answers.refund).toEqual({ type: 'boolean', probability: 0.95 });
    expect(backend.calls[0].parameters?.model).toBe('tev1:0.8b');
  });
});
