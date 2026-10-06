/**
 * SystemOneBackendAdapter tests: the generic decision-only adapter for any
 * System One-compatible server, across dialects.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SystemOneBackendAdapter } from '@johnhenry/aimatey-backend';
import { supportsDecisions, supportsChat } from '@johnhenry/aimatey-utils';
import type { IRDecisionRequest } from '@johnhenry/aimatey-types';

const request: IRDecisionRequest = {
  state: 'Please refund me.',
  questions: {
    refund: { type: 'noul', instructions: 'Is a refund requested?' },
    team: {
      type: 'choice',
      instructions: 'Which team?',
      criteria: { billing: 'money', tech: 'bugs' },
    },
  },
  metadata: { requestId: 'req_1', timestamp: 0 },
};

function mockFetch(response: unknown, ok = true, status = 200) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => response,
    text: async () => JSON.stringify(response),
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('SystemOneBackendAdapter', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('is decision-only', () => {
    const backend = new SystemOneBackendAdapter({ baseURL: 'http://x/v1' });
    expect(supportsDecisions(backend)).toBe(true);
    expect(supportsChat(backend)).toBe(false);
    expect(backend.metadata.name).toBe('systemone-backend');
    expect(backend.metadata.capabilities.decisionTypes).toEqual(['choice', 'score', 'noul']);
    expect(backend.metadata.capabilities.decisionImages).toBe(false);
  });

  it('reflects configured name, types, limits and images', () => {
    const backend = new SystemOneBackendAdapter({
      baseURL: 'http://x/v1',
      name: 'laya-serve',
      defaultModel: 'laya',
      decisionTypes: ['choice'],
      decisionLimits: { maxChoiceOptions: 20 },
      decisionImages: true,
    });
    const caps = backend.metadata.capabilities;
    expect(backend.metadata.name).toBe('laya-serve');
    expect(caps.decisionModels).toEqual(['laya']);
    expect(caps.decisionTypes).toEqual(['choice']);
    expect(caps.decisionLimits).toEqual({ maxChoiceOptions: 20 });
    expect(caps.decisionImages).toBe(true);
  });

  it('POSTs to {baseURL}/systemone; sends no Authorization without an apiKey', async () => {
    const fetchMock = mockFetch({
      model: 'kev',
      answers: { refund: { noul: 0.9 }, team: { choice: 'billing' } },
    });
    const backend = new SystemOneBackendAdapter({
      baseURL: 'http://localhost:8080/v1/',
      defaultModel: 'kev',
    });
    const response = await backend.decide(request);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8080/v1/systemone');
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(init.body).model).toBe('kev');
    expect(response.answers.refund).toEqual({ type: 'noul', value: 0.9 });
    expect(response.metadata.provenance?.backend).toBe('systemone-backend');
  });

  it('sends the bearer key and custom headers', async () => {
    const fetchMock = mockFetch({
      answers: { refund: { noul: 0.9 }, team: { choice: 'billing' } },
    });
    await new SystemOneBackendAdapter({
      baseURL: 'http://x/v1',
      apiKey: 'sk-1',
      headers: { 'X-Test': '1' },
    }).decide(request);
    const init = fetchMock.mock.calls[0]![1];
    expect(init.headers.Authorization).toBe('Bearer sk-1');
    expect(init.headers['X-Test']).toBe('1');
  });

  it('uses the dialect: Vercel /evaluate renames noul to boolean and reads probability', async () => {
    const fetchMock = mockFetch({
      model: 'jev',
      answers: {
        refund: { type: 'boolean', probability: 0.8 },
        team: { type: 'choice', choice: 'tech' },
      },
      usage: { inputTokens: 5, outputTokens: 0 },
    });
    const backend = new SystemOneBackendAdapter({
      baseURL: 'https://ai-gateway.vercel.sh/v1',
      dialect: 'vercel-evaluate',
    });
    const response = await backend.decide(request);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://ai-gateway.vercel.sh/v1/evaluate');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).questions.refund.type).toBe('boolean');
    expect(response.answers.refund).toEqual({ type: 'noul', value: 0.8 });
    expect(response.usage?.inputTokens).toBe(5);
  });

  it('uses a custom path, and the whole baseURL for the cloudflare dialect', async () => {
    const fetchMock = mockFetch({
      result: { model: 'clef', answers: { refund: { noul: 0.1 }, team: { choice: 'billing' } } },
    });
    const backend = new SystemOneBackendAdapter({
      baseURL: 'https://api.cloudflare.com/client/v4/accounts/A/ai/run/@cf/cloudflare/clef',
      dialect: 'cloudflare',
    });
    const response = await backend.decide(request);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://api.cloudflare.com/client/v4/accounts/A/ai/run/@cf/cloudflare/clef'
    );
    expect(response.model).toBe('clef');

    mockFetch({ answers: { refund: { noul: 0.1 }, team: { choice: 'billing' } } });
    await new SystemOneBackendAdapter({ baseURL: 'http://x', path: '/v2/decide' }).decide(request);
    expect((global.fetch as any).mock.calls[0][0]).toBe('http://x/v2/decide');
  });

  it('drops images with a warning unless the server takes them', async () => {
    const image = {
      type: 'image' as const,
      source: { type: 'base64' as const, mediaType: 'image/png', data: 'AAAA' },
    };
    const ok = { answers: { refund: { noul: 0.1 }, team: { choice: 'billing' } } };

    let fetchMock = mockFetch(ok);
    const dropped = await new SystemOneBackendAdapter({ baseURL: 'http://x' }).decide({
      ...request,
      images: [image],
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).not.toHaveProperty('images');
    expect(dropped.metadata.warnings?.[0]?.category).toBe('capability-unsupported');

    fetchMock = mockFetch(ok);
    await new SystemOneBackendAdapter({ baseURL: 'http://x', decisionImages: true }).decide({
      ...request,
      images: [image],
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).images).toEqual(['AAAA']);
  });

  it('maps HTTP errors', async () => {
    mockFetch({ error: 'nope' }, false, 401);
    await expect(
      new SystemOneBackendAdapter({ baseURL: 'http://x', apiKey: 'bad' }).decide(request)
    ).rejects.toThrow(/Authentication/);
  });

  it('healthCheck posts a trivial noul and reports ok/failure', async () => {
    const fetchMock = mockFetch({ answers: { ok: { noul: 0.5 } } });
    const backend = new SystemOneBackendAdapter({ baseURL: 'http://x/v1', defaultModel: 'm' });
    expect(await backend.healthCheck()).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.model).toBe('m');
    expect(body.questions.ok.type).toBe('noul');

    mockFetch({}, false, 500);
    expect(await backend.healthCheck()).toBe(false);
    global.fetch = vi.fn().mockRejectedValue(new Error('down')) as unknown as typeof fetch;
    expect(await backend.healthCheck()).toBe(false);
  });
});
