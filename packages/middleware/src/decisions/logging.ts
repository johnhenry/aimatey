/**
 * Decision Logging Middleware
 *
 * Logs typed-decision calls: what was asked (question names), what came
 * back (per-question type, value and confidence), how long it took and what
 * it used. Shares the `Logger`, levels and sanitizer with
 * `createLoggingMiddleware`; the logged fields are decision-specific.
 *
 * `state` -- the ticket, email or invoice being judged -- is redacted by
 * default, and only question *names* are logged (never instructions or
 * criteria, which can embed business rules or the same sensitive text).
 *
 * @module
 */

import type { DecisionMiddleware, IRDecisionAnswer } from '@johnhenry/aimatey-types';
import { defaultLogger, sanitizeData, shouldLog, type LogLevel, type Logger } from '../logging.js';

/**
 * Configuration for decision logging middleware.
 */
export interface DecisionLoggingConfig {
  /**
   * Minimum log level.
   * @default 'info'
   */
  level?: LogLevel;

  /**
   * Whether to log the request (debug level).
   * @default true
   */
  logRequests?: boolean;

  /**
   * Whether to log the response (info level).
   * @default true
   */
  logResponses?: boolean;

  /**
   * Whether to log errors.
   * @default true
   */
  logErrors?: boolean;

  /**
   * Whether to log the request's `state` (debug level, passed through the
   * same key-based sanitizer as chat logging when `sanitize` is on).
   *
   * Off by default: `state` is usually the sensitive part of a decision
   * request, and the key-based sanitizer cannot recognise a secret inside a
   * free-text string.
   *
   * @default false
   */
  logState?: boolean;

  /**
   * Whether to sanitize sensitive keys (API keys, tokens) in logged state.
   * @default true
   */
  sanitize?: boolean;

  /**
   * Custom logger implementation.
   * @default console
   */
  logger?: Logger;

  /**
   * Custom log prefix.
   * @default '[Decision]'
   */
  prefix?: string;
}

/**
 * One answer reduced to the fields worth logging. `confidence` is omitted
 * when the provider did not report it (it is optional on the IR).
 */
function summarizeAnswer(answer: IRDecisionAnswer): {
  type: string;
  value: string | number;
  confidence?: number;
} {
  return {
    type: answer.type,
    value: answer.value,
    ...(answer.confidence !== undefined && { confidence: answer.confidence }),
  };
}

/**
 * Create decision logging middleware.
 *
 * @param config Logging configuration
 * @returns Decision middleware
 *
 * @example
 * ```typescript
 * bridge.useDecision(createDecisionLoggingMiddleware({ level: 'info' }));
 * // [Decision] Response req_1 { duration: '212ms', model: 'jev-1.13.0',
 * //   answers: { urgent: { type: 'noul', value: 0.93, confidence: 0.93 } }, ... }
 * ```
 */
export function createDecisionLoggingMiddleware(
  config: DecisionLoggingConfig = {}
): DecisionMiddleware {
  const {
    level = 'info',
    logRequests = true,
    logResponses = true,
    logErrors = true,
    logState = false,
    sanitize = true,
    logger = defaultLogger,
    prefix = '[Decision]',
  } = config;

  return async (request, next) => {
    const startTime = Date.now();
    const requestId = request.metadata.requestId;
    const questionNames = Object.keys(request.questions);

    if (logRequests && shouldLog(level, 'debug')) {
      logger.debug(`${prefix} Request ${requestId}`, {
        model: request.parameters?.model,
        questions: questionNames,
        images: request.images?.length ?? 0,
        frontend: request.metadata.provenance?.frontend,
        backend: request.metadata.provenance?.backend,
        ...(logState && { state: sanitize ? sanitizeData(request.state) : request.state }),
      });
    }

    try {
      const response = await next(request);
      const duration = Date.now() - startTime;

      if (logResponses && shouldLog(level, 'info')) {
        logger.info(`${prefix} Response ${requestId}`, {
          duration: `${duration}ms`,
          model: response.model,
          backend: response.metadata.provenance?.backend,
          provider: response.provider,
          questionCount: questionNames.length,
          answers: Object.fromEntries(
            Object.entries(response.answers).map(([name, answer]) => [
              name,
              summarizeAnswer(answer),
            ])
          ),
          usage: response.usage && {
            inputTokens: response.usage.inputTokens,
            ...(response.usage.outputTokens !== undefined && {
              outputTokens: response.usage.outputTokens,
            }),
            ...(response.usage.cost !== undefined && { cost: response.usage.cost }),
          },
        });
      }

      return response;
    } catch (error) {
      const duration = Date.now() - startTime;

      if (logErrors && shouldLog(level, 'error')) {
        logger.error(`${prefix} Error ${requestId}`, {
          duration: `${duration}ms`,
          questions: questionNames,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }

      throw error;
    }
  };
}
