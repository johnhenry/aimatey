/**
 * Decision ensemble
 *
 * Ask several decision backends the same request and combine their answers
 * into one, with the members' disagreement folded into `confidence`. The
 * ensemble is itself a `BackendAdapter`, so it plugs into a `Bridge` (or an
 * escalation fallback) like any single backend. Companion to
 * `createParallelAggregator`, which does the same fan-out for chat.
 *
 * @module
 */

import { AdapterError, ErrorCode } from '@johnhenry/aimatey-errors';
import type {
  AdapterMetadata,
  BackendAdapter,
  IRDecisionAnswer,
  IRDecisionQuestion,
  IRDecisionRequest,
  IRDecisionResponse,
  IRDecisionUsage,
  IRWarning,
} from '@johnhenry/aimatey-types';
import { createGate, normalize, sumUsage } from './shared.js';

/** Combine the members' numbers for one slot (an option's probability, a score value, a noul value). */
export type EnsembleAggregate = (values: readonly number[]) => number;

/** Options for {@link createDecisionEnsemble}. */
export interface DecisionEnsembleOptions {
  /**
   * How to combine members: `'mean'`, `'median'` (robust to one outlier), or
   * your own function over the members' numbers for one slot. Probabilities
   * are renormalized afterwards, so any of them yields a distribution.
   * @default 'mean'
   */
  readonly aggregate?: 'mean' | 'median' | EnsembleAggregate;

  /**
   * Reject when any member fails. When false (the default) a failing member
   * is dropped with a warning and the rest are aggregated; if every member
   * fails the call rejects with the first error.
   * @default false
   */
  readonly requireAll?: boolean;

  /**
   * Most members in flight at once.
   * @default all members
   */
  readonly concurrency?: number;

  /**
   * Per-member timeout in milliseconds. A member that exceeds it counts as
   * failed.
   */
  readonly timeout?: number;

  /**
   * Adapter name.
   * @default 'decision-ensemble'
   */
  readonly name?: string;
}

type Choice = Extract<IRDecisionAnswer, { type: 'choice' }>;
type Score = Extract<IRDecisionAnswer, { type: 'score' }>;
type Noul = Extract<IRDecisionAnswer, { type: 'noul' }>;

const mean: EnsembleAggregate = (v) => v.reduce((s, x) => s + x, 0) / v.length;
const median: EnsembleAggregate = (v) => {
  const s = [...v].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * Build a decision backend that runs the same request on every member and
 * aggregates per question.
 *
 * Aggregation:
 * - `choice`: per-option aggregate of the members' probability vectors,
 *   renormalized; `value` is the argmax (ties go to the first option).
 * - `score`: `value` is the aggregate of the members' values (fractional is
 *   fine), `probabilities` the renormalized aggregate of theirs.
 * - `noul`: `value` is the aggregate of the members' values.
 *
 * A member that reports no `probabilities` contributes a one-hot vote
 * (`choice`: its `value`; `score`: its rounded `value`) and the response
 * carries a warning saying so. A vote is not a calibrated probability; the
 * point is that a split of one-hot votes still shows up as disagreement.
 *
 * Confidence and disagreement. Per question,
 * `disagreement` is in `[0, 1]`: for `choice` and `score` with distributions,
 * the mean total-variation distance (`0.5 * sum |p_member - p_aggregate|`)
 * between each member and the aggregate; for a `score` without them, the
 * mean absolute deviation of the values over `(levels - 1)`; for `noul`, the
 * mean absolute deviation of the values times 2 (a 0/1 split is 1). Then
 *
 *     confidence = mean(member confidence) * (1 - disagreement)
 *
 * where a member's confidence is its own `confidence`, else the largest of
 * its probabilities (`noul`: `max(v, 1 - v)`), averaged over the members
 * that have one. When no member reports any, `confidence` is omitted, as
 * for any answer without a measure. Agreement can only lower confidence,
 * never raise it.
 *
 * `metadata.custom.ensemble` is
 * `{ members: [{ backend, model, answers }], disagreement: Record<question, number> }`.
 * `usage` is the sum over members. Capabilities are the intersection of the
 * members' (`decisionTypes`, `decisionImages`) and the tightest of their
 * `decisionLimits`.
 *
 * `request.parameters.model` is sent to every member unchanged; to pin a
 * model per member, configure it on the member.
 *
 * @example
 * ```typescript
 * const ensemble = createDecisionEnsemble([jevBackend, nimbleBackend, emulated], {
 *   aggregate: 'median',
 * });
 * const bridge = new Bridge(new OpenAIFrontendAdapter(), ensemble);
 * ```
 */
