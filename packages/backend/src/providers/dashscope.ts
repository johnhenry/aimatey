/**
 * DashScope (Alibaba Cloud Model Studio) Backend Adapter
 *
 * Adapts Universal IR to Alibaba Cloud Model Studio's OpenAI-compatible mode.
 * DashScope hosts the Qwen model family (commercial and open-source variants).
 *
 * @module
 */

import type {
  BackendAdapter,
  ApiKeyBackendAdapterConfig,
  AdapterMetadata,
} from '@johnhenry/aimatey-types';
import type { IREmbedRequest, IREmbedResponse } from '@johnhenry/aimatey-types';
import {
  executeOpenAICompatibleEmbed,
  buildStructuredOutputFallbackMessages,
  extractStructuredOutputJSON,
  buildResponseFormatFallbackWarning,
  buildToolsUnsupportedWarning,
} from '../shared.js';
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
import { normalizeSystemMessages, mediaSourceToUrl } from '@johnhenry/aimatey-utils';
import { getEffectiveStreamMode, mergeStreamingConfig } from '@johnhenry/aimatey-utils';

// ============================================================================
// DashScope API Types (OpenAI-compatible mode)
// ============================================================================

export type DashScopeMessageContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

export interface DashScopeMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: DashScopeMessageContent;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export interface DashScopeRequest {
  model: string;
  messages: DashScopeMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string[];
  stream?: boolean;
}

export interface DashScopeResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: DashScopeMessage;
    finish_reason: 'stop' | 'length' | 'tool_calls' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface DashScopeStreamChunk {
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
// DashScope Backend Adapter
// ============================================================================

/**
 * Backend adapter for Alibaba Cloud Model Studio's OpenAI-compatible mode.
 *
 * Features:
 * - Qwen model family (qwen3.7-max/plus, qwen3.6-flash, and open-source Qwen)
 * - OpenAI-compatible API (`/compatible-mode/v1`)
 * - Vision model support (Qwen-VL family)
 * - Free tier: 1,000,000 tokens per model on Alibaba Cloud International
 */
export class DashScopeBackendAdapter implements BackendAdapter<
  DashScopeRequest,
  DashScopeResponse
> {
  readonly metadata: AdapterMetadata;
  private readonly config: ApiKeyBackendAdapterConfig;
  private readonly baseURL: string;

  constructor(config: ApiKeyBackendAdapterConfig) {
    this.config = config;
    // International (Singapore) endpoint by default; mainland China deployments
    // should override baseURL with their region-specific compatible-mode URL.
    this.baseURL = config.baseURL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    this.metadata = {
      name: 'dashscope-backend',
      version: '1.0.0',
      provider: 'Alibaba Cloud Model Studio (DashScope)',
      capabilities: {
        embeddings: true,
        maxEmbeddingBatchSize: 100,
        streaming: true,
        multiModal: true, // Qwen-VL family
        tools: false, // Function calling
        structuredOutput: 'fallback',
        maxContextTokens: 131072,
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
   * Convert IR to DashScope format.
   */
  public fromIR(request: IRChatRequest): DashScopeRequest {
    const { messages } = normalizeSystemMessages(
      buildStructuredOutputFallbackMessages(request.messages, request.responseFormat),
      this.metadata.capabilities.systemMessageStrategy,
      this.metadata.capabilities.supportsMultipleSystemMessages
    );

    const dashScopeMessages: DashScopeMessage[] = messages.map((msg) => ({
      role: msg.role,
      content:
        typeof msg.content === 'string'
          ? msg.content
          : msg.content.map((block) => {
              if (block.type === 'text') {
                return { type: 'text', text: block.text };
              } else if (block.type === 'image') {
                return {
                  type: 'image_url',
                  image_url: {
                    url: mediaSourceToUrl(block.source, 'dashscope-backend'),
                  },
                };
              }
              return { type: 'text', text: JSON.stringify(block) };
            }),
    }));

    return {
      model: request.parameters?.model || this.config.defaultModel || 'qwen3.7-flash',
      messages: dashScopeMessages,
      temperature: request.parameters?.temperature,
      max_tokens: request.parameters?.maxTokens,
      top_p: request.parameters?.topP,
      frequency_penalty: request.parameters?.frequencyPenalty,
      presence_penalty: request.parameters?.presencePenalty,
      stop: request.parameters?.stopSequences ? [...request.parameters.stopSequences] : undefined,
      stream: request.stream || false,
    };
  }

  /**
   * Convert DashScope response to IR.
   */
  public toIR(
    response: DashScopeResponse,
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

    const rawContent =
      typeof choice.message.content === 'string'
        ? choice.message.content
        : choice.message.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('');
    const content = originalRequest.responseFormat
      ? extractStructuredOutputJSON(rawContent)
      : rawContent;
    const message: IRMessage = {
      role: choice.message.role === 'assistant' ? 'assistant' : 'user',
      content,
    };

    const finishReasonMap: Record<string, FinishReason> = {
      stop: 'stop',
      length: 'length',
      tool_calls: 'tool_calls',
    };

    const extraWarnings = [
      ...(originalRequest.responseFormat
        ? [buildResponseFormatFallbackWarning(this.metadata.name)]
        : []),
      ...(originalRequest.tools?.length ? [buildToolsUnsupportedWarning(this.metadata.name)] : []),
    ];

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
        warnings: extraWarnings.length
          ? [...(originalRequest.metadata.warnings ?? []), ...extraWarnings]
          : originalRequest.metadata.warnings,
      },
      raw: response as unknown as Record<string, unknown>,
    };
  }

  /**
   * Generate embeddings via the OpenAI-compatible /embeddings endpoint.
   */
  embed(request: IREmbedRequest, signal?: AbortSignal): Promise<IREmbedResponse> {
    return executeOpenAICompatibleEmbed({
      baseURL: this.baseURL,
      headers: this.getHeaders(),
      request,
      backendName: this.metadata.name,
      defaultModel: 'text-embedding-v4',
      signal,
    });
  }

  /**
   * Execute non-streaming request.
   */
  async execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse> {
    try {
      const dashScopeRequest = this.fromIR(request);
      dashScopeRequest.stream = false;

      const startTime = Date.now();
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(dashScopeRequest),
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

      const data = (await response.json()) as DashScopeResponse;
      return this.toIR(data, request, Date.now() - startTime);
    } catch (error) {
      if (error instanceof NetworkError || error instanceof ProviderError) {
        throw error;
      }

      throw new ProviderError({
        code: ErrorCode.PROVIDER_ERROR,
        message: `DashScope request failed: ${error instanceof Error ? error.message : String(error)}`,
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
      const dashScopeRequest = this.fromIR(request);
      dashScopeRequest.stream = true;

      const streamingConfig = mergeStreamingConfig(this.config.streaming);
      const effectiveMode = getEffectiveStreamMode(request.streamMode, undefined, streamingConfig);
      const includeBoth = streamingConfig.includeBoth || effectiveMode === 'accumulated';

      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(dashScopeRequest),
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
              const chunk = JSON.parse(data) as DashScopeStreamChunk;
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
   * Estimate cost. DashScope pricing isn't consistently published in English-
   * language docs across regions/models, so this returns null rather than
   * risk asserting a wrong number; override with a custom cost estimator if
   * you need budgeting against a specific known SKU.
   */
  estimateCost(_request: IRChatRequest): Promise<number | null> {
    return Promise.resolve(null);
  }
}
