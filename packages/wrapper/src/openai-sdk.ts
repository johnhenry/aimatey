/**
 * OpenAI SDK Wrapper
 *
 * Mimics the OpenAI SDK interface using any backend adapter.
 * Allows you to use OpenAI SDK-style code with any provider.
 *
 * Uses the OpenAI Frontend Adapter internally for format conversions.
 *
 * @module
 */

import type {
  BackendAdapter,
  StreamMode,
  AIModel,
  ListModelsOptions,
  ListModelsResult,
} from '@johnhenry/aimatey-types';
import {
  OpenAIFrontendAdapter,
  type OpenAIRequest,
  type OpenAIMessage,
} from '@johnhenry/aimatey-frontend';
import { supportsChat, supportsChatStream } from '@johnhenry/aimatey-utils';
import { AdapterError, ErrorCode } from '@johnhenry/aimatey-errors';

// ============================================================================
// Re-export types from frontend adapter
// ============================================================================

export type {
  OpenAIRequest,
  OpenAIResponse,
  OpenAIStreamChunk,
  OpenAIMessage,
} from '@johnhenry/aimatey-frontend';

// ============================================================================
// SDK-style Types (convenience aliases)
// ============================================================================

/**
 * OpenAI chat completion request parameters (SDK style).
 */
export interface OpenAIChatCompletionParams {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  stream?: boolean;
  user?: string;
  seed?: number;
}

/**
 * OpenAI chat completion choice.
 */
export interface OpenAIChatCompletionChoice {
  index: number;
  message: OpenAIMessage;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

/**
 * OpenAI usage information.
 */
export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * OpenAI chat completion response.
 */
export interface OpenAIChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: OpenAIChatCompletionChoice[];
  usage: OpenAIUsage;
}

/**
 * OpenAI streaming chunk delta.
 */
export interface OpenAIStreamDelta {
  role?: 'assistant';
  content?: string;
}

/**
 * OpenAI streaming chunk choice.
 */
export interface OpenAIStreamChoice {
  index: number;
  delta: OpenAIStreamDelta;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

/**
 * OpenAI chat completion chunk (streaming).
 */
export interface OpenAIChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: OpenAIStreamChoice[];
}

/**
 * OpenAI Model object.
 */
export interface OpenAIModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

/**
 * OpenAI Models list page.
 */
export interface OpenAIModelsPage {
  object: 'list';
  data: OpenAIModel[];
}

/**
 * OpenAI SDK wrapper configuration.
 */
export interface OpenAISDKConfig {
  /**
   * Streaming mode for stream responses.
   * @default 'delta'
   */
  streamMode?: StreamMode;
}

// ============================================================================
// OpenAI SDK Wrapper Implementation
// ============================================================================

/**
 * Chat completions interface (mimics OpenAI SDK).
 */
export class ChatCompletions {
  private backend: BackendAdapter;
  private config: OpenAISDKConfig;
  private adapter: OpenAIFrontendAdapter;

  constructor(backend: BackendAdapter, config: OpenAISDKConfig = {}) {
    if (!supportsChat(backend) || !supportsChatStream(backend)) {
      throw new AdapterError({
        code: ErrorCode.UNSUPPORTED_FEATURE,
        message: `Backend '${backend.metadata.name}' does not support chat -- the OpenAI SDK wrapper requires a chat-capable backend (both execute and executeStream)`,
        isRetryable: false,
        provenance: { backend: backend.metadata.name },
      });
    }
    this.backend = backend;
    this.config = config;
    this.adapter = new OpenAIFrontendAdapter();
  }

  /**
   * Create a chat completion (non-streaming).
   */
  async create(
    params: OpenAIChatCompletionParams & { stream?: false | undefined }
  ): Promise<OpenAIChatCompletion>;

  /**
   * Create a chat completion (streaming).
   */
  create(
    params: OpenAIChatCompletionParams & { stream: true }
  ): AsyncIterable<OpenAIChatCompletionChunk>;

  /**
   * Create a chat completion.
   */
  create(
    params: OpenAIChatCompletionParams
  ): Promise<OpenAIChatCompletion> | AsyncIterable<OpenAIChatCompletionChunk> {
    if (params.stream) {
      return this.createStream(params);
    }
    return this.createNonStream(params);
  }

