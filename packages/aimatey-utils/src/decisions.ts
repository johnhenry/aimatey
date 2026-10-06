/**
 * Decision Utilities
 *
 * Shared helpers for typed-decision support: capability detection for
 * `decide()` and, symmetrically, for the chat methods that are no longer
 * guaranteed on every `BackendAdapter` now that decision-only backends
 * (Jev, Laya) exist.
 *
 * @module
 */

import type {
  BackendAdapter,
  IRDecisionAnswer,
  IRDecisionQuestion,
  IRDecisionRequest,
  IRDecisionResponse,
  IRWarning,
} from '@johnhenry/aimatey-types';
import { ValidationError, ErrorCode } from '@johnhenry/aimatey-errors';
import { createWarning } from './warnings.js';

// ============================================================================
// Capability Detection
// ============================================================================

/**
 * Type guard: does this backend implement typed decisions?
 */
export function supportsDecisions(
  adapter: BackendAdapter
): adapter is BackendAdapter & Required<Pick<BackendAdapter, 'decide'>> {
  // Mirrors `supportsEmbeddings`: an inherited decide() can be explicitly
  // opted out of via the capability flag.
  return typeof adapter.decide === 'function' && adapter.metadata.capabilities.decisions !== false;
}

/**
 * Type guard: does this backend implement (non-streaming) chat?
 *
 * `execute`/`executeStream` became optional on `BackendAdapter` when
 * decision-only backends were added — most backends still implement both,
 * but nothing guarantees it anymore. `Bridge` and `Router` use this (and
 * {@link supportsChatStream}) to fail fast with `UNSUPPORTED_FEATURE`
 * rather than call an absent method.
 */
export function supportsChat(
  adapter: BackendAdapter
): adapter is BackendAdapter & Required<Pick<BackendAdapter, 'execute'>> {
  return typeof adapter.execute === 'function';
}

/**
 * Type guard: does this backend implement streaming chat?
 */
export function supportsChatStream(
  adapter: BackendAdapter
): adapter is BackendAdapter & Required<Pick<BackendAdapter, 'executeStream'>> {
  return typeof adapter.executeStream === 'function';
}

// ============================================================================
// Response Validation
// ============================================================================

/** Largest deviation from 1 tolerated in a probability distribution's sum. */
const PROBABILITY_SUM_TOLERANCE = 0.02;

function invalid(field: string, value: unknown, reason: string, backend?: string): ValidationError {
  return new ValidationError({
    code: ErrorCode.INVALID_REQUEST,
    message: `Invalid decision response: ${reason}`,
    validationDetails: [{ field, value, reason }],
    provenance: backend ? { backend } : undefined,
  });
}

function requireFinite(value: unknown, field: string, backend?: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid(field, value, `${field} must be a finite number`, backend);
  }
  return value;
}

/**
 * Check that a decision response actually answers the request it came from.
 *
 * Decision providers return typed answers with no generated text to eyeball,
 * so a malformed one (missing question, wrong type, out-of-range score)
 * otherwise flows silently into an application's control flow.
 *
 * Contract: **throws** a {@link ValidationError} for hard failures and
 * **returns** `IRWarning`s for soft ones, leaving the response untouched.
 *
 * Throws when:
 * - a question has no answer (extra answers are ignored);
 * - an answer's `type` differs from its question's;
 * - a `choice` value is not a key of the question's `criteria`;
 * - a `score` is outside `[0, levels - 1]`, or a `noul` outside `[0, 1]`;
 * - any number in an answer (value, confidence, probabilities) is not finite.
 *
 * Warns (`'response-malformed'`) when probabilities are present and:
 * - they sum to 1 +/- 0.02 -- skipped when the distribution is empty (an
 *   LLM-emulated answer has none to check);
 * - their keys (`choice`) or length (`score`) differ from the criteria.
 *
 * `probabilities` and `confidence` are optional on answers, so absence is
 * never a failure.
 */
