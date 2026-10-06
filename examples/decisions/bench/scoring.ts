/**
 * Scoring math for the decision benchmark: correctness per answer,
 * accuracy per question type, Brier and ECE (via `calibrationReport`),
 * latency percentiles and cost.
 *
 * @module
 */

import { calibrationReport, type CalibrationReport } from './testing-decisions.js';
import type { IRDecisionAnswer, IRDecisionQuestion, IRDecisionUsage } from '@johnhenry/aimatey-types';
import { getModelPricingInfo } from '@johnhenry/aimatey-utils';
import type { GoldValue, ScoredRow } from './types.js';

export const QUESTION_TYPES = ['choice', 'score', 'noul'] as const;

/**
 * Whether an answer matches gold. `choice`: same key. `score`: the answer's
 * (possibly fractional) index rounds to the gold level. `noul`: the
 * probability falls on the right side of 0.5.
 */
export function isCorrect(answer: IRDecisionAnswer, gold: GoldValue): boolean {
  switch (answer.type) {
    case 'choice':
      return answer.value === gold;
    case 'score':
      return Math.round(answer.value) === gold;
    case 'noul':
      return answer.value >= 0.5 === (gold === true);
  }
}

/** Whether `answer` has the shape `question` asks for. */
export function answerMatchesQuestion(
  question: IRDecisionQuestion,
  answer: IRDecisionAnswer | undefined
): answer is IRDecisionAnswer {
  return answer !== undefined && answer.type === question.type;
}

/**
 * Percentile by linear interpolation between closest ranks (the numpy
 * default). `NaN` for an empty list.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (index - lo);
}

/**
 * Cost of one call in USD: the provider's own `usage.cost` when it reports
 * one, else input tokens at the model registry's per-million-token input
 * price (decision models bill input only). `null` when neither exists.
 */
export function priceFor(usage: IRDecisionUsage | undefined, model: string): number | null {
  if (!usage) {
    return null;
  }
  if (usage.cost !== undefined) {
    return usage.cost;
  }
  const pricing = getModelPricingInfo(model);
  if (!pricing) {
    return null;
  }
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputPer1M +
    ((usage.outputTokens ?? 0) / 1_000_000) * pricing.outputPer1M
  );
}

export interface Accuracy {
  readonly n: number;
  readonly correct: number;
  /** `null` when `n` is 0. */
  readonly accuracy: number | null;
}

export interface Summary {
  readonly overall: Accuracy;
  readonly byType: Record<(typeof QUESTION_TYPES)[number], Accuracy>;
  /** Brier, ECE and reliability buckets over the answers that carry a confidence. */
  readonly calibration: CalibrationReport;
}

function accuracyOf(rows: readonly ScoredRow[]): Accuracy {
  const correct = rows.filter((r) => isCorrect(r.answer, r.gold)).length;
  return { n: rows.length, correct, accuracy: rows.length === 0 ? null : correct / rows.length };
}

/** Accuracy overall and per question type, plus calibration. */
export function summarize(rows: readonly ScoredRow[]): Summary {
  return {
    overall: accuracyOf(rows),
    byType: {
      choice: accuracyOf(rows.filter((r) => r.type === 'choice')),
      score: accuracyOf(rows.filter((r) => r.type === 'score')),
      noul: accuracyOf(rows.filter((r) => r.type === 'noul')),
    },
    calibration: calibrationReport(rows.map((r) => ({ answer: r.answer, truth: r.gold }))),
  };
}
