/**
 * Cohere Backend Adapter
 *
 * Adapts Universal IR to Cohere Chat API.
 * Cohere has a custom API format optimized for RAG use cases.
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
  ListModelsOptions,
  ListModelsResult,
  AIModel,
} from '@johnhenry/aimatey-types';
import {
  AdapterConversionError,
  NetworkError,
  ProviderError,
  StreamError,
  ErrorCode,
  createErrorFromHttpResponse,
} from '@johnhenry/aimatey-errors';
import { normalizeSystemMessages, getModelCache } from '@johnhenry/aimatey-utils';
import { getEffectiveStreamMode, mergeStreamingConfig } from '@johnhenry/aimatey-utils';
import {
  buildStaticResult,
  applyModelFilter,
  DEFAULT_COHERE_MODELS,
  buildStructuredOutputFallbackMessages,
  extractStructuredOutputJSON,
  buildResponseFormatFallbackWarning,
  type ModelCapabilityFilter,
  estimateTokens,
} from '../shared.js';

// ============================================================================
// Cohere API Types (Custom API)
// ============================================================================

export interface CohereChatMessage {
  role: 'USER' | 'CHATBOT'; // Note: uppercase roles
  message: string;
}

export interface CohereRequest {
  model?: string; // Optional in Cohere
  message: string; // Current user message
  chat_history?: CohereChatMessage[]; // Previous conversation
  preamble?: string; // System message
  temperature?: number;
  max_tokens?: number;
  p?: number; // top_p equivalent
  k?: number; // top_k
  frequency_penalty?: number;
  presence_penalty?: number;
  stop_sequences?: string[];
  stream?: boolean;
  // Cohere-specific RAG parameters
  documents?: Array<{
    id?: string;
    data: Record<string, any>;
  }>;
  connectors?: Array<{
    id: string;
  }>;
}

export interface CohereResponse {
  generation_id: string;
  text: string;
  finish_reason: 'COMPLETE' | 'MAX_TOKENS' | 'ERROR' | 'ERROR_TOXIC';
  meta?: {
    api_version: {
      version: string;
    };
    billed_units?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
  citations?: Array<{
    start: number;
    end: number;
    text: string;
    document_ids: string[];
  }>;
}

export interface CohereStreamChunk {
  event_type: 'stream-start' | 'text-generation' | 'stream-end' | 'citation-generation';
  text?: string;
  finish_reason?: 'COMPLETE' | 'MAX_TOKENS' | 'ERROR' | 'ERROR_TOXIC';
  generation_id?: string;
  citations?: Array<{
    start: number;
    end: number;
    text: string;
    document_ids: string[];
  }>;
}

// ============================================================================
// Cohere Backend Adapter
// ============================================================================

/**
 * Backend adapter for Cohere Chat API.
 *
 * Features:
 * - Custom API optimized for RAG
 * - Document and connector support
 * - Citation generation
 * - Text-only (no vision support)
 * - No function calling
 * - Pricing from $0.15 per 1M tokens
 */
export class CohereBackendAdapter implements BackendAdapter<CohereRequest, CohereResponse> {
  readonly metadata: AdapterMetadata;
  private readonly config: ApiKeyBackendAdapterConfig;
  private readonly baseURL: string;
  private readonly modelCache: ReturnType<typeof getModelCache>;

  constructor(config: ApiKeyBackendAdapterConfig) {
    this.config = config;
    this.baseURL = config.baseURL || 'https://api.cohere.ai/v1';
    this.modelCache = getModelCache(config.modelsCacheScope || 'global');
    this.metadata = {
      name: 'cohere-backend',
      version: '1.0.0',
      provider: 'Cohere',
      capabilities: {
        embeddings: true,
        embeddingModels: ['embed-v4.0', 'embed-english-v3.0', 'embed-multilingual-v3.0'],
        maxEmbeddingBatchSize: 96,
        streaming: true,
        multiModal: false, // Text-only
        tools: false, // No function calling
        structuredOutput: 'fallback',
        maxContextTokens: 128000,
        systemMessageStrategy: 'separate-parameter', // Uses preamble field
        supportsMultipleSystemMessages: false, // Only one preamble
        supportsTemperature: true,
        supportsTopP: true,
        supportsTopK: true,
        supportsSeed: false,
        supportsFrequencyPenalty: true,
        supportsPresencePenalty: true,
        maxStopSequences: 4,
      },
      config: {
        baseURL: this.baseURL,
      },
    };
  }

