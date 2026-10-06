/**
 * Calibration tests (#147): createTemperatureScaling (patterns) and
 * calibrationReport / fitTemperature (testing).
 */

import { describe, it, expect } from 'vitest';
import { ValidationError } from '@johnhenry/aimatey-errors';
import { noulConfidence } from '@johnhenry/aimatey-utils';
import { createTemperatureScaling } from '@johnhenry/aimatey-patterns';
import {
  calibrationReport,
  fitTemperature,
  createMockDecisionBackend,
} from '@johnhenry/aimatey-testing';
import type {
  IRDecisionAnswer,
  IRDecisionRequest,
  IRDecisionResponse,
} from '@johnhenry/aimatey-types';

const request: IRDecisionRequest = {
  state: 'x',
  questions: {
    team: { type: 'choice', instructions: 'Team?', criteria: { a: 'A', b: 'B', c: 'C' } },
    level: { type: 'score', instructions: 'Level?', criteria: ['lo', 'mid', 'hi'] },
    yes: { type: 'noul', instructions: 'Yes?' },
  },
  metadata: { requestId: 'r', timestamp: 1 },
};

const raw: Record<string, IRDecisionAnswer> = {
  team: { type: 'choice', value: 'a', probabilities: { a: 0.7, b: 0.2, c: 0.1 }, confidence: 0.4 },
  level: { type: 'score', value: 1.1, probabilities: [0.1, 0.7, 0.2], confidence: 0.4 },
  yes: { type: 'noul', value: 0.9, confidence: 0.9 },
};

async function scaled(config: Parameters<typeof createTemperatureScaling>[0]) {
  const backend = createMockDecisionBackend({
    handler: (req): IRDecisionResponse => ({ answers: raw, model: 'm', metadata: req.metadata }),
  });
  const res = await createTemperatureScaling(config)(request, (r) => backend.decide(r));
  return res.answers as {
    team: Extract<IRDecisionAnswer, { type: 'choice' }>;
    level: Extract<IRDecisionAnswer, { type: 'score' }>;
    yes: Extract<IRDecisionAnswer, { type: 'noul' }>;
  };
}

