/**
 * Calibration measurement
 *
 * Helpers for finding out how far a decision model's confidence can be
 * trusted on *your* questions: a reliability report (Brier, ECE, buckets)
 * and a one-parameter fit that produces the temperature for
 * `createTemperatureScaling()` in `@johnhenry/aimatey-patterns`.
 *
 * @module
 */

import type { IRDecisionAnswer } from '@johnhenry/aimatey-types';

/** One labeled run: what the model answered, and what was true. */
export interface CalibrationRun {
  readonly answer: IRDecisionAnswer;
  /**
   * Ground truth. `choice`: the correct option key. `score`: the correct
   * level index. `noul`: the correct boolean.
   */
  readonly truth: string | number | boolean;
}

/** One reliability bucket. */
export interface CalibrationBucket {
  /** `[lo, hi)`, except the last bucket, which includes 1. */
  readonly range: [number, number];
  readonly count: number;
  /** Mean reported confidence of the runs in the bucket (0 when empty). */
  readonly meanConfidence: number;
  /** Fraction of the runs in the bucket that were right (0 when empty). */
  readonly accuracy: number;
}

/** Result of {@link calibrationReport}. */
export interface CalibrationReport {
  /** Mean Brier score over the runs measured (lower is better; 0 is perfect). */
  readonly brier: number;
  /** Expected calibration error: sum over buckets of `count / n * |accuracy - meanConfidence|`. */
  readonly ece: number;
  /** Ten equal-width confidence buckets over `[0, 1]`. */
  readonly buckets: CalibrationBucket[];
  /** Runs that were measured. */
  readonly n: number;
  /** Runs left out because the answer carried neither `confidence` nor `probabilities` (and was not a `noul`). */
  readonly skipped: number;
}

const BUCKETS = 10;

/** What one run contributes: its top-label confidence, whether it was right, and its Brier term. */
function measure(
  run: CalibrationRun
): { confidence: number; correct: boolean; brier: number } | null {
  const { answer, truth } = run;
  switch (answer.type) {
    case 'noul': {
      const t = truth === true || truth === 1 ? 1 : 0;
      return {
        confidence: answer.confidence ?? Math.max(answer.value, 1 - answer.value),
        correct: (answer.value >= 0.5 ? 1 : 0) === t,
        brier: (answer.value - t) ** 2,
      };
    }
    case 'choice': {
      const correct = answer.value === truth;
      const p = answer.probabilities;
      const confidence = answer.confidence ?? (p ? Math.max(...Object.values(p)) : undefined);
      if (confidence === undefined) {
        return null;
      }
      const brier = p
        ? Object.entries(p).reduce((s, [k, x]) => s + (x - (k === truth ? 1 : 0)) ** 2, 0)
        : (confidence - (correct ? 1 : 0)) ** 2;
      return { confidence, correct, brier };
    }
    case 'score': {
      const correct = Math.round(answer.value) === truth;
      const p = answer.probabilities;
      const confidence = answer.confidence ?? (p ? Math.max(...p) : undefined);
      if (confidence === undefined) {
        return null;
      }
      const brier = p
        ? p.reduce((s, x, i) => s + (x - (i === truth ? 1 : 0)) ** 2, 0)
        : (confidence - (correct ? 1 : 0)) ** 2;
      return { confidence, correct, brier };
    }
  }
}

/**
 * Reliability report over labeled runs.
 *
 * Each run is judged on its top answer. `confidence` is the answer's own
 * `confidence`, else the largest probability, else (for `noul`)
 * `max(value, 1 - value)`. The Brier term is, per run: `noul` -- `(value -
 * truth)^2`; `choice` / `score` with `probabilities` -- the multi-class
 * Brier score `sum_k (p_k - 1[k = truth])^2`; with only a `confidence` -- `(confidence -
 * correct)^2`. Runs with no confidence of any kind are skipped and counted.
 *
 * Use it to pick the `act` / `review` thresholds for `decisionBands()` from
 * the bucket where accuracy meets your bar, rather than trusting defaults.
 *
 * @example
 * ```typescript
 * const { ece, buckets } = calibrationReport(runs);
 * ```
 */
