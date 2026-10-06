/**
 * Mock Backend Adapter
 *
 * A testing backend that returns predefined responses without making real API calls.
 * Useful for testing, development, and demonstrations.
 *
 * @module
 */

import type { BackendAdapter, AdapterMetadata } from '@johnhenry/aimatey-types';
import type {
  IRDecisionAnswer,
  IRDecisionRequest,
  IRDecisionResponse,
  IRChatRequest,
  IRChatResponse,
  IRChatStream,
  IRMessage,
  MessageContent,
} from '@johnhenry/aimatey-types';
import type { AIModel, ListModelsOptions, ListModelsResult } from '@johnhenry/aimatey-types';

// ============================================================================
// Default Mock Models
// ============================================================================

/**
 * Default mock models for testing.
 */
const DEFAULT_MOCK_MODELS: readonly AIModel[] = [
  {
    id: 'mock-gpt-4',
    name: 'Mock GPT-4',
    description: 'Mock model simulating GPT-4 capabilities',
    ownedBy: 'mock',
    capabilities: {
      maxTokens: 4096,
      contextWindow: 8192,
      supportsStreaming: true,
      supportsVision: true,
      supportsTools: true,
      supportsJSON: true,
    },
  },
  {
    id: 'mock-claude-3',
    name: 'Mock Claude 3',
    description: 'Mock model simulating Claude 3 capabilities',
    ownedBy: 'mock',
    capabilities: {
      maxTokens: 4096,
      contextWindow: 200000,
      supportsStreaming: true,
      supportsVision: true,
      supportsTools: true,
      supportsJSON: false,
    },
  },
  {
    id: 'mock-fast',
    name: 'Mock Fast Model',
    description: 'Mock model for fast responses',
    ownedBy: 'mock',
    capabilities: {
      maxTokens: 2048,
      contextWindow: 4096,
      supportsStreaming: true,
      supportsVision: false,
      supportsTools: false,
      supportsJSON: true,
    },
  },
  {
    id: 'mock-model',
    name: 'Mock Model',
    description: 'Default mock model',
    ownedBy: 'mock',
    capabilities: {
      maxTokens: 4096,
      contextWindow: 8192,
      supportsStreaming: true,
      supportsVision: false,
      supportsTools: true,
      supportsJSON: true,
    },
  },
] as const;

/**
 * Mock response configuration
 */
export interface MockResponse {
  /**
   * Response content (text or content blocks)
   */
  content: string | MessageContent[];

  /**
   * Finish reason
   * @default 'stop'
   */
  finishReason?: 'stop' | 'length' | 'tool_use' | 'content_filter';

  /**
   * Simulated token usage
   */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };

  /**
   * Delay in milliseconds before responding
   * @default 0
   */
  delay?: number;

  /**
   * Error to throw instead of returning response
   */
  error?: Error;
}

/**
 * Mock backend configuration
 */
export interface MockBackendConfig {
  /**
   * Default response to return
   * @default "This is a mock response."
   */
  defaultResponse?: string | MockResponse;

  /**
   * Map of model names to specific responses
   */
  modelResponses?: Record<string, string | MockResponse>;

  /**
   * Custom response function
   */
  responseGenerator?: (request: IRChatRequest) => string | MockResponse;

  /**
   * Simulate streaming chunks
   * @default false
   */
  simulateStreaming?: boolean;

  /**
   * Delay between stream chunks in milliseconds
   * @default 50
   */
  streamChunkDelay?: number;

  /**
   * Default model name
   * @default 'mock-model'
   */
  defaultModel?: string;

  /**
   * Simulate token usage
   * @default true
   */
  simulateUsage?: boolean;

  /**
   * Static list of models to return (optional)
   * Can be model IDs (strings) or full AIModel objects
   */
  models?: readonly (string | AIModel)[];

  /**
   * Canned decision answers, keyed by question name, for `decide()`.
   * A question with no entry (and no `decisionHandler`) rejects, naming it.
   */
  decisionAnswers?: Record<string, IRDecisionAnswer>;

