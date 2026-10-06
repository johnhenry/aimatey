/**
 * Decision Validation Middleware
 *
 * Shape checks on a typed-decision request before it is sent, and
 * `validateDecisionResponse` on what comes back.
 *
 * A parallel implementation to the chat validation middleware (which is
 * about message content: PII, injection, token limits), not a wrapper: the
 * checks here are on the decision IR's own structure.
 *
 * **Not capability-aware.** Everything here is decidable from the request
 * alone. Checks that need to know the backend -- supported question types,
 * option / level / question-count limits, image support, instruction length
 * -- belong to the pre-flight validation in `aimatey-core`
 * (`validateDecisionRequest`), which has the backend's capabilities; do not
 * expect them from this middleware.
 *
 * @module
 */

import type {
  DecisionMiddleware,
  IRDecisionRequest,
  IRDecisionResponse,
  IRWarning,
} from '@johnhenry/aimatey-types';
import { ValidationError, ErrorCode } from '@johnhenry/aimatey-errors';
import { validateDecisionResponse } from '@johnhenry/aimatey-utils';

/**
 * Configuration for decision validation middleware.
 */
export interface DecisionValidationConfig {
  /**
   * Largest accepted `state`, in bytes (UTF-8 for a string state, UTF-8 of
   * the JSON encoding otherwise). Unlimited when unset.
   */
  maxStateBytes?: number;

  /**
   * Validate the response with `validateDecisionResponse` and merge its
   * warnings into `metadata.warnings`. A response that does not answer the
   * request (missing question, wrong type, out-of-range value) always
   * throws a `ValidationError`.
   * @default true
   */
  validateResponse?: boolean;

  /**
   * Turn the soft warnings found by response validation (e.g. probabilities
   * that do not sum to 1) into a thrown `ValidationError` instead of
   * attaching them.
   * @default false
   */
  strict?: boolean;
}

interface Issue {
  field: string;
  value?: unknown;
  reason: string;
}

const QUESTION_TYPES = ['choice', 'score', 'noul'];

const isBlank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';

function stateBytes(state: unknown): number {
  const text = typeof state === 'string' ? state : (JSON.stringify(state) ?? '');
  return new TextEncoder().encode(text).length;
}

/**
 * Collect every shape problem in a decision request.
 */
function checkRequest(request: IRDecisionRequest, config: DecisionValidationConfig): Issue[] {
  const issues: Issue[] = [];
  const entries = Object.entries(request.questions ?? {});

  if (entries.length === 0) {
    issues.push({ field: 'questions', reason: 'at least one question is required' });
  }

  for (const [name, question] of entries) {
    const field = `questions.${name}`;

    if (name.trim() === '') {
      issues.push({ field, reason: 'question names must be non-empty' });
    }
    if (!QUESTION_TYPES.includes(question?.type)) {
      issues.push({
        field: `${field}.type`,
        value: question?.type,
        reason: `type must be one of ${QUESTION_TYPES.join(', ')}`,
      });
      continue;
    }
    if (isBlank(question.instructions)) {
      issues.push({ field: `${field}.instructions`, reason: 'instructions must be non-empty' });
    }

    if (question.type === 'choice') {
      const keys = Object.keys(question.criteria ?? {});
      if (keys.length < 2) {
        issues.push({
          field: `${field}.criteria`,
          value: keys,
          reason: 'a choice question needs at least 2 criteria',
        });
      } else if (keys.some((key) => key.trim() === '')) {
        issues.push({ field: `${field}.criteria`, reason: 'criteria keys must be non-empty' });
      }
    } else if (question.type === 'score') {
      const levels = Array.isArray(question.criteria) ? question.criteria : [];
      if (levels.length < 2) {
        issues.push({
          field: `${field}.criteria`,
          value: levels,
          reason: 'a score question needs at least 2 levels',
        });
      } else if (levels.some(isBlank)) {
        issues.push({ field: `${field}.criteria`, reason: 'score levels must be non-empty' });
      } else if (new Set(levels).size !== levels.length) {
        issues.push({
          field: `${field}.criteria`,
          value: levels,
          reason: 'score levels must be unique',
        });
      }
    } else if (question.criteria !== undefined) {
      if (isBlank(question.criteria.true) || isBlank(question.criteria.false)) {
        issues.push({
          field: `${field}.criteria`,
          reason: 'noul criteria need non-empty `true` and `false` labels',
        });
      }
    }
  }

  if (config.maxStateBytes !== undefined) {
    const bytes = stateBytes(request.state);
    if (bytes > config.maxStateBytes) {
      issues.push({
        field: 'state',
        value: bytes,
        reason: `state is ${bytes} bytes, over the ${config.maxStateBytes}-byte limit`,
      });
    }
  }

  return issues;
}

function validationError(
  message: string,
  issues: readonly Issue[],
  backend?: string
): ValidationError {
  return new ValidationError({
    code: ErrorCode.INVALID_REQUEST,
    message,
    validationDetails: issues.map((issue) => ({ ...issue, value: issue.value })),
    provenance: backend ? { backend } : undefined,
  });
}

/**
 * Create decision validation middleware.
 *
 * Pre-call: throws a `ValidationError` (naming every problem found, without
 * calling the backend) for an empty question set, a question without a valid
 * `type` or non-empty `instructions`, a choice with fewer than 2 criteria, a
 * score with fewer than 2 distinct levels, blank criteria keys/labels, or --
 * with `maxStateBytes` -- an oversized `state`.
 *
 * Post-call: `validateDecisionResponse`; its soft warnings are appended to
 * `metadata.warnings` (or thrown with `strict`).
 *
 * @param config Validation configuration
 * @returns Decision middleware
 *
 * @example
 * ```typescript
 * bridge.useDecision(createDecisionValidationMiddleware({ maxStateBytes: 60_000, strict: true }));
 * ```
 */
export function createDecisionValidationMiddleware(
  config: DecisionValidationConfig = {}
): DecisionMiddleware {
  const { validateResponse = true, strict = false } = config;

  return async (request, next) => {
    const issues = checkRequest(request, config);
    if (issues.length > 0) {
      throw validationError(
        `Invalid decision request: ${issues.map((i) => i.reason).join('; ')}`,
        issues,
        request.metadata.provenance?.backend
      );
    }

    const response = await next(request);
    if (!validateResponse) {
      return response;
    }

    // Throws a ValidationError for a response that does not answer the request.
    const warnings: readonly IRWarning[] = validateDecisionResponse(request, response);
    if (warnings.length === 0) {
      return response;
    }

    if (strict) {
      throw validationError(
        `Decision response failed strict validation: ${warnings.map((w) => w.message).join('; ')}`,
        warnings.map((w) => ({
          field: w.field ?? 'response',
          value: w.originalValue,
          reason: w.message,
        })),
        response.metadata.provenance?.backend
      );
    }

    const merged: IRDecisionResponse = {
      ...response,
      metadata: {
        ...response.metadata,
        warnings: [...(response.metadata.warnings ?? []), ...warnings],
      },
    };
    return merged;
  };
}
