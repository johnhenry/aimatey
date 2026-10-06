/**
 * Decision middleware tests (#146).
 *
 * Covers the five `createDecision*Middleware` factories in
 * `@johnhenry/aimatey-middleware` -- caching, cost tracking, retry,
 * logging/OpenTelemetry and validation -- individually, then composed on one
 * `Bridge` over `createMockDecisionBackend` so the ordering effects are
 * asserted rather than assumed.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { createMockDecisionBackend } from '@johnhenry/aimatey-testing';
import { NetworkError, ProviderError, ValidationError } from '@johnhenry/aimatey-errors';
import {
  InMemoryCacheStorage,
  InMemoryCostStorage,
  createDecisionCachingMiddleware,
  createDecisionCostTrackingMiddleware,
  createDecisionLoggingMiddleware,
  createDecisionOpenTelemetryMiddleware,
  createDecisionRetryMiddleware,
  createDecisionValidationMiddleware,
  createRetryMiddleware,
  DecisionOpenTelemetryAttributes,
  shutdownOpenTelemetry,
  type CostCalculation,
  type Logger,
} from '@johnhenry/aimatey-middleware';
import type {
  IRDecisionAnswer,
  IRDecisionQuestion,
  IRDecisionRequest,
  IRDecisionResponse,
  IRWarning,
} from '@johnhenry/aimatey-types';

// ============================================================================
// Helpers
// ============================================================================

const questions: Record<string, IRDecisionQuestion> = {
  urgent: { type: 'noul', instructions: 'Is this urgent?' },
  team: {
    type: 'choice',
    instructions: 'Which team?',
    criteria: { billing: 'invoices', technical: 'bugs' },
  },
};

const answers: Record<string, IRDecisionAnswer> = {
  urgent: { type: 'noul', value: 0.9, confidence: 0.9 },
  team: {
    type: 'choice',
    value: 'billing',
    probabilities: { billing: 0.8, technical: 0.2 },
    confidence: 0.8,
  },
};

function makeRequest(overrides: Partial<IRDecisionRequest> = {}): IRDecisionRequest {
  return {
    state: { subject: 'Double charge', body: 'Refund me' },
    questions,
    parameters: { model: 'jev-1.13.0' },
    metadata: { requestId: 'req-1', timestamp: 1000, principal: 'user-1' },
    ...overrides,
  };
}

function makeResponse(overrides: Partial<IRDecisionResponse> = {}): IRDecisionResponse {
  return {
    answers,
    model: 'jev-1.13.0',
    usage: { inputTokens: 1_000_000 },
    metadata: { requestId: 'req-1', timestamp: 2000, provenance: { backend: 'mock' } },
    ...overrides,
  };
}

/** A terminal `next` that counts its calls. */
function terminal(response: IRDecisionResponse = makeResponse()) {
  const next = vi.fn(async (_request: IRDecisionRequest) => response);
  return next;
}

