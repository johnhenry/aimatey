/**
 * createDecisionEnsemble tests (#147)
 */

import { describe, it, expect } from 'vitest';
import { createDecisionEnsemble } from '@johnhenry/aimatey-patterns';
import { createMockDecisionBackend } from '@johnhenry/aimatey-testing';
import type { BackendAdapter, IRDecisionAnswer, IRDecisionRequest } from '@johnhenry/aimatey-types';

const request: IRDecisionRequest = {
  state: 'x',
  questions: {
    team: { type: 'choice', instructions: 'Team?', criteria: { a: 'A', b: 'B' } },
    level: { type: 'score', instructions: 'Level?', criteria: ['lo', 'mid', 'hi'] },
    yes: { type: 'noul', instructions: 'Yes?' },
  },
  metadata: { requestId: 'r', timestamp: 1 },
};

function member(
  name: string,
  answers: Record<string, IRDecisionAnswer>,
  extra: { model?: string; usage?: { inputTokens: number; cost?: number } } = {}
) {
  return createMockDecisionBackend({
    name,
    handler: (req) => ({
      answers,
      model: extra.model ?? `${name}-model`,
      usage: extra.usage,
      metadata: req.metadata,
    }),
  });
}

const m1 = () =>
  member(
    'm1',
    {
      team: { type: 'choice', value: 'a', probabilities: { a: 0.8, b: 0.2 }, confidence: 0.8 },
      level: { type: 'score', value: 0.4, probabilities: [0.6, 0.4, 0], confidence: 0.6 },
      yes: { type: 'noul', value: 0.9 },
    },
    { usage: { inputTokens: 10, cost: 0.1 } }
  );
const m2 = () =>
  member(
    'm2',
    {
      team: { type: 'choice', value: 'b', probabilities: { a: 0.4, b: 0.6 }, confidence: 0.6 },
      level: { type: 'score', value: 1.6, probabilities: [0, 0.4, 0.6], confidence: 0.6 },
      yes: { type: 'noul', value: 0.5 },
    },
    { usage: { inputTokens: 20, cost: 0.2 } }
  );

