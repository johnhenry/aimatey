/**
 * Legacy Chrome AI Language Model Wrapper
 *
 * Mimics the ORIGINAL Chrome AI (window.ai.languageModel) API before recent changes.
 *
 * @module
 */

import type { BackendAdapter, IRChatRequest, IRMessage } from '@johnhenry/aimatey-types';
import { trimHistory, supportsChat, supportsChatStream } from '@johnhenry/aimatey-utils';
import { AdapterError, ErrorCode } from '@johnhenry/aimatey-errors';

// ============================================================================
// Types
// ============================================================================

export interface LegacyChromeAIPrompt {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LegacyChromeAICreateOptions {
  initialPrompts?: LegacyChromeAIPrompt[];
  temperature?: number;
  topK?: number;
  maxTokens?: number;
  model?: string;
  maxHistorySize?: number;
}

export interface LegacyChromeAISession {
  prompt(input: string): Promise<string>;
  promptStreaming(input: string): AsyncIterable<string>;
  destroy(): void;
  clone(): LegacyChromeAISession;
  tokensSoFar?: number;
  maxTokens?: number;
  tokensLeft?: number;
}

export interface LegacyChromeAILanguageModelAPI {
  create(options?: LegacyChromeAICreateOptions): LegacyChromeAISession;
  capabilities(): Promise<{
    available: 'yes' | 'no' | 'after-download';
    defaultTemperature?: number;
    defaultTopK?: number;
    maxTopK?: number;
  }>;
}

// ============================================================================
// Session Implementation
// ============================================================================

class LegacyChromeAISessionImpl implements LegacyChromeAISession {
  private backend: BackendAdapter;
  private conversationHistory: IRMessage[];
  private options: LegacyChromeAICreateOptions;
  private destroyed = false;
  private _tokensSoFar = 0;

  constructor(backend: BackendAdapter, options: LegacyChromeAICreateOptions) {
    if (!supportsChat(backend) || !supportsChatStream(backend)) {
      throw new AdapterError({
        code: ErrorCode.UNSUPPORTED_FEATURE,
        message: `Backend '${backend.metadata.name}' does not support chat -- the Chrome AI (legacy) wrapper requires a chat-capable backend (both execute and executeStream)`,
        isRetryable: false,
        provenance: { backend: backend.metadata.name },
      });
    }
    this.backend = backend;
    this.options = options;
    this.conversationHistory =
      options.initialPrompts?.map((prompt) => ({
        role: prompt.role,
        content: prompt.content,
      })) || [];
  }

  get tokensSoFar(): number {
    return this._tokensSoFar;
  }
  get maxTokens(): number {
    return this.options.maxTokens || 1024;
  }
  get tokensLeft(): number {
    return Math.max(0, this.maxTokens - this._tokensSoFar);
  }

  async prompt(input: string): Promise<string> {
    if (this.destroyed) {
      throw new Error('Session has been destroyed');
    }

    const userMessage: IRMessage = { role: 'user', content: input };
    this.conversationHistory.push(userMessage);

    const request: IRChatRequest = {
      messages: [...this.conversationHistory],
      parameters: {
        model: this.options.model,
        temperature: this.options.temperature,
        topK: this.options.topK,
        maxTokens: this.options.maxTokens,
      },
      stream: false,
      metadata: {
        requestId: crypto.randomUUID(),
        timestamp: Date.now(),
        provenance: { frontend: 'chrome-ai-legacy-wrapper' },
      },
    };

    // Non-null: constructor verified chat support.
    const response = await this.backend.execute!(request);
    this.conversationHistory.push(response.message);

    if (this.options.maxHistorySize !== undefined && this.options.maxHistorySize !== -1) {
      this.conversationHistory = trimHistory(
        this.conversationHistory,
        this.options.maxHistorySize,
        'smart'
      );
    }

    if (response.usage) {
      this._tokensSoFar = response.usage.totalTokens;
    } else {
      this._tokensSoFar += Math.ceil(input.length / 4);
      const responseText =
        typeof response.message.content === 'string'
          ? response.message.content
          : response.message.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
      this._tokensSoFar += Math.ceil(responseText.length / 4);
    }

    return typeof response.message.content === 'string'
      ? response.message.content
      : response.message.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  }

  async *promptStreaming(input: string): AsyncIterable<string> {
    if (this.destroyed) {
      throw new Error('Session has been destroyed');
    }

    const userMessage: IRMessage = { role: 'user', content: input };
    this.conversationHistory.push(userMessage);

    const request: IRChatRequest = {
      messages: [...this.conversationHistory],
      parameters: {
        model: this.options.model,
        temperature: this.options.temperature,
        topK: this.options.topK,
        maxTokens: this.options.maxTokens,
      },
      stream: true,
      metadata: {
        requestId: crypto.randomUUID(),
        timestamp: Date.now(),
        provenance: { frontend: 'chrome-ai-legacy-wrapper' },
      },
    };

    let fullContent = '';

    // Non-null: constructor verified chat support.
    const stream = this.backend.executeStream!(request);

    for await (const chunk of stream) {
      if (chunk.type === 'content') {
        fullContent += chunk.delta;
        yield chunk.delta;
      } else if (chunk.type === 'done') {
        if (chunk.message) {
          this.conversationHistory.push(chunk.message);
        }

        if (this.options.maxHistorySize !== undefined && this.options.maxHistorySize !== -1) {
          this.conversationHistory = trimHistory(
            this.conversationHistory,
            this.options.maxHistorySize,
            'smart'
          );
        }

        if (chunk.usage) {
          this._tokensSoFar = chunk.usage.totalTokens;
        } else {
          this._tokensSoFar += Math.ceil(input.length / 4);
          this._tokensSoFar += Math.ceil(fullContent.length / 4);
        }
      } else if (chunk.type === 'error') {
        throw new Error(chunk.error.message);
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.conversationHistory = [];
    this._tokensSoFar = 0;
  }

  clone(): LegacyChromeAISession {
    return new LegacyChromeAISessionImpl(this.backend, {
      ...this.options,
      initialPrompts: this.options.initialPrompts,
    });
  }
}

// ============================================================================
// Language Model Implementation
// ============================================================================

export function LegacyChromeAILanguageModel(
  backend: BackendAdapter
): LegacyChromeAILanguageModelAPI {
  return {
    create(options: LegacyChromeAICreateOptions = {}): LegacyChromeAISession {
      return new LegacyChromeAISessionImpl(backend, options);
    },

    async capabilities(): Promise<{
      available: 'yes' | 'no' | 'after-download';
      defaultTemperature?: number;
      defaultTopK?: number;
      maxTopK?: number;
    }> {
      const isHealthy = backend.healthCheck ? await backend.healthCheck() : true;
      return {
        available: isHealthy ? 'yes' : 'no',
        defaultTemperature: 0.7,
        defaultTopK: 40,
        maxTopK: 100,
      };
    },
  };
}

export function createLegacyWindowAI(backend: BackendAdapter) {
  return { languageModel: LegacyChromeAILanguageModel(backend) };
}

export function polyfillLegacyWindowAI(backend: BackendAdapter): void {
  if (typeof globalThis !== 'undefined') {
    (globalThis as any).ai = createLegacyWindowAI(backend);
  }
}
