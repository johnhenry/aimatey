/**
 * Retry Middleware
 *
 * Retries failed requests with exponential backoff.
 *
 * @module
 */

import type { Middleware, MiddlewareContext, MiddlewareNext } from '@johnhenry/aimatey-types';
import type { IRChatResponse, IRMetadata } from '@johnhenry/aimatey-types';
import { AdapterError } from '@johnhenry/aimatey-errors';

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for retry middleware.
 */
export interface RetryConfig {
  /**
   * Maximum number of retry attempts.
   * @default 3
   */
  maxAttempts?: number;

  /**
   * Initial delay before first retry (milliseconds).
   * @default 1000
   */
  initialDelay?: number;

  /**
   * Backoff multiplier for exponential backoff.
   * @default 2
   */
  backoffMultiplier?: number;

  /**
   * Maximum delay between retries (milliseconds).
   * @default 30000 (30 seconds)
   */
  maxDelay?: number;

  /**
   * Whether to add jitter to retry delays.
   * @default true
   */
  useJitter?: boolean;

  /**
   * Custom function to determine if error is retryable.
   * @default Check error.isRetryable property
   */
  shouldRetry?: (error: unknown, attempt: number) => boolean;

  /**
   * Callback invoked before each retry.
   */
  onRetry?: (error: unknown, attempt: number, delay: number) => void;
}

// ============================================================================
// Retry Logic
// ============================================================================

/**
 * Default retry condition.
 *
 * Only retry transient errors (network issues, rate limits, server errors).
 * Note: maxAttempts is enforced by the middleware loop, not this function.
 *
 * An error that carries no `isRetryable` is **not** retried, and `Bridge`'s own
 * `config.retries` loop now answers the same way (#70) - it used to retry an
 * unclassified error, so the same fault was transient or permanent depending on
 * which of the two retries a caller had configured. An unclassified throwable
 * is as likely a bug in the caller's own adapter or middleware as a transient
 * fault, and re-running it re-runs every middleware side effect for something
 * that cannot succeed. A backend that wants its failures retried should raise a
 * classified `AdapterError`.
 *
 * The flag is read duck-typed rather than through `instanceof AdapterError`: a
 * second copy of the errors package across the ESM/CJS boundary makes
 * `instanceof` quietly false, and losing retries to a packaging artifact is the
 * kind of silent failure this policy exists to prevent.
 *
 * @internal Shared with the decision retry middleware.
 */
export function defaultShouldRetry(error: unknown, _attempt: number): boolean {
  return (error as { isRetryable?: unknown } | undefined)?.isRetryable === true;
}

/**
 * Calculate retry delay with exponential backoff.
 */
function calculateDelay(
  attempt: number,
  initialDelay: number,
  backoffMultiplier: number,
  maxDelay: number,
  useJitter: boolean
): number {
  // Calculate exponential backoff
  let delay = initialDelay * Math.pow(backoffMultiplier, attempt);

  // Cap at max delay
  delay = Math.min(delay, maxDelay);

  // Add jitter if enabled (random value between 0 and delay)
  if (useJitter) {
    delay = Math.random() * delay;
  }

  return Math.floor(delay);
}

/**
 * Sleep for specified duration.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Middleware Factory
// ============================================================================

/**
 * Run `call` with the retry policy of {@link RetryConfig}.
 *
 * The request-type-agnostic core behind {@link createRetryMiddleware} and
 * `createDecisionRetryMiddleware`: backoff, jitter, the `shouldRetry` /
 * `onRetry` contract, abort handling and the `retryAttempts` /
 * `retrySuccess` annotation live here once. A response must carry
 * `IRMetadata` for the annotation, which every IR response does.
 *
 * @param call Invoked once per attempt
 * @param config Retry configuration
 * @param options.signal Stops the loop once aborted
 * @param options.rethrowAsIs Errors for which the final failure is thrown
 *   untouched, rather than re-wrapped with `retryAttempts` details (used to
 *   keep a `ValidationError` a `ValidationError`)
 *
 * @internal
 */
