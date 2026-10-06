/**
 * Logging Middleware
 *
 * Logs requests, responses, and errors with configurable levels and sanitization.
 *
 * @module
 */

import type { Middleware, MiddlewareContext, MiddlewareNext } from '@johnhenry/aimatey-types';
import type { IRChatRequest, IRChatResponse } from '@johnhenry/aimatey-types';

// ============================================================================
// Types
// ============================================================================

/**
 * Log level.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Logger interface.
 */
export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

/**
 * Configuration for logging middleware.
 */
export interface LoggingConfig {
  /**
   * Minimum log level.
   * @default 'info'
   */
  level?: LogLevel;

  /**
   * Whether to log request bodies.
   * @default true
   */
  logRequests?: boolean;

  /**
   * Whether to log response bodies.
   * @default true
   */
  logResponses?: boolean;

  /**
   * Whether to log errors.
   * @default true
   */
  logErrors?: boolean;

  /**
   * Whether to sanitize sensitive data (API keys, tokens).
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
   */
  prefix?: string;
}

// ============================================================================
// Default Logger
// ============================================================================

/**
 * Default console logger.
 *
 * @internal Shared with the decision logging middleware.
 */
export const defaultLogger: Logger = {
  debug: (message: string, data?: unknown) => {
    // eslint-disable-next-line no-console
    console.debug(message, data !== undefined ? data : '');
  },
  info: (message: string, data?: unknown) => {
    // eslint-disable-next-line no-console
    console.info(message, data !== undefined ? data : '');
  },
  warn: (message: string, data?: unknown) => {
    console.warn(message, data !== undefined ? data : '');
  },
  error: (message: string, data?: unknown) => {
    console.error(message, data !== undefined ? data : '');
  },
};

// ============================================================================
// Sanitization
// ============================================================================

/**
 * Sanitize sensitive data from objects.
 *
 * @internal Shared with the decision logging middleware.
 */
export function sanitizeData(data: unknown): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(sanitizeData);
  }

  const sanitized: Record<string, unknown> = {};
  const sensitiveKeys = ['apiKey', 'api_key', 'authorization', 'token', 'secret', 'password'];

  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some((sensitive) => lowerKey.includes(sensitive))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeData(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Sanitize request for logging.
 */
function sanitizeRequest(request: IRChatRequest, shouldSanitize: boolean): unknown {
  if (!shouldSanitize) {
    return request;
  }

  return sanitizeData(request);
}

/**
 * Sanitize response for logging.
 */
function sanitizeResponse(response: IRChatResponse, shouldSanitize: boolean): unknown {
  if (!shouldSanitize) {
    return response;
  }

  return sanitizeData(response);
}

// ============================================================================
// Log Level Comparison
// ============================================================================

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** @internal Shared with the decision logging middleware. */
export function shouldLog(currentLevel: LogLevel, targetLevel: LogLevel): boolean {
  return LOG_LEVELS[targetLevel] >= LOG_LEVELS[currentLevel];
}

// ============================================================================
// Middleware Factory
// ============================================================================

/**
 * Create logging middleware.
 *
 * Logs requests, responses, and errors at configurable levels.
 *
 * @param config Logging configuration
 * @returns Logging middleware
 *
 * @example
 * ```typescript
 * const logging = createLoggingMiddleware({
 *   level: 'info',
 *   logRequests: true,
 *   logResponses: true,
 *   sanitize: true
 * });
 *
 * bridge.use(logging);
 * ```
 */
export function createLoggingMiddleware(config: LoggingConfig = {}): Middleware {
  const {
    level = 'info',
    logRequests = true,
    logResponses = true,
    logErrors = true,
    sanitize = true,
    logger = defaultLogger,
    prefix = '[Bridge]',
  } = config;

  return async (context: MiddlewareContext, next: MiddlewareNext): Promise<IRChatResponse> => {
    const startTime = Date.now();
    const requestId = context.request.metadata.requestId;

    // Log request
    if (logRequests && shouldLog(level, 'debug')) {
      logger.debug(`${prefix} Request ${requestId}`, {
        model: context.request.parameters?.model,
        messages: context.request.messages.length,
        stream: context.request.stream,
        frontend: context.request.metadata.provenance?.frontend,
        backend: context.request.metadata.provenance?.backend,
      });

      if (shouldLog(level, 'debug')) {
        logger.debug(`${prefix} Request details ${requestId}`, {
          request: sanitizeRequest(context.request, sanitize),
        });
      }
    }

    try {
      // Call next middleware/handler
      const response = await next();

      // Calculate duration
      const duration = Date.now() - startTime;

      // Log response
      if (logResponses && shouldLog(level, 'info')) {
        logger.info(`${prefix} Response ${requestId}`, {
          duration: `${duration}ms`,
          finishReason: response.finishReason,
          tokens: response.usage?.totalTokens,
          backend: response.metadata.provenance?.backend,
        });

        if (shouldLog(level, 'debug')) {
          logger.debug(`${prefix} Response details ${requestId}`, {
            response: sanitizeResponse(response, sanitize),
          });
        }
      }

      return response;
    } catch (error) {
      const duration = Date.now() - startTime;

      // Log error
      if (logErrors && shouldLog(level, 'error')) {
        logger.error(`${prefix} Error ${requestId}`, {
          duration: `${duration}ms`,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }

      // Re-throw error
      throw error;
    }
  };
}
