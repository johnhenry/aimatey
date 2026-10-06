/**
 * Proxy decision routing (packages/cli/src/proxy.ts).
 *
 * `createHandler` routes a POST by path: the decision routes
 * (`/v1/systemone`, `/v1/decisions`, `/v1/evaluate`, ...) go to
 * `backend.decide()` when the backend supports decisions, everything else is
 * the chat proxy it always was. A decision-only backend is no longer rejected
 * up front; it serves decisions and answers chat paths with a clear error.
 */

import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { FunctionBackendAdapter } from '@johnhenry/aimatey-backend-browser';
import { createMockDecisionBackend } from '@johnhenry/aimatey-testing';
import { ProviderError } from '@johnhenry/aimatey-errors';
import { ErrorCode } from '@johnhenry/aimatey-types';
import type { IRDecisionAnswer, BackendAdapter } from '@johnhenry/aimatey-types';
import { createHandler } from '../../packages/cli/src/proxy.js';

function createMockRequest(body: string, url: string, method = 'POST'): IncomingMessage {
  const readable = Readable.from([Buffer.from(body, 'utf-8')]);
  Object.assign(readable, { method, url });
  return readable as unknown as IncomingMessage;
}

function createMockResponse() {
  const headers: Record<string, string> = {};
  const writes: string[] = [];
  let statusCode: number | undefined;
  const res = {
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value;
    }),
    writeHead: vi.fn((code: number, hdrs?: Record<string, string>) => {
      statusCode = code;
      if (hdrs) Object.assign(headers, hdrs);
    }),
    write: vi.fn((chunk: string) => writes.push(chunk)),
    end: vi.fn((chunk?: string) => {
      if (typeof chunk === 'string') writes.push(chunk);
    }),
  };
  return {
    res: res as unknown as ServerResponse,
    headers,
    status: () => statusCode,
    json: () => JSON.parse(writes.join('')),
  };
}

async function post(backend: BackendAdapter, url: string, body: unknown, format = 'openai') {
  const handler = createHandler(backend, format, false);
  const out = createMockResponse();
  await handler(createMockRequest(JSON.stringify(body), url), out.res);
  return out;
}

const answers: Record<string, IRDecisionAnswer> = {
  team: { type: 'choice', value: 'billing', probabilities: { billing: 0.9, tech: 0.1 }, confidence: 0.9 },
  urgent: { type: 'noul', value: 0.8 },
};

const wireBody = {
  model: 'tev1:0.8b',
  state: 'refund please',
  questions: {
    team: { type: 'choice', instructions: 'Team?', criteria: { billing: 'money', tech: 'bugs' } },
    urgent: { type: 'noul', instructions: 'Urgent?' },
  },
};

const chatBody = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };

function chatBackend() {
  return new FunctionBackendAdapter({
    execute: async (request) => ({
      message: { role: 'assistant', content: 'chat reply' },
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      metadata: { requestId: request.metadata.requestId, timestamp: 1, provenance: {} },
    }),
    metadata: { name: 'chat-only' },
  });
}

