/**
 * LayaBackendAdapter tests
 *
 * `@receptron/laya` is an optional peer dependency (not installed in this
 * workspace, by design -- ~1.7GB of ONNX weights). Vite's own
 * optional-peer-dep handling stubs the specifier to throw before `vi.mock`
 * can intercept it, so the lazy-load-and-invoke path isn't exercised here
 * -- the same reason `native-apple`/`native-node-llamacpp` have no tests
 * for their own optional native bindings either. What's covered instead
 * is the genuinely novel logic: `toIRAnswer`'s three answer-shape
 * corrections (self-reporting `type`, index-keyed `score.probabilities`,
 * real `noul.confidence` -- the mirror image of what
 * `LayaFrontendAdapter`'s tests in decisions.test.ts already verify going
 * the other direction) and the adapter's capability declaration.
 */

import { describe, it, expect, vi } from 'vitest';
import { LayaBackendAdapter, toIRAnswer } from '@johnhenry/aimatey-native-laya';
import { ProviderError } from '@johnhenry/aimatey-errors';
import type { IRDecisionRequest } from '@johnhenry/aimatey-types';

function makeRequest(): IRDecisionRequest {
  return {
    state: { headline: 'Local sea levels rising faster than predicted' },
    questions: {
      urgency: {
        type: 'score',
        instructions: 'How urgent is this?',
        criteria: ['low', 'medium', 'high'],
      },
    },
    metadata: {
      requestId: 'req-1',
      timestamp: Date.now(),
      provenance: { frontend: 'test' },
    },
  };
}

describe('LayaBackendAdapter', () => {
  it('declares decision capability, not chat', () => {
    const backend = new LayaBackendAdapter();
    expect(backend.metadata.capabilities.decisions).toBe(true);
    expect(backend.metadata.capabilities.streaming).toBe(false);
    expect(typeof (backend as unknown as { execute?: unknown }).execute).toBe('undefined');
    expect(typeof (backend as unknown as { fromIR?: unknown }).fromIR).toBe('undefined');
  });

  it('advertises the three checkpoints as decision models', () => {
    expect(new LayaBackendAdapter().metadata.capabilities.decisionModels).toEqual([
      'english',
      'multilingual',
      'typed-decisions',
    ]);
  });

  it('estimateDecisionCost is always 0 -- local inference has no per-call billing, unlike a hosted API', async () => {
    const backend = new LayaBackendAdapter();
    await expect(backend.estimateDecisionCost(makeRequest())).resolves.toBe(0);
  });

  it('maps a choice answer', () => {
    expect(
      toIRAnswer({
        type: 'choice',
        choice: 'high',
        probabilities: { low: 0.1, medium: 0.2, high: 0.7 },
        confidence: 0.7,
      })
    ).toEqual({
      type: 'choice',
      value: 'high',
      probabilities: { low: 0.1, medium: 0.2, high: 0.7 },
      confidence: 0.7,
    });
  });

  it('maps a score answer, converting index-keyed probabilities to a numeric-order array', () => {
    expect(
      toIRAnswer({
        type: 'score',
        score: 2,
        probabilities: { '2': 0.7, '0': 0.1, '1': 0.2 },
        confidence: 0.7,
      })
    ).toEqual({
      type: 'score',
      value: 2,
      probabilities: [0.1, 0.2, 0.7],
      confidence: 0.7,
    });
  });

  it('maps a noul answer, passing through its real confidence when the wire reports one', () => {
    expect(toIRAnswer({ type: 'noul', noul: 0.83, confidence: 0.66 })).toEqual({
      type: 'noul',
      value: 0.83,
      confidence: 0.66,
    });
  });

  it('derives a noul answer\'s confidence when the wire response omits it -- the real, common case', () => {
    // A live @receptron/laya response's `noul` answer carries no
    // `confidence` field at all (confirmed by actually running it, not
    // assumed) -- this is the shape `toIRAnswer` sees in practice.
    expect(toIRAnswer({ type: 'noul', noul: 0.1923 })).toEqual({
      type: 'noul',
      value: 0.1923,
      confidence: 0.8077,
    });
  });
});

// ============================================================================
// decide() -- driven through a fake Laya session, since @receptron/laya itself
// is not installed in this workspace (see the header comment).
// ============================================================================

const wireResponse = (answers: Record<string, unknown>) => ({
  model: 'laya-rl-agent',
  answers,
  usage: { input_tokens: 12, output_tokens: 0 },
});

function makeBackend(
  systemOne: (state: unknown, questions: unknown) => unknown,
  config: ConstructorParameters<typeof LayaBackendAdapter>[0] = {}
) {
  const backend = new LayaBackendAdapter(config);
  // initialize() is idempotent on a set instance, so this skips the real load.
  (backend as unknown as { instance: unknown }).instance = {
    systemOne: vi.fn(async (state: unknown, questions: unknown) => systemOne(state, questions)),
    close: vi.fn(async () => undefined),
  };
  return backend;
}

