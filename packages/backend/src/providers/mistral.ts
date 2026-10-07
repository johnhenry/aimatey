/**
 * Mistral Backend Adapter
 *
 * Adapts Universal IR to Mistral API.
 * Mistral uses OpenAI-compatible format with minor differences.
 *
 * @module
 */

import type {
  BackendAdapter,
  ApiKeyBackendAdapterConfig,
  AdapterMetadata,
} from '@johnhenry/aimatey-types';
import type { IREmbedRequest, IREmbedResponse } from '@johnhenry/aimatey-types';
import type {
  IRChatRequest,
  IRChatResponse,
  IRChatStream,
  IRMessage,
  IRStreamChunk,
  FinishReason,
} from '@johnhenry/aimatey-types';
import {
  AdapterConversionError,
  NetworkError,
  ProviderError,
  StreamError,
  ErrorCode,
  createErrorFromHttpResponse,
} from '@johnhenry/aimatey-errors';
import { normalizeSystemMessages } from '@johnhenry/aimatey-utils';
import { getModelCache } from '@johnhenry/aimatey-utils';
import { getEffectiveStreamMode, mergeStreamingConfig } from '@johnhenry/aimatey-utils';
import {
  executeOpenAICompatibleEmbed,
  buildStaticResult,
  applyModelFilter,
  DEFAULT_MISTRAL_MODELS,
  buildStructuredOutputFallbackMessages,
  extractStructuredOutputJSON,
  buildResponseFormatFallbackWarning,
  buildToolsUnsupportedWarning,
  estimateTokens,
  type ModelCapabilityFilter,
} from '../shared.js';
import type { ListModelsOptions, ListModelsResult, AIModel } from '@johnhenry/aimatey-types';

// ============================================================================
// Mistral API Types (OpenAI-compatible)
// ============================================================================

export interface MistralMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface MistralRequest {
  model: string;
  messages: MistralMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  safe_mode?: boolean;
  random_seed?: number;
}

export interface MistralResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: MistralMessage;
    finish_reason: 'stop' | 'length' | 'model_length' | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ============================================================================
// Mistral Backend Adapter
// ============================================================================

export class MistralBackendAdapter implements BackendAdapter<MistralRequest, MistralResponse> {
  readonly metadata: AdapterMetadata;
  private readonly config: ApiKeyBackendAdapterConfig;
  private readonly baseURL: string;
  private readonly modelCache: ReturnType<typeof getModelCache>;

  constructor(config: ApiKeyBackendAdapterConfig) {
    this.config = config;
    this.baseURL = config.baseURL || 'https://api.mistral.ai/v1';
    this.modelCache = getModelCache(config.modelsCacheScope || 'global');
    this.metadata = {
      name: 'mistral-backend',
      version: '1.0.0',
      provider: 'Mistral',
      capabilities: {
        embeddings: true,
        embeddingModels: ['mistral-embed'],
        maxEmbeddingBatchSize: 512,
        streaming: true,
        multiModal: false,
        tools: false,
        structuredOutput: 'fallback',
        maxContextTokens: 32000,
        systemMessageStrategy: 'in-messages',
        supportsMultipleSystemMessages: false,
        supportsTemperature: true,
        supportsTopP: true,
        supportsTopK: false,
        supportsSeed: true,
        supportsFrequencyPenalty: false,
        supportsPresencePenalty: false,
        maxStopSequences: 0,
      },
      config: { baseURL: this.baseURL },
    };
  }

  /**
   * Generate embeddings via the OpenAI-compatible /embeddings endpoint.
   */
  embed(request: IREmbedRequest, signal?: AbortSignal): Promise<IREmbedResponse> {
    return executeOpenAICompatibleEmbed({
      baseURL: this.baseURL,
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      request,
      backendName: this.metadata.name,
      defaultModel: 'mistral-embed',
      signal,
    });
  }

  async execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse> {
    try {
      const mistralRequest = this.fromIR(request);
      const startTime = Date.now();

      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
          ...this.config.headers,
        },
        body: JSON.stringify(mistralRequest),
        signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw createErrorFromHttpResponse(response.status, response.statusText, errorBody, {
          backend: this.metadata.name,
        });
      }

