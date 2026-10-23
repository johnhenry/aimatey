/**
 * Error Class Implementations
 *
 * Concrete implementations of all error classes defined in types/errors.ts
 *
 * @module
 */

import type {
  ErrorCode,
  ErrorCategory,
  ErrorProvenance,
  HttpErrorContext,
  ProviderErrorDetails,
  ValidationErrorDetails,
  BaseErrorOptions,
  AuthenticationErrorOptions,
  AuthorizationErrorOptions,
  RateLimitErrorOptions,
  ValidationErrorOptions,
  ProviderErrorOptions,
  AdapterConversionErrorOptions,
  NetworkErrorOptions,
  StreamErrorOptions,
  RouterErrorOptions,
  MiddlewareErrorOptions,
  IRChatRequest,
  IRChatResponse,
} from '@johnhenry/aimatey-types';
import { ErrorCode as ErrorCodeEnum, ERROR_CODE_CATEGORIES } from '@johnhenry/aimatey-types';

// ============================================================================
// Base Error Class
// ============================================================================

/**
 * Base error class for all adapter errors.
 *
 * **`message` is for developers and logs.** It routinely names backends,
 * models, registration tables and provider payloads, and must never be shown
 * to an end user. **`userMessage` is for display**: text that is safe, generic,
 * and free of internals. It is optional; when a thrower did not supply one,
 * {@link toUserMessage} returns a generic sentence for the error's code, so a
 * caller can always render `toUserMessage(error)` without special-casing.
 */
export class AdapterError extends Error {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly isRetryable: boolean;
  readonly provenance: ErrorProvenance;
  readonly cause?: Error;
  readonly irState?: {
    readonly request?: Partial<IRChatRequest>;
    readonly response?: Partial<IRChatResponse>;
  };
  readonly details?: Record<string, unknown>;
  readonly timestamp: number;
  /**
   * End-user-safe text supplied by whoever threw this error, shown verbatim.
   * Absent unless supplied; use {@link toUserMessage} to get a displayable
   * string either way.
   */
  readonly userMessage?: string;
  /** HTTP status of the provider response that caused this error, when there was one. */
  readonly statusCode?: number;
  /** The provider's own (credential-redacted) error message, when one was returned. */
  readonly providerMessage?: string;