describe('LayaBackendAdapter.decide', () => {
  it('maps answers, usage and provenance', async () => {
    const backend = makeBackend(() =>
      wireResponse({
        urgency: {
          type: 'score',
          score: 1.5,
          legend: {},
          probabilities: { '0': 0.1, '1': 0.5, '2': 0.4 },
          confidence: 0.5,
          rl_agent: { act_probability: 0.4 },
        },
      })
    );
    const response = await backend.decide(makeRequest());

    expect(response.answers.urgency).toEqual({
      type: 'score',
      value: 1.5,
      probabilities: [0.1, 0.5, 0.4],
      confidence: 0.5,
    });
    expect(response.model).toBe('laya-rl-agent');
    expect(response.usage).toEqual({ inputTokens: 12 });
    expect(response.metadata.provenance?.backend).toBe('laya-backend');
  });

  it('builds answers from the request questions and throws, naming the question, on a missing one', async () => {
    const backend = makeBackend(() => wireResponse({}));
    const error = await backend.decide(makeRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toMatch(/urgency/);
  });

  it('ignores answers for questions that were not asked', async () => {
    const backend = makeBackend(() =>
      wireResponse({
        urgency: { type: 'noul', noul: 0.2, rl_agent: { act_probability: 0.1 } },
        stray: { type: 'noul', noul: 0.9 },
      })
    );
    const response = await backend.decide({
      ...makeRequest(),
      questions: { urgency: { type: 'noul', instructions: 'Urgent?' } },
    });
    expect(Object.keys(response.answers)).toEqual(['urgency']);
  });

  it('keeps the rl_agent sub-object per question under raw.rl_agent', async () => {
    const backend = makeBackend(() =>
      wireResponse({ urgency: { type: 'noul', noul: 0.2, rl_agent: { act_probability: 0.1 } } })
    );
    const response = await backend.decide({
      ...makeRequest(),
      questions: { urgency: { type: 'noul', instructions: 'Urgent?' } },
    });
    expect(response.raw?.rl_agent).toEqual({ urgency: { act_probability: 0.1 } });
  });

  it('rejects with an AbortError, without loading or running, when already aborted', async () => {
    const backend = new LayaBackendAdapter(); // no instance: a load attempt would throw a different error
    const controller = new AbortController();
    controller.abort();
    await expect(backend.decide(makeRequest(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('does not call systemOne when aborted before the run', async () => {
    const backend = makeBackend(() => wireResponse({}));
    const controller = new AbortController();
    controller.abort();
    await backend.decide(makeRequest(), controller.signal).catch(() => undefined);
    const instance = (backend as unknown as { instance: { systemOne: ReturnType<typeof vi.fn> } }).instance;
    expect(instance.systemOne).not.toHaveBeenCalled();
  });

  it('rejects with an AbortError when aborted while the run was in flight', async () => {
    const controller = new AbortController();
    const backend = makeBackend(() => {
      controller.abort();
      return wireResponse({
        urgency: { type: 'score', score: 0, probabilities: { '0': 1 }, confidence: 1 },
      });
    });
    await expect(backend.decide(makeRequest(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('warns that task/lang cannot be applied, since systemOne() takes neither', async () => {
    const backend = makeBackend(() =>
      wireResponse({ q: { type: 'noul', noul: 0.5, rl_agent: { act_probability: 0.5 } } })
    );
    const request: IRDecisionRequest = {
      ...makeRequest(),
      questions: { q: { type: 'noul', instructions: 'x' } },
      parameters: { custom: { task: 'customer_service', lang: 'de' } },
    };
    const response = await backend.decide(request);
    const fields = (response.metadata.warnings ?? []).map((w) => w.field);
    expect(fields).toEqual(['parameters.custom.task', 'parameters.custom.lang']);
    expect(response.metadata.warnings?.every((w) => w.category === 'parameter-unsupported')).toBe(true);
  });

  it('warns when parameters.model differs from the checkpoint loaded at construction', async () => {
    const backend = makeBackend(
      () => wireResponse({ q: { type: 'noul', noul: 0.5, rl_agent: { act_probability: 0.5 } } }),
      { subfolder: 'english' }
    );
    const base: IRDecisionRequest = {
      ...makeRequest(),
      questions: { q: { type: 'noul', instructions: 'x' } },
    };

    const mismatched = await backend.decide({ ...base, parameters: { model: 'multilingual' } });
    expect(mismatched.metadata.warnings?.map((w) => w.field)).toEqual(['parameters.model']);

    const matching = await backend.decide({ ...base, parameters: { model: 'english' } });
    expect(matching.metadata.warnings ?? []).toEqual([]);
  });
});
