/**
 * What a proxying adapter may forward (#124)
 *
 * In one process `metadata.custom` is a private convention between two files
 * and `raw` is the provider's own payload. Across a trust boundary the first
 * is a claim the far side's middleware will obey and the second is an
 * unredacted payload the provider never knew would leave. These tests pin the
 * forward / strip / rewrite classification `prepareForwardedRequest()` and
 * `prepareForwardedResponse()` encode.
 */

import { describe, it, expect } from 'vitest';
import {
  prepareForwardedRequest,
  prepareForwardedResponse,
  FORWARDED_CUSTOM_PREFIX,
} from '@johnhenry/aimatey-utils';
import type { IRChatRequest, IRChatResponse, IRWarning } from '@johnhenry/aimatey-types';

function request(): IRChatRequest {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    parameters: { model: 'm', temperature: 0.2 },
    metadata: {
      requestId: 'req-124',
      timestamp: 1000,
      provenance: { frontend: 'openai', middleware: ['logging'] },
      principal: 'tenant-7:user-42',
      warnings: [
        {
          category: 'parameter-normalized',
          severity: 'info',
          message: 'scaled',
          field: 'temperature',
        },
      ],
      custom: {
        backend: 'local-only',
        local: true,
        'e2e:traceId': 'abc',
        capabilityRequirements: { required: {} },
      },
    },
  } as IRChatRequest;
}

function farResponse(): IRChatResponse {
  return {
    message: { role: 'assistant', content: 'answer' },
    finishReason: 'stop',
    usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    metadata: {
      requestId: 'req-124',
      timestamp: 2000,
      providerResponseId: 'chatcmpl-9',
      provenance: { frontend: 'openai', backend: 'llama-cpp', servedModel: 'qwen' },
      warnings: [
        {
          category: 'transport-degraded',
          severity: 'warning',
          message: 'reconnected',
          source: 'llama-cpp',
        } as IRWarning,
        { category: 'parameter-clamped', severity: 'info', message: 'clamped' } as IRWarning,
      ],
      custom: { 'e2e:traceId': 'abc', local: true, engine: 'metal' },
    },
    raw: { id: 'chatcmpl-9', secretProviderField: 'x'.repeat(10) },
  } as IRChatResponse;
}

describe('prepareForwardedRequest', () => {
  it('forwards only metadata.custom keys the application marked with the e2e: prefix', () => {
    const out = prepareForwardedRequest(request(), { proxyName: 'tunnel' });

    expect(FORWARDED_CUSTOM_PREFIX).toBe('e2e:');
    expect(out.metadata.custom).toEqual({ 'e2e:traceId': 'abc' });
  });

  it('drops the custom bag entirely when nothing is marked', () => {
    const req = request();
    const out = prepareForwardedRequest(
      { ...req, metadata: { ...req.metadata, custom: { local: true } } },
      { proxyName: 'tunnel' }
    );

    expect('custom' in out.metadata).toBe(false);
  });

  it('keeps requestId (it is the cancel and correlation key) and the semantic payload', () => {
    const out = prepareForwardedRequest(request(), { proxyName: 'tunnel' });

    expect(out.metadata.requestId).toBe('req-124');
    expect(out.messages).toEqual(request().messages);
    expect(out.parameters).toEqual(request().parameters);
    expect(out.metadata.warnings).toEqual(request().metadata.warnings);
  });

  it('never forwards principal: the far side sees the proxy as its caller', () => {
    const out = prepareForwardedRequest(request(), { proxyName: 'tunnel' });

    expect('principal' in out.metadata).toBe(false);
  });

  it('appends this hop to the request provenance middleware chain rather than replacing it', () => {
    const out = prepareForwardedRequest(request(), { proxyName: 'tunnel' });

    expect(out.metadata.provenance).toEqual({
      frontend: 'openai',
      middleware: ['logging', 'tunnel'],
    });
  });

  it('does not mutate its input', () => {
    const req = request();
    const snapshot = JSON.stringify(req);
    prepareForwardedRequest(req, { proxyName: 'tunnel' });

    expect(JSON.stringify(req)).toBe(snapshot);
  });
});

describe('prepareForwardedResponse', () => {
  it('never forwards raw', () => {
    const out = prepareForwardedResponse(farResponse(), { proxyName: 'tunnel' });

    expect('raw' in out).toBe(false);
  });

  it('nests the far side provenance under the proxy hop instead of adopting it', () => {
    const out = prepareForwardedResponse(farResponse(), { proxyName: 'tunnel' });

    expect(out.metadata.provenance).toEqual({
      backend: 'tunnel',
      // The proxy's own hop declares its link (#174); a proxy fails closed.
      locality: 'external',
      upstream: { frontend: 'openai', backend: 'llama-cpp', servedModel: 'qwen' },
    });
  });

  it('attaches provenance-lost when provenance was expected and missing, and only then', () => {
    const far = farResponse();
    const bare = { ...far, metadata: { ...far.metadata, provenance: undefined } };

    const expected = prepareForwardedResponse(bare, {
      proxyName: 'tunnel',
      expectProvenance: true,
    });
    expect(expected.metadata.warnings?.some((w) => w.category === 'provenance-lost')).toBe(true);
    expect(expected.metadata.provenance).toEqual({ backend: 'tunnel', locality: 'external' });

    const notExpected = prepareForwardedResponse(bare, { proxyName: 'tunnel' });
    expect(
      (notExpected.metadata.warnings ?? []).some((w) => w.category === 'provenance-lost')
    ).toBe(false);

    const present = prepareForwardedResponse(far, { proxyName: 'tunnel', expectProvenance: true });
    expect((present.metadata.warnings ?? []).some((w) => w.category === 'provenance-lost')).toBe(
      false
    );
  });

  it('merges far-side warnings and prefixes source with the hop they came through', () => {
    const out = prepareForwardedResponse(farResponse(), { proxyName: 'tunnel' });
    const warnings = out.metadata.warnings ?? [];

    expect(warnings.map((w) => w.category)).toEqual(['transport-degraded', 'parameter-clamped']);
    expect(warnings[0]?.source).toBe('tunnel/llama-cpp');
    expect(warnings[1]?.source).toBe('tunnel/upstream');
  });

  it('applies the same custom prefix rule to response metadata', () => {
    const out = prepareForwardedResponse(farResponse(), { proxyName: 'tunnel' });

    expect(out.metadata.custom).toEqual({ 'e2e:traceId': 'abc' });
  });

  it('keeps requestId, providerResponseId, message and usage', () => {
    const out = prepareForwardedResponse(farResponse(), { proxyName: 'tunnel' });

    expect(out.metadata.requestId).toBe('req-124');
    expect(out.metadata.providerResponseId).toBe('chatcmpl-9');
    expect(out.message).toEqual(farResponse().message);
    expect(out.usage).toEqual(farResponse().usage);
    expect(out.finishReason).toBe('stop');
  });

  it('does not mutate its input', () => {
    const far = farResponse();
    const snapshot = JSON.stringify(far);
    prepareForwardedResponse(far, { proxyName: 'tunnel' });

    expect(JSON.stringify(far)).toBe(snapshot);
  });
});