describe('createTemperatureScaling', () => {
  it('T = 1 leaves probabilities unchanged', async () => {
    const a = await scaled({ default: 1 });
    expect(a.team.probabilities!.a).toBeCloseTo(0.7);
    expect(a.yes.value).toBeCloseTo(0.9);
    expect(a.level.probabilities![1]).toBeCloseTo(0.7);
  });

  it('T > 1 softens, T < 1 sharpens, and probabilities still sum to 1', async () => {
    const soft = await scaled({ default: 2 });
    const sharp = await scaled({ default: 0.5 });
    expect(soft.team.probabilities!.a).toBeLessThan(0.7);
    expect(sharp.team.probabilities!.a).toBeGreaterThan(0.7);
    const sum = (p: Record<string, number>) => Object.values(p).reduce((s, x) => s + x, 0);
    expect(sum(soft.team.probabilities!)).toBeCloseTo(1);
    expect(sum(sharp.team.probabilities!)).toBeCloseTo(1);
    // closed form: p^(1/T) normalized
    const w = [0.7, 0.2, 0.1].map((p) => Math.sqrt(p));
    expect(soft.team.probabilities!.a).toBeCloseTo(w[0]! / w.reduce((s, x) => s + x, 0));
  });

  it('keeps the argmax and changes confidence monotonically with T', async () => {
    const confs: number[] = [];
    for (const T of [0.5, 1, 2, 4]) {
      const a = await scaled({ default: T });
      expect(a.team.value).toBe('a');
      confs.push(a.team.confidence!);
    }
    for (let i = 1; i < confs.length; i++) expect(confs[i]!).toBeLessThan(confs[i - 1]!);
  });

  it('recomputes confidence as 1 - H(p)/ln(n) by default (not the old number)', async () => {
    const a = await scaled({ default: 1 });
    const p = [0.7, 0.2, 0.1];
    const H = -p.reduce((s, x) => s + x * Math.log(x), 0);
    expect(a.team.confidence).toBeCloseTo(1 - H / Math.log(3));
    expect(a.team.confidence).not.toBeCloseTo(0.4);
  });

  it('score: value becomes the expected level index of the rescaled distribution', async () => {
    const a = await scaled({ default: 2 });
    const probs = a.level.probabilities!;
    expect(a.level.value).toBeCloseTo(probs[1]! + 2 * probs[2]!);
  });

  it('noul: logit / T, confidence = noulConfidence(p)', async () => {
    const a = await scaled({ default: 2 });
    const logit = Math.log(0.9 / 0.1) / 2;
    const p = 1 / (1 + Math.exp(-logit));
    expect(a.yes.value).toBeCloseTo(p);
    expect(a.yes.confidence).toBeCloseTo(noulConfidence(p));
    const low = await scaled({ default: 2 });
    expect(low.yes.value).toBeLessThan(0.9);
    // a probability below .5 stays below .5
    const backend = createMockDecisionBackend({ answers: { yes: { type: 'noul', value: 0.1 } } });
    const res = await createTemperatureScaling({ default: 3 })(
      { ...request, questions: { yes: request.questions.yes! } },
      (r) => backend.decide(r)
    );
    const v = (res.answers.yes as { value: number }).value;
    expect(v).toBeGreaterThan(0.1);
    expect(v).toBeLessThan(0.5);
  });

  it('leaves exact 0 and 1 alone and answers with no probabilities untouched', async () => {
    const backend = createMockDecisionBackend({
      answers: {
        team: { type: 'choice', value: 'a' },
        yes: { type: 'noul', value: 1 },
      },
    });
    const res = await createTemperatureScaling({ default: 3 })(
      { ...request, questions: { team: request.questions.team!, yes: request.questions.yes! } },
      (r) => backend.decide(r)
    );
    expect(res.answers.team).toEqual({ type: 'choice', value: 'a' });
    expect(res.answers.yes).toEqual({ type: 'noul', value: 1, confidence: 1 });
  });

  it('resolves T by option count, then type, then default', async () => {
    // team has 3 options, level has 3 levels, yes counts as 2
    const a = await scaled({ byOptionCount: { 3: 1 }, byType: { choice: 9, noul: 1 }, default: 2 });
    expect(a.team.probabilities!.a).toBeCloseTo(0.7); // count wins over type
    expect(a.level.probabilities![1]).toBeCloseTo(0.7);
    expect(a.yes.value).toBeCloseTo(0.9); // type noul = 1
    const b = await scaled({ byType: { choice: 1 }, default: 2 });
    expect(b.team.probabilities!.a).toBeCloseTo(0.7);
    expect(b.level.probabilities![1]).toBeLessThan(0.7); // default 2
  });

  it('defaults to T = 1 everywhere with no config', async () => {
    const a = await scaled({});
    expect(a.team.probabilities!.a).toBeCloseTo(0.7);
  });

  it('winner-mass noul confidence is max(p, 1-p)', async () => {
    const a = await scaled({ default: 1, confidence: 'winner-mass' });
    expect(a.yes.confidence).toBeCloseTo(0.9);
  });

  it('winner-mass confidence is available', async () => {
    const a = await scaled({ default: 1, confidence: 'winner-mass' });
    expect(a.team.confidence).toBeCloseTo(0.7);
  });

  it('rejects non-positive temperatures', () => {
    expect(() => createTemperatureScaling({ default: 0 })).toThrow(ValidationError);
    expect(() => createTemperatureScaling({ byType: { choice: -1 } })).toThrow(ValidationError);
    expect(() => createTemperatureScaling({ byOptionCount: { 3: Number.NaN } })).toThrow(
      ValidationError
    );
  });
});

