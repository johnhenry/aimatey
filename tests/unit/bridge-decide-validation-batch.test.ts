/**
 * Bridge decide validation + decideBatch tests (#145)
 *
 * - decide()/decideFrom() pre-flight the request against the backend's
 *   capabilities and validate the response, merging warnings into metadata.
 * - decideBatch() runs many states through the same chain with bounded
 *   concurrency, in input order.
 */

import { describe, it, expect, vi } from 'vitest';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter, TypeSafeFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { createMockDecisionBackend } from '@johnhenry/aimatey-testing';
import { ValidationError } from '@johnhenry/aimatey-errors';
import type {
  BackendAdapter,
  IRCapabilities,
  IRDecisionAnswer,
  IRDecisionQuestion,
  IRDecisionRequest,
  IRDecisionResponse,
} from '@johnhenry/aimatey-types';

const noul: IRDecisionQuestion = { type: 'noul', instructions: 'Urgent?' };
const questions = { urgent: noul };
const answers: Record<string, IRDecisionAnswer> = { urgent: { type: 'noul', value: 0.9 } };

/** The mock backend, with extra capability fields declared. */
function withCaps(
  backend: ReturnType<typeof createMockDecisionBackend>,
  caps: Partial<IRCapabilities>
): ReturnType<typeof createMockDecisionBackend> {
  Object.assign(backend.metadata.capabilities, caps);
  return backend;
}

function bridgeFor(backend: BackendAdapter): Bridge<OpenAIFrontendAdapter> {
  return new Bridge(new OpenAIFrontendAdapter(), backend);
}

