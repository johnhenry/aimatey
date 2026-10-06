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
  FrontendAdapter,
  IRCapabilities,
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
// Frontend Capability Detection
// ============================================================================

/**
 * Type guard: does this frontend implement chat conversion?
 *
 * `toIR`/`fromIR`/`fromIRStream` became optional on `FrontendAdapter` when
 * decision-only frontends (TypeSafe, Laya) were made real `FrontendAdapter`s
 * -- the frontend-side mirror of {@link supportsChat}. `Bridge.chat()` and
 * `chatStream()` use it to fail with `UNSUPPORTED_FEATURE` rather than call
 * an absent method.
 */
export function supportsChatFrontend<T extends FrontendAdapter>(
  adapter: T
): adapter is T & Required<Pick<FrontendAdapter, 'toIR' | 'fromIR' | 'fromIRStream'>> {
  return (
    typeof adapter.toIR === 'function' &&
    typeof adapter.fromIR === 'function' &&
    typeof adapter.fromIRStream === 'function'
  );
}

/**
 * Type guard: does this frontend implement decision conversion
 * (`decisionToIR` and `decisionFromIR`)?
 */
export function supportsDecisionFrontend<T extends FrontendAdapter>(
  adapter: T
): adapter is T & Required<Pick<FrontendAdapter, 'decisionToIR' | 'decisionFromIR'>> {
  return typeof adapter.decisionToIR === 'function' && typeof adapter.decisionFromIR === 'function';
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
      throw invalid(
        `${field}.value`,
        value,
        `noul answer '${name}' must be in [0, 1], got ${value}`,
        backend
      );
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
        checkSum(
          name,
          entries.map(([, p]) => p),
          `${field}.probabilities`,
          warnings
        );
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

function checkSum(
  name: string,
  values: readonly number[],
  field: string,
  warnings: IRWarning[]
): void {
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

// ============================================================================
// Request Validation
// ============================================================================

/** Instruction length past which decision models are known to degrade. */
const LONG_INSTRUCTIONS_CHARS = 2000;

/** Choice keys decision heads follow by *name*, whatever their definition says. */
const POLAR_KEYS = new Set([
  'yes',
  'no',
  'true',
  'false',
  'good',
  'bad',
  'positive',
  'negative',
  'pass',
  'fail',
]);

/** Share of a state's letters that must be non-Latin script to warn. */
const NON_LATIN_RATIO = 0.5;

function invalidRequest(field: string, value: unknown, reason: string): ValidationError {
  return new ValidationError({
    code: ErrorCode.INVALID_REQUEST,
    message: `Invalid decision request: ${reason}`,
    validationDetails: [{ field, value, reason }],
  });
}

/** `true` when every declared decision model looks English-only (`english`, `en-v1`). */
function onlyEnglishModels(models: readonly string[] | undefined): boolean {
  return (
    models !== undefined &&
    models.length > 0 &&
    models.every((model) => /(^|[^a-z])(english|en)([^a-z]|$)/i.test(model))
  );
}

/** Ratio of non-Latin to all letters in the state's text (0 when it has none). */
function nonLatinRatio(state: unknown): number {
  let text: string;
  try {
    text = typeof state === 'string' ? state : (JSON.stringify(state) ?? '');
  } catch {
    return 0;
  }
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (letters === 0) {
    return 0;
  }
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  return (letters - latin) / letters;
}

/**
 * Check a decision request before it is sent: catch what the backend would
 * reject (or silently mishandle), and flag what is legal but likely to
 * answer badly.
 *
 * Contract (the same as {@link validateDecisionResponse}): **throws** a
 * {@link ValidationError} for hard failures and **returns** `IRWarning`s
 * (category `'request-advisory'` unless noted) for soft ones, leaving the
 * request untouched.
 *
 * Shape checks always run and throw when:
 * - `questions` is empty;
 * - a question's `instructions` is empty or whitespace;
 * - a `choice` has fewer than 2 criteria, or a `score` fewer than 2 levels.
 *
 * With `capabilities`, it also throws when:
 * - a question's type is not in `decisionTypes` (omitted means all three);
 * - the question count exceeds `decisionLimits.maxQuestions`, a choice's
 *   option count `maxChoiceOptions`, or a score's level count `maxScoreLevels`;
 * - `images` is non-empty and `decisionImages` is not `true` (images are
 *   opt-in) or the count exceeds `decisionLimits.maxImages`.
 *
 * Warns when:
 * - a question's instructions exceed 2000 characters;
 * - a choice has polar-word keys (`yes`/`no`/`true`/`false`/`good`/`bad`/...),
 *   which decision heads follow by name rather than meaning (arXiv 2609.26758);
 * - (`capabilities` only, category `'capability-unsupported'`) the state is
 *   mostly non-Latin script and every declared `decisionModels` entry looks
 *   English-only. Heuristic and deliberately tiny: more than half of the
 *   state's letters (its text, or its JSON if structured) are outside the
 *   Latin script, and each model name contains the word `english` or `en`.
 */
export function validateDecisionRequest(
  request: IRDecisionRequest,
  capabilities?: IRCapabilities
): readonly IRWarning[] {
  const warnings: IRWarning[] = [];
  const entries = Object.entries(request.questions);
  const limits = capabilities?.decisionLimits;

  if (entries.length === 0) {
    throw invalidRequest('questions', request.questions, 'at least one question is required');
  }
  if (limits?.maxQuestions !== undefined && entries.length > limits.maxQuestions) {
    throw invalidRequest(
      'questions',
      entries.length,
      `${entries.length} questions exceed the backend's limit of ${limits.maxQuestions}`
    );
  }

  for (const [name, question] of entries) {
    const field = `questions.${name}`;

    if (typeof question.instructions !== 'string' || question.instructions.trim() === '') {
      throw invalidRequest(
        `${field}.instructions`,
        question.instructions,
        `question '${name}' has empty instructions`
      );
    }

    if (capabilities?.decisionTypes && !capabilities.decisionTypes.includes(question.type)) {
      throw invalidRequest(
        `${field}.type`,
        question.type,
        `question '${name}' is type '${question.type}', but the backend only answers: ${capabilities.decisionTypes.join(', ')}`
      );
    }

    if (question.type === 'choice') {
      const keys = Object.keys(question.criteria);
      if (keys.length < 2) {
        throw invalidRequest(
          `${field}.criteria`,
          keys.length,
          `choice '${name}' needs at least 2 criteria, got ${keys.length}`
        );
      }
      if (limits?.maxChoiceOptions !== undefined && keys.length > limits.maxChoiceOptions) {
        throw invalidRequest(
          `${field}.criteria`,
          keys.length,
          `choice '${name}' has ${keys.length} options, over the backend's limit of ${limits.maxChoiceOptions}`
        );
      }
      const polar = keys.filter((key) => POLAR_KEYS.has(key.trim().toLowerCase()));
      if (polar.length > 0) {
        warnings.push(
          createWarning(
            'request-advisory',
            `Choice '${name}' uses polar-word keys (${polar.join(', ')}). Decision models follow option names rather than their definitions (option-name bias, arXiv 2609.26758); prefer neutral keys such as 'opt_1', 'opt_2' and carry the meaning in the descriptions.`,
            { field: `${field}.criteria`, originalValue: keys }
          )
        );
      }
    } else if (question.type === 'score') {
      const levels = question.criteria.length;
      if (levels < 2) {
        throw invalidRequest(
          `${field}.criteria`,
          levels,
          `score '${name}' needs at least 2 levels, got ${levels}`
        );
      }
      if (limits?.maxScoreLevels !== undefined && levels > limits.maxScoreLevels) {
        throw invalidRequest(
          `${field}.criteria`,
          levels,
          `score '${name}' has ${levels} levels, over the backend's limit of ${limits.maxScoreLevels}`
        );
      }
    }

    if (question.instructions.length > LONG_INSTRUCTIONS_CHARS) {
      warnings.push(
        createWarning(
          'request-advisory',
          `Instructions for '${name}' are ${question.instructions.length} characters (over ${LONG_INSTRUCTIONS_CHARS}); decision models answer short, specific questions best.`,
          { field: `${field}.instructions`, originalValue: question.instructions.length }
        )
      );
    }
  }

  if (capabilities && request.images && request.images.length > 0) {
    if (capabilities.decisionImages !== true) {
      throw invalidRequest(
        'images',
        request.images.length,
        'the backend does not accept images with decision requests'
      );
    }
    if (limits?.maxImages !== undefined && request.images.length > limits.maxImages) {
      throw invalidRequest(
        'images',
        request.images.length,
        `${request.images.length} images exceed the backend's limit of ${limits.maxImages}`
      );
    }
  }

  if (capabilities && onlyEnglishModels(capabilities.decisionModels)) {
    const ratio = nonLatinRatio(request.state);
    if (ratio > NON_LATIN_RATIO) {
      warnings.push(
        createWarning(
          'capability-unsupported',
          `The state is mostly non-Latin script (${Math.round(ratio * 100)}% of letters) but the backend only declares English decision models; English-only encoders can answer confidently and wrongly on other scripts.`,
          { field: 'state', details: { nonLatinRatio: ratio } }
        )
      );
    }
  }

  return warnings;
}