export function createDecisionEnsemble(
  backends: readonly BackendAdapter[],
  options: DecisionEnsembleOptions = {}
): BackendAdapter {
  if (backends.length === 0) {
    throw new AdapterError({
      code: ErrorCode.INVALID_REQUEST,
      message: 'createDecisionEnsemble needs at least one backend',
      isRetryable: false,
    });
  }
  for (const b of backends) {
    if (typeof b.decide !== 'function') {
      throw new AdapterError({
        code: ErrorCode.UNSUPPORTED_FEATURE,
        message: `Backend '${b.metadata.name}' has no decide(); it cannot be an ensemble member`,
        isRetryable: false,
        provenance: { backend: b.metadata.name },
      });
    }
  }

  const name = options.name ?? 'decision-ensemble';
  const agg: EnsembleAggregate =
    typeof options.aggregate === 'function'
      ? options.aggregate
      : options.aggregate === 'median'
        ? median
        : mean;
  const gate = createGate(options.concurrency ?? backends.length);

  const metadata: AdapterMetadata = {
    name,
    version: '1.0.0',
    provider: '@johnhenry/aimatey-patterns',
    capabilities: {
      streaming: false,
      multiModal: false,
      tools: false,
      decisions: true,
      ...intersectCapabilities(backends),
      systemMessageStrategy: 'not-supported',
      supportsMultipleSystemMessages: false,
    },
    config: { members: backends.map((b) => b.metadata.name) },
  };

  return {
    metadata,

    async decide(request: IRDecisionRequest, signal?: AbortSignal): Promise<IRDecisionResponse> {
      const settled = await Promise.allSettled(
        backends.map((backend) =>
          gate(() => {
            const timeout =
              options.timeout !== undefined ? AbortSignal.timeout(options.timeout) : undefined;
            const s = signal && timeout ? AbortSignal.any([signal, timeout]) : (signal ?? timeout);
            return backend.decide!(request, s);
          })
        )
      );

      const warnings: IRWarning[] = [...(request.metadata.warnings ?? [])];
      const members: Array<{ backend: string; response: IRDecisionResponse }> = [];
      let firstError: unknown;
      settled.forEach((result, i) => {
        const backend = backends[i]!.metadata.name;
        if (result.status === 'fulfilled') {
          members.push({ backend, response: result.value });
          return;
        }
        firstError ??= result.reason;
        if (options.requireAll) {
          return;
        }
        warnings.push({
          category: 'capability-unsupported',
          severity: 'warning',
          message: `Ensemble member '${backend}' failed and was left out: ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`,
          field: 'decisions',
          source: name,
        });
      });
      if (firstError !== undefined && (options.requireAll || members.length === 0)) {
        throw firstError instanceof Error ? firstError : new Error(JSON.stringify(firstError));
      }

      const answers: Record<string, IRDecisionAnswer> = {};
      const disagreement: Record<string, number> = {};
      for (const [qName, question] of Object.entries(request.questions)) {
        const memberAnswers = members.map((m) => ({
          backend: m.backend,
          answer: m.response.answers[qName]!,
        }));
        const result = aggregateQuestion(qName, question, memberAnswers, agg, warnings, name);
        answers[qName] = result.answer;
        disagreement[qName] = result.disagreement;
      }

      let usage: IRDecisionUsage | undefined;
      for (const m of members) {
        usage = sumUsage(usage, m.response.usage);
      }

      return {
        provider: '@johnhenry/aimatey-patterns',
        answers,
        model: `${name}(${members.map((m) => m.response.model).join(',')})`,
        ...(usage && { usage }),
        metadata: {
          ...request.metadata,
          provenance: { ...request.metadata.provenance, backend: name },
          warnings,
          custom: {
            ...request.metadata.custom,
            ensemble: {
              members: members.map((m) => ({
                backend: m.backend,
                model: m.response.model,
                answers: m.response.answers,
              })),
              disagreement,
            },
          },
        },
      };
    },
  };
}

// ============================================================================
// Aggregation
// ============================================================================

interface MemberAnswer {
  readonly backend: string;
  readonly answer: IRDecisionAnswer;
}

