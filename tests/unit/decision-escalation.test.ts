/**
 * Decision escalation tests (#147): condition evaluator, decisionBands and
 * the createDecisionEscalation middleware.
 */

import { describe, it, expect, vi } from 'vitest';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { ValidationError } from '@johnhenry/aimatey-errors';
import {
  createDecisionEscalation,
  evaluateDecisionCondition,
  decisionBands,
  type DecisionCondition,
} from '@johnhenry/aimatey-patterns';
import { createMockDecisionBackend } from '@johnhenry/aimatey-testing';
import type {
  IRDecisionAnswer,
  IRDecisionRequest,
  IRDecisionResponse,
} from '@johnhenry/aimatey-types';

const questions: IRDecisionRequest['questions'] = {
  team: {
    type: 'choice',
    instructions: 'Which team?',
    criteria: { billing: 'Charges', auth: 'Login' },
  },
  urgency: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'mid', 'high'] },
  refund: { type: 'noul', instructions: 'Refund requested?' },
};

const request: IRDecisionRequest = {
  state: 'I was charged twice',
  questions,
  metadata: { requestId: 'req-1', timestamp: 1 },
};

const answers: Record<string, IRDecisionAnswer> = {
  team: {
    type: 'choice',
    value: 'billing',
    probabilities: { billing: 0.6, auth: 0.4 },
    confidence: 0.6,
  },
  urgency: { type: 'score', value: 1, probabilities: [0.1, 0.8, 0.1], confidence: 0.8 },
  refund: { type: 'noul', value: 0.5 },
};

describe('evaluateDecisionCondition', () => {
  it('confidenceBelow with a question matches only that answer', () => {
    const r = evaluateDecisionCondition({ question: 'team', confidenceBelow: 0.7 }, answers);
    expect(r.matched).toBe(true);
    expect(r.triggeredBy).toEqual([{ question: 'team', reason: 'confidence_below' }]);
    expect(
      evaluateDecisionCondition({ question: 'urgency', confidenceBelow: 0.7 }, answers).matched
    ).toBe(false);
  });

  it('confidenceBelow is strict (equal does not match)', () => {
    expect(
      evaluateDecisionCondition({ question: 'team', confidenceBelow: 0.6 }, answers).matched
    ).toBe(false);
  });

  it('without a question it checks every choice/score answer and lists each trigger', () => {
    const r = evaluateDecisionCondition({ confidenceBelow: 0.9 }, answers);
    expect(r.matched).toBe(true);
    expect(r.triggeredBy.map((t) => t.question).sort()).toEqual(['team', 'urgency']);
  });

  it('matches conservatively when confidence is absent', () => {
    const bare = { team: { type: 'choice', value: 'billing' } } as Record<string, IRDecisionAnswer>;
    const r = evaluateDecisionCondition({ confidenceBelow: 0.1 }, bare);
    expect(r.matched).toBe(true);
    expect(r.triggeredBy).toEqual([{ question: 'team', reason: 'confidence_unavailable' }]);
  });

  it('probabilityBetween is inclusive and only looks at noul answers', () => {
    const c = (lo: number, hi: number): DecisionCondition => ({ probabilityBetween: [lo, hi] });
    expect(evaluateDecisionCondition(c(0.5, 0.6), answers).matched).toBe(true);
    expect(evaluateDecisionCondition(c(0.4, 0.5), answers).matched).toBe(true);
    expect(evaluateDecisionCondition(c(0.51, 0.9), answers).matched).toBe(false);
    const r = evaluateDecisionCondition({ probabilityBetween: [0, 1] }, answers);
    expect(r.triggeredBy).toEqual([{ question: 'refund', reason: 'probability_between' }]);
  });

  it('a named question that is missing or of the wrong type does not match', () => {
    expect(
      evaluateDecisionCondition({ question: 'nope', confidenceBelow: 1 }, answers).matched
    ).toBe(false);
    expect(
      evaluateDecisionCondition({ question: 'refund', confidenceBelow: 1 }, answers).matched
    ).toBe(false);
    expect(
      evaluateDecisionCondition({ question: 'team', probabilityBetween: [0, 1] }, answers).matched
    ).toBe(false);
  });

  it('any / all combine children and union their triggers', () => {
    const lowTeam: DecisionCondition = { question: 'team', confidenceBelow: 0.7 };
    const lowUrgency: DecisionCondition = { question: 'urgency', confidenceBelow: 0.7 };
    const any = evaluateDecisionCondition({ any: [lowTeam, lowUrgency] }, answers);
    expect(any.matched).toBe(true);
    expect(any.triggeredBy).toHaveLength(1);
    expect(evaluateDecisionCondition({ all: [lowTeam, lowUrgency] }, answers).matched).toBe(false);
    const all = evaluateDecisionCondition(
      { all: [lowTeam, { probabilityBetween: [0.4, 0.6] }] },
      answers
    );
    expect(all.matched).toBe(true);
    expect(all.triggeredBy.map((t) => t.question).sort()).toEqual(['refund', 'team']);
  });

  it('atLeast requires count matching conditions', () => {
    const conditions: DecisionCondition[] = [
      { question: 'team', confidenceBelow: 0.7 },
      { question: 'urgency', confidenceBelow: 0.7 },
      { probabilityBetween: [0.4, 0.6] },
    ];
    expect(evaluateDecisionCondition({ atLeast: { count: 2, conditions } }, answers).matched).toBe(
      true
    );
    expect(evaluateDecisionCondition({ atLeast: { count: 3, conditions } }, answers).matched).toBe(
      false
    );
  });

  it('nested conditions evaluate recursively', () => {
    const c: DecisionCondition = {
      any: [
        { all: [{ question: 'team', confidenceBelow: 0.7 }, { probabilityBetween: [0.9, 1] }] },
        {
          atLeast: { count: 1, conditions: [{ question: 'urgency', confidenceBelow: 0.9 }] },
        },
      ],
    };
    const r = evaluateDecisionCondition(c, answers);
    expect(r.matched).toBe(true);
    expect(r.triggeredBy).toEqual([{ question: 'urgency', reason: 'confidence_below' }]);
  });
});

