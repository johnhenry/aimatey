/**
 * Temperature scaling
 *
 * Post-hoc calibration for decision models whose probabilities are
 * over-confident: one temperature per (question type, option count),
 * applied to the reported distribution. Fit the temperature from your own
 * labeled runs with `fitTemperature()` from `@johnhenry/aimatey-testing`.
 *
 * @module
 */

import type {
  DecisionMiddleware,
  IRDecisionAnswer,
  IRDecisionQuestion,
} from '@johnhenry/aimatey-types';
import { decisionConfidence, noulConfidence } from '@johnhenry/aimatey-utils';
import { invalid, normalize } from './shared.js';

/** Options for {@link createTemperatureScaling}. */
export interface TemperatureScalingOptions {
  /** Temperature per question type. */
  readonly byType?: Partial<Record<'choice' | 'score' | 'noul', number>>;

  /**
   * Temperature per option count (`choice` options, `score` levels; a `noul`
   * counts as 2). Wins over `byType`: it is the more specific of the two,
   * matching one temperature per (type, option count) when you fit each
   * separately.
   */
  readonly byOptionCount?: Readonly<Record<number, number>>;

  /**
   * Temperature when neither matches.
   * @default 1 (no change)
   */
  readonly default?: number;

  /**
   * How `confidence` is recomputed on `choice` and `score` after rescaling.
   * `'concentration'` is `decisionConfidence(p)` (`1 - H(p) / ln(n)`, from
   * `@johnhenry/aimatey-utils`), the library-wide definition; `noul` uses
   * `noulConfidence(p)`. `'winner-mass'` is the largest probability instead
   * (`max(p, 1 - p)` for `noul`).
   * @default 'concentration'
   */
  readonly confidence?: 'concentration' | 'winner-mass';
}

/**
 * Middleware that rescales answer probabilities by a temperature `T`.
 *
 * - `choice` and `score`: `p_i' ∝ p_i^(1/T)` (softmax of `log p / T`),
 *   renormalized. `T > 1` softens, `T < 1` sharpens, `T = 1` is the identity.
 *   `value` is kept for `choice` (the argmax cannot change); for `score` it
 *   becomes the expected level index of the new distribution. `confidence`
 *   is recomputed from the new distribution.
 * - `noul`: `sigmoid(logit(p) / T)`; `confidence` is `noulConfidence(p')`.
 *   Exact 0 and 1 are left alone (their logit is infinite).
 *
 * Answers without `probabilities` (`choice`, `score`) have nothing to
 * rescale and pass through unchanged. Temperature scaling never changes
 * which answer wins, only how sure it claims to be, so it cannot fix a
 * wrong answer; it makes `confidence` honest enough for `decisionBands()`
 * and `createDecisionEscalation()` to act on.
 *
 * Laya ships over-confident (ECE 0.466, down to 0.081 after one temperature
 * per question type and option count) and Jev is about 7 points
 * over-confident. Neither number says what *your* model does on *your*
 * questions: fit `T` yourself.
 *
 * @example
 * ```typescript
 * const { temperature } = fitTemperature(runsFromMyLabeledSet);
 * bridge.useDecision(createTemperatureScaling({ byType: { noul: temperature } }));
 * ```
 */
export function createTemperatureScaling(
  options: TemperatureScalingOptions = {}
): DecisionMiddleware {
  const check = (field: string, t: unknown): void => {
    if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) {
      throw invalid(field, t, 'a temperature must be a finite number > 0');
    }
  };
  if (options.default !== undefined) {
    check('default', options.default);
  }
  for (const [k, t] of Object.entries(options.byType ?? {})) {
    check(`byType.${k}`, t);
  }
  for (const [k, t] of Object.entries(options.byOptionCount ?? {})) {
    check(`byOptionCount.${k}`, t);
  }
  const measure = options.confidence ?? 'concentration';

  const temperatureFor = (question: IRDecisionQuestion): number => {
    const count =
      question.type === 'choice'
        ? Object.keys(question.criteria).length
        : question.type === 'score'
          ? question.criteria.length
          : 2;
    return (
      options.byOptionCount?.[count] ?? options.byType?.[question.type] ?? options.default ?? 1
    );
  };

  return async (request, next) => {
    const response = await next(request);
    const answers: Record<string, IRDecisionAnswer> = {};
    for (const [name, answer] of Object.entries(response.answers)) {
      const question = request.questions[name];
      answers[name] = question ? rescale(answer, temperatureFor(question), measure) : answer;
    }
    return { ...response, answers };
  };
}

function rescale(
  answer: IRDecisionAnswer,
  temperature: number,
  measure: 'concentration' | 'winner-mass'
): IRDecisionAnswer {
  const sharpen = (p: readonly number[]): number[] => {
    const w = p.map((x) => (x > 0 ? Math.pow(x, 1 / temperature) : 0));
    return w.some((x) => x > 0) ? normalize(w) : [...p];
  };
  const confidenceOf = (p: readonly number[]): number =>
    measure === 'winner-mass' ? Math.max(...p) : decisionConfidence(p);

  switch (answer.type) {
    case 'choice': {
      if (!answer.probabilities) {
        return answer;
      }
      const keys = Object.keys(answer.probabilities);
      const p = sharpen(keys.map((k) => answer.probabilities![k]!));
      return {
        ...answer,
        probabilities: Object.fromEntries(keys.map((k, i) => [k, p[i]!])),
        confidence: confidenceOf(p),
      };
    }
    case 'score': {
      if (!answer.probabilities) {
        return answer;
      }
      const p = sharpen(answer.probabilities);
      return {
        ...answer,
        value: p.reduce((s, x, i) => s + i * x, 0),
        probabilities: p,
        confidence: confidenceOf(p),
      };
    }
    case 'noul': {
      const v = answer.value;
      const scaled =
        v <= 0 || v >= 1 ? v : 1 / (1 + Math.exp(-Math.log(v / (1 - v)) / temperature));
      return {
        ...answer,
        value: scaled,
        confidence:
          measure === 'winner-mass' ? Math.max(scaled, 1 - scaled) : noulConfidence(scaled),
      };
    }
  }
}
