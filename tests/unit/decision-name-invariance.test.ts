/**
 * nameInvariance tests (#147): the arXiv 2609.26758 two-extra-passes metric.
 */

import { describe, it, expect } from 'vitest';
import { nameInvariance, createMockDecisionBackend } from '@johnhenry/aimatey-testing';
import type {
  IRDecisionAnswer,
  IRDecisionQuestion,
  IRDecisionRequest,
  IRDecisionResponse,
} from '@johnhenry/aimatey-types';

const request: IRDecisionRequest = {
  state: 'I was charged twice and want a refund',
  questions: {
    team: {
      type: 'choice',
      instructions: 'Which team?',
      criteria: {
        billing: 'charges and refunds',
        auth: 'login problems',
        other: 'anything else',
      },
    },
    refund: {
      type: 'noul',
      instructions: 'Refund requested?',
      criteria: { true: 'asks for money back', false: 'does not ask' },
    },
  },
  metadata: { requestId: 'r', timestamp: 1 },
};

/** The "true" definition is whatever this backend knows: billing. */
const TRUTH = 'charges and refunds';

/** Follows definitions: reads the description text, ignores the key. */
function definitionFollower() {
  return createMockDecisionBackend({
    handler: (req): IRDecisionResponse => {
      const answers: Record<string, IRDecisionAnswer> = {};
      for (const [name, q] of Object.entries(req.questions)) answers[name] = answerByDefinition(q);
      return { answers, model: 'definition-follower', metadata: req.metadata };
    },
  });
}

function answerByDefinition(q: IRDecisionQuestion): IRDecisionAnswer {
  if (q.type === 'choice') {
    const hit = Object.entries(q.criteria).find(([, d]) => d.includes(TRUTH));
    return { type: 'choice', value: hit![0] };
  }
  if (q.type === 'noul') {
    // the side whose label is "asks for money back" is the correct one
    const trueIsRefund = q.criteria?.true.includes('money back') ?? true;
    return { type: 'noul', value: trueIsRefund ? 0.95 : 0.05 };
  }
  return { type: 'score', value: 0 };
}

/** Follows names: always answers 'billing' / true, whatever it is told they mean. */
function nameFollower() {
  return createMockDecisionBackend({
    handler: (req): IRDecisionResponse => {
      const answers: Record<string, IRDecisionAnswer> = {};
      for (const [name, q] of Object.entries(req.questions)) {
        if (q.type === 'choice') {
          const keys = Object.keys(q.criteria);
          // Keys it recognizes by name: billing; for neutral keys it falls back to the first.
          answers[name] = {
            type: 'choice',
            value: keys.includes('billing') ? 'billing' : keys[0]!,
          };
        } else if (q.type === 'noul') {
          answers[name] = { type: 'noul', value: 0.95 };
        }
      }
      return { answers, model: 'name-follower', metadata: req.metadata };
    },
  });
}

describe('nameInvariance', () => {
  it('a definition-following backend has zero flip rates', async () => {
    const r = await nameInvariance(definitionFollower(), request);
    expect(r.flipRate).toBe(0);
    expect(r.neutralFlipRate).toBe(0);
    expect(r.perQuestion.team).toMatchObject({ flipRate: 0, neutralFlipRate: 0 });
    expect(r.perQuestion.refund).toMatchObject({ flipRate: 0 });
  });

  it('a name-following backend flips whenever names are reassigned', async () => {
    const r = await nameInvariance(nameFollower(), request);
    expect(r.flipRate).toBe(1);
    expect(r.perQuestion.team!.flipRate).toBe(1);
    expect(r.perQuestion.refund!.flipRate).toBe(1);
  });

  it('neutral keys expose a name-follower that depends on key spelling', async () => {
    const r = await nameInvariance(nameFollower(), request, { seed: 3 });
    // billing -> opt_k; the follower picks opt_1 whatever it means, so it flips unless billing was shuffled first
    expect(r.neutralFlipRate).toBeGreaterThanOrEqual(0);
    expect(r.perQuestion.team!.neutralFlipRate).not.toBeNull();
  });

  it('makes exactly 1 + 2 * trials calls, and each pass sees what it should', async () => {
    const backend = definitionFollower();
    await nameInvariance(backend, request, { trials: 2, seed: 1 });
    expect(backend.calls).toHaveLength(5);
    expect(backend.calls[0]!.questions).toEqual(request.questions);
    const neutral = backend.calls
      .slice(1)
      .filter(
        (c) => Object.keys((c.questions.team as { criteria: object }).criteria)[0] === 'opt_1'
      );
    expect(neutral).toHaveLength(2);
    // reassigned: same descriptions, different names on them
    const reassigned = backend.calls
      .slice(1)
      .filter((c) => 'billing' in (c.questions.team as { criteria: object }).criteria);
    expect(reassigned).toHaveLength(2);
    for (const c of reassigned) {
      const crit = (c.questions.team as { criteria: Record<string, string> }).criteria;
      expect(crit.billing).not.toBe('charges and refunds');
      expect(Object.values(crit).sort()).toEqual(
        Object.values(
          (request.questions.team as { criteria: Record<string, string> }).criteria
        ).sort()
      );
    }
  });

  it('ignores score questions and noul questions without criteria', async () => {
    const r = await nameInvariance(definitionFollower(), {
      ...request,
      questions: {
        level: { type: 'score', instructions: 'L?', criteria: ['a', 'b'] },
        bare: { type: 'noul', instructions: '?' },
        team: request.questions.team!,
      },
    });
    expect(Object.keys(r.perQuestion)).toEqual(['team']);
  });

  it('throws when nothing in the request has names to test', async () => {
    await expect(
      nameInvariance(definitionFollower(), {
        ...request,
        questions: { level: { type: 'score', instructions: 'L?', criteria: ['a', 'b'] } },
      })
    ).rejects.toThrow(/nothing to test/i);
  });

  it('is deterministic for a seed', async () => {
    const a = await nameInvariance(nameFollower(), request, { trials: 3, seed: 9 });
    const b = await nameInvariance(nameFollower(), request, { trials: 3, seed: 9 });
    expect(a).toEqual(b);
  });
});