  /**
   * Convert IR to Cohere format.
   */
  public fromIR(request: IRChatRequest): CohereRequest {
    const { messages, systemParameter } = normalizeSystemMessages(
      buildStructuredOutputFallbackMessages(request.messages, request.responseFormat),
      this.metadata.capabilities.systemMessageStrategy,
      this.metadata.capabilities.supportsMultipleSystemMessages
    );

    // Cohere requires the last message to be a user message
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role !== 'user') {
      throw new AdapterConversionError({
        code: ErrorCode.ADAPTER_CONVERSION_ERROR,
        message: 'Cohere requires the last message to be from user',
        provenance: { backend: this.metadata.name },
      });
    }

    // Extract text content from last message
    const currentMessage =
      typeof lastMessage.content === 'string'
        ? lastMessage.content
        : lastMessage.content.map((block) => (block.type === 'text' ? block.text : '')).join('');

    // Convert chat history (all messages except the last)
    const chatHistory: CohereChatMessage[] = messages.slice(0, -1).map((msg) => ({
      role: msg.role === 'user' ? 'USER' : 'CHATBOT',
      message:
        typeof msg.content === 'string'
          ? msg.content
          : msg.content.map((block) => (block.type === 'text' ? block.text : '')).join(''),
    }));

    const cohereRequest: CohereRequest = {
      message: currentMessage,
      temperature: request.parameters?.temperature,
      max_tokens: request.parameters?.maxTokens,
      p: request.parameters?.topP,
      k: request.parameters?.topK,
      frequency_penalty: request.parameters?.frequencyPenalty,
      presence_penalty: request.parameters?.presencePenalty,
      stop_sequences: request.parameters?.stopSequences
        ? [...request.parameters.stopSequences]
        : undefined,
      stream: request.stream || false,
    };

    // Add model if specified
    if (request.parameters?.model || this.config.defaultModel) {
      cohereRequest.model = request.parameters?.model || this.config.defaultModel || 'command-r7b';
    }

    // Add chat history if present
    if (chatHistory.length > 0) {
      cohereRequest.chat_history = chatHistory;
    }

    // Add system message as preamble
    if (systemParameter) {
      cohereRequest.preamble =
        typeof systemParameter === 'string'
          ? systemParameter
          : (systemParameter as any[])
              .map((block: any) => (block.type === 'text' ? block.text : ''))
              .join('');
    }

    // Add Cohere-specific RAG parameters if provided
    if (request.parameters?.custom?.documents) {
      cohereRequest.documents = request.parameters.custom.documents as Array<{
        id?: string;
        data: Record<string, any>;
      }>;
    }
    if (request.parameters?.custom?.connectors) {
      cohereRequest.connectors = request.parameters.custom.connectors as Array<{ id: string }>;
    }

