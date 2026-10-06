/**
 * Decision escalation
 *
 * Re-run a typed-decision request on a stronger backend when the primary's
 * answers are not trustworthy enough. The condition language is Vercel AI
 * Gateway's decision-fallback `when` contract, so a policy written for one
 * transfers to the other. Extracted from docs/plans/decision-models.md
 * (Phase 3, "Escalation policy").
 *
 * @module
 */

import { AdapterError, ErrorCode } from '@johnhenry/aimatey-errors';
import type {
  BackendAdapter,
  DecisionMiddleware,
  IRDecisionAnswer,
  IRDecisionQuestion,
  IRDecisionRequest,
  IRDecisionResponse,
  IRDecisionUsage,
} from '@johnhenry/aimatey-types';
import { invalid, sumUsage } from './shared.js';

// ============================================================================
// Conditions
// ============================================================================

/**
 * When to escalate: Vercel's `when` contract.
 *
 * - `{ question?, confidenceBelow }` -- a `choice` or `score` answer whose
 *   `confidence` is below the number (strictly). Matches conservatively when
 *   the answer has no `confidence` at all (reason `confidence_unavailable`):
 *   an answer you cannot grade is not one to act on. An LLM-emulated backend
 *   therefore always escalates under a `confidenceBelow` rule.
 * - `{ question?, probabilityBetween: [lo, hi] }` -- a `noul` answer whose
 *   value lies in the inclusive range, i.e. the undecided middle.
 * - `{ any }`, `{ all }`, `{ atLeast: { count, conditions } }` -- combinators.
 *
 * Without `question`, a leaf checks every answer of the type it applies to
 * and matches if any does.
 */
export type DecisionCondition =
  | { readonly question?: string; readonly confidenceBelow: number }
  | { readonly question?: string; readonly probabilityBetween: readonly [number, number] }
  | { readonly any: readonly DecisionCondition[] }
  | { readonly all: readonly DecisionCondition[] }
  | {
      readonly atLeast: {
        readonly count: number;
        readonly conditions: readonly DecisionCondition[];
      };
    };

/** Why one answer tripped the condition. */
export interface DecisionTrigger {
  readonly question: string;
  readonly reason: 'confidence_below' | 'confidence_unavailable' | 'probability_between';
}

/** Result of {@link evaluateDecisionCondition}. */
export interface DecisionConditionResult {
  readonly matched: boolean;
  /** Every answer that tripped a satisfied leaf, deduplicated. Empty when not matched. */
  readonly triggeredBy: DecisionTrigger[];
}

/** Deepest allowed combinator nesting; a bare leaf is depth 1. */
export const MAX_CONDITION_DEPTH = 5;
/** Most children in one `any` / `all` / `atLeast`. */
export const MAX_CONDITION_CHILDREN = 20;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Check a condition against a request's question set, throwing a
 * `ValidationError` for anything that could never match or could not be
 * evaluated: `confidenceBelow` on a `noul` question, `probabilityBetween` on
 * a `choice`/`score` one, an unknown question name, a leaf that applies to
 * none of the request's questions, numbers outside `[0, 1]`, an inverted
 * range, more than {@link MAX_CONDITION_DEPTH} levels of nesting, or an
 * empty / over-{@link MAX_CONDITION_CHILDREN} list.
 */
export function validateDecisionCondition(
  condition: DecisionCondition,
  questions: Readonly<Record<string, IRDecisionQuestion>>
): void {
  check(condition, questions, 1, 'when');
}

