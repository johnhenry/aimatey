/**
 * Anymethod Wrapper
 *
 * Natural language method interface using Proxy pattern.
 *
 * @module
 */

import type { BackendAdapter, IRChatRequest, IRMessage } from '@johnhenry/aimatey-types';
import { trimHistory, supportsChat, supportsChatStream } from '@johnhenry/aimatey-utils';
import { AdapterError, ErrorCode } from '@johnhenry/aimatey-errors';

// ============================================================================
// Types
// ============================================================================

export interface AnymethodConfig {
  model?: string;
  temperature?: number;
  topK?: number;
  topP?: number;
  maxTokens?: number;
  maxHistorySize?: number;
  initialPrompts?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  autoParseJSON?: boolean;
  methodPromptFormatter?: (methodName: string, args: unknown[]) => string;
}

export interface Anymethod {
  readonly $: AnymethodProxy;
  readonly $$: AnymethodStreamProxy;
  prompt(input: string): Promise<string>;
  promptStreaming(input: string): AsyncIterable<string>;
  getHistory(): readonly IRMessage[];
  clearHistory(): void;
  setHistory(history: IRMessage[]): void;
  tokensSoFar: number;
  maxTokens: number;
  tokensLeft: number;
}

export type AnymethodProxy = {
  [key: string]: (...args: unknown[]) => Promise<unknown>;
};

export type AnymethodStreamProxy = {
  [key: string]: (...args: unknown[]) => AsyncIterable<string>;
};

// ============================================================================
// Utility Functions
// ============================================================================

export function formatMethodPrompt(methodName: string, args: unknown[]): string {
  const naturalName = methodName
    .replace(/([A-Z])/g, ' $1')
    .toLowerCase()
    .trim();

  const argsString = args.map((arg) => String(arg)).join(' ');

  if (argsString) {
    return `${naturalName}: ${argsString}`;
  }

  return naturalName;
}

// ============================================================================
// Anymethod Implementation
// ============================================================================

export function createAnymethod(backend: BackendAdapter, config: AnymethodConfig = {}): Anymethod {
  if (!supportsChat(backend) || !supportsChatStream(backend)) {
    throw new AdapterError({
      code: ErrorCode.UNSUPPORTED_FEATURE,
      message: `Backend '${backend.metadata.name}' does not support chat -- anymethod requires a chat-capable backend (both execute and executeStream)`,
      isRetryable: false,
      provenance: { backend: backend.metadata.name },
    });
  }

  const {
    model,
    temperature,
    topK,
    topP,
    maxTokens = 1024,
    maxHistorySize = 0,
    initialPrompts = [],
    autoParseJSON = true,
    methodPromptFormatter = formatMethodPrompt,
  } = config;

  let conversationHistory: IRMessage[] = initialPrompts.map((p) => ({
    role: p.role,
    content: p.content,
  }));
  let _tokensSoFar = 0;

  async function executePrompt(input: string): Promise<string> {
    const userMessage: IRMessage = { role: 'user', content: input };
    conversationHistory.push(userMessage);

    const request: IRChatRequest = {
      messages: [...conversationHistory],
      parameters: { model, temperature, topK, topP, maxTokens },
      stream: false,
      metadata: {
        requestId: crypto.randomUUID(),
        timestamp: Date.now(),
        provenance: { frontend: 'anymethod-wrapper' },
      },
    };

    // Non-null: createAnymethod's guard verified chat support.
    const response = await backend.execute!(request);
    conversationHistory.push(response.message);

    if (maxHistorySize !== undefined && maxHistorySize !== -1) {
      conversationHistory = trimHistory(conversationHistory, maxHistorySize, 'smart');
    }

    if (response.usage) {
      _tokensSoFar = response.usage.totalTokens;
    } else {
      _tokensSoFar += Math.ceil(input.length / 4);
      const responseText =
        typeof response.message.content === 'string'
          ? response.message.content
          : response.message.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
      _tokensSoFar += Math.ceil(responseText.length / 4);
    }

    return typeof response.message.content === 'string'
      ? response.message.content
      : response.message.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  }

  async function* executeStreamingPrompt(input: string): AsyncIterable<string> {
    const userMessage: IRMessage = { role: 'user', content: input };
    conversationHistory.push(userMessage);

    const request: IRChatRequest = {
      messages: [...conversationHistory],
      parameters: { model, temperature, topK, topP, maxTokens },
      stream: true,
      metadata: {
        requestId: crypto.randomUUID(),
        timestamp: Date.now(),
        provenance: { frontend: 'anymethod-wrapper' },
      },
    };

    let fullContent = '';

    // Non-null: createAnymethod's guard verified chat support.
    const stream = backend.executeStream!(request);

    for await (const chunk of stream) {
      if (chunk.type === 'content') {
        fullContent += chunk.delta;
        yield chunk.delta;
      } else if (chunk.type === 'done') {
        if (chunk.message) {
          conversationHistory.push(chunk.message);
        }

        if (maxHistorySize !== undefined && maxHistorySize !== -1) {
          conversationHistory = trimHistory(conversationHistory, maxHistorySize, 'smart');
        }

        if (chunk.usage) {
          _tokensSoFar = chunk.usage.totalTokens;
        } else {
          _tokensSoFar += Math.ceil(input.length / 4);
          _tokensSoFar += Math.ceil(fullContent.length / 4);
        }
      } else if (chunk.type === 'error') {
        throw new Error(chunk.error.message);
      }
    }
  }

  const asyncProxy = new Proxy(
    {},
    {
      get(_target, prop: string) {
        return async (...args: unknown[]): Promise<unknown> => {
          const prompt = methodPromptFormatter(prop, args);
          const result = await executePrompt(prompt);

          if (autoParseJSON) {
            try {
              return JSON.parse(result);
            } catch {
              return result;
            }
          }

          return result;
        };
      },
    }
  ) as AnymethodProxy;

  const streamProxy = new Proxy(
    {},
    {
      get(_target, prop: string) {
        return async function* (...args: unknown[]): AsyncIterable<string> {
          const prompt = methodPromptFormatter(prop, args);
          yield* executeStreamingPrompt(prompt);
        };
      },
    }
  ) as AnymethodStreamProxy;

  const anymethod: Anymethod = {
    $: asyncProxy,
    $$: streamProxy,
    prompt: (input: string) => executePrompt(input),
    promptStreaming: (input: string) => executeStreamingPrompt(input),
    getHistory: () => [...conversationHistory],
    clearHistory: () => {
      conversationHistory = initialPrompts.map((p) => ({ role: p.role, content: p.content }));
      _tokensSoFar = 0;
    },
    setHistory: (history: IRMessage[]) => {
      conversationHistory = [...history];
    },
    get tokensSoFar(): number {
      return _tokensSoFar;
    },
    get maxTokens(): number {
      return maxTokens;
    },
    get tokensLeft(): number {
      return Math.max(0, maxTokens - _tokensSoFar);
    },
  };

  return anymethod;
}

export function createStatelessAnymethod(
  backend: BackendAdapter,
  config: Omit<AnymethodConfig, 'maxHistorySize'> = {}
): Anymethod {
  return createAnymethod(backend, { ...config, maxHistorySize: 0 });
}

export function createConversationalAnymethod(
  backend: BackendAdapter,
  maxHistorySize: number = 10,
  config: Omit<AnymethodConfig, 'maxHistorySize'> = {}
): Anymethod {
  return createAnymethod(backend, { ...config, maxHistorySize });
}