describe('Bridge.decide: request validation', () => {
  it('throws ValidationError before the middleware chain or backend runs', async () => {
    const backend = withCaps(createMockDecisionBackend({ answers }), { decisionTypes: ['choice'] });
    const bridge = bridgeFor(backend);
    const middleware = vi.fn(
      (req: IRDecisionRequest, next: (r: IRDecisionRequest) => Promise<IRDecisionResponse>) =>
        next(req)
    );
    bridge.useDecision(middleware);

    await expect(bridge.decide('s', questions)).rejects.toBeInstanceOf(ValidationError);
    expect(middleware).not.toHaveBeenCalled();
    expect(backend.calls).toHaveLength(0);
  });

  it('throws on empty questions even with no declared capabilities', async () => {
    const backend = createMockDecisionBackend({ answers });
    await expect(bridgeFor(backend).decide('s', {})).rejects.toBeInstanceOf(ValidationError);
  });

  it('merges request warnings into the request the backend sees and into the response', async () => {
    const backend = createMockDecisionBackend({
      answers: { pick: { type: 'choice', value: 'yes' } },
    });
    const polar: IRDecisionQuestion = {
      type: 'choice',
      instructions: 'Pick',
      criteria: { yes: 'a', no: 'b' },
    };
    const response = await bridgeFor(backend).decide('s', { pick: polar });

    expect(backend.calls[0].metadata.warnings?.[0].category).toBe('request-advisory');
    expect(response.metadata.warnings?.map((w) => w.category)).toContain('request-advisory');
  });

  it('keeps request warnings on the response even when the backend drops metadata.warnings', async () => {
    const backend = createMockDecisionBackend({
      handler: (request) => ({
        answers: { pick: { type: 'choice', value: 'yes' } },
        model: 'm',
        metadata: { requestId: request.metadata.requestId, timestamp: 0 },
      }),
    });
    const polar: IRDecisionQuestion = {
      type: 'choice',
      instructions: 'Pick',
      criteria: { yes: 'a', no: 'b' },
    };
    const response = await bridgeFor(backend).decide('s', { pick: polar });
    expect(response.metadata.warnings).toHaveLength(1);
  });

  it('applies the backend capabilities (images)', async () => {
    const backend = createMockDecisionBackend({ answers });
    const bridge = bridgeFor(backend);
    // Bridge.decide takes no images; drive the same path through decideFrom.
    const frontend = new TypeSafeFrontendAdapter();
    const tsBridge = new Bridge(frontend, withCaps(backend, { decisionImages: false }));
    const request = {
      state: 's',
      questions: { urgent: { type: 'noul', instructions: 'Urgent?' } },
      images: [{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AA' } }],
    };
    await expect(
      tsBridge.decideFrom(request as unknown as Parameters<typeof tsBridge.decideFrom>[0])
    ).rejects.toBeInstanceOf(ValidationError);
    expect(bridge).toBeDefined();
  });
});

describe('Bridge.decide: response validation', () => {
  it('throws ValidationError for a malformed response', async () => {
    const backend = createMockDecisionBackend({ answers: { urgent: { type: 'noul', value: 7 } } });
    await expect(bridgeFor(backend).decide('s', questions)).rejects.toBeInstanceOf(ValidationError);
  });

  it('merges response warnings into metadata.warnings', async () => {
    const backend = createMockDecisionBackend({
      answers: {
        pick: { type: 'choice', value: 'a', probabilities: { a: 0.2, b: 0.2 } },
      },
    });
    const q: IRDecisionQuestion = {
      type: 'choice',
      instructions: 'Pick',
      criteria: { a: 'x', b: 'y' },
    };
    const response = await bridgeFor(backend).decide('s', { pick: q });
    expect(response.metadata.warnings?.some((w) => w.category === 'response-malformed')).toBe(true);
  });

  it('adds no warnings for a clean exchange', async () => {
    const response = await bridgeFor(createMockDecisionBackend({ answers })).decide('s', questions);
    expect(response.metadata.warnings ?? []).toEqual([]);
  });

  it('validates through decideFrom too', async () => {
    const backend = createMockDecisionBackend({ answers: { urgent: { type: 'noul', value: 7 } } });
    const bridge = new Bridge(new TypeSafeFrontendAdapter(), backend);
    await expect(
      bridge.decideFrom({
        state: 's',
        questions: { urgent: { type: 'noul', instructions: 'Urgent?' } },
      } as unknown as Parameters<typeof bridge.decideFrom>[0])
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ============================================================================
// decideBatch
// ============================================================================

/** A backend that answers after `delay` ms, tracking peak in-flight calls. */
function trackedBackend(delay = 10, failOn?: (state: unknown) => boolean) {
  let inFlight = 0;
  const stats = { peak: 0, started: 0 };
  const backend = createMockDecisionBackend({
    handler: async (request) => {
      stats.started++;
      inFlight++;
      stats.peak = Math.max(stats.peak, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (failOn?.(request.state)) {
          throw new Error(`boom:${String(request.state)}`);
        }
        return {
          answers: { urgent: { type: 'noul' as const, value: 0.5 } },
          model: `echo:${String(request.state)}`,
          metadata: request.metadata,
        };
      } finally {
        inFlight--;
      }
    },
  });
  return { backend, stats };
}

describe('Bridge.decideBatch', () => {
  it('returns responses in input order', async () => {
    const { backend } = trackedBackend();
    const states = ['a', 'b', 'c', 'd', 'e'];
    const out = await bridgeFor(backend).decideBatch(states, questions);
    expect(out.map((r) => r.model)).toEqual(states.map((s) => `echo:${s}`));
  });

  it('returns an empty array for no states', async () => {
    const { backend } = trackedBackend();
    expect(await bridgeFor(backend).decideBatch([], questions)).toEqual([]);
    expect(backend.calls).toHaveLength(0);
  });

  it('bounds concurrency to the option', async () => {
    const { backend, stats } = trackedBackend();
    await bridgeFor(backend).decideBatch(
      Array.from({ length: 8 }, (_, i) => i),
      questions,
      {
        concurrency: 3,
      }
    );
    expect(stats.peak).toBe(3);
  });

  it('defaults to the backend maxConcurrency', async () => {
    const { backend, stats } = trackedBackend();
    withCaps(backend, { decisionLimits: { maxConcurrency: 1 } });
    await bridgeFor(backend).decideBatch([1, 2, 3, 4], questions);
    expect(stats.peak).toBe(1);
  });

  it('defaults to 4 when the backend declares no limit', async () => {
    const { backend, stats } = trackedBackend();
    await bridgeFor(backend).decideBatch(
      Array.from({ length: 10 }, (_, i) => i),
      questions
    );
    expect(stats.peak).toBe(4);
  });

  it('runs every item through the decision middleware chain', async () => {
    const { backend } = trackedBackend();
    const bridge = bridgeFor(backend);
    const seen: unknown[] = [];
    bridge.useDecision((req, next) => {
      seen.push(req.state);
      return next(req);
    });
    await bridge.decideBatch(['x', 'y', 'z'], questions);
    expect([...seen].sort()).toEqual(['x', 'y', 'z']);
  });

  it('gives each item its own request id and forwards options', async () => {
    const { backend } = trackedBackend();
    await bridgeFor(backend).decideBatch(['x', 'y'], questions, {
      model: 'm1',
      principal: 'user-1',
    });
    const ids = backend.calls.map((c) => c.metadata.requestId);
    expect(new Set(ids).size).toBe(2);
    expect(backend.calls.every((c) => c.parameters?.model === 'm1')).toBe(true);
    expect(backend.calls.every((c) => c.metadata.principal === 'user-1')).toBe(true);
  });

  it('reports progress as items complete', async () => {
    const { backend } = trackedBackend();
    const progress: Array<[number, number]> = [];
    await bridgeFor(backend).decideBatch([1, 2, 3], questions, {
      concurrency: 1,
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it("onError 'throw' (default) rejects with the first error and stops starting items", async () => {
    const { backend, stats } = trackedBackend(5, (s) => s === 1);
    const states = [0, 1, 2, 3, 4, 5, 6, 7];
    await expect(
      bridgeFor(backend).decideBatch(states, questions, { concurrency: 2 })
    ).rejects.toThrow('boom:1');
    expect(stats.started).toBeLessThan(states.length);
  });

  it("onError 'throw' aborts in-flight siblings through the shared signal", async () => {
    const signals: AbortSignal[] = [];
    const backend = createMockDecisionBackend({
      handler: async (request) => {
        if (request.state === 'bad') {
          throw new Error('bad item');
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        return {
          answers: { urgent: { type: 'noul', value: 0.5 } },
          model: 'm',
          metadata: request.metadata,
        };
      },
    });
    const original = backend.decide.bind(backend);
    backend.decide = (request, signal) => {
      if (signal) signals.push(signal);
      return original(request, signal);
    };
    await expect(
      bridgeFor(backend).decideBatch(['slow', 'bad'], questions, { concurrency: 2 })
    ).rejects.toThrow('bad item');
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it("onError 'collect' returns settled entries in input order", async () => {
    const { backend } = trackedBackend(5, (s) => s === 'b');
    const out = await bridgeFor(backend).decideBatch(['a', 'b', 'c'], questions, {
      onError: 'collect',
    });
    expect(out.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    const rejected = out[1] as PromiseRejectedResult;
    expect((rejected.reason as Error).message).toBe('boom:b');
    expect((out[2] as PromiseFulfilledResult<IRDecisionResponse>).value.model).toBe('echo:c');
  });

  it("onError 'collect' counts failures in progress", async () => {
    const { backend } = trackedBackend(1, () => true);
    const progress: number[] = [];
    await bridgeFor(backend).decideBatch([1, 2], questions, {
      onError: 'collect',
      onProgress: (done) => progress.push(done),
    });
    expect(progress).toEqual([1, 2]);
  });

  it('propagates a caller abort: pending items never start', async () => {
    const { backend, stats } = trackedBackend(20);
    const controller = new AbortController();
    const promise = bridgeFor(backend).decideBatch(
      Array.from({ length: 10 }, (_, i) => i),
      questions,
      { concurrency: 2, signal: controller.signal }
    );
    setTimeout(() => controller.abort(new Error('stop')), 5);
    await expect(promise).rejects.toThrow('stop');
    expect(stats.started).toBeLessThan(10);
  });

  it("with 'collect', a caller abort rejects the unfinished items", async () => {
    const { backend } = trackedBackend(20);
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    const out = await bridgeFor(backend).decideBatch([1, 2], questions, {
      onError: 'collect',
      signal: controller.signal,
    });
    expect(out.every((r) => r.status === 'rejected')).toBe(true);
    expect(backend.calls).toHaveLength(0);
  });

  it('validates each item (a bad question fails fast)', async () => {
    const { backend } = trackedBackend();
    await expect(bridgeFor(backend).decideBatch(['a'], {})).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws UNSUPPORTED_FEATURE up front for a backend without decide()', async () => {
    const chatOnly = {
      metadata: createMockDecisionBackend().metadata,
    } as unknown as BackendAdapter;
    await expect(bridgeFor(chatOnly).decideBatch(['a'], questions)).rejects.toMatchObject({
      code: 'UNSUPPORTED_FEATURE',
    });
  });
});
