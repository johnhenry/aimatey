/**
 * Router.decide tests (#145)
 *
 * Mirrors Router.embed: capability-filtered candidates, fallback chain
 * ordering, circuit breaker, per-backend stats, cost, `fallbackStrategy:
 * 'none'`, ALL_BACKENDS_FAILED. Plus decision-specific pre-flight (types,
 * limits, images), the `parameters.model` hint, and chat selection skipping
 * decision-only backends.
 */

import { describe, it, expect, vi } from 'vitest';
import { Bridge, Router } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { createMockDecisionBackend } from '@johnhenry/aimatey-testing';
import { supportsDecisions } from '@johnhenry/aimatey-utils';
import { AdapterError, ErrorCode, ValidationError } from '@johnhenry/aimatey-errors';
import type {
  BackendAdapter,
  IRCapabilities,
  IRChatRequest,
  IRDecisionQuestion,
  IRDecisionRequest,
} from '@johnhenry/aimatey-types';

const choiceQ: IRDecisionQuestion = {
  type: 'choice',
  instructions: 'Which?',
  criteria: { opt_1: 'a', opt_2: 'b' },
};
const noulQ: IRDecisionQuestion = { type: 'noul', instructions: 'Urgent?' };

const answers = {
  pick: { type: 'choice' as const, value: 'opt_1' },
  urgent: { type: 'noul' as const, value: 0.9 },
};

function req(
  questions: Record<string, IRDecisionQuestion>,
  extra: Partial<IRDecisionRequest> = {}
): IRDecisionRequest {
  return { state: 'hello', questions, metadata: { requestId: 'r', timestamp: 0 }, ...extra };
}

function backend(
  name: string,
  caps: Partial<IRCapabilities> = {},
  config: Parameters<typeof createMockDecisionBackend>[0] = {}
) {
  const b = createMockDecisionBackend({ answers, name, ...config });
  Object.assign(b.metadata.capabilities, caps);
  return b;
}

const boom = new Error('backend down');

describe('Router.decide: routing and fallback', () => {
  it('routes to a decision-capable backend, skipping chat-only ones', async () => {
    const chatOnly: BackendAdapter = {
      metadata: { ...backend('chat').metadata, name: 'chat' },
      execute: vi.fn(),
    } as unknown as BackendAdapter;
    delete (chatOnly as { decide?: unknown }).decide;
    const d = backend('d');
    const router = new Router().register('chat', chatOnly).register('d', d);
    const response = await router.decide(req({ urgent: noulQ }));
    expect(response.answers.urgent).toEqual(answers.urgent);
    expect(d.calls).toHaveLength(1);
  });

  it('throws UNSUPPORTED_FEATURE when no backend supports decisions', async () => {
    const router = new Router();
    await expect(router.decide(req({ urgent: noulQ }))).rejects.toMatchObject({
      code: ErrorCode.UNSUPPORTED_FEATURE,
    });
  });

  it('orders candidates: fallback chain, then default, then registration order', async () => {
    const [a, b, c] = [backend('a'), backend('b'), backend('c')];
    const router = new Router({ defaultBackend: 'c' })
      .register('a', a)
      .register('b', b)
      .register('c', c);
    router.setFallbackChain(['b']);
    await router.decide(req({ urgent: noulQ }));
    expect(b.calls).toHaveLength(1);
    expect(a.calls).toHaveLength(0);
    expect(c.calls).toHaveLength(0);

    const router2 = new Router({ defaultBackend: 'c' })
      .register('a', backend('a'))
      .register('c', c);
    await router2.decide(req({ urgent: noulQ }));
    expect(c.calls).toHaveLength(1);
  });

  it('falls back to the next candidate on failure', async () => {
    const failing = backend('failing', {}, { error: boom });
    const working = backend('working');
    const router = new Router().register('failing', failing).register('working', working);
    router.setFallbackChain(['failing', 'working']);

    const response = await router.decide(req({ urgent: noulQ }));
    expect(response.answers.urgent).toBeDefined();
    expect(failing.calls).toHaveLength(1);
    expect(working.calls).toHaveLength(1);
  });

  it("rethrows the first error under fallbackStrategy 'none'", async () => {
    const failing = backend('failing', {}, { error: boom });
    const working = backend('working');
    const router = new Router({ fallbackStrategy: 'none' })
      .register('failing', failing)
      .register('working', working);
    router.setFallbackChain(['failing', 'working']);

    await expect(router.decide(req({ urgent: noulQ }))).rejects.toBe(boom);
    expect(working.calls).toHaveLength(0);
  });

  it('rethrows the last error when every candidate fails', async () => {
    const e2 = new Error('also down');
    const router = new Router()
      .register('a', backend('a', {}, { error: boom }))
      .register('b', backend('b', {}, { error: e2 }));
    router.setFallbackChain(['a', 'b']);
    await expect(router.decide(req({ urgent: noulQ }))).rejects.toBe(e2);
  });

  it('passes the signal to the backend', async () => {
    const d = backend('d');
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    const router = new Router().register('d', d);
    await expect(router.decide(req({ urgent: noulQ }), controller.signal)).rejects.toThrow('stop');
  });
});

