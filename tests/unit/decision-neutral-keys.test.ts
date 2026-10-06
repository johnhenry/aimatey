/**
 * createNeutralOptionKeys tests (#147): choice criteria are rewritten to
 * opt_1..n with the original key folded into the description, and answers
 * are mapped back.
 */

import { describe, it, expect } from 'vitest';
import { createNeutralOptionKeys } from '@johnhenry/aimatey-patterns';
import { createMockDecisionBackend } from '@johnhenry/aimatey-testing';
import type {
  IRDecisionAnswer,
  IRDecisionRequest,
  IRDecisionResponse,
} from '@johnhenry/aimatey-types';

const request: IRDecisionRequest = {
  state: 'x',
  questions: {
    team: {
      type: 'choice',
      instructions: 'Which team?',
      criteria: { billing: 'Charges', auth: 'Login', other: 'Anything else' },
    },
    urgency: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'high'] },
    refund: {
      type: 'noul',
      instructions: 'Refund?',
      criteria: { true: 'asks for money back', false: 'does not' },
    },
  },
  metadata: { requestId: 'r', timestamp: 1 },
};

/** A backend that picks the option whose description starts with `pick:`. */
function pickingBackend(pick: (req: IRDecisionRequest) => Record<string, IRDecisionAnswer>) {
  return createMockDecisionBackend({
    handler: (req): IRDecisionResponse => ({
      answers: pick(req),
      model: 'm',
      metadata: req.metadata,
    }),
  });
}