export async function runWithRetry<T extends { readonly metadata: IRMetadata }>(
  call: () => Promise<T>,
  config: RetryConfig,
  options: { signal?: AbortSignal; rethrowAsIs?: (error: unknown) => boolean } = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelay = 1000,
    backoffMultiplier = 2,
    maxDelay = 30000,
    useJitter = true,
    shouldRetry = defaultShouldRetry,
    onRetry,
  } = config;
  const { signal, rethrowAsIs } = options;

  let lastError: unknown;
  let attempt = 0;

  while (attempt < maxAttempts) {
    try {
      const response = await call();

      // Success - add retry metadata if we retried
      if (attempt > 0) {
        return {
          ...response,
          metadata: {
            ...response.metadata,
            custom: {
              ...response.metadata.custom,
              retryAttempts: attempt,
              retrySuccess: true,
            },
          },
        };
      }

      return response;
    } catch (error) {
      lastError = error;
      attempt++;

      // Check if we should retry
      const willRetry = attempt < maxAttempts && shouldRetry(error, attempt);

      if (!willRetry) {
        // No more retries - add metadata and throw
        if (error instanceof AdapterError && !rethrowAsIs?.(error)) {
          throw new AdapterError({
            ...error,
            details: {
              ...error.details,
              retryAttempts: attempt,
              retrySuccess: false,
            },
          });
        }

        throw error;
      }

      // Calculate retry delay
      const delay = calculateDelay(
        attempt - 1, // 0-indexed for delay calculation
        initialDelay,
        backoffMultiplier,
        maxDelay,
        useJitter
      );

      // Call retry callback if provided
      if (onRetry) {
        onRetry(error, attempt, delay);
      }

      // Check if request was aborted
      if (signal?.aborted) {
        throw error;
      }

      // Wait before retrying
      await sleep(delay);

      // Check again if request was aborted during sleep
      if (signal?.aborted) {
        throw error;
      }
    }
  }

  // Should never reach here, but just in case
  throw lastError;
}

/**
 * Create retry middleware.
 *
 * Retries failed requests with exponential backoff.
 *
 * @param config Retry configuration
 * @returns Retry middleware
 *
 * @example
 * ```typescript
 * const retry = createRetryMiddleware({
 *   maxAttempts: 3,
 *   initialDelay: 1000,
 *   backoffMultiplier: 2,
 *   maxDelay: 30000
 * });
 *
 * bridge.use(retry);
 * ```
 */
export function createRetryMiddleware(config: RetryConfig = {}): Middleware {
  return (context: MiddlewareContext, next: MiddlewareNext): Promise<IRChatResponse> =>
    runWithRetry(() => next(), config, { signal: context.signal });
}

// ============================================================================
// Retry Utilities
// ============================================================================

/**
 * Check if an error is a rate limit error.
 */
export function isRateLimitError(error: unknown): boolean {
  if (error instanceof AdapterError) {
    return error.code === 'RATE_LIMIT_EXCEEDED';
  }

  return false;
}

/**
 * Check if an error is a network error.
 */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof AdapterError) {
    return error.code === 'NETWORK_ERROR';
  }

  return false;
}

/**
 * Check if an error is a server error (5xx).
 */
export function isServerError(error: unknown): boolean {
  if (error instanceof AdapterError) {
    return error.code === 'PROVIDER_ERROR' || error.code === 'INTERNAL_ERROR';
  }

  return false;
}

/**
 * Create a retry predicate that only retries specific error types.
 * Note: maxAttempts is enforced by the middleware loop, not this function.
 */
export function createRetryPredicate(
  errorTypes: Array<'rate_limit' | 'network' | 'server'>
): (error: unknown, attempt: number) => boolean {
  return (error: unknown, _attempt: number): boolean => {
    for (const type of errorTypes) {
      switch (type) {
        case 'rate_limit':
          if (isRateLimitError(error)) {
            return true;
          }
          break;
        case 'network':
          if (isNetworkError(error)) {
            return true;
          }
          break;
        case 'server':
          if (isServerError(error)) {
            return true;
          }
          break;
      }
    }

    return false;
  };
}
