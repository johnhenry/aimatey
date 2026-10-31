/**
 * dispatchParallel(): every leg gets the model name its own backend knows,
 * and the 'custom' strategy hands the successful legs to `customAggregator`.
 */

import { describe, it, expect } from 'vitest';
import { Router } from '@johnhenry/aimatey-core';
import { MockBackendAdapter } from '@johnhenry/aimatey-backend-browser';
import type { IRChatRequest, IRChatResponse } from '@johnhenry/aimatey-types';

function textOf(content: IRChatResponse['message']['content']): string {
  return typeof content === 'string'
    ? content
    : content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

function request(model = 'gpt-4'): IRChatRequest {
  return {
    messages: [{ role: 'user', content: 'Hello!' }],
    parameters: { model },
    metadata: { requestId: 'req-parallel', timestamp: Date.now(), provenance: {} },
  };
}

function capturing(seen: Record<string, string>, name: string, text = name) {
  return new MockBackendAdapter({
    responseGenerator: (req) => {
      seen[name] = req.parameters?.model ?? '';
      return text;
    },
  });
}

describe('Router.dispatchParallel model translation', () => {
  it('translates the model separately for each backend', async () => {
    const seen: Record<string, string> = {};
    const router = new Router({ modelTranslation: { strategy: 'exact', warnOnDefault: false } });
    router.register('anthropic', capturing(seen, 'anthropic'));
    router.register('gemini', capturing(seen, 'gemini'));
    router.register('plain', capturing(seen, 'plain'));
    router.setBackendTranslationMapping('anthropic', { 'gpt-4': 'claude-sonnet-4-5' });
    router.setBackendTranslationMapping('gemini', { 'gpt-4': 'gemini-2.5-pro' });

    await router.dispatchParallel(request(), {
      strategy: 'all',
      backends: ['anthropic', 'gemini', 'plain'],
    });

    expect(seen).toEqual({
      anthropic: 'claude-sonnet-4-5',
      gemini: 'gemini-2.5-pro',
      plain: 'gpt-4',
    });
  });

  it('applies the global translation mapping to every leg', async () => {
    const seen: Record<string, string> = {};
    const router = new Router({ modelTranslation: { strategy: 'exact', warnOnDefault: false } });
    router.register('a', capturing(seen, 'a'));
    router.register('b', capturing(seen, 'b'));
    router.setModelTranslationMapping({ 'gpt-4': 'llama3.1:8b' });

    await router.dispatchParallel(request(), { strategy: 'all', backends: ['a', 'b'] });

    expect(seen).toEqual({ a: 'llama3.1:8b', b: 'llama3.1:8b' });
  });
});

describe('Router.dispatchParallel custom strategy', () => {
  it('calls customAggregator with every successful leg and returns its answer', async () => {
    const router = new Router();
    router.register('a', new MockBackendAdapter({ defaultResponse: 'alpha' }));
    router.register('b', new MockBackendAdapter({ defaultResponse: 'beta' }));

    let received: Array<{ backend: string; response: IRChatResponse; latencyMs: number }> = [];
    const result = await router.dispatchParallel(request(), {
      strategy: 'custom',
      backends: ['a', 'b'],
      customAggregator: (responses) => {
        received = responses;
        const text = responses
          .map((r) => textOf(r.response.message.content))
          .sort()
          .join(' + ');
        return { ...responses[0]!.response, message: { role: 'assistant', content: text } };
      },
    });

    expect(received.map((r) => r.backend).sort()).toEqual(['a', 'b']);
    expect(received.every((r) => typeof r.latencyMs === 'number')).toBe(true);
    expect(result.response.message.content).toBe('alpha + beta');
    expect(result.allResponses).toHaveLength(2);
    expect([...result.successfulBackends].sort()).toEqual(['a', 'b']);
  });

  it('accepts an async aggregator', async () => {
    const router = new Router();
    router.register('a', new MockBackendAdapter({ defaultResponse: 'alpha' }));

    const result = await router.dispatchParallel(request(), {
      strategy: 'custom',
      backends: ['a'],
      customAggregator: async (responses) => ({
        ...responses[0]!.response,
        message: { role: 'assistant', content: 'aggregated' },
      }),
    });

    expect(result.response.message.content).toBe('aggregated');
  });

  it('passes only successful legs to the aggregator', async () => {
    const router = new Router();
    router.register('ok', new MockBackendAdapter({ defaultResponse: 'fine' }));
    router.register(
      'bad',
      new MockBackendAdapter({
        responseGenerator: () => {
          throw new Error('boom');
        },
      })
    );

    const result = await router.dispatchParallel(request(), {
      strategy: 'custom',
      backends: ['ok', 'bad'],
      customAggregator: (responses) => {
        expect(responses.map((r) => r.backend)).toEqual(['ok']);
        return responses[0]!.response;
      },
    });

    expect(result.failedBackends.map((f) => f.backend)).toEqual(['bad']);
  });

  it("rejects the 'custom' strategy without an aggregator", async () => {
    const router = new Router();
    router.register('a', new MockBackendAdapter());
    await expect(
      router.dispatchParallel(request(), { strategy: 'custom', backends: ['a'] })
    ).rejects.toThrow(/customAggregator/);
  });

  it('wraps an aggregator that throws', async () => {
    const router = new Router();
    router.register('a', new MockBackendAdapter());
    await expect(
      router.dispatchParallel(request(), {
        strategy: 'custom',
        backends: ['a'],
        customAggregator: () => {
          throw new Error('nope');
        },
      })
    ).rejects.toThrow(/customAggregator failed: nope/);
  });
});
