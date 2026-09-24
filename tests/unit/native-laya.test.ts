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

import { describe, it, expect } from 'vitest';
import { LayaBackendAdapter, toIRAnswer } from '@johnhenry/aimatey-native-laya';
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