describe('decisionBands', () => {
  const t = { act: 0.9, review: 0.6 };
  it('bands choice/score by confidence', () => {
    expect(decisionBands({ type: 'choice', value: 'a', confidence: 0.95 }, t)).toBe('act');
    expect(decisionBands({ type: 'score', value: 1, confidence: 0.9 }, t)).toBe('act');
    expect(decisionBands({ type: 'choice', value: 'a', confidence: 0.7 }, t)).toBe('review');
    expect(decisionBands({ type: 'choice', value: 'a', confidence: 0.3 }, t)).toBe('escalate');
  });
  it('treats a missing confidence as escalate', () => {
    expect(decisionBands({ type: 'choice', value: 'a' }, t)).toBe('escalate');
  });
  it('bands noul by max(p, 1-p), on either side', () => {
    expect(decisionBands({ type: 'noul', value: 0.97 }, t)).toBe('act');
    expect(decisionBands({ type: 'noul', value: 0.03 }, t)).toBe('act');
    expect(decisionBands({ type: 'noul', value: 0.25 }, t)).toBe('review');
    expect(decisionBands({ type: 'noul', value: 0.5 }, t)).toBe('escalate');
  });
  it('rejects thresholds where review exceeds act', () => {
    expect(() => decisionBands({ type: 'noul', value: 0.5 }, { act: 0.5, review: 0.9 })).toThrow(
      ValidationError
    );
  });
});

function lowConfidencePrimary() {
  return createMockDecisionBackend({
    name: 'primary',
    model: 'primary-model',
    handler: (req): IRDecisionResponse => ({
      answers,
      model: 'primary-model',
      usage: { inputTokens: 100, outputTokens: 2, cost: 0.001 },
      metadata: req.metadata,
    }),
  });
}

function fallbackBackend(model = 'fallback-model') {
  return createMockDecisionBackend({
    name: 'fallback',
    handler: (req): IRDecisionResponse => ({
      answers: {
        team: { type: 'choice', value: 'auth', confidence: 0.99 },
        urgency: { type: 'score', value: 2 },
        refund: { type: 'noul', value: 0.99 },
      },
      model,
      usage: { inputTokens: 40, outputTokens: 5, cost: 0.002 },
      metadata: { ...req.metadata, custom: { keep: 'me' } },
    }),
  });
}