  /**
   * Build the whole decision response yourself. Takes precedence over
   * `decisionAnswers`.
   */
  decisionHandler?: (request: IRDecisionRequest) => IRDecisionResponse | Promise<IRDecisionResponse>;
}

/**
 * Mock Backend Adapter for testing
 *
 * Returns predefined responses without making real API calls.
 *
 * @example Basic Usage
 * ```typescript
 * import { MockBackendAdapter } from '@johnhenry/aimatey';
 *
 * const backend = new MockBackendAdapter({
 *   defaultResponse: 'This is a test response',
 * });
 * ```
 *
 * @example Model-Specific Responses
 * ```typescript
 * const backend = new MockBackendAdapter({
 *   modelResponses: {
 *     'gpt-4': 'GPT-4 response',
 *     'claude-3': 'Claude response',
 *   },
 * });
 * ```
 *
 * @example Custom Response Generator
 * ```typescript
 * const backend = new MockBackendAdapter({
 *   responseGenerator: (request) => {
 *     const lastMessage = request.messages[request.messages.length - 1];
 *     return `You said: ${lastMessage.content[0].text}`;
 *   },
 * });
 * ```
 *
 * @example Error Simulation
 * ```typescript
 * const backend = new MockBackendAdapter({
 *   defaultResponse: {
 *     content: '',
 *     error: new Error('Simulated API error'),
 *   },
 * });
 * ```
 */
export class MockBackendAdapter implements BackendAdapter {
  public readonly metadata: AdapterMetadata = {
    name: 'mock',
    version: '1.0.0',
    provider: 'mock',
    capabilities: {
      streaming: true,
      multiModal: true,
      tools: true,
      systemMessageStrategy: 'in-messages',
      supportsMultipleSystemMessages: true,
      decisions: true,
    },
  };

  private config: MockBackendConfig & {
    defaultResponse: string | MockResponse;
    modelResponses: Record<string, string | MockResponse>;
    simulateStreaming: boolean;
    streamChunkDelay: number;
    defaultModel: string;
    simulateUsage: boolean;
  };

  /**
   * Last request received by this adapter (for testing).
   */
  public lastRequest?: IRChatRequest;

  /**
   * All requests received by this adapter (for testing).
   */
  public allRequests: IRChatRequest[] = [];

  /**
   * All decision requests received by this adapter (for testing).
   */
  public allDecisionRequests: IRDecisionRequest[] = [];

  constructor(config: MockBackendConfig = {}) {
    this.config = {
      defaultResponse: 'This is a mock response.',
      modelResponses: {},
      responseGenerator: config.responseGenerator,
      simulateStreaming: false,
      streamChunkDelay: 50,
      defaultModel: 'mock-model',
      simulateUsage: true,
      ...config,
    };
  }

  /**
   * Convert IR request to mock format (passthrough since mock uses IR).
   */
  fromIR(request: IRChatRequest): IRChatRequest {
    // Mock adapter uses IR directly - no conversion needed
    return request;
  }

  /**
   * Convert mock response to IR format (passthrough since mock uses IR).
   */
  toIR(
    response: IRChatResponse,
    _originalRequest: IRChatRequest,
    _latencyMs: number
  ): IRChatResponse {
    // Mock adapter uses IR directly - no conversion needed
    return response;
  }

