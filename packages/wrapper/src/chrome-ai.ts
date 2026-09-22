/**
 * Chrome AI Language Model Wrapper
 *
 * Mimics the Chrome AI (window.ai.languageModel) API using any backend adapter.
 *
 * @module
 */

import type {
  BackendAdapter,
  IRChatRequest,
  IRMessage,
  StreamMode,
} from '@johnhenry/aimatey-types';
import { supportsChat, supportsChatStream } from '@johnhenry/aimatey-utils';
import { AdapterError, ErrorCode } from '@johnhenry/aimatey-errors';

// ============================================================================
// Types
// ============================================================================

export interface ChromeAIPrompt {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChromeAICreateOptions {
  initialPrompts?: ChromeAIPrompt[];
  temperature?: number;
  topK?: number;
  topP?: number;
  maxTokens?: number;
  model?: string;
  streamMode?: StreamMode;
}

export interface ChromeAISession {
  prompt(input: string): Promise<string>;
  promptStreaming(input: string): ReadableStream<string>;
  destroy(): void;
  clone(): ChromeAISession;
}

export interface ChromeAILanguageModelAPI {
  create(options?: ChromeAICreateOptions): ChromeAISession;
  capabilities(): Promise<{ available: 'readily' | 'after-download' | 'no' }>;
}

// ============================================================================
// Session Implementation
// ============================================================================

class ChromeAISessionImpl implements ChromeAISession {
  private backend: BackendAdapter;
  private conversationHistory: IRMessage[];
  private options: ChromeAICreateOptions;
  private destroyed = false;

  constructor(backend: BackendAdapter, options: ChromeAICreateOptions) {
    if (!supportsChat(backend) || !supportsChatStream(backend)) {
      throw new AdapterError({
        code: ErrorCode.UNSUPPORTED_FEATURE,
        message: `Backend '${backend.metadata.name}' does not support chat -- the Chrome AI wrapper requires a chat-capable backend (both execute and executeStream)`,
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
        topP: this.options.topP,
        maxTokens: this.options.maxTokens,
      },
      stream: false,
      metadata: {
        requestId: crypto.randomUUID(),
        timestamp: Date.now(),
        provenance: { frontend: 'chrome-ai-wrapper' },
      },
    };

    // Non-null: constructor verified chat support.
    const response = await this.backend.execute!(request);
    this.conversationHistory.push(response.message);

    return typeof response.message.content === 'string'
      ? response.message.content
      : response.message.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  }

  promptStreaming(input: string): ReadableStream<string> {
    if (this.destroyed) {
      throw new Error('Session has been destroyed');
    }

    const userMessage: IRMessage = { role: 'user', content: input };
    this.conversationHistory.push(userMessage);

    const streamMode = this.options.streamMode || 'accumulated';

    const request: IRChatRequest = {
      messages: [...this.conversationHistory],
      parameters: {
        model: this.options.model,
        temperature: this.options.temperature,
        topK: this.options.topK,
        topP: this.options.topP,
        maxTokens: this.options.maxTokens,
      },
      stream: true,
      streamMode,
      metadata: {
        requestId: crypto.randomUUID(),
        timestamp: Date.now(),
        provenance: { frontend: 'chrome-ai-wrapper' },
      },
    };

    const backend = this.backend;
    const conversationHistory = this.conversationHistory;
    let contentBuffer = '';

    return new ReadableStream<string>({
      async start(controller) {
        try {
          // Non-null: constructor verified chat support.
          const stream = backend.executeStream!(request);

          for await (const chunk of stream) {
            if (chunk.type === 'content') {
              contentBuffer += chunk.delta;
              if (streamMode === 'delta') {
                controller.enqueue(chunk.delta);
              } else {
                controller.enqueue(contentBuffer);
              }
            } else if (chunk.type === 'done') {
              if (chunk.message) {
                conversationHistory.push(chunk.message);
              }
              controller.close();
            } else if (chunk.type === 'error') {
              controller.error(new Error(chunk.error.message));
            }
          }
        } catch (error) {
          controller.error(error);
        }
      },
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.conversationHistory = [];
  }

  clone(): ChromeAISession {
    return new ChromeAISessionImpl(this.backend, {
      ...this.options,
      initialPrompts: this.conversationHistory
        .filter((msg) => msg.role === 'system')
        .map((msg) => ({
          role: msg.role as 'system',
          content: typeof msg.content === 'string' ? msg.content : '',
        })),
    });
  }
}

// ============================================================================
// Language Model Implementation
// ============================================================================

export function ChromeAILanguageModel(
  backend: BackendAdapter,
  defaultOptions: ChromeAICreateOptions = {}
): ChromeAILanguageModelAPI {
  return {
    create(options: ChromeAICreateOptions = {}): ChromeAISession {
      const mergedOptions: ChromeAICreateOptions = {
        ...defaultOptions,
        ...options,
        initialPrompts: [
          ...(defaultOptions.initialPrompts || []),
          ...(options.initialPrompts || []),
        ],
      };
      return new ChromeAISessionImpl(backend, mergedOptions);
    },

    async capabilities(): Promise<{ available: 'readily' | 'after-download' | 'no' }> {
      const isHealthy = backend.healthCheck ? await backend.healthCheck() : true;
      return { available: isHealthy ? 'readily' : 'no' };
    },
  };
}

export function createChromeAILanguageModel(backend: BackendAdapter) {
  return { languageModel: ChromeAILanguageModel(backend) };
}