describe('Router.decide: pre-flight capability filtering', () => {
  it('skips a choice-only backend for a noul question', async () => {
    const choiceOnly = backend('choice-only', { decisionTypes: ['choice'] });
    const general = backend('general');
    const router = new Router().register('choice-only', choiceOnly).register('general', general);
    router.setFallbackChain(['choice-only', 'general']);

    await router.decide(req({ urgent: noulQ }));
    expect(choiceOnly.calls).toHaveLength(0);
    expect(general.calls).toHaveLength(1);
    // A skip is not an attempt: it does not count against the backend.
    expect(router.getBackendStats('choice-only')?.totalRequests).toBe(0);
  });

  it('skips on limits and images', async () => {
    const small = backend('small', { decisionLimits: { maxChoiceOptions: 1 } });
    const noImages = backend('no-images', { decisionImages: false });
    const ok = backend('ok', { decisionImages: true });
    const router = new Router()
      .register('small', small)
      .register('no-images', noImages)
      .register('ok', ok);
    router.setFallbackChain(['small', 'no-images', 'ok']);

    await router.decide(
      req(
        { pick: choiceQ },
        {
          images: [
            { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AA' } },
          ],
        }
      )
    );
    expect(small.calls).toHaveLength(0);
    expect(noImages.calls).toHaveLength(0);
    expect(ok.calls).toHaveLength(1);
  });

  it('reports each skip through onWarning, naming the backend and reason', async () => {
    const onWarning = vi.fn();
    const router = new Router({ onWarning })
      .register('choice-only', backend('choice-only', { decisionTypes: ['choice'] }))
      .register('general', backend('general'));
    router.setFallbackChain(['choice-only', 'general']);
    await router.decide(req({ urgent: noulQ }));

    expect(onWarning).toHaveBeenCalledTimes(1);
    const warning = onWarning.mock.calls[0][0];
    expect(warning.severity).toBe('info');
    expect(warning.message).toContain('choice-only');
    expect(warning.message).toMatch(/noul/);
  });

  it('throws the validation error when no decision backend can serve the request', async () => {
    const router = new Router().register('c', backend('c', { decisionTypes: ['choice'] }));
    await expect(router.decide(req({ urgent: noulQ }))).rejects.toBeInstanceOf(ValidationError);
  });

  it('passes backend-specific soft warnings to the chosen backend', async () => {
    const d = backend('d');
    const router = new Router().register('d', d);
    const polar: IRDecisionQuestion = {
      type: 'choice',
      instructions: 'Pick',
      criteria: { yes: 'a', no: 'b' },
    };
    await router.decide(req({ pick: polar }));
    expect(d.calls[0].metadata.warnings?.[0].category).toBe('request-advisory');
  });
});

describe('Router.decide: model hint', () => {
  it('deprioritizes a backend whose decisionModels lack the hinted model, without excluding it', async () => {
    const a = backend('a', { decisionModels: ['alpha'] });
    const b = backend('b', { decisionModels: ['beta'] });
    const router = new Router().register('a', a).register('b', b);
    router.setFallbackChain(['a', 'b']);

    await router.decide(req({ urgent: noulQ }, { parameters: { model: 'beta' } }));
    expect(b.calls).toHaveLength(1);
    expect(a.calls).toHaveLength(0);
  });

  it('still falls back to the deprioritized backend', async () => {
    const a = backend('a', { decisionModels: ['alpha'] });
    const b = backend('b', { decisionModels: ['beta'] }, { error: boom });
    const router = new Router().register('a', a).register('b', b);
    router.setFallbackChain(['a', 'b']);

    await router.decide(req({ urgent: noulQ }, { parameters: { model: 'beta' } }));
    expect(b.calls).toHaveLength(1);
    expect(a.calls).toHaveLength(1);
  });

  it('does not penalize backends that declare no decisionModels', async () => {
    const a = backend('a');
    const b = backend('b', { decisionModels: ['beta'] });
    const router = new Router().register('a', a).register('b', b);
    router.setFallbackChain(['a', 'b']);
    await router.decide(req({ urgent: noulQ }, { parameters: { model: 'beta' } }));
    expect(a.calls).toHaveLength(1);
  });
});

describe('Router.decide: circuit breaker, stats, cost', () => {
  it('opens the breaker after the threshold and then skips the backend', async () => {
    const failing = backend('failing', {}, { error: boom });
    const working = backend('working');
    const router = new Router({ enableCircuitBreaker: true, circuitBreakerThreshold: 2 })
      .register('failing', failing)
      .register('working', working);
    router.setFallbackChain(['failing', 'working']);

    await router.decide(req({ urgent: noulQ }));
    await router.decide(req({ urgent: noulQ }));
    expect(router.isCircuitBreakerOpen('failing')).toBe(true);

    await router.decide(req({ urgent: noulQ }));
    expect(failing.calls).toHaveLength(2);
    expect(working.calls).toHaveLength(3);
  });

  it('counts per-backend successes and failures, not router-level totals (like embed)', async () => {
    const failing = backend('failing', {}, { error: boom });
    const working = backend('working', {}, { latencyMs: 5 });
    const router = new Router().register('failing', failing).register('working', working);
    router.setFallbackChain(['failing', 'working']);

    await router.decide(req({ urgent: noulQ }));
    const stats = router.getStats();
    expect(stats.backendStats['failing']).toMatchObject({ totalRequests: 1, failedRequests: 1 });
    expect(stats.backendStats['working']).toMatchObject({
      totalRequests: 1,
      successfulRequests: 1,
    });
    expect(stats.backendStats['working'].averageLatencyMs).toBeGreaterThan(0);
    expect(stats.totalRequests).toBe(0);
  });

  it('tracks cost via estimateDecisionCost when trackCost is on', async () => {
    const d = backend('d');
    d.estimateDecisionCost = vi.fn().mockResolvedValue(0.25);
    const router = new Router({ trackCost: true }).register('d', d);
    await router.decide(req({ urgent: noulQ }));
    await router.decide(req({ urgent: noulQ }));
    expect(router.getBackendStats('d')?.totalCost).toBeCloseTo(0.5);

    const off = new Router().register('d', d);
    await off.decide(req({ urgent: noulQ }));
    expect(off.getBackendStats('d')?.totalCost).toBeUndefined();
  });
});

describe('Router as a decision backend', () => {
  it('satisfies supportsDecisions', () => {
    expect(supportsDecisions(new Router())).toBe(true);
  });

  it('works behind a Bridge (and Bridge pre-flights request shape)', async () => {
    const d = backend('d');
    const router = new Router().register('d', d);
    const bridge = new Bridge(new OpenAIFrontendAdapter(), router);
    const response = await bridge.decide('hello', { urgent: noulQ });
    expect(response.answers.urgent).toBeDefined();
    expect(response.metadata.provenance?.backend).toBe('router');
    await expect(bridge.decide('hello', {})).rejects.toBeInstanceOf(ValidationError);
    expect(AdapterError).toBeDefined();
  });
});

describe('Router chat selection skips decision-only backends', () => {
  const chatBackend = (name: string): BackendAdapter =>
    ({
      metadata: { ...backend(name).metadata, name },
      execute: vi.fn(async () => ({
        message: { role: 'assistant', content: `from ${name}` },
        finishReason: 'stop',
        metadata: { requestId: 'r', timestamp: 0 },
      })),
    }) as unknown as BackendAdapter;

  const chatRequest: IRChatRequest = {
    messages: [{ role: 'user', content: 'hi' }],
    metadata: { requestId: 'r', timestamp: 0 },
  };

  it('does not pick a decision-only backend registered first', async () => {
    const decisionOnly = backend('decision-only');
    const router = new Router()
      .register('decision-only', decisionOnly)
      .register('chat', chatBackend('chat'));
    expect(await router.selectBackend(chatRequest)).toBe('chat');
    const response = await router.execute(chatRequest);
    expect(response.message.content).toBe('from chat');
  });

  it('ignores a decision-only default backend for chat', async () => {
    const router = new Router({ defaultBackend: 'decision-only' })
      .register('decision-only', backend('decision-only'))
      .register('chat', chatBackend('chat'));
    expect(await router.selectBackend(chatRequest)).toBe('chat');
  });

  it('throws NO_BACKEND_AVAILABLE when only decision-only backends exist', async () => {
    const router = new Router().register('decision-only', backend('decision-only'));
    await expect(router.selectBackend(chatRequest)).rejects.toMatchObject({
      code: ErrorCode.NO_BACKEND_AVAILABLE,
    });
  });
});