  /**
   * Execute a chat request with predefined mock response.
   *
   * This method processes an IR chat request and returns a mock response without
   * making any real API calls. It simulates delays, errors, and usage statistics
   * based on configuration. Useful for testing, development, and demonstrations
   * where you need predictable responses without external dependencies.
   *
   * @param irRequest - Universal IR chat request
   * @returns Promise resolving to mock IR chat response
   * @throws {Error} If mock response is configured to throw an error
   *
   * @example
   * ```typescript
   * const adapter = new MockBackendAdapter({
   *   responses: [{
   *     content: 'This is a mock response!',
   *     delay: 100 // Simulate 100ms network delay
   *   }]
   * });
   * const response = await adapter.execute(request);
   * console.log(response.message.content);
   * ```
   */
  async execute(irRequest: IRChatRequest): Promise<IRChatResponse> {
    // Track request for testing
    this.lastRequest = irRequest;
    this.allRequests.push(irRequest);

    // Get mock response
    const mockResponse = this.getMockResponse(irRequest);

    // Simulate delay
    if (mockResponse.delay && mockResponse.delay > 0) {
      await this.sleep(mockResponse.delay);
    }

    // Throw error if configured
    if (mockResponse.error) {
      throw mockResponse.error;
    }

    // Build response content
    const content: MessageContent[] =
      typeof mockResponse.content === 'string'
        ? [{ type: 'text', text: mockResponse.content }]
        : mockResponse.content;

    // Build IR message
    const message: IRMessage = {
      role: 'assistant',
      content,
    };

    // Build usage stats
    const usage = mockResponse.usage
      ? {
          promptTokens: mockResponse.usage.inputTokens,
          completionTokens: mockResponse.usage.outputTokens,
          totalTokens: mockResponse.usage.inputTokens + mockResponse.usage.outputTokens,
        }
      : this.config.simulateUsage
        ? {
            promptTokens: this.estimateTokens(Array.from(irRequest.messages)),
            completionTokens: this.estimateTokens([message]),
            totalTokens: 0,
          }
        : undefined;

    if (usage) {
      usage.totalTokens = usage.promptTokens + usage.completionTokens;
    }

    return {
      message,
      finishReason: (mockResponse.finishReason || 'stop') as 'stop',
      usage,
      metadata: irRequest.metadata,
    };
  }

  /**
   * Execute a streaming chat request with predefined mock response.
   *
   * This async generator processes an IR chat request and yields mock stream
   * chunks without making any real API calls. It simulates realistic streaming
   * behavior by splitting responses into chunks with configurable delays between
   * them. Supports error simulation and usage statistics. Perfect for testing
   * streaming UI components without external dependencies.
   *
   * @param irRequest - Universal IR chat request
   * @yields IR stream chunks including start, content, done, and error events
   *
   * @example
   * ```typescript
   * const adapter = new MockBackendAdapter({
   *   responses: [{
   *     content: 'Streaming mock response!',
   *     streamDelayMs: 50 // 50ms between chunks
   *   }]
   * });
   * for await (const chunk of adapter.executeStream(request)) {
   *   if (chunk.type === 'content') {
   *     console.log('Chunk:', chunk.delta);
   *   }
   * }
   * ```
   */
  async *executeStream(irRequest: IRChatRequest): IRChatStream {
    // Track request for testing
    this.lastRequest = irRequest;
    this.allRequests.push(irRequest);

    // Get mock response
    const mockResponse = this.getMockResponse(irRequest);

    // Simulate delay before starting
    if (mockResponse.delay && mockResponse.delay > 0) {
      await this.sleep(mockResponse.delay);
    }

    // Throw error if configured
    if (mockResponse.error) {
      yield {
        type: 'error',
        sequence: 0,
        error: {
          code: 'mock_error',
          message: mockResponse.error.message,
        },
      };
      return;
    }

    // Start chunk
    yield {
      type: 'start',
      sequence: 0,
      metadata: irRequest.metadata,
    };

    // Get response text
    const text =
      typeof mockResponse.content === 'string'
        ? mockResponse.content
        : mockResponse.content
            .filter((c) => c.type === 'text')
            .map((c) => (c as { text: string }).text)
            .join('');

    // Stream chunks
    let sequence = 1;
    if (this.config.simulateStreaming && text) {
      const words = text.split(' ');
      for (const word of words) {
        yield {
          type: 'content',
          sequence: sequence++,
          delta: word + ' ',
        };

        if (this.config.streamChunkDelay > 0) {
          await this.sleep(this.config.streamChunkDelay);
        }
      }
    } else {
      // Single chunk
      yield {
        type: 'content',
        sequence: sequence++,
        delta: text,
      };
    }

    // Done chunk
    const usage = mockResponse.usage
      ? {
          promptTokens: mockResponse.usage.inputTokens,
          completionTokens: mockResponse.usage.outputTokens,
          totalTokens: mockResponse.usage.inputTokens + mockResponse.usage.outputTokens,
        }
      : this.config.simulateUsage
        ? {
            promptTokens: this.estimateTokens(Array.from(irRequest.messages)),
            completionTokens: Math.ceil(text.length / 4),
            totalTokens: 0,
          }
        : undefined;

    if (usage) {
      usage.totalTokens = usage.promptTokens + usage.completionTokens;
    }

    yield {
      type: 'done',
      sequence: sequence++,
      finishReason: (mockResponse.finishReason || 'stop') as 'stop',
      usage,
    };
  }

