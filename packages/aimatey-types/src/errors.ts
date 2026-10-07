/**
 * Error Types and Codes
 *
 * Normalized error handling across all AI providers. Provider-specific errors
 * are translated to universal error types with actionable context.
 *
 * @module
 */

import type { IRChatRequest, IRChatResponse } from './ir.js';

// ============================================================================
// Error Codes
// ============================================================================

/**
 * Universal error codes covering all adapter failure modes.
 */
export const ErrorCode = {
  // Authentication errors (40x)
  INVALID_API_KEY: 'INVALID_API_KEY',
  MISSING_API_KEY: 'MISSING_API_KEY',
  EXPIRED_API_KEY: 'EXPIRED_API_KEY',

  // Authorization errors (40x)
  INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',

  // Rate limiting (429)
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',

  // Validation errors (400)
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_MESSAGE_FORMAT: 'INVALID_MESSAGE_FORMAT',
  INVALID_PARAMETERS: 'INVALID_PARAMETERS',
  UNSUPPORTED_MODEL: 'UNSUPPORTED_MODEL',
  UNSUPPORTED_FEATURE: 'UNSUPPORTED_FEATURE',
  MAX_TOOL_ITERATIONS_EXCEEDED: 'MAX_TOOL_ITERATIONS_EXCEEDED',
  CONTEXT_LENGTH_EXCEEDED: 'CONTEXT_LENGTH_EXCEEDED',

  // Provider errors (50x)
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  PROVIDER_OVERLOADED: 'PROVIDER_OVERLOADED',
  /**
   * The backend is alive but warming up (loading a model into memory). A signal,
   * not a fault: the default circuit-breaker predicate does not count it, so a
   * slow-starting local backend is not tripped by being slow to start.
   */
  MODEL_LOADING: 'MODEL_LOADING',

  // Adapter errors
  ADAPTER_CONVERSION_ERROR: 'ADAPTER_CONVERSION_ERROR',
  ADAPTER_VALIDATION_ERROR: 'ADAPTER_VALIDATION_ERROR',
  UNSUPPORTED_CONVERSION: 'UNSUPPORTED_CONVERSION',
  SEMANTIC_DRIFT_ERROR: 'SEMANTIC_DRIFT_ERROR',

  // Network errors
  NETWORK_ERROR: 'NETWORK_ERROR',
  CONNECTION_TIMEOUT: 'CONNECTION_TIMEOUT',
  DNS_RESOLUTION_FAILED: 'DNS_RESOLUTION_FAILED',

  // Streaming errors
  STREAM_ERROR: 'STREAM_ERROR',
  STREAM_INTERRUPTED: 'STREAM_INTERRUPTED',
  STREAM_PARSE_ERROR: 'STREAM_PARSE_ERROR',
  STREAM_CANCELLED: 'STREAM_CANCELLED',

  // Router errors
  NO_BACKEND_AVAILABLE: 'NO_BACKEND_AVAILABLE',
  ROUTING_FAILED: 'ROUTING_FAILED',
  ALL_BACKENDS_FAILED: 'ALL_BACKENDS_FAILED',

  // Middleware errors
  MIDDLEWARE_ERROR: 'MIDDLEWARE_ERROR',

  // Generic errors
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// ============================================================================
// Error Categories
// ============================================================================

/**
 * Groups error codes into categories for easier handling.
 */
export const ErrorCategory = {
  AUTHENTICATION: 'authentication',
  AUTHORIZATION: 'authorization',
  RATE_LIMIT: 'rate_limit',
  VALIDATION: 'validation',
  PROVIDER: 'provider',
  ADAPTER: 'adapter',
  NETWORK: 'network',
  STREAMING: 'streaming',
  ROUTING: 'routing',
  MIDDLEWARE: 'middleware',
  UNKNOWN: 'unknown',
} as const;

export type ErrorCategory = (typeof ErrorCategory)[keyof typeof ErrorCategory];

/**
 * Maps error codes to their categories.
 */
export const ERROR_CODE_CATEGORIES: Record<ErrorCode, ErrorCategory> = {
  [ErrorCode.INVALID_API_KEY]: ErrorCategory.AUTHENTICATION,
  [ErrorCode.MISSING_API_KEY]: ErrorCategory.AUTHENTICATION,
  [ErrorCode.EXPIRED_API_KEY]: ErrorCategory.AUTHENTICATION,
  [ErrorCode.INSUFFICIENT_PERMISSIONS]: ErrorCategory.AUTHORIZATION,
  [ErrorCode.QUOTA_EXCEEDED]: ErrorCategory.AUTHORIZATION,
  [ErrorCode.RATE_LIMIT_EXCEEDED]: ErrorCategory.RATE_LIMIT,
  [ErrorCode.INVALID_REQUEST]: ErrorCategory.VALIDATION,
  [ErrorCode.INVALID_MESSAGE_FORMAT]: ErrorCategory.VALIDATION,
  [ErrorCode.INVALID_PARAMETERS]: ErrorCategory.VALIDATION,
  [ErrorCode.UNSUPPORTED_MODEL]: ErrorCategory.VALIDATION,
  [ErrorCode.UNSUPPORTED_FEATURE]: ErrorCategory.VALIDATION,
  [ErrorCode.MAX_TOOL_ITERATIONS_EXCEEDED]: ErrorCategory.VALIDATION,
  [ErrorCode.CONTEXT_LENGTH_EXCEEDED]: ErrorCategory.VALIDATION,
  [ErrorCode.PROVIDER_ERROR]: ErrorCategory.PROVIDER,
  [ErrorCode.PROVIDER_UNAVAILABLE]: ErrorCategory.PROVIDER,
  [ErrorCode.PROVIDER_TIMEOUT]: ErrorCategory.PROVIDER,
  [ErrorCode.PROVIDER_OVERLOADED]: ErrorCategory.PROVIDER,
  [ErrorCode.MODEL_LOADING]: ErrorCategory.PROVIDER,
  [ErrorCode.ADAPTER_CONVERSION_ERROR]: ErrorCategory.ADAPTER,
  [ErrorCode.ADAPTER_VALIDATION_ERROR]: ErrorCategory.ADAPTER,
  [ErrorCode.UNSUPPORTED_CONVERSION]: ErrorCategory.ADAPTER,
  [ErrorCode.SEMANTIC_DRIFT_ERROR]: ErrorCategory.ADAPTER,
  [ErrorCode.NETWORK_ERROR]: ErrorCategory.NETWORK,
  [ErrorCode.CONNECTION_TIMEOUT]: ErrorCategory.NETWORK,
  [ErrorCode.DNS_RESOLUTION_FAILED]: ErrorCategory.NETWORK,
  [ErrorCode.STREAM_ERROR]: ErrorCategory.STREAMING,
  [ErrorCode.STREAM_INTERRUPTED]: ErrorCategory.STREAMING,
  [ErrorCode.STREAM_PARSE_ERROR]: ErrorCategory.STREAMING,
  [ErrorCode.STREAM_CANCELLED]: ErrorCategory.STREAMING,
  [ErrorCode.NO_BACKEND_AVAILABLE]: ErrorCategory.ROUTING,
  [ErrorCode.ROUTING_FAILED]: ErrorCategory.ROUTING,
  [ErrorCode.ALL_BACKENDS_FAILED]: ErrorCategory.ROUTING,
  [ErrorCode.MIDDLEWARE_ERROR]: ErrorCategory.MIDDLEWARE,
  [ErrorCode.UNKNOWN_ERROR]: ErrorCategory.UNKNOWN,
  [ErrorCode.INTERNAL_ERROR]: ErrorCategory.UNKNOWN,
};

// ============================================================================
// Error Details Types
// ============================================================================

/**
 * Context about where an error occurred in the adapter chain.
 */
export interface ErrorProvenance {
  /**
   * Frontend adapter that initiated the request.
   */
  readonly frontend?: string;

  /**
   * Backend adapter that was processing the request.
   */
  readonly backend?: string;

  /**
   * Middleware layer where error occurred (if applicable).
   */
  readonly middleware?: string;

  /**
   * Router that was handling the request (if applicable).
   */
  readonly router?: string;
}

/**
 * HTTP status code and additional HTTP context.
 */
export interface HttpErrorContext {
  readonly statusCode: number;
  readonly statusText?: string;
  readonly headers?: Record<string, string>;
  readonly responseBody?: unknown;
}

/**
 * Provider-specific error information.
 */
export interface ProviderErrorDetails {
  /**
   * Original error code from provider.
   */
  readonly providerCode?: string;

  /**
   * Original error message from provider.
   */
  readonly providerMessage?: string;

  /**
   * Provider name (openai, anthropic, gemini, etc.).
   */
  readonly provider: string;

  /**
   * Provider-specific error data.
   */
  readonly providerData?: Record<string, unknown>;
}

/**
 * Validation error details.
 */
export interface ValidationErrorDetails {
  /**
   * Field or parameter that failed validation.
   */
  readonly field: string;

  /**
   * Value that failed validation.
   */
  readonly value: unknown;

  /**
   * Why validation failed.
   */
  readonly reason: string;

  /**
   * Expected format or constraint.
   */
  readonly expected?: string;
}

/**
 * Rate limit error details.
 */
export interface RateLimitErrorDetails {
  /**
   * Time until rate limit resets (milliseconds).
   */
  readonly retryAfter?: number;

  /**
   * Rate limit ceiling (requests per period).
   */
  readonly limit?: number;

  /**
   * Remaining requests in current period.
   */
  readonly remaining?: number;

  /**
   * When limit resets (ISO timestamp).
   */
  readonly resetAt?: string;
}

// ============================================================================
// Error Options Types
// ============================================================================

/**
 * Base error constructor options.
 */
export interface BaseErrorOptions {
  readonly code: ErrorCode;
  readonly message: string;
  readonly isRetryable?: boolean;
  readonly provenance?: ErrorProvenance;
  readonly cause?: Error;
  readonly irState?: {
    readonly request?: Partial<IRChatRequest>;
    readonly response?: Partial<IRChatResponse>;
  };
  readonly details?: Record<string, unknown>;
  /**
   * Text that is safe to show an **end user**, as opposed to `message`, which
   * is for developers and logs.
   *
   * Optional. When absent, `toUserMessage(error)` (in `@johnhenry/aimatey-errors`)
   * supplies a generic sentence for the error's code. Whatever is supplied
   * here is shown verbatim, so it must never be built from provider payloads,
   * backend names, request content or anything else an end user should not see.
   */
  readonly userMessage?: string;
}

/**
 * Authentication error constructor options.
 */
export interface AuthenticationErrorOptions {
  readonly code:
    | typeof ErrorCode.INVALID_API_KEY
    | typeof ErrorCode.MISSING_API_KEY
    | typeof ErrorCode.EXPIRED_API_KEY;
  readonly message: string;
  /** See {@link BaseErrorOptions.userMessage}. */
  readonly userMessage?: string;
  readonly provenance?: ErrorProvenance;
  readonly cause?: Error;
}

/**
 * Authorization error constructor options.
 */
export interface AuthorizationErrorOptions {
  readonly code: typeof ErrorCode.INSUFFICIENT_PERMISSIONS | typeof ErrorCode.QUOTA_EXCEEDED;
  readonly message: string;
  /** See {@link BaseErrorOptions.userMessage}. */
  readonly userMessage?: string;
  readonly provenance?: ErrorProvenance;
  readonly cause?: Error;
}

/**
 * Rate limit error constructor options.
 */
export interface RateLimitErrorOptions {
  readonly message: string;
  /** See {@link BaseErrorOptions.userMessage}. */
  readonly userMessage?: string;
  readonly provenance?: ErrorProvenance;
  readonly cause?: Error;
  readonly rateLimitDetails?: RateLimitErrorDetails;
}

/**
 * Validation error constructor options.
 */
export interface ValidationErrorOptions {
  readonly code:
    | typeof ErrorCode.INVALID_REQUEST
    | typeof ErrorCode.INVALID_MESSAGE_FORMAT
    | typeof ErrorCode.INVALID_PARAMETERS
    | typeof ErrorCode.UNSUPPORTED_MODEL
    | typeof ErrorCode.UNSUPPORTED_FEATURE
    | typeof ErrorCode.CONTEXT_LENGTH_EXCEEDED;
  readonly message: string;
  /** See {@link BaseErrorOptions.userMessage}. */
  readonly userMessage?: string;
  readonly validationDetails: ValidationErrorDetails[];
  readonly provenance?: ErrorProvenance;
  readonly irState?: {
    readonly request?: Partial<IRChatRequest>;
  };
}

/**
 * Provider error constructor options.
 */
export interface ProviderErrorOptions {
  readonly code:
    | typeof ErrorCode.PROVIDER_ERROR
    | typeof ErrorCode.PROVIDER_UNAVAILABLE
    | typeof ErrorCode.PROVIDER_TIMEOUT
    | typeof ErrorCode.PROVIDER_OVERLOADED
    | typeof ErrorCode.MODEL_LOADING;
  readonly message: string;
  /** See {@link BaseErrorOptions.userMessage}. */
  readonly userMessage?: string;
  readonly isRetryable?: boolean;
  readonly provenance?: ErrorProvenance;
  readonly cause?: Error;
  readonly providerDetails?: ProviderErrorDetails;
  readonly httpContext?: HttpErrorContext;
  readonly irState?: {
    readonly request?: Partial<IRChatRequest>;
    readonly response?: Partial<IRChatResponse>;
  };
}

/**
 * Adapter conversion error constructor options.
 */
export interface AdapterConversionErrorOptions {
  readonly code:
    | typeof ErrorCode.ADAPTER_CONVERSION_ERROR
    | typeof ErrorCode.ADAPTER_VALIDATION_ERROR
    | typeof ErrorCode.UNSUPPORTED_CONVERSION
    | typeof ErrorCode.SEMANTIC_DRIFT_ERROR;
  readonly message: string;
  /** See {@link BaseErrorOptions.userMessage}. */
  readonly userMessage?: string;
  readonly provenance?: ErrorProvenance;
  readonly cause?: Error;
  readonly irState?: {
    readonly request?: Partial<IRChatRequest>;
    readonly response?: Partial<IRChatResponse>;
  };
}

/**
 * Network error constructor options.
 */
export interface NetworkErrorOptions {
  readonly code:
    | typeof ErrorCode.NETWORK_ERROR
    | typeof ErrorCode.CONNECTION_TIMEOUT
    | typeof ErrorCode.DNS_RESOLUTION_FAILED;
  readonly message: string;
  /** See {@link BaseErrorOptions.userMessage}. */
  readonly userMessage?: string;
  readonly provenance?: ErrorProvenance;
  readonly cause?: Error;
}

/**
 * Stream error constructor options.
 */
export interface StreamErrorOptions {
  readonly code:
    | typeof ErrorCode.STREAM_ERROR
    | typeof ErrorCode.STREAM_INTERRUPTED
    | typeof ErrorCode.STREAM_PARSE_ERROR
    | typeof ErrorCode.STREAM_CANCELLED;
  readonly message: string;
  /** See {@link BaseErrorOptions.userMessage}. */
  readonly userMessage?: string;
  readonly provenance?: ErrorProvenance;
  readonly cause?: Error;
  readonly irState?: {
    readonly request?: Partial<IRChatRequest>;
  };
}

/**
 * Router error constructor options.
 */
export interface RouterErrorOptions {
  readonly code:
    | typeof ErrorCode.NO_BACKEND_AVAILABLE
    | typeof ErrorCode.ROUTING_FAILED
    | typeof ErrorCode.ALL_BACKENDS_FAILED;
  readonly message: string;
  /** See {@link BaseErrorOptions.userMessage}. */
  readonly userMessage?: string;
  readonly provenance?: ErrorProvenance;
  readonly cause?: Error;
  readonly attemptedBackends?: string[];
  /**
   * The failures the attempted backends produced.
   *
   * `attemptedBackends` records *which* backends were tried; this records
   * *how* each one failed. A composite `ALL_BACKENDS_FAILED` derives its
   * `isRetryable` from these - retryable only when at least one leaf failure
   * was itself retryable - so supplying them is what makes the classification
   * meaningful rather than assumed.
   */
  readonly backendErrors?: readonly Error[];
  readonly irState?: {
    readonly request?: Partial<IRChatRequest>;
  };
}

/**
 * Middleware error constructor options.
 */
export interface MiddlewareErrorOptions {
  readonly message: string;
  /** See {@link BaseErrorOptions.userMessage}. */
  readonly userMessage?: string;
  readonly middlewareName?: string;
  readonly provenance?: ErrorProvenance;
  readonly cause?: Error;
  readonly irState?: {
    readonly request?: Partial<IRChatRequest>;
    readonly response?: Partial<IRChatResponse>;
  };
}

// ============================================================================
// Error Class Interfaces
// ============================================================================

/**
 * Base error class interface.
 *
 * **`message` is for developers and logs; never show it to an end user.** It
 * routinely names backends, models, registration tables, provider payloads and
 * configuration. Display `userMessage` instead -- or, when it is absent, the
 * generic sentence `toUserMessage(error)` returns for the error's code.
 */
export interface AdapterError extends Error {
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
  /** End-user-safe text, when the thrower supplied one. See {@link BaseErrorOptions.userMessage}. */
  readonly userMessage?: string;

  isCategory(category: ErrorCategory): boolean;
  toJSON(): Record<string, unknown>;
}

/**
 * Authentication error interface.
 */
export interface AuthenticationError extends AdapterError {
  readonly name: 'AuthenticationError';
}

/**
 * Authorization error interface.
 */
export interface AuthorizationError extends AdapterError {
  readonly name: 'AuthorizationError';
}

/**
 * Rate limit error interface.
 */
export interface RateLimitError extends AdapterError {
  readonly name: 'RateLimitError';
  readonly retryAfter?: number;
  readonly limit?: number;
  readonly remaining?: number;
  readonly resetAt?: string;
}

/**
 * Validation error interface.
 */
export interface ValidationError extends AdapterError {
  readonly name: 'ValidationError';
  readonly validationDetails: ValidationErrorDetails[];
}

/**
 * Provider error interface.
 */
export interface ProviderError extends AdapterError {
  readonly name: 'ProviderError';
  readonly providerDetails?: ProviderErrorDetails;
  readonly httpContext?: HttpErrorContext;
}

/**
 * Adapter conversion error interface.
 */
export interface AdapterConversionError extends AdapterError {
  readonly name: 'AdapterConversionError';
}

/**
 * Network error interface.
 */
export interface NetworkError extends AdapterError {
  readonly name: 'NetworkError';
}

/**
 * Stream error interface.
 */
export interface StreamError extends AdapterError {
  readonly name: 'StreamError';
}

/**
 * Router error interface.
 */
export interface RouterError extends AdapterError {
  readonly name: 'RouterError';
  readonly attemptedBackends?: string[];
  /** The leaf failures this error is composed of, when the router had them. */
  readonly backendErrors?: readonly Error[];
}

/**
 * Middleware error interface.
 */
export interface MiddlewareError extends AdapterError {
  readonly name: 'MiddlewareError';
  readonly middlewareName?: string;
}