describe('proxy decision routes', () => {
  it('serves /v1/systemone from a decision-only backend', async () => {
    const backend = createMockDecisionBackend({ answers });
    const out = await post(backend, '/v1/systemone', wireBody);

    expect(out.status()).toBe(200);
    expect(out.headers['Content-Type']).toBe('application/json');
    expect(out.json().answers.team.choice).toBe('billing');
    expect(out.json().answers.urgent).toEqual({ noul: 0.8 });
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]!.parameters?.model).toBe('tev1:0.8b');
  });

  it('serves /v1/decisions in the openrouter shape and /v1/evaluate in the vercel shape', async () => {
    const backend = createMockDecisionBackend({ answers });
    const or = await post(backend, '/v1/decisions', wireBody);
    expect(or.json().answers.urgent).toEqual({ type: 'noul', noul: 0.8 });
    expect(or.json().id).toBeTruthy();

    const body = {
      ...wireBody,
      questions: { ...wireBody.questions, urgent: { type: 'boolean', instructions: 'Urgent?' } },
    };
    const vercel = await post(backend, '/v1/evaluate', body);
    expect(vercel.json().answers.urgent).toEqual({ type: 'boolean', probability: 0.8 });
  });

  it('ignores the query string and the --format when routing a decision path', async () => {
    const backend = createMockDecisionBackend({ answers });
    const out = await post(backend, '/typesafe/v1/systemone?x=1', wireBody, 'anthropic');
    expect(out.status()).toBe(200);
    expect(out.json().answers.team.choice).toBe('billing');
  });

  it('also serves decisions from a backend that has both chat and decide()', async () => {
    const both = Object.assign(chatBackend(), {
      decide: createMockDecisionBackend({ answers }).decide,
    });
    (both.metadata.capabilities as { decisions?: boolean }).decisions = true;
    expect((await post(both, '/v1/systemone', wireBody)).status()).toBe(200);
    expect((await post(both, '/v1/chat/completions', chatBody)).json().choices[0].message.content).toBe(
      'chat reply'
    );
  });

  it('answers a decision route on a chat-only backend with a 404', async () => {
    const out = await post(chatBackend(), '/v1/systemone', wireBody);
    expect(out.status()).toBe(404);
    expect(out.json().error).toMatch(/does not support typed decisions/);
  });

  it('answers a chat path on a decision-only backend with a clear 404, not a startup throw', async () => {
    const backend = createMockDecisionBackend({ answers });
    const out = await post(backend, '/v1/chat/completions', chatBody);
    expect(out.status()).toBe(404);
    expect(out.json().error.message).toMatch(/decision-only/);
    expect(out.json().error.message).toMatch(/\/v1\/systemone/);
    expect(backend.calls).toHaveLength(0);
  });

  it('still refuses a backend that can do neither', () => {
    const neither = { ...createMockDecisionBackend({ answers }), decide: undefined } as BackendAdapter;
    expect(() => createHandler(neither, 'openai', false)).toThrow(/neither chat nor decisions/);
  });

  it('keeps 405 for non-POST on a decision route', async () => {
    const handler = createHandler(createMockDecisionBackend({ answers }), 'openai', false);
    const out = createMockResponse();
    await handler(createMockRequest('', '/v1/systemone', 'GET'), out.res);
    expect(out.status()).toBe(405);
  });

  it('adds escalation headers when the response carries an escalation record', async () => {
    const backend = createMockDecisionBackend({
      handler: (request) => ({
        answers,
        model: 'big',
        metadata: {
          ...request.metadata,
          custom: {
            escalation: {
              triggeredBy: [{ question: 'team', reason: 'confidence_below' }],
              primaryModel: 'small',
            },
          },
        },
      }),
    });
    const out = await post(backend, '/v1/systemone', wireBody);
    expect(out.headers['x-aimatey-decision-fallback-triggered']).toBe('true');
    expect(out.headers['x-aimatey-decision-fallback-model']).toBe('big');
    expect(out.json().provider_metadata.gateway.routing.modelAttempts[0].triggeredBy).toEqual([
      { question: 'team', reason: 'confidence_below' },
    ]);
  });

  describe('errors use the dialect envelope and status', () => {
    it('400 for a malformed body, per dialect', async () => {
      const backend = createMockDecisionBackend({ answers });
      const bad = { state: 's' };
      expect((await post(backend, '/v1/systemone', bad)).json()).toEqual({ error: "'questions' must be a non-empty object" });
      expect((await post(backend, '/v1/decisions', bad)).json().error.code).toBe(400);
      const vercel = await post(backend, '/v1/evaluate', bad);
      expect(vercel.status()).toBe(400);
      expect(vercel.json().error.type).toBe('invalid_request_error');
    });

    it('400 for unparseable JSON', async () => {
      const handler = createHandler(createMockDecisionBackend({ answers }), 'openai', false);
      const out = createMockResponse();
      await handler(createMockRequest('{nope', '/v1/systemone'), out.res);
      expect(out.status()).toBe(400);
      expect(out.json().error).toMatch(/JSON/);
    });

    it('502 when the backend fails upstream', async () => {
      const backend = createMockDecisionBackend({
        error: new ProviderError({ code: ErrorCode.PROVIDER_ERROR, message: 'upstream down' }),
      });
      const out = await post(backend, '/v1/systemone', wireBody);
      expect(out.status()).toBe(502);
      expect(out.json().error).toBe('upstream down');
    });
  });
});
