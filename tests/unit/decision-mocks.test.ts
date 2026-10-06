/**
 * Decision mock tests: createMockDecisionBackend (aimatey-testing) and
 * MockBackendAdapter.decide (backend-browser).
 */

import { describe, it, expect } from 'vitest';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { MockBackendAdapter } from '@johnhenry/aimatey-backend-browser';
import { createMockDecisionBackend } from '@johnhenry/aimatey-testing';
import { supportsDecisions, validateDecisionResponse } from '@johnhenry/aimatey-utils';
import type { IRDecisionRequest, IRDecisionResponse } from '@johnhenry/aimatey-types';

const questions: IRDecisionRequest['questions'] = {
  urgent: { type: 'noul', instructions: 'Is this urgent?' },
  team: {
    type: 'choice',
    instructions: 'Which team?',
    criteria: { billing: 'invoices', technical: 'bugs' },
  },
};

const answers = {
  urgent: { type: 'noul', value: 0.9 },
  team: { type: 'choice', value: 'billing', probabilities: { billing: 0.8, technical: 0.2 }, confidence: 0.8 },
} as const;

function request(): IRDecisionRequest {
  return { state: 'I was charged twice', questions, metadata: { requestId: 'r', timestamp: 0 } };
}

describe('createMockDecisionBackend', () => {
  it('is a decision-only backend', () => {
    const backend = createMockDecisionBackend({ answers });
    expect(supportsDecisions(backend)).toBe(true);
    expect(backend.execute).toBeUndefined();
    expect(backend.metadata.capabilities.decisions).toBe(true);
  });

  it('answers each question from the configured answers and logs the call', async () => {
    const backend = createMockDecisionBackend({ answers });
    const req = request();
    const response = await backend.decide(req);

    expect(response.answers).toEqual(answers);
    expect(validateDecisionResponse(req, response)).toEqual([]);
    expect(backend.calls).toEqual([req]);
    expect(response.metadata.provenance?.backend).toBe(backend.metadata.name);
  });

  it('throws naming the question when no answer is configured for it', async () => {
    const backend = createMockDecisionBackend({ answers: { urgent: answers.urgent } });
    await expect(backend.decide(request())).rejects.toThrow(/team/);
  });

  it('prefers a handler over answers, and awaits async handlers', async () => {
    const backend = createMockDecisionBackend({
      answers,
      handler: async (req): Promise<IRDecisionResponse> => ({
        answers: { urgent: { type: 'noul', value: 0.1 }, team: answers.team },
        model: 'handler-model',
        metadata: req.metadata,
      }),
    });
    const response = await backend.decide(request());
    expect(response.model).toBe('handler-model');
    expect(response.answers.urgent).toEqual({ type: 'noul', value: 0.1 });
  });

  it('throws the configured error, still logging the call', async () => {
    const boom = new Error('boom');
    const backend = createMockDecisionBackend({ answers, error: boom });
    await expect(backend.decide(request())).rejects.toBe(boom);
    expect(backend.calls).toHaveLength(1);
  });

  it('waits latencyMs before answering', async () => {
    const backend = createMockDecisionBackend({ answers, latencyMs: 40 });
    const start = Date.now();
    await backend.decide(request());
    expect(Date.now() - start).toBeGreaterThanOrEqual(35);
  });

  it('rejects with an AbortError when the signal is already aborted', async () => {
    const backend = createMockDecisionBackend({ answers });
    const controller = new AbortController();
    controller.abort();
    await expect(backend.decide(request(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('works behind Bridge.decide', async () => {
    const backend = createMockDecisionBackend({ answers });
    const bridge = new Bridge(new OpenAIFrontendAdapter(), backend);
    const response = await bridge.decide('state', questions);
    expect(response.answers.urgent).toEqual(answers.urgent);
    expect(backend.calls[0]?.state).toBe('state');
  });
});

describe('MockBackendAdapter.decide', () => {
  it('declares decision support without losing chat support', () => {
    const backend = new MockBackendAdapter({ decisionAnswers: answers });
    expect(supportsDecisions(backend)).toBe(true);
    expect(typeof backend.execute).toBe('function');
  });

  it('answers from decisionAnswers and records requests', async () => {
    const backend = new MockBackendAdapter({ decisionAnswers: answers });
    const response = await backend.decide(request());
    expect(response.answers).toEqual(answers);
    expect(backend.allDecisionRequests).toHaveLength(1);
  });

  it('prefers decisionHandler', async () => {
    const backend = new MockBackendAdapter({
      decisionAnswers: answers,
      decisionHandler: (req) => ({
        answers: { urgent: { type: 'noul', value: 0 }, team: answers.team },
        model: 'h',
        metadata: req.metadata,
      }),
    });
    expect((await backend.decide(request())).answers.urgent).toEqual({ type: 'noul', value: 0 });
  });

  it('throws naming the question when none is configured', async () => {
    const backend = new MockBackendAdapter();
    await expect(backend.decide(request())).rejects.toThrow(/urgent/);
  });

  it('honours an already-aborted signal', async () => {
    const backend = new MockBackendAdapter({ decisionAnswers: answers });
    const controller = new AbortController();
    controller.abort();
    await expect(backend.decide(request(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