describe('createNeutralOptionKeys', () => {
  it('rewrites choice keys to opt_n and folds the original key into the description', async () => {
    const backend = pickingBackend((req) => ({
      team: {
        type: 'choice',
        value: Object.keys((req.questions.team as { criteria: object }).criteria)[0]!,
      },
      urgency: { type: 'score', value: 0 },
      refund: { type: 'noul', value: 0.8 },
    }));
    const mw = createNeutralOptionKeys();
    await mw(request, (r) => backend.decide(r));
    const sent = backend.calls[0]!.questions.team as { criteria: Record<string, string> };
    expect(sent.criteria).toEqual({
      opt_1: 'billing: Charges',
      opt_2: 'auth: Login',
      opt_3: 'other: Anything else',
    });
    // score and noul are untouched by default
    expect(backend.calls[0]!.questions.urgency).toEqual(request.questions.urgency);
    expect(backend.calls[0]!.questions.refund).toEqual(request.questions.refund);
    // the input is not mutated
    expect((request.questions.team as { criteria: Record<string, string> }).criteria.billing).toBe(
      'Charges'
    );
  });

  it('maps value and probabilities back to the original keys', async () => {
    const backend = pickingBackend(() => ({
      team: {
        type: 'choice',
        value: 'opt_2',
        probabilities: { opt_1: 0.1, opt_2: 0.7, opt_3: 0.2 },
        confidence: 0.7,
        reasoning: 'because',
      },
      urgency: { type: 'score', value: 1 },
      refund: { type: 'noul', value: 0.3 },
    }));
    const res = await createNeutralOptionKeys()(request, (r) => backend.decide(r));
    expect(res.answers.team).toEqual({
      type: 'choice',
      value: 'auth',
      probabilities: { billing: 0.1, auth: 0.7, other: 0.2 },
      confidence: 0.7,
      reasoning: 'because',
    });
    expect(res.answers.urgency).toEqual({ type: 'score', value: 1 });
  });

  it('honours a custom prefix', async () => {
    const backend = pickingBackend(() => ({ team: { type: 'choice', value: 'o_1' } }));
    const onlyTeam = { ...request, questions: { team: request.questions.team! } };
    const res = await createNeutralOptionKeys({ prefix: 'o' })(onlyTeam, (r) => backend.decide(r));
    expect(
      Object.keys((backend.calls[0]!.questions.team as { criteria: object }).criteria)
    ).toEqual(['o_1', 'o_2', 'o_3']);
    expect(res.answers.team).toMatchObject({ value: 'billing' });
  });

  it('round-trips under shuffle: a definition-following backend gets the same answer', async () => {
    // Follows definitions: always picks whichever neutral key's description mentions "Login".
    const follower = pickingBackend((req) => {
      const crit = (req.questions.team as { criteria: Record<string, string> }).criteria;
      const key = Object.entries(crit).find(([, d]) => d.includes('Login'))![0];
      return { team: { type: 'choice', value: key } };
    });
    const onlyTeam = { ...request, questions: { team: request.questions.team! } };
    const orders = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const mw = createNeutralOptionKeys({ shuffle: true, seed });
      const res = await mw(onlyTeam, (r) => follower.decide(r));
      expect(res.answers.team).toMatchObject({ value: 'auth' });
      const sent = follower.calls.at(-1)!.questions.team as { criteria: Record<string, string> };
      expect(Object.keys(sent.criteria)).toEqual(['opt_1', 'opt_2', 'opt_3']);
      orders.add(Object.values(sent.criteria).join('|'));
    }
    expect(orders.size).toBeGreaterThan(1); // it actually shuffled
  });

  it('un-shuffles probabilities', async () => {
    // Probabilities keyed by the description's original name, whatever order it was sent in.
    const backend = pickingBackend((req) => {
      const crit = (req.questions.team as { criteria: Record<string, string> }).criteria;
      const weight: Record<string, number> = { billing: 0.5, auth: 0.3, other: 0.2 };
      const probabilities = Object.fromEntries(
        Object.entries(crit).map(([k, d]) => [k, weight[d.split(':')[0]!]!])
      );
      const value = Object.entries(crit).find(([, d]) => d.startsWith('billing'))![0];
      return { team: { type: 'choice', value, probabilities } };
    });
    const onlyTeam = { ...request, questions: { team: request.questions.team! } };
    const res = await createNeutralOptionKeys({ shuffle: true, seed: 42 })(onlyTeam, (r) =>
      backend.decide(r)
    );
    expect(res.answers.team).toMatchObject({
      value: 'billing',
      probabilities: { billing: 0.5, auth: 0.3, other: 0.2 },
    });
  });

  it('is deterministic for a seed and different across seeds', async () => {
    const send = async (seed: number) => {
      const backend = pickingBackend(() => ({ team: { type: 'choice', value: 'opt_1' } }));
      const onlyTeam = { ...request, questions: { team: request.questions.team! } };
      await createNeutralOptionKeys({ shuffle: true, seed })(onlyTeam, (r) => backend.decide(r));
      return JSON.stringify(backend.calls[0]!.questions);
    };
    expect(await send(7)).toBe(await send(7));
    const variants = new Set([await send(1), await send(2), await send(3), await send(4)]);
    expect(variants.size).toBeGreaterThan(1);
  });

  describe('noulAsChoice', () => {
    it('turns a noul into a two-option choice and maps the answer to P(true)', async () => {
      const backend = pickingBackend(() => ({
        refund: { type: 'choice', value: 'opt_1', probabilities: { opt_1: 0.8, opt_2: 0.2 } },
      }));
      const onlyRefund = { ...request, questions: { refund: request.questions.refund! } };
      const res = await createNeutralOptionKeys({ noulAsChoice: true })(onlyRefund, (r) =>
        backend.decide(r)
      );
      const sent = backend.calls[0]!.questions.refund as { type: string; criteria: object };
      expect(sent.type).toBe('choice');
      expect(sent.criteria).toEqual({
        opt_1: 'true: asks for money back',
        opt_2: 'false: does not',
      });
      expect(res.answers.refund).toEqual({ type: 'noul', value: 0.8, confidence: 0.8 });
    });

    it('uses a one-hot value when the backend gives no probabilities', async () => {
      const backend = pickingBackend(() => ({ refund: { type: 'choice', value: 'opt_2' } }));
      const onlyRefund = { ...request, questions: { refund: request.questions.refund! } };
      const res = await createNeutralOptionKeys({ noulAsChoice: true })(onlyRefund, (r) =>
        backend.decide(r)
      );
      expect(res.answers.refund).toEqual({ type: 'noul', value: 0 });
    });

    it('un-shuffles when the true option was sent second', async () => {
      const backend = pickingBackend((req) => {
        const crit = (req.questions.refund as { criteria: Record<string, string> }).criteria;
        const probabilities = Object.fromEntries(
          Object.entries(crit).map(([k, d]) => [k, d.startsWith('true') ? 0.9 : 0.1])
        );
        return { refund: { type: 'choice', value: 'opt_1', probabilities } };
      });
      const onlyRefund = { ...request, questions: { refund: request.questions.refund! } };
      for (const seed of [1, 2, 3, 4, 5]) {
        const res = await createNeutralOptionKeys({ noulAsChoice: true, shuffle: true, seed })(
          onlyRefund,
          (r) => backend.decide(r)
        );
        expect((res.answers.refund as { value: number }).value).toBeCloseTo(0.9);
      }
    });
  });

  it('flags a returned key it did not send instead of guessing', async () => {
    const backend = pickingBackend(() => ({ team: { type: 'choice', value: 'mystery' } }));
    const onlyTeam = { ...request, questions: { team: request.questions.team! } };
    const res = await createNeutralOptionKeys()(onlyTeam, (r) => backend.decide(r));
    expect(res.answers.team).toMatchObject({ value: 'mystery' });
    expect(res.metadata.warnings?.some((w) => w.category === 'response-malformed')).toBe(true);
  });

  it('is a no-op for requests with no choice questions', async () => {
    const backend = pickingBackend(() => ({ urgency: { type: 'score', value: 0 } }));
    const only = { ...request, questions: { urgency: request.questions.urgency! } };
    await createNeutralOptionKeys()(only, (r) => backend.decide(r));
    expect(backend.calls[0]!.questions).toEqual(only.questions);
  });
});