  private async createNonStream(params: OpenAIChatCompletionParams): Promise<OpenAIChatCompletion> {
    // Convert params to OpenAI request format
    const request: OpenAIRequest = {
      model: params.model,
      messages: params.messages,
      temperature: params.temperature,
      max_tokens: params.max_tokens,
      top_p: params.top_p,
      frequency_penalty: params.frequency_penalty,
      presence_penalty: params.presence_penalty,
      stop: params.stop,
      stream: false,
      user: params.user,
      seed: params.seed,
    };

    // Use frontend adapter to convert to IR
    const irRequest = await this.adapter.toIR(request);

    // Execute via backend
    // Non-null: constructor verified chat support.
    const irResponse = await this.backend.execute!(irRequest);

    // Use frontend adapter to convert back to OpenAI format
    const openaiResponse = await this.adapter.fromIR(irResponse);

    // Return in SDK-style format
    return {
      id: openaiResponse.id,
      object: 'chat.completion',
      created: openaiResponse.created,
      model: openaiResponse.model,
      choices: openaiResponse.choices.map((choice) => ({
        index: choice.index,
        message: choice.message,
        finish_reason: choice.finish_reason,
      })),
      usage: openaiResponse.usage ?? {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };
  }

  private async *createStream(
    params: OpenAIChatCompletionParams
  ): AsyncIterable<OpenAIChatCompletionChunk> {
    // Convert params to OpenAI request format
    const request: OpenAIRequest = {
      model: params.model,
      messages: params.messages,
      temperature: params.temperature,
      max_tokens: params.max_tokens,
      top_p: params.top_p,
      frequency_penalty: params.frequency_penalty,
      presence_penalty: params.presence_penalty,
      stop: params.stop,
      stream: true,
      user: params.user,
      seed: params.seed,
    };

    // Use frontend adapter to convert to IR
    let irRequest = await this.adapter.toIR(request);

    // Add stream mode if configured
    if (this.config.streamMode) {
      irRequest = { ...irRequest, streamMode: this.config.streamMode };
    }

    // Execute streaming via backend
    // Non-null: constructor verified chat support.
    const irStream = this.backend.executeStream!(irRequest);

    // Use frontend adapter to convert stream
    for await (const chunk of this.adapter.fromIRStream(irStream)) {
      // Convert to SDK-style chunk
      yield {
        id: chunk.id,
        object: 'chat.completion.chunk',
        created: chunk.created,
        model: chunk.model,
        choices: chunk.choices.map((choice) => ({
          index: choice.index,
          delta: {
            role: choice.delta.role,
            content: choice.delta.content,
          },
          finish_reason: choice.finish_reason,
        })),
      };
    }
  }
}

/**
 * Models interface (mimics OpenAI SDK).
 */
export class Models {
  private backend: BackendAdapter;

  constructor(backend: BackendAdapter) {
    this.backend = backend;
  }

  /**
   * List available models.
   */
  async list(options?: ListModelsOptions): Promise<OpenAIModelsPage> {
    if (!this.backend.listModels) {
      return { object: 'list', data: [] };
    }

    const result: ListModelsResult = await this.backend.listModels(options);

    const data: OpenAIModel[] = result.models.map((model: AIModel) => ({
      id: model.id,
      object: 'model' as const,
      created: model.created
        ? new Date(model.created).getTime() / 1000
        : Math.floor(result.fetchedAt / 1000),
      owned_by: model.ownedBy || 'unknown',
    }));

    return { object: 'list', data };
  }

  /**
   * Retrieve information about a specific model.
   */
  async retrieve(modelId: string): Promise<OpenAIModel | null> {
    if (!this.backend.listModels) {
      return null;
    }

    const result: ListModelsResult = await this.backend.listModels();
    const model = result.models.find((m: AIModel) => m.id === modelId);
    if (!model) {
      return null;
    }

    return {
      id: model.id,
      object: 'model',
      created: model.created
        ? new Date(model.created).getTime() / 1000
        : Math.floor(result.fetchedAt / 1000),
      owned_by: model.ownedBy || 'unknown',
    };
  }
}

/**
 * Chat interface (mimics OpenAI SDK).
 */
export class Chat {
  readonly completions: ChatCompletions;

  constructor(backend: BackendAdapter, config: OpenAISDKConfig = {}) {
    this.completions = new ChatCompletions(backend, config);
  }
}

/**
 * OpenAI SDK-compatible client.
 */
export class OpenAIClient {
  readonly chat: Chat;
  readonly models: Models;

  constructor(backend: BackendAdapter, config: OpenAISDKConfig = {}) {
    this.chat = new Chat(backend, config);
    this.models = new Models(backend);
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an OpenAI SDK-compatible client using any backend adapter.
 *
 * Supports both calling styles:
 * - Factory: `OpenAI(backend, config)`
 * - Constructor: `new OpenAI({ backend, ...config })`
 *
 * @example
 * ```typescript
 * import { OpenAI } from '@johnhenry/aimatey-wrapper/openai';
 * import { AnthropicBackendAdapter } from '@johnhenry/aimatey-backend/anthropic';
 *
 * const backend = new AnthropicBackendAdapter({ apiKey: 'sk-ant-...' });
 *
 * // Factory style
 * const client1 = OpenAI(backend);
 *
 * // Constructor style
 * const client2 = new OpenAI({ backend });
 *
 * const completion = await client1.chat.completions.create({
 *   model: 'claude-3-5-sonnet',
 *   messages: [
 *     { role: 'user', content: 'Hello!' }
 *   ],
 * });
 *
 * console.log(completion.choices[0].message.content);
 * ```
 */
export function OpenAI(
  backendOrConfig: BackendAdapter | ({ backend: BackendAdapter } & OpenAISDKConfig),
  config?: OpenAISDKConfig
): OpenAIClient {
  // Support both calling styles:
  // 1. OpenAI(backend, config) - factory style
  // 2. new OpenAI({ backend, ...config }) - constructor style from README
  if (backendOrConfig && typeof backendOrConfig === 'object' && 'backend' in backendOrConfig) {
    const { backend, ...restConfig } = backendOrConfig;
    return new OpenAIClient(backend, restConfig);
  }
  return new OpenAIClient(backendOrConfig, config);
}