describe('calibrationReport', () => {
  it('computes Brier exactly on noul runs', () => {
    const runs = [
      { answer: { type: 'noul', value: 0.9 } as IRDecisionAnswer, truth: true },
      { answer: { type: 'noul', value: 0.8 } as IRDecisionAnswer, truth: false },
      { answer: { type: 'noul', value: 0.2 } as IRDecisionAnswer, truth: false },
      { answer: { type: 'noul', value: 0.5 } as IRDecisionAnswer, truth: true },
    ];
    const r = calibrationReport(runs);
    // (0.1^2 + 0.8^2 + 0.2^2 + 0.5^2) / 4
    expect(r.brier).toBeCloseTo((0.01 + 0.64 + 0.04 + 0.25) / 4);
    expect(r.buckets).toHaveLength(10);
  });

  it('perfect, confident predictions have Brier 0 and ECE 0', () => {
    const runs = Array.from({ length: 5 }, (_, i) => ({
      answer: { type: 'noul', value: i % 2 ? 1 : 0 } as IRDecisionAnswer,
      truth: i % 2 === 1,
    }));
    const r = calibrationReport(runs);
    expect(r.brier).toBe(0);
    expect(r.ece).toBeCloseTo(0);
  });

  it('buckets by confidence with count, mean confidence and accuracy', () => {
    const mk = (conf: number, ok: boolean): { answer: IRDecisionAnswer; truth: string } => ({
      answer: {
        type: 'choice',
        value: 'a',
        confidence: conf,
        probabilities: { a: conf, b: 1 - conf },
      },
      truth: ok ? 'a' : 'b',
    });
    const r = calibrationReport([mk(0.95, true), mk(0.92, true), mk(0.91, false), mk(0.55, true)]);
    const hi = r.buckets[9]!;
    expect(hi.range).toEqual([0.9, 1]);
    expect(hi.count).toBe(3);
    expect(hi.meanConfidence).toBeCloseTo((0.95 + 0.92 + 0.91) / 3);
    expect(hi.accuracy).toBeCloseTo(2 / 3);
    const mid = r.buckets[5]!;
    expect(mid.count).toBe(1);
    expect(mid.accuracy).toBe(1);
    expect(r.buckets[0]!.count).toBe(0);
    // ECE = sum(n_b / N * |acc - conf|)
    const expected =
      (3 / 4) * Math.abs(2 / 3 - (0.95 + 0.92 + 0.91) / 3) + (1 / 4) * Math.abs(1 - 0.55);
    expect(r.ece).toBeCloseTo(expected);
  });

  it('confidence 1.0 lands in the last bucket', () => {
    const r = calibrationReport([
      { answer: { type: 'choice', value: 'a', confidence: 1 }, truth: 'a' },
    ]);
    expect(r.buckets[9]!.count).toBe(1);
  });

  it('uses multi-class Brier when probabilities exist (choice and score)', () => {
    const r = calibrationReport([
      {
        answer: {
          type: 'choice',
          value: 'a',
          probabilities: { a: 0.6, b: 0.3, c: 0.1 },
          confidence: 0.6,
        },
        truth: 'b',
      },
      {
        answer: { type: 'score', value: 1, probabilities: [0.2, 0.8], confidence: 0.8 },
        truth: 1,
      },
    ]);
    const first = 0.36 + 0.49 + 0.01;
    const second = 0.04 + 0.04;
    expect(r.brier).toBeCloseTo((first + second) / 2);
  });

  it('skips runs with nothing to measure and reports how many', () => {
    const r = calibrationReport([
      { answer: { type: 'choice', value: 'a' }, truth: 'a' },
      { answer: { type: 'noul', value: 0.7 }, truth: true },
    ]);
    expect(r.n).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it('is NaN-free on empty input', () => {
    const r = calibrationReport([]);
    expect(r.brier).toBe(0);
    expect(r.ece).toBe(0);
    expect(r.n).toBe(0);
  });
});

describe('fitTemperature', () => {
  /** Deterministic over-confident noul runs: says 0.95 but is right ~70% of the time. */
  const overconfident = () => {
    const runs: Array<{ answer: IRDecisionAnswer; truth: boolean }> = [];
    for (let i = 0; i < 100; i++) {
      runs.push({ answer: { type: 'noul', value: 0.95 }, truth: i % 10 < 7 });
    }
    return runs;
  };

  it('finds T > 1 for over-confident predictions and the optimum matches the closed form', () => {
    const fit = fitTemperature(overconfident());
    expect(fit.temperature).toBeGreaterThan(1.5);
    // NLL-optimal sigmoid(logit(.95)/T) = 0.7  =>  T = logit(.95)/logit(.7)
    const expected = Math.log(0.95 / 0.05) / Math.log(0.7 / 0.3);
    expect(fit.temperature).toBeCloseTo(expected, 1);
    expect(fit.nll).toBeLessThan(fit.nllBefore);
  });

  it('finds T < 1 for under-confident predictions', () => {
    const runs: Array<{ answer: IRDecisionAnswer; truth: boolean }> = [];
    for (let i = 0; i < 100; i++)
      runs.push({ answer: { type: 'noul', value: 0.6 }, truth: i % 10 < 9 });
    expect(fitTemperature(runs).temperature).toBeLessThan(1);
  });

  it('is ~1 for already calibrated predictions', () => {
    const runs: Array<{ answer: IRDecisionAnswer; truth: boolean }> = [];
    for (let i = 0; i < 100; i++)
      runs.push({ answer: { type: 'noul', value: 0.8 }, truth: i % 10 < 8 });
    expect(fitTemperature(runs).temperature).toBeCloseTo(1, 1);
  });

  it('fits choice runs from probabilities', () => {
    const runs: Array<{ answer: IRDecisionAnswer; truth: string }> = [];
    for (let i = 0; i < 100; i++) {
      runs.push({
        answer: { type: 'choice', value: 'a', probabilities: { a: 0.9, b: 0.1 } },
        truth: i % 10 < 6 ? 'a' : 'b',
      });
    }
    expect(fitTemperature(runs).temperature).toBeGreaterThan(1);
  });

  it('fitted temperature, applied, lowers ECE', async () => {
    const runs = overconfident();
    const T = fitTemperature(runs).temperature;
    const backend = createMockDecisionBackend({ answers: { q: { type: 'noul', value: 0.95 } } });
    const mw = createTemperatureScaling({ byType: { noul: T } });
    const res = await mw(
      {
        state: 'x',
        questions: { q: { type: 'noul', instructions: '?' } },
        metadata: { requestId: 'r', timestamp: 1 },
      },
      (r) => backend.decide(r)
    );
    // ECE treats confidence as the chance of being right, so grade the rescaled
    // value itself (winner mass) rather than its concentration `confidence`.
    const { value } = res.answers.q as { value: number };
    const rescaled = runs.map((run) => ({ ...run, answer: { type: 'noul', value } as const }));
    expect(calibrationReport(rescaled).ece).toBeLessThan(calibrationReport(runs).ece);
  });

  it('throws when no run carries probabilities', () => {
    expect(() =>
      fitTemperature([{ answer: { type: 'choice', value: 'a' }, truth: 'a' }])
    ).toThrow();
  });
});

describe('calibrationReport predicted probability (#171)', () => {
  /** 10 runs, answer `a` with p = 0.8 each, 8 right: perfectly calibrated at 0.8. */
  const calibrated = (confidence?: number) =>
    Array.from({ length: 10 }, (_, i) => ({
      answer: {
        type: 'choice',
        value: 'a',
        probabilities: { a: 0.8, b: 0.1, c: 0.1 },
        ...(confidence === undefined ? {} : { confidence }),
      } as IRDecisionAnswer,
      truth: i < 8 ? 'a' : 'b',
    }));

  it('choice: ECE ~ 0 from probabilities even when confidence is garbage', () => {
    const r = calibrationReport(calibrated(0.01));
    expect(r.ece).toBeCloseTo(0);
    expect(r.buckets[8]!.count).toBe(10);
    expect(r.buckets[8]!.meanConfidence).toBeCloseTo(0.8);
  });

  it('score: uses the mass on the rounded winning level', () => {
    const runs = Array.from({ length: 10 }, (_, i) => ({
      answer: {
        type: 'score',
        value: 1.2,
        probabilities: [0.1, 0.8, 0.1],
        confidence: 0.99,
      } as IRDecisionAnswer,
      truth: i < 8 ? 1 : 0,
    }));
    const r = calibrationReport(runs);
    expect(r.ece).toBeCloseTo(0);
    expect(r.buckets[8]!.count).toBe(10);
  });

  it('noul: uses max(value, 1 - value), ignoring confidence', () => {
    const runs = Array.from({ length: 10 }, (_, i) => ({
      answer: { type: 'noul', value: 0.2, confidence: 0.99 } as IRDecisionAnswer,
      truth: i >= 8, // false 8 times of 10 -> right 80% of the time at p = 0.8
    }));
    const r = calibrationReport(runs);
    expect(r.ece).toBeCloseTo(0);
    expect(r.buckets[8]!.count).toBe(10);
  });

  it('falls back to confidence only when probabilities are absent', () => {
    const r = calibrationReport([
      { answer: { type: 'choice', value: 'a', confidence: 0.95 }, truth: 'a' },
      { answer: { type: 'score', value: 1, confidence: 0.35 }, truth: 1 },
    ]);
    expect(r.n).toBe(2);
    expect(r.buckets[9]!.count).toBe(1);
    expect(r.buckets[3]!.count).toBe(1);
  });
});
