/**
 * Shared types for the decision benchmark harness.
 *
 * @module
 */

import type { IRDecisionAnswer, IRDecisionQuestion } from '@johnhenry/aimatey-types';

/** Ground truth for one question: option key, level index, or boolean. */
export type GoldValue = string | number | boolean;

/** One labeled benchmark item: a state, typed questions, and the right answer to each. */
export interface BenchItem {
  readonly id: string;
  /** Workflow style or source benchmark, used for display only. */
  readonly workflow: string;
  readonly state: unknown;
  readonly questions: Record<string, IRDecisionQuestion>;
  /**
   * Normalized gold labels, one per question. `choice`: the option key.
   * `score`: the level index. `noul`: the boolean.
   */
  readonly gold: Record<string, GoldValue>;
}

/** One scored answer. */
export interface ScoredRow {
  readonly type: IRDecisionQuestion['type'];
  readonly answer: IRDecisionAnswer;
  readonly gold: GoldValue;
}
