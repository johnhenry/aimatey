/**
 * Neutral option keys
 *
 * Decision models follow the *name* of an option rather than its
 * definition. This middleware hides the names: every `choice` question's
 * criteria are renamed `opt_1..opt_n` with the original key folded into the
 * description, and the answers are mapped back on the way out.
 *
 * @module
 */

import type {
  DecisionMiddleware,
  IRDecisionAnswer,
  IRDecisionQuestion,
  IRDecisionResponse,
  IRWarning,
} from '@johnhenry/aimatey-types';
import { noulConfidence } from '@johnhenry/aimatey-utils';
import { createRng, shuffled, invalid } from './shared.js';

/** Options for {@link createNeutralOptionKeys}. */
export interface NeutralOptionKeysOptions {
  /**
   * Key prefix: options are named `<prefix>_1 ... <prefix>_n`.
   * @default 'opt'
   */
  readonly prefix?: string;

  /**
   * Randomize the order the options are presented in, and number the neutral
   * keys in the shuffled order (so `opt_1` carries no information about the
   * original position either). Probabilities are un-shuffled on the way out.
   * @default false
   */
  readonly shuffle?: boolean;

  /**
   * Seed for the shuffle: the same seed gives the same order for the same
   * request. Without it, ordering uses `Math.random`.
   */
  readonly seed?: number | string;

  /**
   * Also rewrite every `noul` question as a two-option choice with neutral
   * keys (the `true` and `false` labels folded into the descriptions) and map
   * the answer back to a `noul` value, `P(true option)`.
   * @default false
   */
  readonly noulAsChoice?: boolean;
}

type Mapping =
  | { readonly kind: 'choice'; readonly toOriginal: ReadonlyMap<string, string> }
  | {
      readonly kind: 'noul';
      readonly trueKey: string;
      readonly toOriginal: ReadonlyMap<string, 'true' | 'false'>;
    };

/**
 * Middleware that rewrites option names to neutral keys.
 *
 * Why: Laya followed option *names* rather than their definitions in
 * arXiv 2609.26758. Swapping which definition `yes`/`no` pointed at flipped
 * its answer 76.9 % of the time (Jev: 32.5 %), against 6.5 % when the keys
 * were neutral `0`/`1`; rotating names across multi-option questions took
 * accuracy from 56.4 % to 15.5 %. With the meaning carried in the
 * description and the key reduced to a slot number, there is no name to
 * follow. Measure how much a given model needs this with `nameInvariance()`
 * from `@johnhenry/aimatey-testing`.
 *
 * What it changes: each `choice` question's `criteria` become
 * `{ opt_1: '<original key>: <description>', ... }`; `value` and the keys of
 * `probabilities` are mapped back. `score` questions (their labels are an
 * ordered scale, not names to confuse) and, unless `noulAsChoice` is set,
 * `noul` questions are left alone.
 *
 * Default-off: this is a factory; nothing registers it for you. Use
 * `bridge.useDecision(createNeutralOptionKeys())`.
 *
 * @example
 * ```typescript
 * bridge.useDecision(createNeutralOptionKeys({ shuffle: true, seed: 7 }));
 * ```
 */
export function createNeutralOptionKeys(
  options: NeutralOptionKeysOptions = {}
): DecisionMiddleware {
  const prefix = options.prefix ?? 'opt';
  if (prefix.length === 0) {
    throw invalid('prefix', prefix, 'prefix must not be empty');
  }
  const shuffle = options.shuffle === true;
  const noulAsChoice = options.noulAsChoice === true;

  return async (request, next) => {
    const rng = createRng(options.seed);
    const order = <T>(items: readonly T[]): T[] => (shuffle ? shuffled(items, rng) : [...items]);
    const key = (i: number): string => `${prefix}_${i + 1}`;

    const mappings = new Map<string, Mapping>();
    const questions: Record<string, IRDecisionQuestion> = {};
    for (const [name, q] of Object.entries(request.questions)) {
      if (q.type === 'choice') {
        const toOriginal = new Map<string, string>();
        const criteria: Record<string, string> = {};
        order(Object.entries(q.criteria)).forEach(([original, description], i) => {
          toOriginal.set(key(i), original);
          criteria[key(i)] = `${original}: ${description}`;
        });
        mappings.set(name, { kind: 'choice', toOriginal });
        questions[name] = { ...q, criteria };
      } else if (q.type === 'noul' && noulAsChoice) {
        const sides = order([
          { side: 'true' as const, text: q.criteria?.true ?? 'the answer is yes' },
          { side: 'false' as const, text: q.criteria?.false ?? 'the answer is no' },
        ]);
        const toOriginal = new Map<string, 'true' | 'false'>();
        const criteria: Record<string, string> = {};
        sides.forEach(({ side, text }, i) => {
          toOriginal.set(key(i), side);
          criteria[key(i)] = `${side}: ${text}`;
        });
        mappings.set(name, {
          kind: 'noul',
          trueKey: key(sides.findIndex((s) => s.side === 'true')),
          toOriginal,
        });
        questions[name] = { type: 'choice', instructions: q.instructions, criteria };
      } else {
        questions[name] = q;
      }
    }

    if (mappings.size === 0) {
      return next(request);
    }

    const response = await next({ ...request, questions });

    const warnings: IRWarning[] = [];
    const answers: Record<string, IRDecisionAnswer> = {};
    for (const [name, answer] of Object.entries(response.answers)) {
      const mapping = mappings.get(name);
      answers[name] = mapping ? mapBack(name, answer, mapping, warnings) : answer;
    }
    const out: IRDecisionResponse = {
      ...response,
      answers,
      metadata:
        warnings.length > 0
          ? { ...response.metadata, warnings: [...(response.metadata.warnings ?? []), ...warnings] }
          : response.metadata,
    };
    return out;
  };
}

function mapBack(
  name: string,
  answer: IRDecisionAnswer,
  mapping: Mapping,
  warnings: IRWarning[]
): IRDecisionAnswer {
  if (answer.type !== 'choice') {
    return answer;
  }
  const unknown = (value: string): void => {
    warnings.push({
      category: 'response-malformed',
      severity: 'warning',
      message: `Question '${name}' was answered with '${value}', which is not one of the neutral keys that were sent; the answer is passed through unmapped.`,
      field: `answers.${name}`,
      source: 'neutral-option-keys',
    });
  };

  if (mapping.kind === 'choice') {
    const original = mapping.toOriginal.get(answer.value);
    if (original === undefined) {
      unknown(answer.value);
      return answer;
    }
    const { probabilities, ...rest } = answer;
    return {
      ...rest,
      value: original,
      ...(probabilities && {
        probabilities: Object.fromEntries(
          Object.entries(probabilities).map(([k, p]) => [mapping.toOriginal.get(k) ?? k, p])
        ),
      }),
    };
  }

  // noul sent as a two-option choice
  if (!mapping.toOriginal.has(answer.value)) {
    unknown(answer.value);
    return answer;
  }
  const pTrue =
    answer.probabilities?.[mapping.trueKey] ?? (answer.value === mapping.trueKey ? 1 : 0);
  return {
    type: 'noul',
    value: pTrue,
    ...(answer.probabilities && { confidence: noulConfidence(pTrue) }),
    ...(answer.reasoning !== undefined && { reasoning: answer.reasoning }),
  };
}