function captureLogger(): Logger & { calls: Array<[string, string, unknown]> } {
  const calls: Array<[string, string, unknown]> = [];
  const log = (level: string) => (message: string, data?: unknown) => {
    calls.push([level, message, data]);
  };
  return {
    calls,
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
}

// ============================================================================
// Caching
// ============================================================================

describe('createDecisionCachingMiddleware', () => {
  it('serves an identical request from cache with a fresh requestId/timestamp and cacheHit marker', async () => {
    const mw = createDecisionCachingMiddleware();
    const next = terminal();

    const first = await mw(makeRequest(), next);
    expect(first.metadata.custom?.cacheHit).toBe(false);

    const second = await mw(
      makeRequest({ metadata: { requestId: 'req-2', timestamp: 5000, principal: 'user-1' } }),
      next
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(second.answers).toEqual(first.answers);
    expect(second.metadata.custom?.cacheHit).toBe(true);
    expect(second.metadata.requestId).toBe('req-2');
    expect(second.metadata.timestamp).toBeGreaterThan(2000);
  });

  it('bypasses (with a cache-bypassed warning) when the request has no principal', async () => {
    const mw = createDecisionCachingMiddleware();
    const next = terminal();
    const request = makeRequest({ metadata: { requestId: 'r', timestamp: 1 } });

    const first = await mw(request, next);
    await mw(request, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(first.metadata.warnings?.some((w) => w.category === 'cache-bypassed')).toBe(true);
    expect(first.metadata.custom?.cacheBypassed).toBe(true);
  });

  it("shares one bucket for unidentified requests with unidentified: 'share'", async () => {
    const mw = createDecisionCachingMiddleware({ unidentified: 'share' });
    const next = terminal();
    const request = makeRequest({ metadata: { requestId: 'r', timestamp: 1 } });

    await mw(request, next);
    const second = await mw(request, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(second.metadata.custom?.cacheHit).toBe(true);
  });

  it('scopes entries per principal and honours scopeKey over principal', async () => {
    const mw = createDecisionCachingMiddleware();
    const next = terminal();

    await mw(makeRequest(), next);
    await mw(
      makeRequest({ metadata: { requestId: 'r', timestamp: 1, principal: 'user-2' } }),
      next
    );
    expect(next).toHaveBeenCalledTimes(2);

    const scoped = createDecisionCachingMiddleware({ scopeKey: 'tenant' });
    const next2 = terminal();
    await scoped(makeRequest(), next2);
    await scoped(
      makeRequest({ metadata: { requestId: 'r', timestamp: 1, principal: 'someone-else' } }),
      next2
    );
    expect(next2).toHaveBeenCalledTimes(1);
  });

  it('keys on state, questions, images, model and parameters.custom', async () => {
    const mw = createDecisionCachingMiddleware();
    const next = terminal();
    const image = (data: string) =>
      ({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data } }) as const;

    await mw(makeRequest(), next); // 1
    await mw(makeRequest({ state: 'different' }), next); // 2
    await mw(
      makeRequest({
        questions: { urgent: { type: 'noul', instructions: 'Is it really urgent?' } },
      }),
      next
    ); // 3
    await mw(makeRequest({ images: [image('AAAA')] }), next); // 4
    await mw(makeRequest({ images: [image('BBBB')] }), next); // 5
    await mw(makeRequest({ parameters: { model: 'clef' } }), next); // 6
    await mw(makeRequest({ parameters: { model: 'jev-1.13.0', custom: { trace: true } } }), next); // 7
    expect(next).toHaveBeenCalledTimes(7);

    // identical to #4 -> hit
    await mw(makeRequest({ images: [image('AAAA')] }), next);
    expect(next).toHaveBeenCalledTimes(7);
  });

  it('is insensitive to object key order in state and parameters.custom', async () => {
    const mw = createDecisionCachingMiddleware();
    const next = terminal();

    await mw(
      makeRequest({ state: { a: 1, b: { c: 2, d: 3 } }, parameters: { custom: { x: 1, y: 2 } } }),
      next
    );
    await mw(
      makeRequest({ state: { b: { d: 3, c: 2 }, a: 1 }, parameters: { custom: { y: 2, x: 1 } } }),
      next
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not key on metadata (requestId, timestamp)', async () => {
    const mw = createDecisionCachingMiddleware();
    const next = terminal();
    await mw(makeRequest(), next);
    await mw(
      makeRequest({ metadata: { requestId: 'zzz', timestamp: 9, principal: 'user-1' } }),
      next
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('expires entries after the TTL', async () => {
    vi.useFakeTimers();
    try {
      const mw = createDecisionCachingMiddleware({ ttl: 1000 });
      const next = terminal();
      await mw(makeRequest(), next);
      vi.advanceTimersByTime(1500);
      await mw(makeRequest(), next);
      expect(next).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  const warning = (category: string): IRWarning =>
    ({ category, severity: 'warning', message: 'w' }) as IRWarning;

  it.each(['response-malformed', 'capability-emulated', 'capability-unsupported'])(
    'never caches a response carrying a %s warning',
    async (category) => {
      const mw = createDecisionCachingMiddleware();
      const next = terminal(
        makeResponse({ metadata: { requestId: 'r', timestamp: 1, warnings: [warning(category)] } })
      );
      await mw(makeRequest(), next);
      await mw(makeRequest(), next);
      expect(next).toHaveBeenCalledTimes(2);
    }
  );

  it('caches responses with other warnings, and the uncacheable list is configurable', async () => {
    const other = terminal(
      makeResponse({
        metadata: { requestId: 'r', timestamp: 1, warnings: [warning('parameter-normalized')] },
      })
    );
    const mw = createDecisionCachingMiddleware();
    await mw(makeRequest(), other);
    await mw(makeRequest(), other);
    expect(other).toHaveBeenCalledTimes(1);

    const custom = createDecisionCachingMiddleware({
      uncacheableWarnings: ['parameter-normalized'],
    });
    const next = terminal(
      makeResponse({
        metadata: { requestId: 'r', timestamp: 1, warnings: [warning('parameter-normalized')] },
      })
    );
    await custom(makeRequest(), next);
    await custom(makeRequest(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('supports a custom storage and keyGenerator', async () => {
    const storage = new InMemoryCacheStorage<IRDecisionResponse>(10);
    const mw = createDecisionCachingMiddleware({ storage, keyGenerator: () => 'fixed' });
    const next = terminal();
    await mw(makeRequest({ metadata: { requestId: 'a', timestamp: 1 } }), next);
    expect(await storage.has('fixed')).toBe(true);
    await mw(makeRequest({ state: 'other', metadata: { requestId: 'b', timestamp: 1 } }), next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Cost tracking
// ============================================================================

describe('createDecisionCostTrackingMiddleware', () => {
  it('prices inputTokens with the registry rate for response.model (jev)', async () => {
    const costs: CostCalculation[] = [];
    const mw = createDecisionCostTrackingMiddleware({ onCost: (c) => void costs.push(c) });
    await mw(makeRequest(), terminal(makeResponse({ usage: { inputTokens: 2_000_000 } })));

    expect(costs).toHaveLength(1);
    expect(costs[0]!.totalCost).toBeCloseTo(0.084, 9); // 2M * $0.042/1M
    expect(costs[0]!.model).toBe('jev-1.13.0');
    expect(costs[0]!.inputTokens).toBe(2_000_000);
    expect(costs[0]!.requestId).toBe('req-1');
  });

  it('prices clef at its own registry rate', async () => {
    const costs: CostCalculation[] = [];
    const mw = createDecisionCostTrackingMiddleware({ onCost: (c) => void costs.push(c) });
    await mw(
      makeRequest(),
      terminal(makeResponse({ model: 'clef', usage: { inputTokens: 500_000 } }))
    );
    expect(costs[0]!.totalCost).toBeCloseTo(0.12, 9); // 0.5M * $0.24/1M
  });

  it('prefers usage.cost over registry pricing', async () => {
    const costs: CostCalculation[] = [];
    const mw = createDecisionCostTrackingMiddleware({ onCost: (c) => void costs.push(c) });
    await mw(
      makeRequest(),
      terminal(makeResponse({ usage: { inputTokens: 2_000_000, cost: 0.5 } }))
    );
    expect(costs[0]!.totalCost).toBe(0.5);
    expect(costs[0]!.metadata?.costSource).toBe('provider');
  });

  it('falls back to request.parameters.model when response.model is not priced', async () => {
    const costs: CostCalculation[] = [];
    const mw = createDecisionCostTrackingMiddleware({ onCost: (c) => void costs.push(c) });
    await mw(
      makeRequest({ parameters: { model: 'clef' } }),
      terminal(makeResponse({ model: 'edge-build-7', usage: { inputTokens: 1_000_000 } }))
    );
    expect(costs[0]!.totalCost).toBeCloseTo(0.24, 9);
  });

  it('records 0 and logs a warning when no price can be found', async () => {
    const logger = captureLogger();
    const costs: CostCalculation[] = [];
    const mw = createDecisionCostTrackingMiddleware({
      logger,
      onCost: (c) => void costs.push(c),
    });
    await mw(
      makeRequest({ parameters: { model: 'mystery' } }),
      terminal(makeResponse({ model: 'mystery', usage: { inputTokens: 123 } }))
    );
    expect(costs[0]!.totalCost).toBe(0);
    expect(costs[0]!.metadata?.costSource).toBe('none');
    expect(logger.calls.some(([level, msg]) => level === 'warn' && /mystery/.test(msg))).toBe(true);
  });

  it('honours user-supplied model pricing, including output tokens', async () => {
    const costs: CostCalculation[] = [];
    const mw = createDecisionCostTrackingMiddleware({
      models: [{ model: 'mystery', pricing: { inputCostPer1M: 1, outputCostPer1M: 4 } }],
      onCost: (c) => void costs.push(c),
    });
    await mw(
      makeRequest(),
      terminal(
        makeResponse({ model: 'mystery', usage: { inputTokens: 1_000_000, outputTokens: 500_000 } })
      )
    );
    expect(costs[0]!.totalCost).toBeCloseTo(3, 9);
    expect(costs[0]!.outputTokens).toBe(500_000);
  });

  it('does nothing when the response reports no usage', async () => {
    const onCost = vi.fn();
    const mw = createDecisionCostTrackingMiddleware({ onCost });
    const response = makeResponse({ usage: undefined });
    expect(await mw(makeRequest(), terminal(response))).toBe(response);
    expect(onCost).not.toHaveBeenCalled();
  });

  it('keeps a ledger, fires thresholds, and can attach the cost to the response', async () => {
    const storage = new InMemoryCostStorage();
    const onThresholdExceeded = vi.fn();
    const mw = createDecisionCostTrackingMiddleware({
      storage,
      requestThreshold: 0.01,
      onThresholdExceeded,
      includeInMetadata: true,
    });
    const response = await mw(
      makeRequest(),
      terminal(makeResponse({ usage: { inputTokens: 1_000_000 } }))
    );
    await mw(makeRequest(), terminal(makeResponse({ usage: { inputTokens: 1_000_000 } })));

    expect(await storage.getTotal()).toBeCloseTo(0.084, 9);
    expect((await storage.getByModel()).get('jev-1.13.0')).toBeCloseTo(0.084, 9);
    expect(onThresholdExceeded).toHaveBeenCalledTimes(2);
    expect((response.metadata.custom?.cost as CostCalculation).totalCost).toBeCloseTo(0.042, 9);
  });

  it('records the principal on the cost record', async () => {
    const costs: CostCalculation[] = [];
    const mw = createDecisionCostTrackingMiddleware({ onCost: (c) => void costs.push(c) });
    await mw(makeRequest(), terminal());
    expect(costs[0]!.metadata?.principal).toBe('user-1');
  });
});

// ============================================================================
// Retry
// ============================================================================

describe('createDecisionRetryMiddleware', () => {
  const fast = { initialDelay: 1, useJitter: false, maxDelay: 2 };
  const retryable = () => new NetworkError({ message: 'socket hang up' });

  it('retries a retryable failure and annotates the recovered response', async () => {
    const mw = createDecisionRetryMiddleware({ ...fast, maxAttempts: 3 });
    const next = vi
      .fn<(r: IRDecisionRequest) => Promise<IRDecisionResponse>>()
      .mockRejectedValueOnce(retryable())
      .mockResolvedValue(makeResponse());

    const response = await mw(makeRequest(), next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(response.metadata.custom).toMatchObject({ retryAttempts: 1, retrySuccess: true });
  });

  it('retries a 429 and a 5xx classified error', async () => {
    const mw = createDecisionRetryMiddleware({ ...fast });
    const next = vi
      .fn<(r: IRDecisionRequest) => Promise<IRDecisionResponse>>()
      .mockRejectedValueOnce(
        new ProviderError({
          message: 'overloaded',
          isRetryable: true,
          providerDetails: {},
        } as never)
      )
      .mockResolvedValue(makeResponse());
    await mw(makeRequest(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxAttempts', async () => {
    const mw = createDecisionRetryMiddleware({ ...fast, maxAttempts: 2 });
    const next = vi.fn(async () => {
      throw retryable();
    });
    await expect(mw(makeRequest(), next)).rejects.toMatchObject({
      details: { retryAttempts: 2, retrySuccess: false },
    });
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('does not retry an unclassified error', async () => {
    const mw = createDecisionRetryMiddleware({ ...fast });
    const next = vi.fn(async () => {
      throw new Error('bug');
    });
    await expect(mw(makeRequest(), next)).rejects.toThrow('bug');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('never retries a ValidationError, even when shouldRetry says yes, and rethrows it as-is', async () => {
    const mw = createDecisionRetryMiddleware({ ...fast, shouldRetry: () => true });
    const error = new ValidationError({
      code: 'INVALID_REQUEST' as never,
      message: 'bad',
      validationDetails: [{ field: 'f', value: 1, reason: 'r' }],
    });
    const next = vi.fn(async () => {
      throw error;
    });
    await expect(mw(makeRequest(), next)).rejects.toBe(error);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('stops retrying when a signal on the request metadata is aborted', async () => {
    const controller = new AbortController();
    const mw = createDecisionRetryMiddleware({
      ...fast,
      onRetry: () => controller.abort(),
    });
    const next = vi.fn(async () => {
      throw retryable();
    });
    const request = makeRequest({
      metadata: { requestId: 'r', timestamp: 1, custom: { signal: controller.signal } },
    });
    await expect(mw(request, next)).rejects.toThrow('socket hang up');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('shares its loop with the chat retry middleware (same defaults, same onRetry contract)', async () => {
    const onRetryChat = vi.fn();
    const onRetryDecision = vi.fn();
    const chat = createRetryMiddleware({ ...fast, onRetry: onRetryChat });
    const decision = createDecisionRetryMiddleware({ ...fast, onRetry: onRetryDecision });

    let chatCalls = 0;
    await chat({ request: {} as never, state: {} } as never, async () => {
      if (chatCalls++ === 0) {
        throw retryable();
      }
      return { metadata: {} } as never;
    });
    let decisionCalls = 0;
    await decision(makeRequest(), async () => {
      if (decisionCalls++ === 0) {
        throw retryable();
      }
      return makeResponse();
    });

    expect(onRetryChat.mock.calls[0]!.slice(1)).toEqual(onRetryDecision.mock.calls[0]!.slice(1));
  });
});

// ============================================================================
// Logging
// ============================================================================

describe('createDecisionLoggingMiddleware', () => {
  it('logs per-question type/value/confidence, latency, model, backend and usage', async () => {
    const logger = captureLogger();
    const mw = createDecisionLoggingMiddleware({ logger, level: 'info' });
    await mw(makeRequest(), terminal(makeResponse({ usage: { inputTokens: 42, cost: 0.1 } })));

    const entry = logger.calls.find(
      ([level, msg]) => level === 'info' && /Response req-1/.test(msg)
    );
    expect(entry).toBeDefined();
    const data = entry![2] as Record<string, any>;
    expect(data.model).toBe('jev-1.13.0');
    expect(data.backend).toBe('mock');
    expect(data.questionCount).toBe(2);
    expect(data.answers.urgent).toEqual({ type: 'noul', value: 0.9, confidence: 0.9 });
    expect(data.answers.team).toEqual({ type: 'choice', value: 'billing', confidence: 0.8 });
    expect(data.usage).toEqual({ inputTokens: 42, cost: 0.1 });
    expect(typeof data.duration).toBe('string');
  });

  it('redacts state by default and logs question names only', async () => {
    const logger = captureLogger();
    const mw = createDecisionLoggingMiddleware({ logger, level: 'debug' });
    await mw(makeRequest({ state: 'my secret ssn 123-45-6789' }), terminal());

    const serialized = JSON.stringify(logger.calls);
    expect(serialized).not.toContain('123-45-6789');
    expect(serialized).not.toContain('Which team?'); // instructions are not logged
    expect(serialized).not.toContain('invoices'); // criteria are not logged

    const request = logger.calls.find(([, msg]) => /Request req-1/.test(msg));
    expect((request![2] as Record<string, unknown>).questions).toEqual(['urgent', 'team']);
  });

  it('logs the (sanitized) state when logState is true', async () => {
    const logger = captureLogger();
    const mw = createDecisionLoggingMiddleware({ logger, level: 'debug', logState: true });
    await mw(makeRequest({ state: { note: 'hello', token: 'sk-live-1' } }), terminal());

    const serialized = JSON.stringify(logger.calls);
    expect(serialized).toContain('hello');
    expect(serialized).not.toContain('sk-live-1');
  });

  it('logs errors and rethrows', async () => {
    const logger = captureLogger();
    const mw = createDecisionLoggingMiddleware({ logger });
    const next = vi.fn(async () => {
      throw new Error('backend down');
    });
    await expect(mw(makeRequest(), next)).rejects.toThrow('backend down');
    expect(logger.calls.some(([level, msg]) => level === 'error' && /Error req-1/.test(msg))).toBe(
      true
    );
  });

  it('respects the minimum level', async () => {
    const logger = captureLogger();
    const mw = createDecisionLoggingMiddleware({ logger, level: 'error' });
    await mw(makeRequest(), terminal());
    expect(logger.calls).toEqual([]);
  });
});

// ============================================================================
// OpenTelemetry
// ============================================================================

describe('createDecisionOpenTelemetryMiddleware', () => {
  let exporter: InMemorySpanExporter;
  let mw: Awaited<ReturnType<typeof createDecisionOpenTelemetryMiddleware>>;

  beforeAll(async () => {
    await shutdownOpenTelemetry();
    mw = await createDecisionOpenTelemetryMiddleware({ exportSpans: false, samplingRate: 1 });
    const proxy = trace.getTracerProvider() as unknown as { getDelegate?: () => unknown };
    const delegate = (typeof proxy.getDelegate === 'function' ? proxy.getDelegate() : proxy) as {
      addSpanProcessor: (p: SimpleSpanProcessor) => void;
    };
    exporter = new InMemorySpanExporter();
    delegate.addSpanProcessor(new SimpleSpanProcessor(exporter));
  });

  beforeEach(() => exporter.reset());

  it('emits one span per decide with per-question answer attributes', async () => {
    await mw(
      makeRequest(),
      terminal(makeResponse({ usage: { inputTokens: 42, outputTokens: 1, cost: 0.1 } }))
    );

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const a = spans[0]!.attributes;
    const K = DecisionOpenTelemetryAttributes;
    expect(spans[0]!.name).toBe('aimatey-decision');
    expect(a[K.REQUEST_MODEL]).toBe('jev-1.13.0');
    expect(a[K.QUESTION_COUNT]).toBe(2);
    expect(a[K.QUESTION_NAMES]).toEqual(['urgent', 'team']);
    expect(a[K.RESPONSE_BACKEND]).toBe('mock');
    expect(a[K.RESPONSE_MODEL]).toBe('jev-1.13.0');
    expect(a[K.answer('urgent', 'type')]).toBe('noul');
    expect(a[K.answer('urgent', 'value')]).toBe(0.9);
    expect(a[K.answer('urgent', 'confidence')]).toBe(0.9);
    expect(a[K.answer('team', 'type')]).toBe('choice');
    expect(a[K.answer('team', 'value')]).toBe('billing');
    expect(a[K.answer('team', 'confidence')]).toBe(0.8);
    expect(a[K.TOKENS_PROMPT]).toBe(42);
    expect(a[K.COST_USD]).toBe(0.1);
    expect(typeof a[K.DURATION_MS]).toBe('number');
  });

  it('omits confidence when the provider did not report it, and never records state', async () => {
    const response = makeResponse({
      answers: { urgent: { type: 'noul', value: 0.2 }, team: answers.team! },
    });
    await mw(makeRequest({ state: 'SECRET-STATE' }), terminal(response));

    const attrs = exporter.getFinishedSpans()[0]!.attributes;
    expect(DecisionOpenTelemetryAttributes.answer('urgent', 'confidence') in attrs).toBe(false);
    expect(JSON.stringify(attrs)).not.toContain('SECRET-STATE');
  });

  it('records the error and rethrows', async () => {
    const next = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(mw(makeRequest(), next)).rejects.toThrow('boom');
    const span = exporter.getFinishedSpans()[0]!;
    expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span.attributes['error']).toBe(true);
  });
});

// ============================================================================
// Validation
// ============================================================================

describe('createDecisionValidationMiddleware', () => {
  const run = (request: IRDecisionRequest, config = {}, response = makeResponse()) =>
    createDecisionValidationMiddleware(config)(request, terminal(response));

  const detailsOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      return (error as ValidationError).validationDetails.map((d) => d.field);
    }
    throw new Error('expected a ValidationError');
  };

  it('passes a well-formed request and response through', async () => {
    const response = await run(makeRequest());
    expect(response.answers).toEqual(answers);
  });

  it('rejects empty questions without calling the backend', async () => {
    const next = terminal();
    const mw = createDecisionValidationMiddleware();
    await expect(mw(makeRequest({ questions: {} }), next)).rejects.toBeInstanceOf(ValidationError);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a question with no type or no instructions', async () => {
    const fields = await detailsOf(
      run(
        makeRequest({
          questions: {
            a: { instructions: 'x' } as never,
            b: { type: 'noul', instructions: '  ' },
            c: { type: 'bogus', instructions: 'x' } as never,
          },
        })
      )
    );
    expect(fields).toEqual(
      expect.arrayContaining(['questions.a.type', 'questions.b.instructions', 'questions.c.type'])
    );
  });

  it('requires at least 2 choice criteria and non-empty keys', async () => {
    const one = await detailsOf(
      run(
        makeRequest({
          questions: { q: { type: 'choice', instructions: 'x', criteria: { a: 'a' } } },
        })
      )
    );
    expect(one).toEqual(['questions.q.criteria']);

    const empty = await detailsOf(
      run(
        makeRequest({
          questions: {
            q: { type: 'choice', instructions: 'x', criteria: { a: 'a', '': 'blank' } },
          },
        })
      )
    );
    expect(empty).toEqual(['questions.q.criteria']);
  });

  it('requires at least 2 score levels, unique and non-empty', async () => {
    const one = await detailsOf(
      run(
        makeRequest({ questions: { q: { type: 'score', instructions: 'x', criteria: ['low'] } } })
      )
    );
    expect(one).toEqual(['questions.q.criteria']);

    const dup = await detailsOf(
      run(
        makeRequest({
          questions: { q: { type: 'score', instructions: 'x', criteria: ['low', 'low'] } },
        })
      )
    );
    expect(dup).toEqual(['questions.q.criteria']);

    const blank = await detailsOf(
      run(
        makeRequest({
          questions: { q: { type: 'score', instructions: 'x', criteria: ['low', ''] } },
        })
      )
    );
    expect(blank).toEqual(['questions.q.criteria']);
  });

  it('checks noul criteria labels when given', async () => {
    const fields = await detailsOf(
      run(
        makeRequest({
          questions: {
            q: { type: 'noul', instructions: 'x', criteria: { true: '', false: 'no' } },
          },
        })
      )
    );
    expect(fields).toEqual(['questions.q.criteria']);
  });

  it('enforces maxStateBytes in UTF-8 bytes', async () => {
    const mw = createDecisionValidationMiddleware({ maxStateBytes: 10 });
    await expect(mw(makeRequest({ state: 'x'.repeat(11) }), terminal())).rejects.toBeInstanceOf(
      ValidationError
    );
    await expect(mw(makeRequest({ state: '€€€€' }), terminal())).rejects.toBeInstanceOf(
      ValidationError
    ); // 12 bytes
    await expect(mw(makeRequest({ state: { a: 'b' } }), terminal())).resolves.toBeDefined(); // 9 bytes of JSON
  });

  it('merges response-validation warnings into metadata.warnings', async () => {
    const bad = makeResponse({
      answers: {
        urgent: answers.urgent!,
        team: { type: 'choice', value: 'billing', probabilities: { billing: 0.3, technical: 0.3 } },
      },
      metadata: {
        requestId: 'r',
        timestamp: 1,
        warnings: [{ category: 'parameter-normalized', severity: 'info', message: 'kept' }],
      },
    });
    const response = await run(makeRequest(), {}, bad);
    const categories = response.metadata.warnings!.map((w) => w.category);
    expect(categories).toEqual(['parameter-normalized', 'response-malformed']);
  });

  it('always throws on a hard response failure', async () => {
    const bad = makeResponse({ answers: { urgent: answers.urgent! } }); // 'team' unanswered
    await expect(run(makeRequest(), {}, bad)).rejects.toBeInstanceOf(ValidationError);
  });

  it('strict mode turns soft warnings into a ValidationError', async () => {
    const soft = makeResponse({
      answers: {
        urgent: answers.urgent!,
        team: { type: 'choice', value: 'billing', probabilities: { billing: 0.3, technical: 0.3 } },
      },
    });
    await expect(run(makeRequest(), { strict: true }, soft)).rejects.toBeInstanceOf(
      ValidationError
    );
    await expect(run(makeRequest(), { strict: false }, soft)).resolves.toBeDefined();
  });

  it('can skip response validation', async () => {
    const bad = makeResponse({ answers: {} });
    await expect(run(makeRequest(), { validateResponse: false }, bad)).resolves.toBe(bad);
  });
});

// ============================================================================
// Composition on one Bridge
// ============================================================================

describe('decision middleware composed on one Bridge', () => {
  const ask = (bridge: Bridge<any, any>, principal = 'user-1', state: unknown = 'refund me') =>
    bridge.decide(state, questions, { principal, model: 'jev-1.13.0' });

  function build(options: {
    handler?: (request: IRDecisionRequest) => IRDecisionResponse | Promise<IRDecisionResponse>;
    strict?: boolean;
  }) {
    const backend = createMockDecisionBackend({
      name: 'mock',
      handler:
        options.handler ?? ((request) => makeResponse({ metadata: { ...request.metadata } })),
    });
    const bridge = new Bridge(new OpenAIFrontendAdapter(), backend);
    const logger = captureLogger();
    const costs: CostCalculation[] = [];

    // Outermost first: cache -> log -> validate -> retry -> cost -> backend.
    bridge.useDecision(createDecisionCachingMiddleware());
    bridge.useDecision(createDecisionLoggingMiddleware({ logger }));
    bridge.useDecision(createDecisionValidationMiddleware({ strict: options.strict }));
    bridge.useDecision(
      createDecisionRetryMiddleware({ initialDelay: 1, useJitter: false, maxDelay: 2 })
    );
    bridge.useDecision(createDecisionCostTrackingMiddleware({ onCost: (c) => void costs.push(c) }));

    return { bridge, backend, logger, costs };
  }

  it('a cache hit skips validation, retry, cost and the backend entirely', async () => {
    const { bridge, backend, costs, logger } = build({});

    const first = await ask(bridge);
    const second = await ask(bridge);

    expect(backend.calls).toHaveLength(1);
    expect(costs).toHaveLength(1);
    expect(first.metadata.custom?.cacheHit).toBe(false);
    expect(second.metadata.custom?.cacheHit).toBe(true);
    // Logging sits inside the cache here, so it saw only the miss.
    expect(logger.calls.filter(([, m]) => /Response/.test(m))).toHaveLength(1);
  });

  it('retry recovers after one failure and cost is recorded once, for the successful call only', async () => {
    let calls = 0;
    const { bridge, backend, costs } = build({
      handler: (request) => {
        if (calls++ === 0) {
          throw new NetworkError({ message: 'blip' });
        }
        return makeResponse({
          usage: { inputTokens: 1_000_000 },
          metadata: { ...request.metadata },
        });
      },
    });

    const response = await ask(bridge);

    expect(backend.calls).toHaveLength(2);
    expect(response.metadata.custom).toMatchObject({ retryAttempts: 1, retrySuccess: true });
    expect(costs).toHaveLength(1);
    expect(costs[0]!.totalCost).toBeCloseTo(0.042, 9);
  });

  it('cost ledger totals across distinct (uncached) requests and principals', async () => {
    const { bridge, costs } = build({
      handler: (request) =>
        makeResponse({ usage: { inputTokens: 1_000_000 }, metadata: { ...request.metadata } }),
    });

    await ask(bridge, 'user-1', 'one');
    await ask(bridge, 'user-1', 'two');
    await ask(bridge, 'user-2', 'one');
    await ask(bridge, 'user-1', 'one'); // hit: not billed

    expect(costs).toHaveLength(3);
    expect(costs.reduce((sum, c) => sum + c.totalCost, 0)).toBeCloseTo(0.126, 9);
    expect(costs.map((c) => c.metadata?.principal)).toEqual(['user-1', 'user-1', 'user-2']);
  });

  it('strict validation throws on a malformed response, which is then not cached or retried', async () => {
    const { bridge, backend } = build({
      strict: true,
      handler: (request) =>
        makeResponse({
          answers: {
            urgent: answers.urgent!,
            team: {
              type: 'choice',
              value: 'billing',
              probabilities: { billing: 0.3, technical: 0.3 },
            },
          },
          metadata: { ...request.metadata },
        }),
    });

    await expect(ask(bridge)).rejects.toBeInstanceOf(ValidationError);
    await expect(ask(bridge)).rejects.toBeInstanceOf(ValidationError);
    expect(backend.calls).toHaveLength(2); // nothing cached; ValidationError is not retried
  });

  it('non-strict validation lets a malformed response through, flagged and uncached', async () => {
    const { bridge, backend } = build({
      handler: (request) =>
        makeResponse({
          answers: {
            urgent: answers.urgent!,
            team: {
              type: 'choice',
              value: 'billing',
              probabilities: { billing: 0.3, technical: 0.3 },
            },
          },
          metadata: { ...request.metadata },
        }),
    });

    const first = await ask(bridge);
    await ask(bridge);

    expect(first.metadata.warnings?.some((w) => w.category === 'response-malformed')).toBe(true);
    expect(backend.calls).toHaveLength(2); // response-malformed is never cached
  });

  it('works with the OpenTelemetry middleware in the chain', async () => {
    const backend = createMockDecisionBackend({ answers });
    const bridge = new Bridge(new OpenAIFrontendAdapter(), backend);
    bridge.useDecision(await createDecisionOpenTelemetryMiddleware({ exportSpans: false }));
    bridge.useDecision(createDecisionCachingMiddleware({ unidentified: 'share' }));

    const response = await bridge.decide('x', questions);
    expect(response.answers.team).toEqual(answers.team);
  });
});
