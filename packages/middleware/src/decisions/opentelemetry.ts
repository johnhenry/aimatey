/**
 * Decision OpenTelemetry Middleware
 *
 * One span per typed-decision call, with per-question answer attributes.
 * Reuses the optional-peer loading, tracer-provider singleton and sampling
 * of `createOpenTelemetryMiddleware` (`acquireTracer`), so decision spans
 * and chat spans go to the same provider.
 *
 * `state` is never put on a span unless `logState` is set, and only question
 * *names* are recorded (never instructions or criteria).
 *
 * @module
 */

import type { DecisionMiddleware, IRDecisionResponse } from '@johnhenry/aimatey-types';
import { acquireTracer, shouldSample, type OpenTelemetryConfig } from '../opentelemetry.js';

/**
 * OpenTelemetry span attribute names for decision spans.
 *
 * Request/response attributes reuse the `ai.*` names of chat spans where the
 * meaning is the same.
 */
export const DecisionOpenTelemetryAttributes = {
  REQUEST_ID: 'ai.request.id',
  REQUEST_MODEL: 'ai.request.model',
  FRONTEND: 'ai.frontend',
  RESPONSE_BACKEND: 'ai.response.backend',
  RESPONSE_MODEL: 'ai.response.model',
  RESPONSE_PROVIDER: 'ai.response.provider',
  TOKENS_PROMPT: 'ai.tokens.prompt',
  TOKENS_COMPLETION: 'ai.tokens.completion',
  DURATION_MS: 'ai.duration.ms',

  // Decision-specific attributes
  QUESTION_COUNT: 'ai.decision.question_count',
  QUESTION_NAMES: 'ai.decision.questions',
  STATE: 'ai.decision.state',
  COST_USD: 'ai.decision.cost_usd',

  /**
   * Attribute name for one field of one answer, e.g.
   * `ai.decision.answer.urgent.confidence`.
   */
  answer: (question: string, field: 'type' | 'value' | 'confidence'): string =>
    `ai.decision.answer.${question}.${field}`,
} as const;

/**
 * Configuration for decision OpenTelemetry middleware: the chat
 * {@link OpenTelemetryConfig} plus `logState`.
 */
export interface DecisionOpenTelemetryConfig extends OpenTelemetryConfig {
  /**
   * Record the request's `state` (JSON) on the span as `ai.decision.state`.
   * Off by default: `state` is usually the sensitive part of the request.
   * @default false
   */
  logState?: boolean;
}

/** Set the per-answer attributes of a response on a span. */
function setAnswerAttributes(span: any, response: IRDecisionResponse): void {
  for (const [name, answer] of Object.entries(response.answers)) {
    span.setAttribute(DecisionOpenTelemetryAttributes.answer(name, 'type'), answer.type);
    span.setAttribute(DecisionOpenTelemetryAttributes.answer(name, 'value'), answer.value);
    if (answer.confidence !== undefined) {
      span.setAttribute(
        DecisionOpenTelemetryAttributes.answer(name, 'confidence'),
        answer.confidence
      );
    }
  }
}

/**
 * Create decision OpenTelemetry middleware.
 *
 * Requires the same optional OpenTelemetry packages as
 * {@link createOpenTelemetryMiddleware}; like it, the factory is async.
 *
 * @param config OpenTelemetry configuration
 * @returns Promise that resolves to decision middleware
 * @throws Error if OpenTelemetry packages are not installed
 *
 * @example
 * ```typescript
 * bridge.useDecision(await createDecisionOpenTelemetryMiddleware({ serviceName: 'triage' }));
 * ```
 */
export async function createDecisionOpenTelemetryMiddleware(
  config: DecisionOpenTelemetryConfig = {}
): Promise<DecisionMiddleware> {
  const { samplingRate = 1.0, logState = false } = config;
  const { tracer, api } = await acquireTracer(config);
  const K = DecisionOpenTelemetryAttributes;

  return async (request, next) => {
    if (!shouldSample(samplingRate)) {
      return next(request);
    }

    const questionNames = Object.keys(request.questions);
    const span = tracer.startSpan('aimatey-decision', {
      attributes: {
        [K.REQUEST_ID]: request.metadata.requestId,
        [K.REQUEST_MODEL]: request.parameters?.model ?? 'unknown',
        [K.FRONTEND]: request.metadata.provenance?.frontend ?? 'unknown',
        [K.QUESTION_COUNT]: questionNames.length,
        [K.QUESTION_NAMES]: questionNames,
        ...(logState && { [K.STATE]: JSON.stringify(request.state) }),
      },
    });

    const startTime = Date.now();

    try {
      const spanContext = api.trace.setSpan(api.context.active(), span);
      const response: IRDecisionResponse = await api.context.with(spanContext, async () => {
        return await next(request);
      });

      span.setAttribute(K.DURATION_MS, Date.now() - startTime);
      span.setAttribute(K.RESPONSE_BACKEND, response.metadata.provenance?.backend ?? 'unknown');
      span.setAttribute(K.RESPONSE_MODEL, response.model);
      if (response.provider !== undefined) {
        span.setAttribute(K.RESPONSE_PROVIDER, response.provider);
      }
      setAnswerAttributes(span, response);

      if (response.usage) {
        span.setAttribute(K.TOKENS_PROMPT, response.usage.inputTokens);
        if (response.usage.outputTokens !== undefined) {
          span.setAttribute(K.TOKENS_COMPLETION, response.usage.outputTokens);
        }
        if (response.usage.cost !== undefined) {
          span.setAttribute(K.COST_USD, response.usage.cost);
        }
      }

      span.setStatus({ code: api.SpanStatusCode.OK });
      span.end();

      return response;
    } catch (error) {
      // Never let span bookkeeping mask the original error.
      try {
        span.setAttribute(K.DURATION_MS, Date.now() - startTime);
        span.setAttribute('error', true);
        span.setAttribute('error.type', error instanceof Error ? error.name : 'unknown');

        if (error instanceof Error) {
          span.recordException(error);
          span.setStatus({ code: api.SpanStatusCode.ERROR, message: error.message });
        } else {
          span.setStatus({ code: api.SpanStatusCode.ERROR, message: String(error) });
        }

        span.end();
      } catch (spanError) {
        console.error('[OpenTelemetry] Failed to record error in span:', spanError);
        try {
          span.end();
        } catch {
          // Ignore - best effort to clean up
        }
      }

      throw error;
    }
  };
}