export function validateDecisionResponse(
  request: IRDecisionRequest,
  response: IRDecisionResponse
): readonly IRWarning[] {
  const warnings: IRWarning[] = [];
  const backend = response.metadata?.provenance?.backend;

  for (const [name, question] of Object.entries(request.questions)) {
    const field = `answers.${name}`;
    const answer = response.answers[name];
    if (!answer) {
      throw invalid(field, undefined, `question '${name}' was not answered`, backend);
    }
    if (answer.type !== question.type) {
      throw invalid(
        `${field}.type`,
        answer.type,
        `question '${name}' is type '${question.type}' but was answered with type '${answer.type}'`,
        backend
      );
    }
    validateAnswer(name, question, answer, warnings, backend);
  }

  return warnings;
}

function validateAnswer(
  name: string,
  question: IRDecisionQuestion,
  answer: IRDecisionAnswer,
  warnings: IRWarning[],
  backend?: string
): void {
  const field = `answers.${name}`;

  if (answer.confidence !== undefined) {
    requireFinite(answer.confidence, `${field}.confidence`, backend);
  }

  if (answer.type === 'noul') {
    const value = requireFinite(answer.value, `${field}.value`, backend);
    if (value < 0 || value > 1) {
      throw invalid(`${field}.value`, value, `noul answer '${name}' must be in [0, 1], got ${value}`, backend);
    }
    return;
  }

  if (answer.type === 'choice' && question.type === 'choice') {
    if (!Object.prototype.hasOwnProperty.call(question.criteria, answer.value)) {
      throw invalid(
        `${field}.value`,
        answer.value,
        `choice answer '${name}' is '${answer.value}', which is not one of: ${Object.keys(question.criteria).join(', ')}`,
        backend
      );
    }
    const probabilities = answer.probabilities;
    if (probabilities) {
      const entries = Object.entries(probabilities);
      for (const [key, p] of entries) {
        requireFinite(p, `${field}.probabilities.${key}`, backend);
      }
      if (entries.length > 0) {
        const expected = Object.keys(question.criteria);
        const got = entries.map(([key]) => key);
        if (got.length !== expected.length || got.some((key) => !expected.includes(key))) {
          warnings.push(
            createWarning(
              'response-malformed',
              `Probability keys for '${name}' (${got.join(', ')}) do not match the question's criteria keys (${expected.join(', ')})`,
              { field: `${field}.probabilities`, originalValue: got }
            )
          );
        }
        checkSum(name, entries.map(([, p]) => p), `${field}.probabilities`, warnings);
      }
    }
    return;
  }

  if (answer.type === 'score' && question.type === 'score') {
    const value = requireFinite(answer.value, `${field}.value`, backend);
    const max = question.criteria.length - 1;
    if (value < 0 || value > max) {
      throw invalid(
        `${field}.value`,
        value,
        `score answer '${name}' must be in [0, ${max}], got ${value}`,
        backend
      );
    }
    const probabilities = answer.probabilities;
    if (probabilities) {
      probabilities.forEach((p, i) => requireFinite(p, `${field}.probabilities[${i}]`, backend));
      if (probabilities.length > 0) {
        if (probabilities.length !== question.criteria.length) {
          warnings.push(
            createWarning(
              'response-malformed',
              `Probabilities for '${name}' have length ${probabilities.length}, but the question has ${question.criteria.length} levels`,
              { field: `${field}.probabilities`, originalValue: probabilities.length }
            )
          );
        }
        checkSum(name, probabilities, `${field}.probabilities`, warnings);
      }
    }
  }
}

function checkSum(name: string, values: readonly number[], field: string, warnings: IRWarning[]): void {
  const sum = values.reduce((total, p) => total + p, 0);
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
    warnings.push(
      createWarning(
        'response-malformed',
        `Probabilities for '${name}' sum to ${Number(sum.toFixed(4))}, expected 1 (+/- ${PROBABILITY_SUM_TOLERANCE})`,
        { field, originalValue: sum }
      )
    );
  }
}
