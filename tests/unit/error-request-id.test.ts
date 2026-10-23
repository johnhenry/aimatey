/**
 * Provider request id on errors (#213)
 *
 * The provider's own request id (x-request-id, Anthropic's request-id, AWS's x-amzn-requestid, ...)
 * is kept on error.details.requestId and passed through in stream error chunk details.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createErrorFromHttpResponse,
  extractRequestId,
  AdapterError,
} from '@johnhenry/aimatey-errors';
import { OpenAIBackendAdapter, AnthropicBackendAdapter } from '@johnhenry/aimatey-backend';
import type { IRChatRequest } from '@johnhenry/aimatey-types';

const PROV = { backend: 'test' };

describe('createErrorFromHttpResponse request id', () => {
  it.each([
    ['x-request-id', 'req_7f3'],
    ['request-id', 'req_011abc'],
    ['x-amzn-requestid', 'aws-1234'],
    ['x-amzn-request-id', 'aws-5678'],
    ['x-ms-request-id', 'ms-1'],
  ])('reads %s', (header, value) => {
    const e = createErrorFromHttpResponse(401, '', { error: { message: 'x' } }, PROV, {
      [header]: value,
    });
    expect(e.details?.requestId).toBe(value);
  });

  it('works with a Headers instance and on every status class', () => {
    const headers = new Headers({ 'X-Request-Id': 'req_h' });
    for (const status of [400, 401, 403, 404, 418, 429, 500, 503]) {
      expect(
        createErrorFromHttpResponse(status, '', 'boom', PROV, headers).details?.requestId
      ).toBe('req_h');
    }
  });

  it('is absent when no header is present', () => {
    const e = createErrorFromHttpResponse(401, '', 'x', PROV, new Headers());
    expect(e.details).not.toHaveProperty('requestId');
    expect(extractRequestId(undefined)).toBeUndefined();
  });
});

function req(model: string): IRChatRequest {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    parameters: { model },
    metadata: { requestId: 'r', timestamp: 0, provenance: {} },
  } as IRChatRequest;
}

function stubFetch(status: number, headers: Record<string, string>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status, headers })
    )
  );
}

const ADAPTERS: Array<[string, () => any, string, string]> = [
  ['openai', () => new OpenAIBackendAdapter({ apiKey: 'bad' }), 'gpt-4o', 'x-request-id'],
  [
    'anthropic',
    () => new AnthropicBackendAdapter({ apiKey: 'bad' }),
    'claude-sonnet-4-5',
    'request-id',
  ],
];

describe.each(ADAPTERS)('%s request id', (_n, make, model, header) => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([401, 429, 500])('execute %i keeps the request id', async (status) => {
    stubFetch(status, { [header]: 'req_7f3' });
    const e = (await make()
      .execute(req(model))
      .catch((err: unknown) => err)) as AdapterError;
    expect(e).toBeInstanceOf(AdapterError);
    expect(e.details?.requestId).toBe('req_7f3');
  });

  it.each([401, 429, 500])('executeStream %i passes it in error details', async (status) => {
    stubFetch(status, { [header]: 'req_7f3' });
    const chunks: any[] = [];
    for await (const c of make().executeStream(req(model))) chunks.push(c);
    const err = chunks.find((c) => c.type === 'error');
    expect(err.error.details).toMatchObject({ statusCode: status, requestId: 'req_7f3' });
  });
});
