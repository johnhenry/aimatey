/**
 * AI21 Labs Backend Adapter
 *
 * Adapts Universal IR to AI21 Labs Chat Completions API.
 * AI21 is OpenAI-compatible with Jamba models featuring efficient tokenization.
 *
 * @module
 */

import type {
  BackendAdapter,
  ApiKeyBackendAdapterConfig,
  AdapterMetadata,
} from '@johnhenry/aimatey-types';
import type {
  IRChatRequest,
  IRChatResponse,
  IRChatStream,
  IRMessage,
  IRStreamChunk,
  FinishReason,
} from '@johnhenry/aimatey-types';
import {
  NetworkError,
  ProviderError,
  StreamError,
  ErrorCode,
  createErrorFromHttpResponse,
} from '@johnhenry/aimatey-errors';
import { normalizeSystemMessages } from '@johnhenry/aimatey-utils';
import { getEffectiveStreamMode, mergeStreamingConfig } from '@johnhenry/aimatey-utils';
import {
  buildStaticResult,
  applyModelFilter,
  DEFAULT_AI21_MODELS,
  buildStructuredOutputFallbackMessages,
  extractStructuredOutputJSON,
  buildResponseFormatFallbackWarning,
  type ModelCapabilityFilter,
  estimateTokens,
} from '../shared.js';
import type { ListModelsOptions, ListModelsResult } from '@johnhenry/aimatey-types';

// ============================================================================
// AI21 Labs API Types (OpenAI-compatible)
// ============================================================================

export interface AI21Message {
  role: 'system' | 'user' | 'assistant';
  content: string; // AI21 only supports text content
}

export interface AI21Request {
  model: string;
  messages: AI21Message[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string[];
  stream?: boolean;
  // AI21-specific parameters
  n?: number; // Number of completions
  documents?: Array<{
    // Documents for RAG
    content: string;
    metadata?: Record<string, any>;
  }>;
}

export interface AI21Response {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: AI21Message;
    finish_reason: 'stop' | 'length' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface AI21StreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
    };
    finish_reason: 'stop' | 'length' | null;
  }>;
}

// ============================================================================
// AI21 Labs Backend Adapter
// ============================================================================

/**
 * Backend adapter for AI21 Labs Chat Completions API.
 *
 * Features:
 * - Jamba models with efficient tokenization
 * - OpenAI-compatible API
 * - RAG support with document parameter
 * - Text-only (no vision support)
 * - No function calling
 * - Pricing from $0.50 per 1M tokens
 */
export class AI21BackendAdapter implements BackendAdapter<AI21Request, AI21Response> {
  readonly metadata: AdapterMetadata;
  private readonly config: ApiKeyBackendAdapterConfig;
  private readonly baseURL: string;

