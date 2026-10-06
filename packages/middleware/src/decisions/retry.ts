/**
 * Decision Retry Middleware
 *
 * Retries failed decision calls with exponential backoff. A thin wrapper
 * over the same `runWithRetry` loop as `createRetryMiddleware`, so backoff,
 * jitter, the default retryability rule (`error.isRetryable === true`, which
 * is how network errors, 429s and 5xx are classified) and the `onRetry`
 * contract are identical; only the request type and the policy for
 * `ValidationError` differ.
 *
 * @module
 */

import type { DecisionMiddleware } from '@johnhenry/aimatey-types';
import { ValidationError } from '@johnhenry/aimatey-errors';
import { defaultShouldRetry, runWithRetry, type RetryConfig } from '../retry.js';

/**
 * Configuration for decision retry middleware. Identical to the chat
 * {@link RetryConfig}.
 */
export type DecisionRetryConfig = RetryConfig;

/**
 * Whether `error` is a `ValidationError`. Duck-typed on `name` as well as
 * `instanceof`, because a second copy of the errors package across the
 * ESM/CJS boundary makes `instanceof` quietly false.
 */
function isValidationError(error: unknown): boolean {
  return (
    error instanceof ValidationError ||
    (error as { name?: unknown } | null)?.name === 'ValidationError'
  );
}

/**
 * Read an abort signal off the request, if the caller attached one.
 *
 * Chat middleware gets `context.signal`; a `DecisionMiddleware` receives only
 * the request, and `Bridge.decide()` keeps `options.signal` to itself (it is
 * handed to the backend). A caller who wants the retry loop itself to stop
 * early passes the signal as `metadata.custom.signal`.
 */
function requestSignal(custom: Record<string, unknown> | undefined): AbortSignal | undefined {
  const signal = custom?.['signal'];
  return typeof (signal as AbortSignal | undefined)?.aborted === 'boolean'
    ? (signal as AbortSignal)
    : undefined;
}

/**
 * Create decision retry middleware.
 *
 * Never retries a `ValidationError` -- the same request fails the same way --
 * whatever `shouldRetry` says, and rethrows it unwrapped.
 *
 * @param config Retry configuration
 * @returns Decision middleware
 *
 * @example
 * ```typescript
 * bridge.useDecision(createDecisionRetryMiddleware({ maxAttempts: 3, initialDelay: 500 }));
 * ```
 */
export function createDecisionRetryMiddleware(
  config: DecisionRetryConfig = {}
): DecisionMiddleware {
  const shouldRetry = config.shouldRetry ?? defaultShouldRetry;

  const guarded: RetryConfig = {
    ...config,
    shouldRetry: (error, attempt) => !isValidationError(error) && shouldRetry(error, attempt),
  };

  return (request, next) =>
    runWithRetry(() => next(request), guarded, {
      signal: requestSignal(request.metadata.custom),
      rethrowAsIs: isValidationError,
    });
}