export function calibrationReport(runs: readonly CalibrationRun[]): CalibrationReport {
  const buckets = Array.from({ length: BUCKETS }, (_, i) => ({
    range: [i / BUCKETS, (i + 1) / BUCKETS] as [number, number],
    count: 0,
    confidenceSum: 0,
    correctSum: 0,
  }));
  let n = 0;
  let skipped = 0;
  let brierSum = 0;
  for (const run of runs) {
    const m = measure(run);
    if (!m) {
      skipped++;
      continue;
    }
    n++;
    brierSum += m.brier;
    const c = Math.min(1, Math.max(0, m.confidence));
    const b = buckets[Math.min(BUCKETS - 1, Math.floor(c * BUCKETS))]!;
    b.count++;
    b.confidenceSum += c;
    b.correctSum += m.correct ? 1 : 0;
  }
  const ece =
    n === 0
      ? 0
      : buckets.reduce(
          (s, b) =>
            b.count === 0
              ? s
              : s + (b.count / n) * Math.abs(b.correctSum / b.count - b.confidenceSum / b.count),
          0
        );
  return {
    brier: n === 0 ? 0 : brierSum / n,
    ece,
    buckets: buckets.map((b) => ({
      range: b.range,
      count: b.count,
      meanConfidence: b.count === 0 ? 0 : b.confidenceSum / b.count,
      accuracy: b.count === 0 ? 0 : b.correctSum / b.count,
    })),
    n,
    skipped,
  };
}

/** Result of {@link fitTemperature}. */
export interface TemperatureFit {
  /** The temperature minimizing negative log-likelihood of the truth. Use it in `createTemperatureScaling`. */
  readonly temperature: number;
  /** Mean NLL at that temperature. */
  readonly nll: number;
  /** Mean NLL at `T = 1`, for comparison. */
  readonly nllBefore: number;
  /** Runs used. */
  readonly n: number;
}

const EPS = 1e-12;

/** Logit-space terms for one run: the probability of the truth after scaling by `beta = 1/T`. */
function truthProbability(run: CalibrationRun): ((beta: number) => number) | null {
  const { answer, truth } = run;
  if (answer.type === 'noul') {
    const p = Math.min(1 - EPS, Math.max(EPS, answer.value));
    const logit = Math.log(p / (1 - p));
    const isTrue = truth === true || truth === 1;
    return (beta) => {
      const q = 1 / (1 + Math.exp(-logit * beta));
      return isTrue ? q : 1 - q;
    };
  }
  const probs =
    answer.type === 'choice'
      ? answer.probabilities
        ? Object.entries(answer.probabilities)
        : undefined
      : answer.probabilities?.map((x, i) => [String(i), x] as [string, number]);
  if (!probs) {
    return null;
  }
  const key = String(truth);
  if (!probs.some(([k]) => k === key)) {
    return null;
  }
  const logs = probs.map(([k, x]) => [k, Math.log(Math.max(x, EPS))] as const);
  return (beta) => {
    const max = Math.max(...logs.map(([, l]) => l * beta));
    const total = logs.reduce((s, [, l]) => s + Math.exp(l * beta - max), 0);
    const mine = logs.find(([k]) => k === key)![1];
    return Math.exp(mine * beta - max) / total;
  };
}

/**
 * Find the single temperature that minimizes the negative log-likelihood of
 * the truth over labeled runs: a one-dimensional convex search (the loss is
 * convex in `1/T`, so golden-section on it finds the global optimum).
 * `choice` and `score` runs need `probabilities`; `noul` runs need only
 * `value`. Runs without what they need are ignored. Fit each question type
 * (and option count) separately by passing only its runs, then feed the
 * results to `createTemperatureScaling({ byType, byOptionCount })`.
 *
 * `T > 1` means the model is over-confident (probabilities must be softened);
 * `T < 1`, under-confident. The search is bounded to `T` in `[0.05, 20]`.
 *
 * @throws when no run has probabilities to fit.
 */
export function fitTemperature(runs: readonly CalibrationRun[]): TemperatureFit {
  const terms = runs.map(truthProbability).filter((t): t is (beta: number) => number => t !== null);
  if (terms.length === 0) {
    throw new Error(
      'fitTemperature: no run carries probabilities (choice/score) or a value (noul) to fit'
    );
  }
  const nllAt = (beta: number): number =>
    terms.reduce((s, t) => s - Math.log(Math.max(t(beta), EPS)), 0) / terms.length;

  let lo = 1 / 20;
  let hi = 1 / 0.05;
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = hi - phi * (hi - lo);
  let b = lo + phi * (hi - lo);
  let fa = nllAt(a);
  let fb = nllAt(b);
  for (let i = 0; i < 120 && hi - lo > 1e-9; i++) {
    if (fa < fb) {
      hi = b;
      b = a;
      fb = fa;
      a = hi - phi * (hi - lo);
      fa = nllAt(a);
    } else {
      lo = a;
      a = b;
      fa = fb;
      b = lo + phi * (hi - lo);
      fb = nllAt(b);
    }
  }
  const beta = (lo + hi) / 2;
  return { temperature: 1 / beta, nll: nllAt(beta), nllBefore: nllAt(1), n: terms.length };
}