function check(
  c: unknown,
  questions: Readonly<Record<string, IRDecisionQuestion>>,
  depth: number,
  path: string
): void {
  if (!isObject(c)) {
    throw invalid(path, c, 'a condition must be an object');
  }
  if (depth > MAX_CONDITION_DEPTH) {
    throw invalid(path, c, `conditions nest at most ${MAX_CONDITION_DEPTH} levels deep`);
  }
  const kinds = ['confidenceBelow', 'probabilityBetween', 'any', 'all', 'atLeast'].filter(
    (k) => k in c
  );
  if (kinds.length !== 1) {
    throw invalid(
      path,
      c,
      'a condition has exactly one of confidenceBelow, probabilityBetween, any, all, atLeast'
    );
  }
  const kind = kinds[0]!;

  if (kind === 'any' || kind === 'all' || kind === 'atLeast') {
    let children: unknown;
    if (kind === 'atLeast') {
      const a = c.atLeast;
      if (!isObject(a) || !Number.isInteger(a.count) || (a.count as number) < 1) {
        throw invalid(`${path}.atLeast.count`, a, 'atLeast.count must be an integer >= 1');
      }
      children = a.conditions;
      if (Array.isArray(children) && (a.count as number) > children.length) {
        throw invalid(
          `${path}.atLeast.count`,
          a.count,
          `atLeast.count (${String(a.count)}) exceeds the number of conditions (${children.length})`
        );
      }
    } else {
      children = c[kind];
    }
    const listPath = kind === 'atLeast' ? `${path}.atLeast.conditions` : `${path}.${kind}`;
    if (
      !Array.isArray(children) ||
      children.length < 1 ||
      children.length > MAX_CONDITION_CHILDREN
    ) {
      throw invalid(listPath, children, `needs between 1 and ${MAX_CONDITION_CHILDREN} conditions`);
    }
    children.forEach((child, i) => check(child, questions, depth + 1, `${listPath}[${i}]`));
    return;
  }

  // Leaf
  const wantsType = kind === 'confidenceBelow' ? ['choice', 'score'] : ['noul'];
  if (kind === 'confidenceBelow') {
    const t = c.confidenceBelow;
    if (typeof t !== 'number' || !(t >= 0 && t <= 1)) {
      throw invalid(`${path}.confidenceBelow`, t, 'confidenceBelow must be a number in [0, 1]');
    }
  } else {
    const r = c.probabilityBetween;
    if (
      !Array.isArray(r) ||
      r.length !== 2 ||
      typeof r[0] !== 'number' ||
      typeof r[1] !== 'number' ||
      !(r[0] >= 0 && r[1] <= 1 && r[0] <= r[1])
    ) {
      throw invalid(
        `${path}.probabilityBetween`,
        r,
        'probabilityBetween must be [lo, hi] with 0 <= lo <= hi <= 1'
      );
    }
  }
  if (c.question !== undefined) {
    const named = c.question;
    if (typeof named !== 'string' || !(named in questions)) {
      throw invalid(`${path}.question`, named, `unknown question ${JSON.stringify(named)}`);
    }
    const type = questions[named]!.type;
    if (!wantsType.includes(type)) {
      throw invalid(
        `${path}.question`,
        named,
        `${kind} applies to ${wantsType.join('/')} questions, but '${named}' is a ${type} question`
      );
    }
  } else if (!Object.values(questions).some((q) => wantsType.includes(q.type))) {
    throw invalid(
      path,
      c,
      `${kind} applies to ${wantsType.join('/')} questions and the request has none`
    );
  }
}

/**
 * Evaluate a condition against a set of answers. Pure: no validation (use
 * {@link validateDecisionCondition}), so a named question that is absent or
 * of the wrong type simply does not match.
 */