  constructor(options: BaseErrorOptions) {
    super(options.message);
    this.name = 'AdapterError';
    this.code = options.code;
    this.category = ERROR_CODE_CATEGORIES[options.code];
    this.isRetryable = options.isRetryable ?? false;
    this.provenance = options.provenance ?? {};
    this.cause = options.cause;
    this.irState = options.irState;
    this.details = options.details;
    this.timestamp = Date.now();
    this.userMessage = options.userMessage;
    this.statusCode = options.statusCode;
    this.providerMessage = options.providerMessage;

    // Maintains proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Check if error belongs to a category.
   */
  isCategory(category: ErrorCategory): boolean {
    return this.category === category;
  }

  /**
   * Convert to JSON for logging/serialization.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      message: this.message,
      userMessage: this.userMessage,
      statusCode: this.statusCode,
      providerMessage: this.providerMessage,
      isRetryable: this.isRetryable,
      provenance: this.provenance,
      irState: this.irState,
      details: this.details,
      timestamp: this.timestamp,
      stack: this.stack,
      cause: this.cause
        ? {
            name: this.cause.name,
            message: this.cause.message,
            stack: this.cause.stack,
          }
        : undefined,
    };
  }
}

// ============================================================================
// Specialized Error Classes
// ============================================================================

/**
 * Authentication error (API key issues).
 */
export class AuthenticationError extends AdapterError {
  constructor(options: AuthenticationErrorOptions) {
    super({
      ...options,
      isRetryable: false,
    });
    this.name = 'AuthenticationError';
  }
}

/**
 * Authorization error (permissions, quota).
 */
export class AuthorizationError extends AdapterError {
  constructor(options: AuthorizationErrorOptions) {
    super({
      ...options,
      isRetryable: false,
    });
    this.name = 'AuthorizationError';
  }
}

/**
 * Rate limit error with retry information.
 */
export class RateLimitError extends AdapterError {
  readonly retryAfter?: number;
  readonly limit?: number;
  readonly remaining?: number;
  readonly resetAt?: string;

  constructor(options: RateLimitErrorOptions) {
    super({
      code: ErrorCodeEnum.RATE_LIMIT_EXCEEDED,
      message: options.message,
      userMessage: options.userMessage,
      isRetryable: true,
      provenance: options.provenance,
      cause: options.cause,
      statusCode: options.statusCode,
      providerMessage: options.providerMessage,
      details: { ...options.rateLimitDetails, ...options.details } as Record<string, unknown>,
    });
    this.name = 'RateLimitError';
    this.retryAfter = options.rateLimitDetails?.retryAfter;
    this.limit = options.rateLimitDetails?.limit;
    this.remaining = options.rateLimitDetails?.remaining;
    this.resetAt = options.rateLimitDetails?.resetAt;
  }
}

/**
 * Validation error with field-specific context.
 */
export class ValidationError extends AdapterError {
  readonly validationDetails: ValidationErrorDetails[];

  constructor(options: ValidationErrorOptions) {
    super({
      ...options,
      isRetryable: false,
      details: { ...options.details, validationDetails: options.validationDetails },
    });
    this.name = 'ValidationError';
    this.validationDetails = options.validationDetails;
  }
}

/**
 * Provider error (upstream API issues).
 */
export class ProviderError extends AdapterError {
  readonly providerDetails?: ProviderErrorDetails;
  readonly httpContext?: HttpErrorContext;

  constructor(options: ProviderErrorOptions) {
    super({
      ...options,
      details: {
        ...options.providerDetails,
        ...options.httpContext,
      },
    });
    this.name = 'ProviderError';
    this.providerDetails = options.providerDetails;
    this.httpContext = options.httpContext;
  }
}

/**
 * Adapter conversion error (translation issues).
 */
export class AdapterConversionError extends AdapterError {
  constructor(options: AdapterConversionErrorOptions) {
    super({
      ...options,
      isRetryable: false,
    });
    this.name = 'AdapterConversionError';
  }
}

/**
 * Network error (connectivity issues).
 */
export class NetworkError extends AdapterError {
  constructor(options: NetworkErrorOptions) {
    super({
      ...options,
      isRetryable: true,
    });
    this.name = 'NetworkError';
  }
}

/**
 * Streaming error (stream-specific issues).
 */
export class StreamError extends AdapterError {
  constructor(options: StreamErrorOptions) {
    super({
      ...options,
      isRetryable: options.code === ErrorCodeEnum.STREAM_INTERRUPTED,
    });
    this.name = 'StreamError';
  }
}

/**
 * Retryability of an error that is about to be wrapped.
 *
 * Duck-typed rather than tested with `instanceof AdapterError`: a cause can
 * arrive from a second copy of this package (the dual ESM/CJS output, or a
 * duplicated install), where `instanceof` quietly returns false. This is how
 * `defaultShouldRetry` in the retry middleware reads the flag too.
 */
function causeIsRetryable(cause: Error | undefined): boolean {
  return (cause as { isRetryable?: unknown } | undefined)?.isRetryable === true;
}

/**
 * Whether *any* of the failures a composite error wraps is retryable.
 *
 * Retrying a composite helps as soon as one of its legs could succeed on a
 * second attempt, so this is `some` and not `every`: three backends where two
 * rejected the API key and one timed out is still worth retrying, because the
 * one that timed out might answer.
 */
function anyCauseIsRetryable(causes: readonly Error[] | undefined): boolean {
  return causes?.some((cause) => causeIsRetryable(cause)) === true;
}

/** Serialization-safe view of a wrapped failure, for `toJSON()` and logs. */
function summarizeCause(cause: Error): Record<string, unknown> {
  const classified = cause as { code?: unknown; isRetryable?: unknown };
  return {
    name: cause.name,
    message: cause.message,
    code: classified.code,
    isRetryable: classified.isRetryable === true,
  };
}

/**
 * Router error (routing issues).
 *
 * `ALL_BACKENDS_FAILED` used to be asserted retryable purely from its code, so
 * a router whose every backend rejected the API key produced a "retryable"
 * error and the caller burned its whole retry budget on a fault that was
 * permanent at every leaf. A composite error has no more standing to
 * reclassify its parts than a wrapper has to reclassify its cause (#65), so
 * retryability is derived from `backendErrors`: retryable only when at least
 * one attempted backend failed retryably.
 *
 * With no `backendErrors` there is no evidence either way, and an unevidenced
 * claim of retryability is the bug this fixes - so it stays non-retryable, the
 * same answer `MiddlewareError` gives for a cause it cannot classify.
 */
export class RouterError extends AdapterError {
  readonly attemptedBackends?: string[];
  /** The leaf failures this error is composed of, when the router had them. */
  readonly backendErrors?: readonly Error[];

  constructor(options: RouterErrorOptions) {
    super({
      ...options,
      isRetryable:
        options.code === ErrorCodeEnum.ALL_BACKENDS_FAILED &&
        anyCauseIsRetryable(options.backendErrors),
      details: {
        attemptedBackends: options.attemptedBackends,
        backendErrors: options.backendErrors?.map(summarizeCause),
      },
    });
    this.name = 'RouterError';
    this.attemptedBackends = options.attemptedBackends;
    this.backendErrors = options.backendErrors;
  }
}

/**
 * Middleware error.
 *
 * A `MiddlewareError` built around a `cause` is a wrapper, and a wrapper has no
 * standing to reclassify what it wraps: a transient `NetworkError` does not
 * stop being retryable because a middleware carried it. Its retryability is
 * therefore the cause's. A `MiddlewareError` raised on its own - a middleware
 * that failed by itself - stays non-retryable, as does one wrapping a cause
 * that carries no classification of its own.
 */
export class MiddlewareError extends AdapterError {
  readonly middlewareName?: string;

  constructor(options: MiddlewareErrorOptions) {
    super({
      code: ErrorCodeEnum.MIDDLEWARE_ERROR,
      message: options.message,
      userMessage: options.userMessage,
      isRetryable: causeIsRetryable(options.cause),
      provenance: options.provenance,
      cause: options.cause,
      irState: options.irState,
      details: { middlewareName: options.middlewareName },
    });
    this.name = 'MiddlewareError';
    this.middlewareName = options.middlewareName;
  }
}

export { toUserMessage, DEFAULT_USER_MESSAGES, GENERIC_USER_MESSAGE } from './user-messages.js';

// ============================================================================
// Error Factory Functions
// ============================================================================

/**
 * 4xx statuses whose canonical meaning is "try again", listed because the
 * `statusCode >= 500` rule below cannot see them.
 *
 * - **408 Request Timeout** - the server gave up waiting for the request and
 *   says so explicitly; RFC 9110 has the client repeat it. This is what a
 *   provider returns when *it* wants another attempt, and calling it permanent
 *   inverted the one instruction it carries.
 * - **425 Too Early** - the server declined to risk replaying an early-data
 *   request; RFC 8470 has the client retry it once the handshake completes.
 *
 * Every other status that falls through stays non-retryable, and each was
 * checked rather than assumed:
 *
 * - **404 Not Found** - a wrong URL or a model name the provider does not
 *   have. The second identical request finds it just as absent.
 * - **409 Conflict** - a state mismatch. Retrying the same request against the
 *   same state reproduces the same conflict. (Some APIs overload 409 for
 *   "resource busy", but that is not its canonical meaning, and guessing wrong
 *   retries a semantic error until the budget runs out.)
 * - **422 Unprocessable Content** - the payload is syntactically fine and
 *   semantically wrong. Resending the identical payload fails identically.
 */
const RETRYABLE_CLIENT_STATUS_CODES: ReadonlySet<number> = new Set([408, 425]);

/**
 * Whether an HTTP status is worth another attempt.
 *
 * 5xx is the server admitting a fault it may not repeat; the handful of 4xx
 * codes in {@link RETRYABLE_CLIENT_STATUS_CODES} ask for a retry outright.
 */
function isRetryableStatusCode(statusCode: number): boolean {
  return statusCode >= 500 || RETRYABLE_CLIENT_STATUS_CODES.has(statusCode);
}

const REDACTED = '[REDACTED]';

/**
 * Strip credentials a provider (or proxy) may echo back in an error body:
 * `Authorization`/`x-api-key`-style header lines, bearer tokens, `key=`/`api_key=`
 * query or JSON values, and well-known key shapes (OpenAI `sk-`, Google `AIza`,
 * Anthropic `sk-ant-`, GitHub `ghp_`, Hugging Face `hf_`, Groq `gsk_`, AWS `AKIA`).
 */
export function redactSecrets(text: string): string {
  return text
    .replace(
      /\b(authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key)(["']?\s*[:=]\s*["']?)(?:bearer\s+|basic\s+)?[^\s"',;&]+/gi,
      `$1$2${REDACTED}`
    )
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`)
    .replace(/\b(api[_-]?key|access[_-]?token|token|secret|key)=([^\s&"']+)/gi, `$1=${REDACTED}`)
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{10,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{16,}|hf_[A-Za-z0-9]{16,}|gsk_[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{12,}|xox[abp]-[A-Za-z0-9-]{10,})/g,
      REDACTED
    );
}

const MAX_PROVIDER_MESSAGE_LENGTH = 1000;

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Pull the human-readable message out of a provider error body. Handles the
 * common shapes: `{error:{message}}`, `{error:"..."}`, `{message}`, `{detail}`,
 * `{errors:[{message}]}`, arrays of those (Gemini), JSON given as a string, and
 * plain text. Returns undefined when nothing readable is there.
 */
function extractProviderMessage(body: unknown, depth = 0): string | undefined {
  if (body === null || body === undefined || depth > 3) {
    return undefined;
  }
  if (typeof body === 'string') {
    const text = body.trim();
    if (!text) {
      return undefined;
    }
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        const nested = extractProviderMessage(JSON.parse(text), depth + 1);
        if (nested) {
          return nested;
        }
      } catch {
        // not JSON after all; fall through to the raw text
      }
    }
    // An HTML error page is not a message worth surfacing.
    return /^<(?:!doctype|html)/i.test(text) ? undefined : text;
  }
  if (Array.isArray(body)) {
    for (const item of body) {
      const m = extractProviderMessage(item, depth + 1);
      if (m) {
        return m;
      }
    }
    return undefined;
  }
  if (typeof body === 'object') {
    const o = body as Record<string, unknown>;
    return (
      pickString(o.message) ??
      extractProviderMessage(o.error, depth + 1) ??
      pickString(o.detail) ??
      pickString(o.error_description) ??
      extractProviderMessage(o.errors, depth + 1) ??
      extractProviderMessage(o.detail, depth + 1)
    );
  }
  return undefined;
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? undefined;
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === lower && (typeof v === 'string' || typeof v === 'number')) {
      return String(v);
    }
  }
  return undefined;
}

/**
 * Parse a rate-limit wait out of response headers, in milliseconds.
 * Honors `retry-after-ms`, then `Retry-After` as delta-seconds or an HTTP-date.
 */
export function parseRetryAfter(headers: unknown): number | undefined {
  const ms = readHeader(headers, 'retry-after-ms');
  if (ms !== undefined && /^\d+(\.\d+)?$/.test(ms.trim())) {
    return Math.round(Number(ms));
  }
  const raw = readHeader(headers, 'retry-after')?.trim();
  if (!raw) {
    return undefined;
  }
  if (/^\d+(\.\d+)?$/.test(raw)) {
    return Math.round(Number(raw) * 1000);
  }
  const when = Date.parse(raw);
  return Number.isNaN(when) ? undefined : Math.max(0, when - Date.now());
}

function redactBody(body: unknown): unknown {
  if (typeof body === 'string') {
    return redactSecrets(body).slice(0, 4000);
  }
  if (body === null || body === undefined) {
    return body;
  }
  try {
    return JSON.parse(redactSecrets(JSON.stringify(body)));
  } catch {
    return undefined;
  }
}

/**
 * Create adapter error from HTTP response.
 *
 * Keeps what the provider said: the status (`error.statusCode`), the provider's
 * own message (`error.providerMessage`, also folded into `error.message` so it
 * is visible when `statusText` is empty, as it always is over HTTP/2 and
 * HTTP/3), and the redacted body (`error.details.responseBody`). Credentials
 * echoed by a provider are redacted from all three.
 *
 * Status mapping: 401 authentication, 403 authorization, 429 rate limit
 * (`retryAfter` in ms from `headers`), 400 validation (non-retryable),
 * 404/410 about a model `UNSUPPORTED_MODEL` (non-retryable), 5xx retryable.
 *
 * @param headers - Optional response headers (`Headers` or a plain object) used for `Retry-After`.
 */
export function createErrorFromHttpResponse(
  statusCode: number,
  statusText: string,
  responseBody: unknown,
  provenance: ErrorProvenance,
  headers?: Headers | Record<string, string>
): AdapterError {
  const rawMessage = extractProviderMessage(responseBody);
  const providerMessage = rawMessage
    ? redactSecrets(rawMessage).slice(0, MAX_PROVIDER_MESSAGE_LENGTH)
    : undefined;
  const redactedBody = redactBody(responseBody);
  const detail = providerMessage ?? (statusText ? redactSecrets(statusText) : `HTTP ${statusCode}`);

  const httpContext = {
    statusCode,
    statusText,
    responseBody: redactedBody,
  } as HttpErrorContext;
  const common = {
    provenance,
    statusCode,
    providerMessage,
    details: { statusCode, statusText, responseBody: redactedBody, providerMessage },
  };

  if (statusCode === 401) {
    return new AuthenticationError({
      ...common,
      code: ErrorCodeEnum.INVALID_API_KEY,
      message: `Authentication failed (${statusCode}): ${detail}`,
    });
  }

  if (statusCode === 403) {
    return new AuthorizationError({
      ...common,
      code: ErrorCodeEnum.INSUFFICIENT_PERMISSIONS,
      message: `Authorization failed (${statusCode}): ${detail}`,
    });
  }

  if (statusCode === 429) {
    const retryAfter = parseRetryAfter(headers);
    return new RateLimitError({
      ...common,
      message: `Rate limit exceeded (${statusCode}): ${detail}`,
      rateLimitDetails: retryAfter === undefined ? undefined : { retryAfter },
    });
  }

  if (statusCode === 400) {
    return new ValidationError({
      ...common,
      code: ErrorCodeEnum.INVALID_REQUEST,
      message: `Invalid request (${statusCode}): ${detail}`,
      validationDetails: [],
    });
  }

  if ((statusCode === 404 || statusCode === 410) && /\bmodels?\b/i.test(detail)) {
    return new ValidationError({
      ...common,
      code: ErrorCodeEnum.UNSUPPORTED_MODEL,
      message: `Model not found (${statusCode}): ${detail}`,
      validationDetails: [],
    });
  }

  if (statusCode >= 500) {
    return new ProviderError({
      provenance,
      statusCode,
      providerMessage,
      code: ErrorCodeEnum.PROVIDER_ERROR,
      message: `Provider error (${statusCode}): ${detail}`,
      isRetryable: true,
      httpContext,
    });
  }

  return new AdapterError({
    ...common,
    code: ErrorCodeEnum.PROVIDER_ERROR,
    message: `HTTP error ${statusCode}: ${detail}`,
    isRetryable: isRetryableStatusCode(statusCode),
  });
}

/**
 * Create error from provider-specific error.
 */
export function createErrorFromProviderError(
  provider: string,
  providerError: unknown,
  provenance: ErrorProvenance
): AdapterError {
  // Provider-specific error mapping would go here
  // This is a simplified version
  return new ProviderError({
    code: ErrorCodeEnum.PROVIDER_ERROR,
    message: `Provider error from ${provider}`,
    provenance,
    providerDetails: {
      provider,
      providerMessage: String(providerError),
    },
  });
}

// Re-export error codes and categories from types
export { ErrorCodeEnum as ErrorCode, ERROR_CODE_CATEGORIES };
export type {
  ErrorCode as ErrorCodeType,
  ErrorCategory,
  ErrorProvenance,
  HttpErrorContext,
  ProviderErrorDetails,
  ValidationErrorDetails,
  BaseErrorOptions,
  AuthenticationErrorOptions,
  AuthorizationErrorOptions,
  RateLimitErrorOptions,
  ValidationErrorOptions,
  ProviderErrorOptions,
  AdapterConversionErrorOptions,
  NetworkErrorOptions,
  StreamErrorOptions,
  RouterErrorOptions,
  MiddlewareErrorOptions,
} from '@johnhenry/aimatey-types';