describe('createDecisionEnsemble', () => {
  it('averages choice probabilities, renormalizes and takes the argmax', async () => {
    const ens = createDecisionEnsemble([m1(), m2()]);
    const res = await ens.decide!(request);
    const team = res.answers.team as Extract<IRDecisionAnswer, { type: 'choice' }>;
    expect(team.value).toBe('a');
    expect(team.probabilities!.a).toBeCloseTo(0.6);
    expect(team.probabilities!.b).toBeCloseTo(0.4);
    expect(Object.values(team.probabilities!).reduce((s, x) => s + x, 0)).toBeCloseTo(1);
  });

  it('confidence = mean member confidence x (1 - disagreement), disagreement = mean total-variation', async () => {
    const ens = createDecisionEnsemble([m1(), m2()]);
    const res = await ens.decide!(request);
    const team = res.answers.team as Extract<IRDecisionAnswer, { type: 'choice' }>;
    // members: (0.8,0.2) and (0.4,0.6) vs mean (0.6,0.4): TV = 0.2 each -> disagreement 0.2
    expect(res.metadata.custom?.ensemble).toMatchObject({
      disagreement: { team: expect.closeTo(0.2) },
    });
    expect(team.confidence).toBeCloseTo(((0.8 + 0.6) / 2) * (1 - 0.2));
  });

  it('identical members have zero disagreement and keep their confidence', async () => {
    const ens = createDecisionEnsemble([m1(), m1()]);
    const res = await ens.decide!(request);
    const meta = res.metadata.custom?.ensemble as { disagreement: Record<string, number> };
    for (const v of Object.values(meta.disagreement)) expect(v).toBeCloseTo(0);
    expect((res.answers.team as { confidence: number }).confidence).toBeCloseTo(0.8);
  });

  it('score: mean of values and of probabilities', async () => {
    const res = await createDecisionEnsemble([m1(), m2()]).decide!(request);
    const level = res.answers.level as Extract<IRDecisionAnswer, { type: 'score' }>;
    expect(level.value).toBeCloseTo(1.0);
    expect(level.probabilities![0]).toBeCloseTo(0.3);
    expect(level.probabilities![1]).toBeCloseTo(0.4);
    expect(level.probabilities![2]).toBeCloseTo(0.3);
  });

  it('noul: mean value; confidence from max(p, 1-p) with disagreement', async () => {
    const res = await createDecisionEnsemble([m1(), m2()]).decide!(request);
    const yes = res.answers.yes as Extract<IRDecisionAnswer, { type: 'noul' }>;
    expect(yes.value).toBeCloseTo(0.7);
    // member confs 0.9 and 0.5 -> mean 0.7; mean abs dev 0.2 -> normalized 0.4
    expect(yes.confidence).toBeCloseTo(0.7 * (1 - 0.4));
  });

  it('median aggregation ignores an outlier', async () => {
    const outlier = member('m3', {
      team: { type: 'choice', value: 'b', probabilities: { a: 0, b: 1 }, confidence: 1 },
      level: { type: 'score', value: 2, probabilities: [0, 0, 1], confidence: 1 },
      yes: { type: 'noul', value: 0 },
    });
    const res = await createDecisionEnsemble([m1(), m1(), outlier], { aggregate: 'median' })
      .decide!(request);
    expect((res.answers.yes as { value: number }).value).toBeCloseTo(0.9);
    expect((res.answers.team as { value: string }).value).toBe('a');
    const mean = await createDecisionEnsemble([m1(), m1(), outlier]).decide!(request);
    expect((mean.answers.yes as { value: number }).value).toBeCloseTo(0.6);
  });

  it('accepts a custom aggregate over the numbers', async () => {
    const res = await createDecisionEnsemble([m1(), m2()], {
      aggregate: (values) => Math.max(...values),
    }).decide!(request);
    expect((res.answers.yes as { value: number }).value).toBeCloseTo(0.9);
  });

  it('a backend without probabilities contributes a one-hot vote and a warning', async () => {
    const bare = member('bare', {
      team: { type: 'choice', value: 'b' },
      level: { type: 'score', value: 2 },
      yes: { type: 'noul', value: 1 },
    });
    const res = await createDecisionEnsemble([m1(), bare]).decide!(request);
    const team = res.answers.team as Extract<IRDecisionAnswer, { type: 'choice' }>;
    expect(team.probabilities!.a).toBeCloseTo(0.4);
    expect(team.probabilities!.b).toBeCloseTo(0.6);
    expect(team.value).toBe('b');
    const w = res.metadata.warnings?.filter(
      (x) => x.source?.includes('bare') || x.message.includes('bare')
    );
    expect(w?.length).toBeGreaterThan(0);
    // confidence is averaged over the members that reported one (m1 only)
    expect(team.confidence).toBeDefined();
  });

  it('omits confidence when no member reports anything', async () => {
    const bare = (n: string) =>
      member(n, {
        team: { type: 'choice', value: 'a' },
        level: { type: 'score', value: 1 },
        yes: { type: 'noul', value: 1 },
      });
    const res = await createDecisionEnsemble([bare('x'), bare('y')]).decide!(request);
    expect((res.answers.team as { confidence?: number }).confidence).toBeUndefined();
  });

  it('records members and sums usage', async () => {
    const res = await createDecisionEnsemble([m1(), m2()]).decide!(request);
    const meta = res.metadata.custom?.ensemble as {
      members: Array<{ backend: string; model: string; answers: Record<string, unknown> }>;
    };
    expect(meta.members.map((m) => [m.backend, m.model])).toEqual([
      ['m1', 'm1-model'],
      ['m2', 'm2-model'],
    ]);
    expect(Object.keys(meta.members[0]!.answers)).toEqual(['team', 'level', 'yes']);
    expect(res.usage?.inputTokens).toBe(30);
    expect(res.usage?.cost).toBeCloseTo(0.3);
  });

  it('runs members in parallel', async () => {
    const slow = (n: string) =>
      createMockDecisionBackend({
        name: n,
        latencyMs: 150,
        answers: {
          team: { type: 'choice', value: 'a' },
          level: { type: 'score', value: 0 },
          yes: { type: 'noul', value: 1 },
        },
      });
    const started = Date.now();
    await createDecisionEnsemble([slow('a'), slow('b'), slow('c')]).decide!(request);
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('concurrency limits how many members are in flight', async () => {
    let active = 0;
    let peak = 0;
    const tracked = (n: string) =>
      createMockDecisionBackend({
        name: n,
        handler: async (req) => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 20));
          active--;
          return {
            answers: {
              team: { type: 'choice', value: 'a' },
              level: { type: 'score', value: 0 },
              yes: { type: 'noul', value: 1 },
            },
            model: 'm',
            metadata: req.metadata,
          };
        },
      });
    await createDecisionEnsemble([tracked('a'), tracked('b'), tracked('c'), tracked('d')], {
      concurrency: 2,
    }).decide!(request);
    expect(peak).toBe(2);
  });

  it('drops failing members with a warning unless requireAll', async () => {
    const broken = createMockDecisionBackend({ name: 'broken', error: new Error('boom') });
    const res = await createDecisionEnsemble([m1(), broken]).decide!(request);
    expect((res.metadata.custom?.ensemble as { members: unknown[] }).members).toHaveLength(1);
    expect(res.metadata.warnings?.some((w) => w.message.includes('broken'))).toBe(true);

    await expect(
      createDecisionEnsemble([m1(), broken], { requireAll: true }).decide!(request)
    ).rejects.toThrow(/boom/);
    await expect(createDecisionEnsemble([broken, broken]).decide!(request)).rejects.toThrow();
  });

  it('capabilities are the intersection of the members', () => {
    const a: BackendAdapter = {
      ...createMockDecisionBackend({ name: 'a' }),
      metadata: {
        ...createMockDecisionBackend().metadata,
        name: 'a',
        capabilities: {
          ...createMockDecisionBackend().metadata.capabilities,
          decisionTypes: ['choice', 'noul'],
          decisionImages: true,
          decisionLimits: { maxQuestions: 10, maxChoiceOptions: 255 },
        },
      },
    };
    const b: BackendAdapter = {
      ...createMockDecisionBackend({ name: 'b' }),
      metadata: {
        ...createMockDecisionBackend().metadata,
        name: 'b',
        capabilities: {
          ...createMockDecisionBackend().metadata.capabilities,
          decisionTypes: ['choice', 'score'],
          decisionImages: false,
          decisionLimits: { maxQuestions: 4, maxScoreLevels: 10 },
        },
      },
    };
    const caps = createDecisionEnsemble([a, b]).metadata.capabilities;
    expect(caps.decisions).toBe(true);
    expect(caps.decisionTypes).toEqual(['choice']);
    expect(caps.decisionImages).toBe(false);
    expect(caps.decisionLimits).toEqual({
      maxQuestions: 4,
      maxChoiceOptions: 255,
      maxScoreLevels: 10,
    });
  });

  it('rejects an empty member list and members that cannot decide', () => {
    expect(() => createDecisionEnsemble([])).toThrow();
    expect(() => createDecisionEnsemble([{ metadata: m1().metadata } as BackendAdapter])).toThrow(
      /decide/
    );
  });
});
