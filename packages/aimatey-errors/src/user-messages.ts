/**
 * End-user messages for errors.
 *
 * `AdapterError.message` is written for developers: it names backends, models,
 * registration tables and provider payloads ("Requested backend 'x' is not
 * registered. Registered backends: ..."). Showing it to an end user leaks
 * internals and reads as noise. This module is the other half of that
 * contract: text that is safe to display.
 *
 * **The rule.** `message` is for developers and logs. `userMessage` is for
 * display. {@link toUserMessage} resolves one from any thrown value and is
 * total -- it never returns `error.message`, and it never throws.
 *
 * **Why the defaults cannot leak.** Every default below is a fixed string
 * chosen per error code. Nothing is interpolated from the error: not its
 * message, not `details`, not `cause`, not `provenance`, not a provider
 * response body. An explicit `userMessage` supplied by a thrower is the only
 * caller-controlled text, and that is the thrower's responsibility to keep
 * clean (documented on `BaseErrorOptions.userMessage`).
 *
 * **Stability.** The table is typed `Record<ErrorCode, string>`, so adding an
 * `ErrorCode` fails to compile here until it gets a sentence. At runtime an
 * unknown code (an error from a newer copy of the package, say) falls back to
 * its category's sentence and then to {@link GENERIC_USER_MESSAGE}, so a new
 * code can never surface as a raw internal string.
 *
 * The strings are plain English. They are a default, not a localisation
 * system: an application that localises should switch on `error.code` (or
 * `error.category`) itself, or put its own text in `userMessage`.
 *
 * @module
 */

import { ErrorCode, ErrorCategory, ERROR_CODE_CATEGORIES } from '@johnhenry/aimatey-types';

/** What {@link toUserMessage} returns for anything it cannot classify. */
export const GENERIC_USER_MESSAGE = 'Something went wrong. Please try again.';

const CATEGORY_MESSAGES: Readonly<Record<ErrorCategory, string>> = {
  [ErrorCategory.AUTHENTICATION]:
    "We couldn't connect to the AI service. Please contact the administrator.",
  [ErrorCategory.AUTHORIZATION]:
    'This request is not permitted by the AI service. Please contact the administrator.',
  [ErrorCategory.RATE_LIMIT]: 'Too many requests right now. Please wait a moment and try again.',
  [ErrorCategory.VALIDATION]: "That request couldn't be processed. Please check it and try again.",
  [ErrorCategory.PROVIDER]: 'The AI service had a problem. Please try again in a moment.',
  [ErrorCategory.ADAPTER]: "That request couldn't be processed. Please try again.",
  [ErrorCategory.NETWORK]:
    "We couldn't reach the AI service. Please check your connection and try again.",
  [ErrorCategory.STREAMING]: 'The response was interrupted. Please try again.',
  [ErrorCategory.ROUTING]: 'The AI service is temporarily unavailable. Please try again shortly.',
  [ErrorCategory.MIDDLEWARE]: GENERIC_USER_MESSAGE,
  [ErrorCategory.UNKNOWN]: GENERIC_USER_MESSAGE,
};

/**
 * The default end-user sentence for every error code. Fixed text; see the
 * module comment for why nothing from the error is ever interpolated.
 */