  /**
   * List available mock models.
   *
   * Returns configured models or default mock models.
   */
  listModels(options?: ListModelsOptions): Promise<ListModelsResult> {
    // Check if config provides custom models
    if (this.config.models) {
      return Promise.resolve(this.buildStaticResult(this.config.models, options?.filter));
    }

    // Use default mock models
    const result: ListModelsResult = {
      models: [...DEFAULT_MOCK_MODELS],
      source: 'static',
      fetchedAt: Date.now(),
      isComplete: true,
    };

    // Apply filter if requested
    return Promise.resolve(this.applyModelFilter(result, options?.filter));
  }

  /**
   * Build static result from configured models.
   */
  private buildStaticResult(
    models: readonly (string | AIModel)[],
    filter?: ListModelsOptions['filter']
  ): ListModelsResult {
    // Convert string IDs to AIModel objects
    const aiModels: AIModel[] = models.map((model) => {
      if (typeof model === 'string') {
        // Simple model with just ID
        return {
          id: model,
          name: model,
          ownedBy: 'mock',
          capabilities: {
            supportsStreaming: true,
            supportsVision: false,
            supportsTools: true,
            supportsJSON: true,
          },
        };
      }
      return model;
    });

    const result: ListModelsResult = {
      models: aiModels,
      source: 'static',
      fetchedAt: Date.now(),
      isComplete: true,
    };

    return this.applyModelFilter(result, filter);
  }

  /**
   * Apply capability filter to model list.
   */
  private applyModelFilter(
    result: ListModelsResult,
    filter?: ListModelsOptions['filter']
  ): ListModelsResult {
    if (!filter) {
      return result;
    }

    const filtered = result.models.filter((model) => {
      const caps = model.capabilities;
      if (!caps) {
        return true;
      } // If no capabilities info, include it

      // Check each filter criterion
      if (
        filter.supportsStreaming !== undefined &&
        caps.supportsStreaming !== filter.supportsStreaming
      ) {
        return false;
      }
      if (filter.supportsVision !== undefined && caps.supportsVision !== filter.supportsVision) {
        return false;
      }
      if (filter.supportsTools !== undefined && caps.supportsTools !== filter.supportsTools) {
        return false;
      }
      if (filter.supportsJSON !== undefined && caps.supportsJSON !== filter.supportsJSON) {
        return false;
      }

      return true;
    });

    return {
      ...result,
      models: filtered,
      isComplete: filtered.length === result.models.length,
    };
  }

  /**
   * Get mock response for request
   */
  private getMockResponse(request: IRChatRequest): MockResponse {
    // Use custom generator if provided
    if (this.config.responseGenerator) {
      const generated = this.config.responseGenerator(request);
      return this.normalizeResponse(generated);
    }

    // Check for model-specific response
    const model = request.parameters?.model;
    if (model && this.config.modelResponses[model]) {
      return this.normalizeResponse(this.config.modelResponses[model]);
    }

    // Use default response
    return this.normalizeResponse(this.config.defaultResponse);
  }