  constructor(config: ApiKeyBackendAdapterConfig) {
    this.config = config;
    this.baseURL = config.baseURL || 'https://api.ai21.com/studio/v1';
    this.metadata = {
      name: 'ai21-backend',
      version: '1.0.0',
      provider: 'AI21 Labs',
      capabilities: {
        streaming: true,
        multiModal: false, // Text-only
        tools: false, // No function calling
        structuredOutput: 'fallback',
        maxContextTokens: 256000, // Jamba 1.5 has 256K context
        systemMessageStrategy: 'in-messages',
        supportsMultipleSystemMessages: true,
        supportsTemperature: true,
        supportsTopP: true,
        supportsTopK: false,
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
   * Convert IR to AI21 format.
   */
  public fromIR(request: IRChatRequest): AI21Request {
    const { messages } = normalizeSystemMessages(
      buildStructuredOutputFallbackMessages(request.messages, request.responseFormat),
      this.metadata.capabilities.systemMessageStrategy,
      this.metadata.capabilities.supportsMultipleSystemMessages
    );

    // AI21 only supports text content, so extract text from multi-modal content
    const ai21Messages: AI21Message[] = messages.map((msg) => ({
      role: msg.role === 'tool' ? 'user' : msg.role, // Map tool to user
      content:
        typeof msg.content === 'string'
          ? msg.content
          : msg.content.map((block) => (block.type === 'text' ? block.text : '')).join(''),
    }));

    const ai21Request: AI21Request = {
      model: request.parameters?.model || this.config.defaultModel || 'jamba-1.5-mini',
      messages: ai21Messages,
      temperature: request.parameters?.temperature,
      max_tokens: request.parameters?.maxTokens,
      top_p: request.parameters?.topP,
      frequency_penalty: request.parameters?.frequencyPenalty,
      presence_penalty: request.parameters?.presencePenalty,
      stop: request.parameters?.stopSequences ? [...request.parameters.stopSequences] : undefined,
      stream: request.stream || false,
    };

    // Add AI21-specific parameters if provided
    if (request.parameters?.custom?.documents) {
      ai21Request.documents = request.parameters.custom.documents as Array<{
        content: string;
        metadata?: Record<string, any>;
      }>;
    }
    if (request.parameters?.custom?.n) {
      ai21Request.n = request.parameters.custom.n as number;
    }

    return ai21Request;
  }

  /**
   * Convert AI21 response to IR.
   */
  public toIR(
    response: AI21Response,
    originalRequest: IRChatRequest,
    latencyMs: number
  ): IRChatResponse {
    const choice = response.choices[0];
    if (!choice) {
      throw new ProviderError({
        code: ErrorCode.PROVIDER_ERROR,
        message: 'No choices returned in response',
        isRetryable: false,
        provenance: { backend: this.metadata.name },
      });
    }

    const message: IRMessage = {
      role: choice.message.role === 'assistant' ? 'assistant' : 'user',
      content: originalRequest.responseFormat
        ? extractStructuredOutputJSON(choice.message.content)
        : choice.message.content,
    };

    const finishReasonMap: Record<string, FinishReason> = {
      stop: 'stop',
      length: 'length',
    };

    return {
      message,
      finishReason: finishReasonMap[choice.finish_reason || 'stop'] || 'stop',
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined,
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
          latencyMs,
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
  async execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse> {
    try {
      const ai21Request = this.fromIR(request);
      ai21Request.stream = false;

      const startTime = Date.now();
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(ai21Request),
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

      const data = (await response.json()) as AI21Response;
      return this.toIR(data, request, Date.now() - startTime);
    } catch (error) {
      if (error instanceof NetworkError || error instanceof ProviderError) {
        throw error;
      }

      throw new ProviderError({
        code: ErrorCode.PROVIDER_ERROR,
        message: `AI21 Labs request failed: ${error instanceof Error ? error.message : String(error)}`,
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
      const ai21Request = this.fromIR(request);
      ai21Request.stream = true;

      const streamingConfig = mergeStreamingConfig(this.config.streaming);
      const effectiveMode = getEffectiveStreamMode(request.streamMode, undefined, streamingConfig);
      const includeBoth = streamingConfig.includeBoth || effectiveMode === 'accumulated';

      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(ai21Request),
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
            if (!line.trim() || !line.startsWith('data: ')) {
              continue;
            }

            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              continue;
            }

            try {
              const chunk = JSON.parse(data) as AI21StreamChunk;
              const delta = chunk.choices[0]?.delta?.content;

              if (delta) {
                contentBuffer += delta;

                const contentChunk: IRStreamChunk = {
                  type: 'content',
                  sequence: sequence++,
                  delta: delta,
                  role: 'assistant',
                };

                if (includeBoth) {
                  (contentChunk as any).accumulated = contentBuffer;
                }

                yield contentChunk;
              }

              if (chunk.choices[0]?.finish_reason) {
                const finishReasonMap: Record<string, FinishReason> = {
                  stop: 'stop',
                  length: 'length',
                };

                yield {
                  type: 'done',
                  sequence: sequence++,
                  finishReason: finishReasonMap[chunk.choices[0].finish_reason] || 'stop',
                  message: { role: 'assistant', content: contentBuffer },
                } as IRStreamChunk;
              }
            } catch (parseError) {
              console.warn('Failed to parse SSE chunk:', data, parseError);
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
      const response = await fetch(`${this.baseURL}/models`, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * List available AI21 models.
   *
   * Since AI21 doesn't have a public models endpoint, this uses:
   * 1. Static config (config.models) - if provided
   * 2. Default model list - built-in list of Jamba models
   */
  listModels(options?: ListModelsOptions): Promise<ListModelsResult> {
    // 1. Check static config first
    if (this.config.models) {
      return Promise.resolve(buildStaticResult(this.config.models, 'ai21'));
    }

    // 2. Use default AI21 models
    const result: ListModelsResult = {
      models: [...DEFAULT_AI21_MODELS],
      source: 'static',
      fetchedAt: Date.now(),
      isComplete: true,
    };

    // 3. Apply filter if requested
    return Promise.resolve(applyModelFilter(result, options?.filter as ModelCapabilityFilter));
  }

  /**
   * Estimate cost.
   */
  estimateCost(request: IRChatRequest): Promise<number | null> {
    const pricing: Record<string, { input: number; output: number }> = {
      'jamba-instruct': { input: 0.5, output: 0.7 },
      'jamba-1.5-mini': { input: 0.2, output: 0.4 },
      'jamba-1.5-large': { input: 2.0, output: 8.0 },
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
}