export const DEFAULT_USER_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  [ErrorCode.INVALID_API_KEY]: CATEGORY_MESSAGES[ErrorCategory.AUTHENTICATION],
  [ErrorCode.MISSING_API_KEY]: CATEGORY_MESSAGES[ErrorCategory.AUTHENTICATION],
  [ErrorCode.EXPIRED_API_KEY]: CATEGORY_MESSAGES[ErrorCategory.AUTHENTICATION],
  [ErrorCode.INSUFFICIENT_PERMISSIONS]: CATEGORY_MESSAGES[ErrorCategory.AUTHORIZATION],
  [ErrorCode.QUOTA_EXCEEDED]:
    'The usage limit for the AI service has been reached. Please try again later.',
  [ErrorCode.RATE_LIMIT_EXCEEDED]: CATEGORY_MESSAGES[ErrorCategory.RATE_LIMIT],
  [ErrorCode.INVALID_REQUEST]: CATEGORY_MESSAGES[ErrorCategory.VALIDATION],
  [ErrorCode.INVALID_MESSAGE_FORMAT]: CATEGORY_MESSAGES[ErrorCategory.VALIDATION],
  [ErrorCode.INVALID_PARAMETERS]: CATEGORY_MESSAGES[ErrorCategory.VALIDATION],
  [ErrorCode.UNSUPPORTED_MODEL]: 'That model is not available. Please choose a different one.',
  [ErrorCode.UNSUPPORTED_FEATURE]: "That feature isn't available with the selected AI service.",
  [ErrorCode.MAX_TOOL_ITERATIONS_EXCEEDED]:
    'This took too many steps to complete. Please try a simpler request.',
  [ErrorCode.CONTEXT_LENGTH_EXCEEDED]:
    'The conversation is too long. Please start a new one or shorten your message.',
  [ErrorCode.PROVIDER_ERROR]: CATEGORY_MESSAGES[ErrorCategory.PROVIDER],
  [ErrorCode.PROVIDER_UNAVAILABLE]:
    'The AI service is temporarily unavailable. Please try again shortly.',
  [ErrorCode.PROVIDER_TIMEOUT]: 'The AI service took too long to respond. Please try again.',
  [ErrorCode.PROVIDER_OVERLOADED]:
    'The AI service is busy right now. Please try again in a moment.',
  [ErrorCode.MODEL_LOADING]: 'The AI model is still starting up. Please try again in a moment.',
  [ErrorCode.ADAPTER_CONVERSION_ERROR]: CATEGORY_MESSAGES[ErrorCategory.ADAPTER],
  [ErrorCode.ADAPTER_VALIDATION_ERROR]: CATEGORY_MESSAGES[ErrorCategory.ADAPTER],
  [ErrorCode.UNSUPPORTED_CONVERSION]: CATEGORY_MESSAGES[ErrorCategory.ADAPTER],
  [ErrorCode.SEMANTIC_DRIFT_ERROR]: CATEGORY_MESSAGES[ErrorCategory.ADAPTER],
  [ErrorCode.NETWORK_ERROR]: CATEGORY_MESSAGES[ErrorCategory.NETWORK],
  [ErrorCode.CONNECTION_TIMEOUT]: CATEGORY_MESSAGES[ErrorCategory.NETWORK],
  [ErrorCode.DNS_RESOLUTION_FAILED]: CATEGORY_MESSAGES[ErrorCategory.NETWORK],
  [ErrorCode.STREAM_ERROR]: CATEGORY_MESSAGES[ErrorCategory.STREAMING],
  [ErrorCode.STREAM_INTERRUPTED]: CATEGORY_MESSAGES[ErrorCategory.STREAMING],
  [ErrorCode.STREAM_PARSE_ERROR]: CATEGORY_MESSAGES[ErrorCategory.STREAMING],
  [ErrorCode.STREAM_CANCELLED]: 'The response was cancelled.',
  [ErrorCode.NO_BACKEND_AVAILABLE]: CATEGORY_MESSAGES[ErrorCategory.ROUTING],
  [ErrorCode.ROUTING_FAILED]: CATEGORY_MESSAGES[ErrorCategory.ROUTING],
  [ErrorCode.ALL_BACKENDS_FAILED]: CATEGORY_MESSAGES[ErrorCategory.ROUTING],
  [ErrorCode.MIDDLEWARE_ERROR]: CATEGORY_MESSAGES[ErrorCategory.MIDDLEWARE],
  [ErrorCode.UNKNOWN_ERROR]: GENERIC_USER_MESSAGE,
  [ErrorCode.INTERNAL_ERROR]: GENERIC_USER_MESSAGE,
};

/**
 * Own-property lookup, so a code like `"constructor"` or `"__proto__"` from an
 * untrusted object cannot resolve to something inherited.
 */
function lookup<T>(table: Readonly<Record<string, T>>, key: unknown): T | undefined {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key)
    ? table[key]
    : undefined;
}

/**
 * The text to show an end user for a thrown value.
 *
 * Resolution order:
 *
 * 1. a non-empty string `userMessage` on the error (the thrower vouched for it);
 * 2. the default sentence for the error's `code`;
 * 3. the sentence for its `category` (an unrecognised code from a newer copy);
 * 4. {@link GENERIC_USER_MESSAGE}.
 *
 * It **never** returns `error.message`, never reads `details`, `cause` or
 * `provenance`, and never throws -- so it is safe to call on anything caught,
 * including values that are not `Error`s.
 *
 * Duck-typed rather than `instanceof AdapterError`, for the same reason
 * `defaultShouldRetry` is: an error can arrive from a second copy of this
 * package, where `instanceof` quietly answers false.
 *
 * @example
 * ```typescript
 * try {
 *   await bridge.chat(request);
 * } catch (error) {
 *   console.error(error);                 // developers: the full error
 *   showToast(toUserMessage(error));      // users: a generic sentence
 * }
 * ```
 */
export function toUserMessage(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return GENERIC_USER_MESSAGE;
  }

  let explicit: unknown;
  let code: unknown;
  let category: unknown;
  try {
    const candidate = error as { userMessage?: unknown; code?: unknown; category?: unknown };
    explicit = candidate.userMessage;
    code = candidate.code;
    category = candidate.category;
  } catch {
    // A hostile getter. Nothing to read; say the generic thing.
    return GENERIC_USER_MESSAGE;
  }

  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    return explicit;
  }

  const byCode = lookup(DEFAULT_USER_MESSAGES, code);
  if (byCode !== undefined) {
    return byCode;
  }

  // An unrecognised code may still carry a category; a known code's category
  // is authoritative, so prefer it only when the code itself was unknown.
  const byCategory =
    lookup(CATEGORY_MESSAGES, category) ??
    lookup(CATEGORY_MESSAGES, lookup(ERROR_CODE_CATEGORIES, code));
  return byCategory ?? GENERIC_USER_MESSAGE;
}