    return cohereRequest;
  }

  /**
   * Convert Cohere response to IR.
   */
  public toIR(
    response: CohereResponse,
    originalRequest: IRChatRequest,
    latencyMs: number
  ): IRChatResponse {
    const content = originalRequest.responseFormat
      ? extractStructuredOutputJSON(response.text)
      : response.text;
    const message: IRMessage = {
      role: 'assistant',
      content,
    };

    const finishReasonMap: Record<string, FinishReason> = {
      COMPLETE: 'stop',
      MAX_TOKENS: 'length',
      ERROR: 'stop',
      ERROR_TOXIC: 'stop',
    };

    return {
      message,
      finishReason: finishReasonMap[response.finish_reason] || 'stop',
      usage: response.meta?.billed_units
        ? {
            promptTokens: response.meta.billed_units.input_tokens,
            completionTokens: response.meta.billed_units.output_tokens,
            totalTokens:
              response.meta.billed_units.input_tokens + response.meta.billed_units.output_tokens,
          }
        : undefined,
      metadata: {
        ...originalRequest.metadata,
        providerResponseId: response.generation_id,
        provenance: {
          ...originalRequest.metadata.provenance,
          backend: this.metadata.name,
          locality: 'external',
          // This provider does not report a served model. Setting it explicitly
          // stops an upstream hop's value, spread in above, from being
          // re-attributed to this backend — absent is acceptable, wrong is not.
          servedModel: undefined,
        },
        custom: {
          ...originalRequest.metadata.custom,
          latencyMs,
          ...(response.citations && response.citations.length > 0
            ? { citations: response.citations }
            : {}),
          ...(originalRequest.responseFormat ? { responseFormatEnforced: false } : {}),
        },
        warnings: originalRequest.responseFormat
          ? [
              ...(originalRequest.metadata.warnings ?? []),
              buildResponseFormatFallbackWarning(this.metadata.name),
            ]
          : originalRequest.metadata.warnings,
      },
      raw: response as unknown as Record<string, unknown>,
    };
  }

  /**
   * Execute non-streaming request.
   */
  /**
   * Generate embeddings via Cohere's v2 embed endpoint.
   *
   * Cohere requires an input_type; IR `inputType` maps directly, defaulting
   * to 'search_document'.
   */
  async embed(request: IREmbedRequest, signal?: AbortSignal): Promise<IREmbedResponse> {
    const model = request.parameters?.model || this.config.defaultModel || 'embed-v4.0';
    const inputs = typeof request.input === 'string' ? [request.input] : [...request.input];
    const inputTypeMap: Record<string, string> = {
      query: 'search_query',
      document: 'search_document',
      classification: 'classification',
      clustering: 'clustering',
    };
    const inputType = inputTypeMap[request.parameters?.inputType ?? 'document'];

    // v2 embed lives under /v2 regardless of the chat base path
    const embedURL = this.baseURL.replace(/\/v1$/, '/v2');
    const response = await fetch(`${embedURL}/embed`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model,
        texts: inputs,
        input_type: inputType,
        embedding_types: ['float'],
        ...(request.parameters?.truncate !== undefined && {
          truncate: request.parameters.truncate ? 'END' : 'NONE',
        }),
      }),
      signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw createErrorFromHttpResponse(response.status, response.statusText, errorBody, {
        backend: this.metadata.name,
      });
    }

    const json = (await response.json()) as {
      embeddings: { float?: number[][] };
      meta?: { billed_units?: { input_tokens?: number } };
    };

    const vectors = json.embeddings.float ?? [];
    const embeddings = vectors.map((vector, index) => ({ index, vector }));
    const promptTokens = json.meta?.billed_units?.input_tokens;

    return {
      embeddings,
      model,
      dimensions: embeddings[0]?.vector.length ?? 0,
      usage: promptTokens !== undefined ? { promptTokens, totalTokens: promptTokens } : undefined,
      metadata: {
        ...request.metadata,
        provenance: {
          ...request.metadata.provenance,
          backend: this.metadata.name,
          locality: 'external',
        },
      },
      raw: json as unknown as Record<string, unknown>,
    };
  }

  async execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse> {
    try {
      const cohereRequest = this.fromIR(request);
      cohereRequest.stream = false;

      const startTime = Date.now();
      const response = await fetch(`${this.baseURL}/chat`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(cohereRequest),
        signal,
      });

      if (!response.ok) {
        throw createErrorFromHttpResponse(
          response.status,
          response.statusText,
          await response.text(),
          { backend: this.metadata.name }
        );
      }

      const data = (await response.json()) as CohereResponse;
      return this.toIR(data, request, Date.now() - startTime);
    } catch (error) {
      if (error instanceof NetworkError || error instanceof ProviderError) {
        throw error;
      }

      throw new ProviderError({
        code: ErrorCode.PROVIDER_ERROR,
        message: `Cohere request failed: ${error instanceof Error ? error.message : String(error)}`,
        isRetryable: true,
        provenance: { backend: this.metadata.name },
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Execute streaming request.
   */
  async *executeStream(request: IRChatRequest, signal?: AbortSignal): IRChatStream {
    let sequence = 0;
    try {
      const cohereRequest = this.fromIR(request);
      cohereRequest.stream = true;

      const streamingConfig = mergeStreamingConfig(this.config.streaming);
      const effectiveMode = getEffectiveStreamMode(request.streamMode, undefined, streamingConfig);
      const includeBoth = streamingConfig.includeBoth || effectiveMode === 'accumulated';

      const response = await fetch(`${this.baseURL}/chat`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(cohereRequest),
        signal,
      });

      if (!response.ok) {
        throw createErrorFromHttpResponse(
          response.status,
          response.statusText,
          await response.text(),
          { backend: this.metadata.name }
        );
      }

      if (!response.body) {
        throw new StreamError({
          code: ErrorCode.STREAM_ERROR,
          message: 'No response body',
          provenance: { backend: this.metadata.name },
        });
      }
      let contentBuffer = '';
      let citations: CohereResponse['citations'];

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
            if (!line.trim()) {
              continue;
            }

            try {
              const chunk = JSON.parse(line) as CohereStreamChunk;

              // Handle different event types
              if (chunk.event_type === 'text-generation' && chunk.text) {
                contentBuffer += chunk.text;

                const contentChunk: IRStreamChunk = {
                  type: 'content',
                  sequence: sequence++,
                  delta: chunk.text,
                  role: 'assistant',
                };

                if (includeBoth) {
                  (contentChunk as any).accumulated = contentBuffer;
                }

                yield contentChunk;
              } else if (chunk.event_type === 'citation-generation' && chunk.citations) {
                citations = chunk.citations;
              } else if (chunk.event_type === 'stream-end') {
                const finishReasonMap: Record<string, FinishReason> = {
                  COMPLETE: 'stop',
                  MAX_TOKENS: 'length',
                  ERROR: 'stop',
                  ERROR_TOXIC: 'stop',
                };

                const doneChunk: IRStreamChunk = {
                  type: 'done',
                  sequence: sequence++,
                  finishReason: finishReasonMap[chunk.finish_reason || 'COMPLETE'] || 'stop',
                  message: { role: 'assistant', content: contentBuffer },
                };

                // Include citations if present
                if (citations && citations.length > 0) {
                  (doneChunk as any).citations = citations;
                }

                yield doneChunk;
              }
            } catch (parseError) {
              console.warn('Failed to parse Cohere stream chunk:', line, parseError);
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

  /**
   * Get HTTP headers.
   * Cohere uses Authorization: Bearer token.
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
    };

    return { ...headers, ...this.config.headers };
  }

  /**
   * Health check.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseURL}/check-api-key`, {
        method: 'POST',
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Estimate cost.
   */
  estimateCost(request: IRChatRequest): Promise<number | null> {
    const pricing: Record<string, { input: number; output: number }> = {
      'command-r': { input: 0.15, output: 0.6 },
      'command-r-plus': { input: 3.0, output: 15.0 },
      command: { input: 1.0, output: 2.0 },
      'command-light': { input: 0.3, output: 0.6 },
    };

    const model = request.parameters?.model || this.config.defaultModel || '';
    const modelPricing = pricing[model];

    if (!modelPricing) {
      return Promise.resolve(null);
    }

    const inputTokens = estimateTokens(request);

    const outputTokens = request.parameters?.maxTokens || 1024;

    const inputCost = (inputTokens / 1_000_000) * modelPricing.input;
    const outputCost = (outputTokens / 1_000_000) * modelPricing.output;

    return Promise.resolve(inputCost + outputCost);
  }

  /**
   * List available models from Cohere API with caching and fallback.
   *
   * Priority order:
   * 1. Static config override (this.config.models)
   * 2. Cached result (1 hour TTL)
   * 3. API fetch (https://api.cohere.ai/v1/models)
   * 4. Fallback to DEFAULT_COHERE_MODELS
   *
   * @param options - Optional filter and refresh settings
   * @returns Promise resolving to list of models
   */
  async listModels(options?: ListModelsOptions): Promise<ListModelsResult> {
    try {
      // 1. Check static config override first
      if (this.config.models && !options?.forceRefresh) {
        return buildStaticResult(this.config.models, 'cohere');
      }

      // 2. Check cache
      if (this.config.cacheModels !== false && !options?.forceRefresh) {
        const cached = this.modelCache.get(this.metadata.name);
        if (cached) {
          return applyModelFilter(cached, options?.filter as ModelCapabilityFilter);
        }
      }

      // 3. Fetch from Cohere API
      const response = await fetch(`${this.baseURL}/models`, {
        method: 'GET',
        headers: this.getHeaders(),
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

      const data = (await response.json()) as { models: any[] };

      // 4. Transform to AIModel format - filter for chat models
      const models = data.models
        .filter((m) => m.endpoints?.includes('chat'))
        .map((model) => this.transformCohereModel(model));

      // 5. Build result
      const result: ListModelsResult = {
        models,
        source: 'remote',
        fetchedAt: Date.now(),
        isComplete: true,
      };

      // 6. Cache the result
      if (this.config.cacheModels !== false) {
        const ttl = this.config.modelsCacheTTL || 3600000; // 1 hour default
        this.modelCache.set(this.metadata.name, result, ttl);
      }

      // 7. Apply filter if requested
      return applyModelFilter(result, options?.filter as ModelCapabilityFilter);
    } catch {
      // 8. Fallback to cached result on error
      if (!options?.forceRefresh) {
        const cached = this.modelCache.get(this.metadata.name);
        if (cached) {
          return cached;
        }
      }

      // 9. Final fallback to DEFAULT_COHERE_MODELS
      const result: ListModelsResult = {
        models: [...DEFAULT_COHERE_MODELS],
        source: 'static',
        fetchedAt: Date.now(),
        isComplete: true,
      };
      return applyModelFilter(result, options?.filter as ModelCapabilityFilter);
    }
  }

  /**
   * Transform Cohere API model to AIModel format.
   */
  private transformCohereModel(model: any): AIModel {
    return {
      id: model.name,
      name: model.name,
      ownedBy: 'cohere',
      capabilities: {
        maxTokens: 4096,
        contextWindow: model.context_length || 128000,
        supportsStreaming: true,
        supportsVision: false,
        supportsTools: false,
        supportsJSON: false,
      },
    };
  }

  /**
   * Invalidate the model cache for this provider.
   * Useful when you want to force a fresh fetch on next listModels() call.
   *
   * @returns this for chaining
   */
  invalidateModelCache(): CohereBackendAdapter {
    this.modelCache.invalidate(this.metadata.name);
    return this;
  }
}