  /**
   * Normalize response to MockResponse format
   */
  private normalizeResponse(response: string | MockResponse): MockResponse {
    if (typeof response === 'string') {
      return {
        content: response,
        finishReason: 'stop',
      };
    }
    return response;
  }

  /**
   * Estimate token count for messages
   */
  private estimateTokens(messages: IRMessage[]): number {
    let total = 0;
    for (const message of messages) {
      if (typeof message.content === 'string') {
        total += Math.ceil(message.content.length / 4);
      } else {
        for (const content of message.content) {
          if (content.type === 'text') {
            // Rough estimate: ~4 chars per token
            total += Math.ceil(content.text.length / 4);
          } else if (content.type === 'tool_use') {
            total += 50; // Estimate for tool use
          }
        }
      }
    }
    return total;
  }

  /**
   * Clear request history (for testing).
   * Resets both lastRequest and allRequests.
   */
  public clearHistory(): void {
    this.lastRequest = undefined;
    this.allRequests = [];
  }

  /**
   * Answer a typed-decision request from `decisionHandler` or
   * `decisionAnswers`, without calling any model.
   *
   * @throws {Error} If a question has no configured answer, or the signal is aborted
   */
  async decide(request: IRDecisionRequest, signal?: AbortSignal): Promise<IRDecisionResponse> {
    this.allDecisionRequests.push(request);
    signal?.throwIfAborted();

    if (this.config.decisionHandler) {
      return this.config.decisionHandler(request);
    }

    const answers: Record<string, IRDecisionAnswer> = {};
    for (const question of Object.keys(request.questions)) {
      const answer = this.config.decisionAnswers?.[question];
      if (!answer) {
        throw new Error(
          `MockBackendAdapter: no decisionAnswers entry configured for question '${question}'`
        );
      }
      answers[question] = answer;
    }

    return {
      answers,
      model: this.config.defaultModel,
      metadata: {
        ...request.metadata,
        provenance: { ...request.metadata.provenance, backend: this.metadata.name },
      },
    };
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create a mock backend with echo responses (repeats user input)
 *
 * @example
 * ```typescript
 * import { createEchoBackend } from '@johnhenry/aimatey';
 *
 * const backend = createEchoBackend();
 * ```
 */
export function createEchoBackend(): MockBackendAdapter {
  return new MockBackendAdapter({
    responseGenerator: (request) => {
      const lastMessage = request.messages[request.messages.length - 1];
      if (!lastMessage) {
        return 'Echo: (no message)';
      }
      const text =
        typeof lastMessage.content === 'string'
          ? lastMessage.content
          : lastMessage.content
              .filter((c) => c.type === 'text')
              .map((c) => (c as { text: string }).text)
              .join(' ');
      return `Echo: ${text}`;
    },
  });
}

/**
 * Create a mock backend that always errors
 *
 * @param error - Error to throw
 * @example
 * ```typescript
 * import { createErrorBackend } from '@johnhenry/aimatey';
 *
 * const backend = createErrorBackend(new Error('API unavailable'));
 * ```
 */
export function createErrorBackend(error: Error): MockBackendAdapter {
  return new MockBackendAdapter({
    defaultResponse: {
      content: '',
      error,
    },
  });
}

/**
 * Create a mock backend with delayed responses
 *
 * @param delayMs - Delay in milliseconds
 * @param response - Response to return
 * @example
 * ```typescript
 * import { createDelayedBackend } from '@johnhenry/aimatey';
 *
 * const backend = createDelayedBackend(1000, 'Delayed response');
 * ```
 */
export function createDelayedBackend(
  delayMs: number,
  response: string = 'Delayed response'
): MockBackendAdapter {
  return new MockBackendAdapter({
    defaultResponse: {
      content: response,
      delay: delayMs,
    },
  });
}