describe('createDecisionEscalation', () => {
  it('passes the primary response through when nothing matches', async () => {
    const primary = lowConfidencePrimary();
    const fallback = fallbackBackend();
    const mw = createDecisionEscalation({ fallback, when: { confidenceBelow: 0.1 } });
    const res = await mw(request, (r) => primary.decide(r));
    expect(res.model).toBe('primary-model');
    expect(fallback.calls).toHaveLength(0);
    expect(res.metadata.custom?.escalation).toBeUndefined();
  });

  it('reruns the whole original request on the fallback and records the escalation', async () => {
    const primary = lowConfidencePrimary();
    const fallback = fallbackBackend();
    const onEscalate = vi.fn();
    const mw = createDecisionEscalation({
      fallback,
      when: { question: 'team', confidenceBelow: 0.7 },
      onEscalate,
    });
    const res = await mw(request, (r) => primary.decide(r));

    // whole request, not just the triggering question
    expect(fallback.calls).toHaveLength(1);
    expect(Object.keys(fallback.calls[0]!.questions)).toEqual(['team', 'urgency', 'refund']);
    expect(fallback.calls[0]!.state).toBe(request.state);

    expect(res.model).toBe('fallback-model');
    expect(res.answers.team).toMatchObject({ value: 'auth' });
    expect(res.metadata.custom?.keep).toBe('me');
    expect(res.metadata.custom?.escalation).toEqual({
      triggeredBy: [{ question: 'team', reason: 'confidence_below' }],
      primaryModel: 'primary-model',
      primaryBackend: undefined,
      primaryUsage: { inputTokens: 100, outputTokens: 2, cost: 0.001 },
    });
    expect(onEscalate).toHaveBeenCalledTimes(1);
    expect(onEscalate.mock.calls[0]![0].triggeredBy).toHaveLength(1);
  });

  it('sums primary and fallback usage (both stages are billed)', async () => {
    const mw = createDecisionEscalation({
      fallback: fallbackBackend(),
      when: { confidenceBelow: 0.9 },
    });
    const res = await mw(request, (r) => lowConfidencePrimary().decide(r));
    expect(res.usage?.inputTokens).toBe(140);
    expect(res.usage?.outputTokens).toBe(7);
    expect(res.usage?.cost).toBeCloseTo(0.003);
  });

  it('reports the primary backend from provenance when present', async () => {
    const primary = createMockDecisionBackend({
      handler: (req) => ({
        answers,
        model: 'm',
        metadata: { ...req.metadata, provenance: { backend: 'primary-x' } },
      }),
    });
    const mw = createDecisionEscalation({
      fallback: fallbackBackend(),
      when: { confidenceBelow: 0.9 },
    });
    const res = await mw(request, (r) => primary.decide(r));
    expect((res.metadata.custom?.escalation as { primaryBackend: string }).primaryBackend).toBe(
      'primary-x'
    );
  });

  it('accepts a function that picks the fallback from the request', async () => {
    const fallback = fallbackBackend();
    const pick = vi.fn(() => fallback);
    const mw = createDecisionEscalation({ fallback: pick, when: { confidenceBelow: 0.9 } });
    await mw(request, (r) => lowConfidencePrimary().decide(r));
    expect(pick).toHaveBeenCalledWith(request);
    expect(fallback.calls).toHaveLength(1);
  });

  it('plugs into bridge.useDecision', async () => {
    const primary = lowConfidencePrimary();
    const fallback = fallbackBackend();
    const bridge = new Bridge(new OpenAIFrontendAdapter(), primary);
    bridge.useDecision(
      createDecisionEscalation({ fallback, when: { question: 'team', confidenceBelow: 0.7 } })
    );
    const res = await bridge.decide('I was charged twice', questions);
    expect(res.answers.team).toMatchObject({ value: 'auth' });
    expect(res.metadata.custom?.escalation).toBeDefined();
  });

  describe('validation (before any backend is called)', () => {
    const run = async (when: DecisionCondition, qs = questions) => {
      const primary = lowConfidencePrimary();
      const mw = createDecisionEscalation({ fallback: fallbackBackend(), when });
      try {
        await mw({ ...request, questions: qs }, (r) => primary.decide(r));
      } catch (error) {
        expect(primary.calls).toHaveLength(0);
        throw error;
      }
    };

    it('rejects confidenceBelow on a noul question', async () => {
      await expect(run({ question: 'refund', confidenceBelow: 0.5 })).rejects.toThrow(
        ValidationError
      );
    });
    it('rejects probabilityBetween on a choice question', async () => {
      await expect(run({ question: 'team', probabilityBetween: [0.1, 0.9] })).rejects.toThrow(
        ValidationError
      );
    });
    it('rejects an unknown question name', async () => {
      await expect(run({ question: 'ghost', confidenceBelow: 0.5 })).rejects.toThrow(/ghost/);
    });
    it('rejects a leaf that cannot apply to any question', async () => {
      await expect(run({ confidenceBelow: 0.5 }, { refund: questions.refund! })).rejects.toThrow(
        ValidationError
      );
    });
    it('rejects out-of-range numbers and inverted ranges', async () => {
      await expect(run({ confidenceBelow: 1.5 })).rejects.toThrow(ValidationError);
      await expect(run({ probabilityBetween: [0.8, 0.2] })).rejects.toThrow(ValidationError);
    });
    it('rejects empty and oversize any/all lists', async () => {
      await expect(run({ any: [] })).rejects.toThrow(ValidationError);
      const many = Array.from({ length: 21 }, () => ({ confidenceBelow: 0.5 }));
      await expect(run({ all: many })).rejects.toThrow(ValidationError);
      await expect(run({ all: many.slice(0, 20) })).resolves.toBeUndefined();
    });
    it('rejects nesting deeper than 5', async () => {
      let c: DecisionCondition = { confidenceBelow: 0.5 };
      for (let i = 0; i < 4; i++) c = { any: [c] };
      await expect(run(c)).resolves.toBeUndefined(); // depth 5
      await expect(run({ any: [c] })).rejects.toThrow(/nest/i);
    });
    it('rejects atLeast with an impossible count', async () => {
      await expect(
        run({ atLeast: { count: 3, conditions: [{ confidenceBelow: 0.5 }] } })
      ).rejects.toThrow(ValidationError);
    });
    it('rejects an object that is not a condition', async () => {
      await expect(run({} as DecisionCondition)).rejects.toThrow(ValidationError);
    });
  });

  it('throws when the chosen fallback cannot decide', async () => {
    const mw = createDecisionEscalation({
      fallback: { metadata: fallbackBackend().metadata } as never,
      when: { confidenceBelow: 0.9 },
    });
    await expect(mw(request, (r) => lowConfidencePrimary().decide(r))).rejects.toThrow(/decide/);
  });
});
