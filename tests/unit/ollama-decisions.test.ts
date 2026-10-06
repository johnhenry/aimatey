/**
 * Ollama decision tests: `OllamaBackendAdapter.decide()` against
 * `/v1/systemone` (request shape, images, keep_alive, errors, abort),
 * decision-model discovery in `listModels()`, and replay of the responses
 * captured from a real Ollama (fixtures/decisions-ollama/, recorded by
 * tests/integration/ollama-decisions-live.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { OllamaBackendAdapter, isOllamaDecisionModel } from '@johnhenry/aimatey-backend';
import { supportsDecisions } from '@johnhenry/aimatey-utils';
import { loadFixture } from '@johnhenry/aimatey-testing';
import type { IRDecisionRequest, IRDecisionResponse } from '@johnhenry/aimatey-types';

const request: IRDecisionRequest = {
  state: 'Subject: Duplicate charge. Body: I was billed twice, please refund me today.',
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: { billing: 'invoices, refunds', technical: 'bugs, outages' },
    },
    refund: { type: 'noul', instructions: 'Does the user request a refund?' },
  },
  parameters: { model: 'tev1:0.8b' },
  metadata: { requestId: 'req_1', timestamp: 0 },
};

const wire = {
  model: 'tev1:0.8b',
  answers: {
    department: {
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.98, technical: 0.02 },
      confidence: 0.9,
    },
    refund: { type: 'noul', noul: 0.99 },
  },
  usage: { input_tokens: 400, output_tokens: 2 },
};

function mockFetch(response: unknown, ok = true, status = 200) {
  const fn = vi.fn().mockResolvedValueOnce({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => response,
    text: async () => JSON.stringify(response),
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('OllamaBackendAdapter decisions', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('is a decision backend that still chats', () => {
    const backend = new OllamaBackendAdapter({});
    expect(supportsDecisions(backend)).toBe(true);
    expect(backend.execute).toBeDefined();
  });

  it('declares its decision capabilities', () => {
    const caps = new OllamaBackendAdapter({}).metadata.capabilities;
    expect(caps.decisions).toBe(true);
    expect(caps.decisionTypes).toEqual(['choice', 'score', 'noul']);
    expect(caps.decisionImages).toBe(true);
    expect(caps.decisionLimits).toEqual({
      maxQuestions: 64,
      maxChoiceOptions: 255,
      maxScoreLevels: 26,
    });
    expect(caps.decisionModels).toContain('nimble');
    expect(caps.decisionModels).toContain('tev1');
  });

  it('POSTs to /v1/systemone on the configured base URL and maps the answers', async () => {
    const fetchMock = mockFetch(wire);
    const backend = new OllamaBackendAdapter({ baseURL: 'http://ollama.test:11434' });
    const response = await backend.decide(request);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://ollama.test:11434/v1/systemone');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('tev1:0.8b');
    expect(body.state).toEqual(request.state);
    expect(body.questions.refund.type).toBe('noul');
    expect(body).not.toHaveProperty('images');
    expect(body).not.toHaveProperty('keep_alive');

    expect(response.answers.department).toEqual({
      type: 'choice',
      value: 'billing',
      probabilities: { billing: 0.98, technical: 0.02 },
      confidence: 0.9,
    });
    expect(response.answers.refund).toEqual({ type: 'noul', value: 0.99 });
    expect(response.usage?.inputTokens).toBe(400);
    expect(response.metadata.provenance?.backend).toBe('ollama-backend');
  });

  it('falls back to config.defaultModel, then to nimble', async () => {
    const noModel = { ...request, parameters: undefined };
    let fetchMock = mockFetch(wire);
    await new OllamaBackendAdapter({ defaultModel: 'kev' }).decide(noModel);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).model).toBe('kev');

    fetchMock = mockFetch(wire);
    await new OllamaBackendAdapter({}).decide(noModel);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).model).toBe('nimble');
  });

  it('sends base64 images as bare strings and keepAlive as keep_alive', async () => {
    const fetchMock = mockFetch(wire);
    await new OllamaBackendAdapter({}).decide({
      ...request,
      images: [{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } }],
      parameters: { model: 'tev1:0.8b', custom: { keepAlive: '30m' } },
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.images).toEqual(['AAAA']);
    expect(body.keep_alive).toBe('30m');
  });

  it('rejects url images with a clear ProviderError instead of dropping them', async () => {
    const fetchMock = mockFetch(wire);
    await expect(
      new OllamaBackendAdapter({}).decide({
        ...request,
        images: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }],
      })
    ).rejects.toThrow(/base64/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps HTTP errors and passes the abort signal to fetch', async () => {
    mockFetch({ error: 'model not found' }, false, 404);
    await expect(new OllamaBackendAdapter({}).decide(request)).rejects.toThrow();

    const fetchMock = mockFetch(wire);
    const controller = new AbortController();
    await new OllamaBackendAdapter({}).decide(request, controller.signal);
    expect(fetchMock.mock.calls[0]![1].signal).toBe(controller.signal);
  });

  it('throws naming the question when the server omits an answer', async () => {
    mockFetch({ model: 'tev1:0.8b', answers: { department: wire.answers.department } });
    await expect(new OllamaBackendAdapter({}).decide(request)).rejects.toThrow(/refund/);
  });

  it('estimates decision cost as free', async () => {
    expect(await new OllamaBackendAdapter({}).estimateDecisionCost(request)).toBe(0);
  });

  it('works through Bridge.decide()', async () => {
    mockFetch(wire);
    const bridge = new Bridge(new OpenAIFrontendAdapter(), new OllamaBackendAdapter({}));
    const response = await bridge.decide(request.state, request.questions, {
      model: 'tev1:0.8b',
    });
    expect(response.answers.department?.type).toBe('choice');
  });
});

describe('Ollama decision-model discovery', () => {
  it('recognises the known decision-model families by name', () => {
    for (const name of [
      'nimble',
      'nimble:latest',
      'tev1:0.8b',
      'library/tev1:4b',
      'kev:4b',
      'clef-flash',
      'strands-decider:2b',
      'laya',
    ]) {
      expect(isOllamaDecisionModel(name), name).toBe(true);
    }
  });

  it('recognises a decision model by its GGUF parent when the tag is custom', () => {
    expect(isOllamaDecisionModel('my-triage:v2', 'Bespoke-Nimble-9B-merged-Q8_0.gguf')).toBe(true);
  });

  it('does not flag chat models', () => {
    for (const name of ['llama3.2:latest', 'qwen3.5:0.8b', 'nomic-embed-text', 'monkey:7b']) {
      expect(isOllamaDecisionModel(name), name).toBe(false);
    }
  });

  it("listModels reports kind: 'decision' for decision models only", async () => {
    mockFetch({
      models: [
        { name: 'nimble:latest', details: { family: 'qwen35', parameter_size: '9.0B', parent_model: 'Bespoke-Nimble-9B-merged-current-Q8_0.gguf' } },
        { name: 'tev1:0.8b', details: { family: 'qwen35', parameter_size: '752M', parent_model: 'Tev1-0.8B-Q8_0.gguf' } },
        { name: 'qwen3.5:0.8b', details: { family: 'qwen35', parameter_size: '873M', parent_model: '' } },
      ],
    });
    const { models } = await new OllamaBackendAdapter({}).listModels();
    const kinds = Object.fromEntries(models.map((m) => [m.id, m.metadata?.kind]));
    expect(kinds).toEqual({
      'nimble:latest': 'decision',
      'tev1:0.8b': 'decision',
      'qwen3.5:0.8b': undefined,
    });
    expect(models[0]!.capabilities?.supportsStreaming).toBe(false);
  });
});

// ============================================================================
// Replay of real captured responses
// ============================================================================

describe('real Ollama responses (fixtures/decisions-ollama)', () => {
  for (const scenario of ['tev1-0.8b-triage', 'nimble-triage']) {
    it(`replays ${scenario} through the adapter to the captured IR answers`, async () => {
      const fixture = (await loadFixture('decisions-ollama', scenario)) as unknown as {
        request: IRDecisionRequest;
        response: IRDecisionResponse;
        providerResponse: unknown;
      };
      mockFetch(fixture.providerResponse);
      const response = await new OllamaBackendAdapter({}).decide(fixture.request);

      expect(response.answers).toEqual(fixture.response.answers);
      expect(response.model).toBe(fixture.response.model);
      expect(response.usage).toEqual(fixture.response.usage);
      // Every captured question got a typed answer in range.
      for (const [name, question] of Object.entries(fixture.request.questions)) {
        expect(response.answers[name]?.type).toBe(question.type);
      }
    });
  }
});
