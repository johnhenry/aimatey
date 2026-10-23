/**
 * HTTP failure mapping (aimatey#193)
 *
 * Provider HTTP errors must keep the provider's status and message, map to the right error class and
 * retryability, and never be re-wrapped as a retryable PROVIDER_ERROR by the adapter's catch block.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AdapterError,
  AuthenticationError,
  AuthorizationError,
  RateLimitError,
  ValidationError,
  ProviderError,
  createErrorFromHttpResponse,
  ErrorCode,
} from '@johnhenry/aimatey-errors';
import {
  OpenAIBackendAdapter,
  AnthropicBackendAdapter,
  OpenRouterBackendAdapter,
  GroqBackendAdapter,
  OllamaBackendAdapter,
} from '@johnhenry/aimatey-backend';
import type { IRChatRequest } from '@johnhenry/aimatey-types';

const PROV = { backend: 'test' };

describe('createErrorFromHttpResponse mapping', () => {
  it('401 -> AuthenticationError, non-retryable, keeps status and provider message with empty statusText', () => {
    const e = createErrorFromHttpResponse(
      401,
      '',
      { error: { message: 'Incorrect API key provided' } },
      PROV
    ) as AuthenticationError;
    expect(e).toBeInstanceOf(AuthenticationError);
    expect(e.code).toBe(ErrorCode.INVALID_API_KEY);
    expect(e.isRetryable).toBe(false);
    expect(e.message).toContain('Incorrect API key provided');
    expect(e.statusCode).toBe(401);
    expect(e.providerMessage).toBe('Incorrect API key provided');
    expect(e.details?.responseBody).toBeDefined();
  });

  it('403 -> AuthorizationError, non-retryable', () => {
    const e = createErrorFromHttpResponse(
      403,
      '',
      '{"error":{"message":"insufficient quota"}}',
      PROV
    );
    expect(e).toBeInstanceOf(AuthorizationError);
    expect(e.isRetryable).toBe(false);
    expect(e.message).toContain('insufficient quota');
    expect(e.statusCode).toBe(403);
  });

  it('429 -> RateLimitError, retryable, retryAfter (ms) from numeric Retry-After header', () => {
    const e = createErrorFromHttpResponse(
      429,
      '',
      { error: { message: 'Slow down' } },
      PROV,
      new Headers({ 'retry-after': '7' })
    ) as RateLimitError;
    expect(e).toBeInstanceOf(RateLimitError);
    expect(e.isRetryable).toBe(true);
    expect(e.retryAfter).toBe(7000);
    expect(e.message).toContain('Slow down');
    expect(e.statusCode).toBe(429);
  });

  it('429 parses an HTTP-date Retry-After and retry-after-ms', () => {
    const date = new Date(Date.now() + 30_000).toUTCString();
    const a = createErrorFromHttpResponse(429, '', '', PROV, {
      'Retry-After': date,
    }) as RateLimitError;
    expect(a.retryAfter).toBeGreaterThan(20_000);
    expect(a.retryAfter).toBeLessThanOrEqual(30_000);
    const b = createErrorFromHttpResponse(
      429,
      '',
      '',
      PROV,
      new Headers({ 'retry-after-ms': '250' })
    ) as RateLimitError;
    expect(b.retryAfter).toBe(250);
    const c = createErrorFromHttpResponse(429, '', '', PROV) as RateLimitError;
    expect(c.retryAfter).toBeUndefined();
  });

  it('400 -> ValidationError, non-retryable, keeps message', () => {
    const e = createErrorFromHttpResponse(
      400,
      '',
      { error: { message: 'context length exceeded' } },
      PROV
    );
    expect(e).toBeInstanceOf(ValidationError);
    expect(e.code).toBe(ErrorCode.INVALID_REQUEST);
    expect(e.isRetryable).toBe(false);
    expect(e.message).toContain('context length exceeded');
    expect(e.statusCode).toBe(400);
  });

  it.each([404, 410])('%i with a model message -> UNSUPPORTED_MODEL, non-retryable', (status) => {
    const e = createErrorFromHttpResponse(
      status,
      '',
      { error: { message: "The model 'gpt-9' does not exist" } },
      PROV
    );
    expect(e).toBeInstanceOf(ValidationError);
    expect(e.code).toBe(ErrorCode.UNSUPPORTED_MODEL);
    expect(e.isRetryable).toBe(false);
    expect(e.statusCode).toBe(status);
  });

  it('404 without a model message stays a non-retryable AdapterError carrying the message', () => {
    const e = createErrorFromHttpResponse(404, '', 'Not found: /v1/chat', PROV);
    expect(e.code).toBe(ErrorCode.PROVIDER_ERROR);
    expect(e.isRetryable).toBe(false);
    expect(e.message).toContain('Not found');
    expect(e.statusCode).toBe(404);
  });

  it('5xx -> ProviderError, retryable, keeps message and status', () => {
    const e = createErrorFromHttpResponse(503, '', { error: { message: 'overloaded' } }, PROV);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.isRetryable).toBe(true);
    expect(e.message).toContain('overloaded');
    expect(e.statusCode).toBe(503);
  });

  it('extracts message from common body shapes', () => {
    expect(createErrorFromHttpResponse(400, '', { message: 'm1' }, PROV).providerMessage).toBe(
      'm1'
    );
    expect(createErrorFromHttpResponse(400, '', { error: 'm2' }, PROV).providerMessage).toBe('m2');
    expect(createErrorFromHttpResponse(400, '', { detail: 'm3' }, PROV).providerMessage).toBe('m3');
    expect(
      createErrorFromHttpResponse(400, '', [{ error: { message: 'm4' } }], PROV).providerMessage
    ).toBe('m4');
    expect(createErrorFromHttpResponse(400, '', 'plain text oops', PROV).providerMessage).toBe(
      'plain text oops'
    );
  });

  it('falls back to statusText, then to the bare status, when the body has no message', () => {
    expect(createErrorFromHttpResponse(401, 'Unauthorized', {}, PROV).message).toContain(
      'Unauthorized'
    );
    expect(createErrorFromHttpResponse(401, '', '', PROV).message).toContain('401');
  });

  it('redacts API keys and bearer tokens echoed by the provider', () => {
    const body = {
      error: {
        message:
          'Incorrect API key provided: sk-proj-abcdefghijklmnop1234. Authorization: Bearer abc.def.ghi-123456 ' +
          'key=AIzaSyA1234567890abcdefghijklmnopqrstu x-api-key: ant-secret-value-xyz',
      },
    };
    const e = createErrorFromHttpResponse(401, '', body, PROV);
    const blob = JSON.stringify({ m: e.message, p: e.providerMessage, d: e.details });
    for (const secret of [
      'sk-proj-abcdefghijklmnop1234',
      'abc.def.ghi-123456',
      'AIzaSyA1234567890abcdefghijklmnopqrstu',
      'ant-secret-value-xyz',
    ]) {
      expect(blob).not.toContain(secret);
    }
    expect(e.message).toContain('Incorrect API key provided');
    expect(e.message).toContain('[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// Adapter level: errors must pass through execute() / executeStream() unwrapped
// ---------------------------------------------------------------------------

function req(model: string): IRChatRequest {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    parameters: { model },
    metadata: { requestId: 'r', timestamp: 0, provenance: {} },
  } as IRChatRequest;
}

function stubFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
    )
  );
}

const ADAPTERS: Array<
  [
    string,
    () => {
      execute(r: IRChatRequest): Promise<unknown>;
      executeStream(r: IRChatRequest): AsyncIterable<unknown>;
    },
    string,
  ]
> = [
  ['openai', () => new OpenAIBackendAdapter({ apiKey: 'bad' }) as any, 'gpt-4o'],
  ['anthropic', () => new AnthropicBackendAdapter({ apiKey: 'bad' }) as any, 'claude-sonnet-4-5'],
  [
    'openrouter',
    () => new OpenRouterBackendAdapter({ apiKey: 'bad' }) as any,
    'meta-llama/llama-3.3-70b-instruct',
  ],
  ['groq', () => new GroqBackendAdapter({ apiKey: 'bad' }) as any, 'llama-3.3-70b-versatile'],
  ['ollama', () => new OllamaBackendAdapter({}) as any, 'llama3'],
];

async function catchErr(p: () => Promise<unknown>): Promise<AdapterError> {
  try {
    await p();
  } catch (e) {
    return e as AdapterError;
  }
  throw new Error('expected rejection');
}

describe.each(ADAPTERS)('%s adapter surfaces HTTP errors unwrapped', (_name, make, model) => {
  afterEach(() => vi.unstubAllGlobals());

  it('401 is AuthenticationError (not retryable) with the provider message', async () => {
    stubFetch(401, { error: { message: 'Incorrect API key provided' } });
    const e = await catchErr(() => make().execute(req(model)));
    expect(e).toBeInstanceOf(AuthenticationError);
    expect(e.isRetryable).toBe(false);
    expect(e.message).toContain('Incorrect API key provided');
    expect(e.statusCode).toBe(401);
  });

  it('429 is RateLimitError with retryAfter', async () => {
    stubFetch(429, { error: { message: 'Rate limit reached' } }, { 'retry-after': '3' });
    const e = (await catchErr(() => make().execute(req(model)))) as RateLimitError;
    expect(e).toBeInstanceOf(RateLimitError);
    expect(e.retryAfter).toBe(3000);
    expect(e.message).toContain('Rate limit reached');
  });

  it('400 is a non-retryable ValidationError', async () => {
    stubFetch(400, { error: { message: 'bad param' } });
    const e = await catchErr(() => make().execute(req(model)));
    expect(e).toBeInstanceOf(ValidationError);
    expect(e.isRetryable).toBe(false);
    expect(e.message).toContain('bad param');
  });

  it('500 stays retryable and keeps the message', async () => {
    stubFetch(500, { error: { message: 'upstream blew up' } });
    const e = await catchErr(() => make().execute(req(model)));
    expect(e.isRetryable).toBe(true);
    expect(e.message).toContain('upstream blew up');
    expect(e.statusCode).toBe(500);
  });

  it('streaming 401 yields an error chunk with the provider message, status and non-retryable details', async () => {
    stubFetch(401, { error: { message: 'Incorrect API key provided' } });
    const chunks: any[] = [];
    for await (const c of make().executeStream(req(model))) chunks.push(c);
    const err = chunks.find((c) => c.type === 'error');
    expect(err).toBeDefined();
    expect(err.error.message).toContain('Incorrect API key provided');
    expect(err.error.details).toMatchObject({
      statusCode: 401,
      retryable: false,
      errorCode: ErrorCode.INVALID_API_KEY,
    });
  });

  it('streaming 429 reports retryAfter in details', async () => {
    stubFetch(429, { error: { message: 'Rate limit reached' } }, { 'retry-after': '2' });
    const chunks: any[] = [];
    for await (const c of make().executeStream(req(model))) chunks.push(c);
    const err = chunks.find((c) => c.type === 'error');
    expect(err.error.details).toMatchObject({ statusCode: 429, retryable: true, retryAfter: 2000 });
  });
});