export function evaluateDecisionCondition(
  condition: DecisionCondition,
  answers: Readonly<Record<string, IRDecisionAnswer>>
): DecisionConditionResult {
  const raw = evalNode(condition, answers);
  const seen = new Set<string>();
  const triggeredBy = raw.triggeredBy.filter((t) => {
    const key = `${t.question}\u0000${t.reason}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return { matched: raw.matched, triggeredBy: raw.matched ? triggeredBy : [] };
}

function evalNode(
  c: DecisionCondition,
  answers: Readonly<Record<string, IRDecisionAnswer>>
): DecisionConditionResult {
  if ('any' in c || 'all' in c || 'atLeast' in c) {
    const list = 'any' in c ? c.any : 'all' in c ? c.all : c.atLeast.conditions;
    const results = list.map((child) => evalNode(child, answers));
    const hits = results.filter((r) => r.matched);
    const need = 'any' in c ? 1 : 'all' in c ? list.length : c.atLeast.count;
    const matched = hits.length >= need;
    return { matched, triggeredBy: matched ? hits.flatMap((r) => r.triggeredBy) : [] };
  }

  const names = c.question !== undefined ? [c.question] : Object.keys(answers);
  const triggeredBy: DecisionTrigger[] = [];
  for (const question of names) {
    const answer = answers[question];
    if (!answer) {
      continue;
    }
    if ('confidenceBelow' in c) {
      if (answer.type !== 'choice' && answer.type !== 'score') {
        continue;
      }
      if (answer.confidence === undefined) {
        triggeredBy.push({ question, reason: 'confidence_unavailable' });
      } else if (answer.confidence < c.confidenceBelow) {
        triggeredBy.push({ question, reason: 'confidence_below' });
      }
    } else {
      if (answer.type !== 'noul') {
        continue;
      }
      const [lo, hi] = c.probabilityBetween;
      if (answer.value >= lo && answer.value <= hi) {
        triggeredBy.push({ question, reason: 'probability_between' });
      }
    }
  }
  return { matched: triggeredBy.length > 0, triggeredBy };
}

// ============================================================================
// Bands
// ============================================================================

/** Thresholds for {@link decisionBands}. */
export interface DecisionBandThresholds {
  /** At or above this confidence the answer can be acted on. */
  readonly act: number;
  /** At or above this (and below `act`) a human or a second opinion should look. */
  readonly review: number;
}

/**
 * Sort an answer into one of three bands: `act`, `review`, `escalate`.
 *
 * The measure is `confidence` for `choice` and `score`
 * (a missing one is `escalate`: an ungradable answer is not one to act on)
 * and `max(value, 1 - value)` for `noul` -- how far from a coin flip it sits,
 * on the same scale as the IR's `noul.confidence`.
 *
 * **There are no default thresholds, on purpose.** Confidence is
 * distribution concentration, not accuracy, and how far it can be trusted
 * differs per model, per question type and per domain. Choose `act` and
 * `review` from your own labeled runs with `calibrationReport()` from
 * `@johnhenry/aimatey-testing` -- the lowest confidence bucket whose
 * accuracy meets your bar is your `act`.
 */
export function decisionBands(
  answer: IRDecisionAnswer,
  thresholds: DecisionBandThresholds
): 'act' | 'review' | 'escalate' {
  if (!(thresholds.act >= thresholds.review)) {
    throw invalid('thresholds', thresholds, 'act must be >= review');
  }
  const measure =
    answer.type === 'noul'
      ? (answer.confidence ?? Math.max(answer.value, 1 - answer.value))
      : answer.confidence;
  if (measure === undefined) {
    return 'escalate';
  }
  if (measure >= thresholds.act) {
    return 'act';
  }
  if (measure >= thresholds.review) {
    return 'review';
  }
  return 'escalate';
}

// ============================================================================
// Middleware
// ============================================================================

/** What `metadata.custom.escalation` carries on an escalated response. */
export interface DecisionEscalationInfo {
  readonly triggeredBy: DecisionTrigger[];
  /** Model the primary reported. */
  readonly primaryModel: string;
  /** Backend that produced the primary answers, from the response's provenance, when known. */
  readonly primaryBackend: string | undefined;
  /** What the primary stage cost; it is also included in the response's summed `usage`. */
  readonly primaryUsage: IRDecisionUsage | undefined;
}

/** Options for {@link createDecisionEscalation}. */
export interface DecisionEscalationOptions {
  /**
   * Backend to rerun on, or a function choosing one from the request (e.g.
   * the LLM emulation for text-heavy requests, a larger decision model for
   * the rest).
   */
  readonly fallback: BackendAdapter | ((request: IRDecisionRequest) => BackendAdapter);
  /** When to escalate. */
  readonly when: DecisionCondition;
  /** Called after a match, before the fallback is run. */
  readonly onEscalate?: (info: {
    readonly triggeredBy: DecisionTrigger[];
    readonly request: IRDecisionRequest;
    readonly primary: IRDecisionResponse;
  }) => void;
}

/**
 * Middleware that reruns a decision on a fallback backend when the primary's
 * answers match a {@link DecisionCondition}.
 *
 * The whole original request is rerun on the fallback, not just the
 * questions that tripped the condition: answers to one question can depend
 * on the others, and mixing two models' answers into one response would
 * leave no single `model` to attribute it to. The fallback's response is
 * returned with `metadata.custom.escalation` set to
 * {@link DecisionEscalationInfo}, and `usage` is the **sum of both stages**,
 * the way Vercel bills an escalated call (the primary ran, so it is paid for).
 * Nothing is merged otherwise; `model`, `answers` and `provider` are the
 * fallback's.
 *
 * The condition is validated against the request's question types before the
 * primary runs, so a rule that can never match fails loudly, not silently.
 *
 * Default-off like every decision pattern: register it yourself with
 * `bridge.useDecision()`.
 *
 * @example
 * ```typescript
 * bridge.useDecision(
 *   createDecisionEscalation({
 *     fallback: createEmulatedDecisionBackend(new OpenAIBackendAdapter(), { model: 'gpt-4o' }),
 *     when: { any: [{ confidenceBelow: 0.7 }, { probabilityBetween: [0.4, 0.6] }] },
 *   })
 * );
 * ```
 */
export function createDecisionEscalation(options: DecisionEscalationOptions): DecisionMiddleware {
  const { fallback, when, onEscalate } = options;
  if (!fallback) {
    throw invalid('fallback', fallback, 'a fallback backend is required');
  }

  return async (request, next) => {
    validateDecisionCondition(when, request.questions);
    const primary = await next(request);

    const { matched, triggeredBy } = evaluateDecisionCondition(when, primary.answers);
    if (!matched) {
      return primary;
    }

    const backend = typeof fallback === 'function' ? fallback(request) : fallback;
    if (typeof backend.decide !== 'function') {
      throw new AdapterError({
        code: ErrorCode.UNSUPPORTED_FEATURE,
        message: `Escalation fallback '${backend.metadata.name}' has no decide(); it cannot answer decision requests`,
        isRetryable: false,
        provenance: { backend: backend.metadata.name },
      });
    }

    onEscalate?.({ triggeredBy, request, primary });
    const rerun = await backend.decide(request);

    const escalation: DecisionEscalationInfo = {
      triggeredBy,
      primaryModel: primary.model,
      primaryBackend: primary.metadata.provenance?.backend,
      primaryUsage: primary.usage,
    };
    const usage = sumUsage(primary.usage, rerun.usage);
    return {
      ...rerun,
      ...(usage && { usage }),
      metadata: {
        ...rerun.metadata,
        custom: { ...rerun.metadata.custom, escalation },
      },
    };
  };
}