      const data = (await response.json()) as MistralResponse;
      return this.toIR(data, request, Date.now() - startTime);
    } catch (error) {
      if (error instanceof NetworkError || error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError({
        code: ErrorCode.PROVIDER_ERROR,
        message: `Mistral request failed: ${error instanceof Error ? error.message : String(error)}`,
        isRetryable: true,
        provenance: { backend: this.metadata.name },
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  async *executeStream(request: IRChatRequest, signal?: AbortSignal): IRChatStream {
    let sequence = 0;
    try {
      const mistralRequest = this.fromIR(request);
      mistralRequest.stream = true;

      // Get effective streaming configuration
      const streamingConfig = mergeStreamingConfig(this.config.streaming);
      const effectiveMode = getEffectiveStreamMode(request.streamMode, undefined, streamingConfig);
      const includeBoth = streamingConfig.includeBoth || effectiveMode === 'accumulated';

      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
          ...this.config.headers,
        },
        body: JSON.stringify(mistralRequest),
        signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw createErrorFromHttpResponse(response.status, response.statusText, errorBody, {
          backend: this.metadata.name,
        });
      }

      if (!response.body) {
        throw new StreamError({
          code: ErrorCode.STREAM_ERROR,
          message: 'No response body',
          provenance: { backend: this.metadata.name },
        });
      }

      yield {
        type: 'start',
        sequence: sequence++,
        metadata: {
          ...request.metadata,
          provenance: {
            ...request.metadata.provenance,
            backend: this.metadata.name,
            locality: 'external',
          },
        },
      } as IRStreamChunk;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let contentBuffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim() || !line.startsWith('data: ')) {
              continue;
            }
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              continue;
            }

            try {
              const chunk = JSON.parse(data);
              const delta = chunk.choices?.[0]?.delta?.content;
              const finishReason = chunk.choices?.[0]?.finish_reason;

              if (delta) {
                contentBuffer += delta;

                // Build content chunk with optional accumulated field
                const contentChunk: IRStreamChunk = {
                  type: 'content',
                  sequence: sequence++,
                  delta,
                  role: 'assistant',
                };

                // Add accumulated field if configured
                if (includeBoth) {
                  (contentChunk as any).accumulated = contentBuffer;
                }

                yield contentChunk;
              }

              if (finishReason) {
                const message: IRMessage = { role: 'assistant', content: contentBuffer };
                yield {
                  type: 'done',
                  sequence: sequence++,
                  finishReason: this.mapFinishReason(finishReason),
                  message,
                } as IRStreamChunk;
              }
            } catch (parseError) {
              console.warn('Failed to parse Mistral SSE chunk:', data, parseError);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      yield {
        type: 'error',
        sequence: sequence++,
        error: {
          code: error instanceof Error ? error.name : 'UNKNOWN_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      } as IRStreamChunk;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseURL}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  estimateCost(request: IRChatRequest): Promise<number | null> {
    const estimatedTokens = estimateTokens(request);
    return Promise.resolve((estimatedTokens / 1000) * 0.002); // Rough estimate: $0.002 per 1K tokens
  }

  /**
   * List available Mistral models.
   */
  async listModels(options?: ListModelsOptions): Promise<ListModelsResult> {
    try {
      if (this.config.models && !options?.forceRefresh) {
        return buildStaticResult(this.config.models, 'mistralai');
      }

      if (this.config.cacheModels !== false && !options?.forceRefresh) {
        const cached = this.modelCache.get(this.metadata.name);
        if (cached) {
          return applyModelFilter(cached, options?.filter as ModelCapabilityFilter);
        }
      }

      const response = await fetch(`${this.baseURL}/models`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
          ...this.config.headers,
        },
        signal: AbortSignal.timeout(this.config.timeout || 30000),
      });

      if (!response.ok) {
        throw createErrorFromHttpResponse(
          response.status,
          response.statusText,
          await response.text(),
          { backend: this.metadata.name }
        );
      }

      const data = (await response.json()) as { object: string; data: any[] };
      const models = data.data.map((model) => this.transformMistralModel(model));

      const result: ListModelsResult = {
        models,
        source: 'remote',
        fetchedAt: Date.now(),
        isComplete: true,
      };

      if (this.config.cacheModels !== false) {
        this.modelCache.set(this.metadata.name, result, this.config.modelsCacheTTL || 3600000);
      }

      return applyModelFilter(result, options?.filter as ModelCapabilityFilter);
    } catch {
      if (!options?.forceRefresh) {
        const cached = this.modelCache.get(this.metadata.name);
        if (cached) {
          return cached;
        }
      }

      const result: ListModelsResult = {
        models: [...DEFAULT_MISTRAL_MODELS],
        source: 'static',
        fetchedAt: Date.now(),
        isComplete: true,
      };
      return applyModelFilter(result, options?.filter as ModelCapabilityFilter);
    }
  }

  private transformMistralModel(model: any): AIModel {
    return {
      id: model.id,
      name: model.id,
      ownedBy: 'mistralai',
      capabilities: {
        maxTokens: 8192,
        contextWindow: 32000,
        supportsStreaming: true,
        supportsVision: false,
        supportsTools: true,
        supportsJSON: true,
      },
    };
  }

  invalidateModelCache(): MistralBackendAdapter {
    this.modelCache.invalidate(this.metadata.name);
    return this;
  }

  /**
   * Convert IR request to Mistral format.
   *
   * Public method for testing and debugging - see what will be sent to Mistral.
   */
  public fromIR(request: IRChatRequest): MistralRequest {
    const { messages } = normalizeSystemMessages(
      buildStructuredOutputFallbackMessages(request.messages, request.responseFormat),
      this.metadata.capabilities.systemMessageStrategy,
      this.metadata.capabilities.supportsMultipleSystemMessages
    );

    const mistralMessages: MistralMessage[] = messages.map((msg) => ({
      role: msg.role as 'system' | 'user' | 'assistant',
      content:
        typeof msg.content === 'string'
          ? msg.content
          : msg.content.map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join(''),
    }));

    return {
      model: request.parameters?.model || this.config.defaultModel || 'mistral-small-2501',
      messages: mistralMessages,
      temperature: request.parameters?.temperature,
      max_tokens: request.parameters?.maxTokens,
      top_p: request.parameters?.topP,
      stream: request.stream,
      random_seed: request.parameters?.seed,
    };
  }

  /**
   * Convert Mistral response to IR format.
   *
   * Public method for testing and debugging - parse Mistral responses manually.
   */
  public toIR(
    response: MistralResponse,
    originalRequest: IRChatRequest,
    latencyMs: number
  ): IRChatResponse {
    const choice = response.choices[0];
    if (!choice) {
      throw new AdapterConversionError({
        code: ErrorCode.ADAPTER_CONVERSION_ERROR,
        message: 'No choices in Mistral response',
        provenance: { backend: this.metadata.name },
      });
    }

    const content = originalRequest.responseFormat
      ? extractStructuredOutputJSON(choice.message.content)
      : choice.message.content;
    const message: IRMessage = { role: 'assistant', content };

    const extraWarnings = [
      ...(originalRequest.responseFormat
        ? [buildResponseFormatFallbackWarning(this.metadata.name)]
        : []),
      ...(originalRequest.tools?.length ? [buildToolsUnsupportedWarning(this.metadata.name)] : []),
    ];

    return {
      message,
      finishReason: this.mapFinishReason(choice.finish_reason || 'stop'),
      usage: {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      },
      metadata: {
        ...originalRequest.metadata,
        providerResponseId: response.id,
        provenance: {
          ...originalRequest.metadata.provenance,
          backend: this.metadata.name,
          locality: 'external',
          servedModel: response.model,
        },
        custom: {
          ...originalRequest.metadata.custom,
          mistralResponseId: response.id,
          latencyMs,
          ...(originalRequest.responseFormat ? { responseFormatEnforced: false } : {}),
        },
        warnings: extraWarnings.length
          ? [...(originalRequest.metadata.warnings ?? []), ...extraWarnings]
          : originalRequest.metadata.warnings,
      },
      raw: response as unknown as Record<string, unknown>,
    };
  }

  private mapFinishReason(reason: string): FinishReason {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'length':
      case 'model_length':
        return 'length';
      default:
        return 'stop';
    }
  }
}