function aggregateQuestion(
  qName: string,
  question: IRDecisionQuestion,
  members: readonly MemberAnswer[],
  agg: EnsembleAggregate,
  warnings: IRWarning[],
  source: string
): { answer: IRDecisionAnswer; disagreement: number } {
  const noProbabilities = (backend: string): void => {
    warnings.push({
      category: 'capability-emulated',
      severity: 'info',
      message: `Ensemble member '${backend}' reported no probabilities for question '${qName}'; it contributes a one-hot vote.`,
      field: `answers.${qName}`,
      source,
    });
  };
  const meanConfidence = (confs: Array<number | undefined>): number | undefined => {
    const known = confs.filter((c): c is number => c !== undefined);
    return known.length > 0 ? mean(known) : undefined;
  };

  switch (question.type) {
    case 'choice': {
      const keys = Object.keys(question.criteria);
      const vectors = members.map(({ backend, answer }) => {
        const a = answer as Choice;
        if (a.probabilities) {
          return normalize(keys.map((k) => a.probabilities![k] ?? 0));
        }
        noProbabilities(backend);
        return keys.map((k) => (k === a.value ? 1 : 0));
      });
      const combined = normalize(keys.map((_, i) => agg(vectors.map((v) => v[i]!))));
      let best = 0;
      combined.forEach((p, i) => {
        if (p > combined[best]!) {
          best = i;
        }
      });
      const dis = clamp01(mean(vectors.map((v) => totalVariation(v, combined))));
      const conf = meanConfidence(
        members.map(({ answer }, i) => {
          const a = answer as Choice;
          return a.confidence ?? (a.probabilities ? Math.max(...vectors[i]!) : undefined);
        })
      );
      return {
        disagreement: dis,
        answer: {
          type: 'choice',
          value: keys[best]!,
          probabilities: Object.fromEntries(keys.map((k, i) => [k, combined[i]!])),
          ...(conf !== undefined && { confidence: conf * (1 - dis) }),
        },
      };
    }
    case 'score': {
      const levels = question.criteria.length;
      const vectors = members.map(({ backend, answer }) => {
        const a = answer as Score;
        if (a.probabilities) {
          return normalize(a.probabilities);
        }
        noProbabilities(backend);
        const hot = Math.min(levels - 1, Math.max(0, Math.round(a.value)));
        return Array.from({ length: levels }, (_, i) => (i === hot ? 1 : 0));
      });
      const values = members.map((m) => (m.answer as Score).value);
      const value = agg(values);
      const combined = normalize(
        Array.from({ length: levels }, (_, i) => agg(vectors.map((v) => v[i]!)))
      );
      const allHaveDistribution = members.every((m) => (m.answer as Score).probabilities);
      const dis = clamp01(
        allHaveDistribution
          ? mean(vectors.map((v) => totalVariation(v, combined)))
          : levels > 1
            ? mean(values.map((v) => Math.abs(v - mean(values)))) / (levels - 1)
            : 0
      );
      const conf = meanConfidence(
        members.map(({ answer }, i) => {
          const a = answer as Score;
          return a.confidence ?? (a.probabilities ? Math.max(...vectors[i]!) : undefined);
        })
      );
      return {
        disagreement: dis,
        answer: {
          type: 'score',
          value,
          probabilities: combined,
          ...(conf !== undefined && { confidence: conf * (1 - dis) }),
        },
      };
    }
    case 'noul': {
      const values = members.map((m) => (m.answer as Noul).value);
      const value = clamp01(agg(values));
      const centre = mean(values);
      const dis = clamp01(2 * mean(values.map((v) => Math.abs(v - centre))));
      const conf = mean(
        members.map(({ answer }) => {
          const a = answer as Noul;
          return a.confidence ?? Math.max(a.value, 1 - a.value);
        })
      );
      return {
        disagreement: dis,
        answer: { type: 'noul', value, confidence: conf * (1 - dis) },
      };
    }
  }
}

/** Total-variation distance between two distributions over the same support. */
function totalVariation(p: readonly number[], q: readonly number[]): number {
  return 0.5 * p.reduce((s, x, i) => s + Math.abs(x - q[i]!), 0);
}

// ============================================================================
// Capabilities
// ============================================================================

const ALL_TYPES = ['choice', 'score', 'noul'] as const;

function intersectCapabilities(backends: readonly BackendAdapter[]): {
  decisionTypes: readonly ('choice' | 'score' | 'noul')[];
  decisionImages: boolean;
  decisionLimits?: NonNullable<AdapterMetadata['capabilities']['decisionLimits']>;
} {
  const types = ALL_TYPES.filter((t) =>
    backends.every((b) => (b.metadata.capabilities.decisionTypes ?? ALL_TYPES).includes(t))
  );
  const limits: Record<string, number> = {};
  for (const b of backends) {
    for (const [k, v] of Object.entries(b.metadata.capabilities.decisionLimits ?? {})) {
      if (typeof v === 'number') {
        limits[k] = Math.min(limits[k] ?? v, v);
      }
    }
  }
  return {
    decisionTypes: types,
    decisionImages: backends.every((b) => b.metadata.capabilities.decisionImages === true),
    ...(Object.keys(limits).length > 0 && {
      decisionLimits: limits as NonNullable<AdapterMetadata['capabilities']['decisionLimits']>,
    }),
  };
}
