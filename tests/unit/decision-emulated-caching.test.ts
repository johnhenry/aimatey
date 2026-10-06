/**
 * An LLM-emulated decision is not cached by default (#147): the emulation
 * emits `capability-emulated`, which DEFAULT_UNCACHEABLE_WARNINGS lists.
 */

import { describe, it, expect } from 'vitest';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { createEmulatedDecisionBackend } from '@johnhenry/aimatey-patterns';
import {
  createDecisionCachingMiddleware,
  DEFAULT_UNCACHEABLE_WARNINGS,
} from '@johnhenry/aimatey-middleware';
import type { BackendAdapter, IRChatRequest, IRChatResponse } from '@johnhenry/aimatey-types';

function fakeChat() {
  let calls = 0;
  const adapter: BackendAdapter & { count: () => number } = {
    count: () => calls,
    metadata: {
      name: 'fake-chat',
      version: '1',
      provider: 'Fake',
      capabilities: {
        streaming: false,
        multiModal: false,
        structuredOutput: 'native',
        systemMessageStrategy: 'in-messages',
        supportsMultipleSystemMessages: true,
      },
    },
    execute(request: IRChatRequest): Promise<IRChatResponse> {
      calls++;
      return Promise.resolve({
        message: { role: 'assistant', content: '{"answers":{"urgent":true}}' },
        finishReason: 'stop',
        metadata: { ...request.metadata, warnings: undefined },
      });
    },
  };
  return adapter;
}

describe('emulated decisions and the caching middleware', () => {
  it('lists capability-emulated as uncacheable by default', () => {
    expect(DEFAULT_UNCACHEABLE_WARNINGS).toContain('capability-emulated');
  });

  it('does not cache a response from createEmulatedDecisionBackend', async () => {
    const chat = fakeChat();
    const bridge = new Bridge(
      new OpenAIFrontendAdapter(),
      createEmulatedDecisionBackend(chat, { model: 'm' })
    );
    bridge.useDecision(createDecisionCachingMiddleware({ unidentified: 'share' }));
    const questions = { urgent: { type: 'noul', instructions: 'Urgent?' } } as const;

    const first = await bridge.decide('same state', questions);
    await bridge.decide('same state', questions);

    expect(first.metadata.warnings?.some((w) => w.category === 'capability-emulated')).toBe(true);
    expect(chat.count()).toBe(2);
  });
});
