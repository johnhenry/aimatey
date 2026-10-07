/**
 * Fireworks AI Backend Adapter
 *
 * Adapts Universal IR to Fireworks AI Chat Completions API.
 * Fireworks AI is OpenAI-compatible with 100+ models and fastest APIs.
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
  estimateTokens,
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
// Fireworks AI API Types (OpenAI-compatible with extensions)
// ============================================================================

export type FireworksAIMessageContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

export interface FireworksAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: FireworksAIMessageContent;
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

export interface FireworksAIRequest {
  model: string;
  messages: FireworksAIMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  top_k?: number; // Fireworks AI supports topK (unique among OpenAI-compatible)
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string[];
  stream?: boolean;
  reasoning_effort?: 'low' | 'medium' | 'high'; // For reasoning models
}

export interface FireworksAIResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: FireworksAIMessage;
    finish_reason: 'stop' | 'length' | 'tool_calls' | null;
  }>;
  usage: {
    // Always present in Fireworks AI
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface FireworksAIStreamChunk {
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
  usage?: {
    // Usage stats included in streaming chunks
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ============================================================================
// Fireworks AI Backend Adapter
// ============================================================================

/**
 * Backend adapter for Fireworks AI Chat Completions API.
 *
 * Features:
 * - 100+ open-source models
 * - Fastest inference APIs
 * - OpenAI-compatible with topK support
 * - Vision model support
 * - Function calling support
 * - Reasoning models with reasoning_effort parameter
 * - Pricing from $0.10 per 1M tokens
 */
export class FireworksAIBackendAdapter implements BackendAdapter<
  FireworksAIRequest,
  FireworksAIResponse
> {
  readonly metadata: AdapterMetadata;
  private readonly config: ApiKeyBackendAdapterConfig;
  private readonly baseURL: string;

  constructor(config: ApiKeyBackendAdapterConfig) {
    this.config = config;
    this.baseURL = config.baseURL || 'https://api.fireworks.ai/inference/v1';
    this.metadata = {
      name: 'fireworks-ai-backend',
      version: '1.0.0',
      provider: 'Fireworks AI',
      capabilities: {
        embeddings: true,
        maxEmbeddingBatchSize: 100,
        streaming: true,
        multiModal: true, // Vision models available
        tools: false, // Function calling
        structuredOutput: 'fallback',
        maxContextTokens: 1000000, // DeepSeek V4 and other current models support up to 1M
        systemMessageStrategy: 'in-messages',
        supportsMultipleSystemMessages: true,
        supportsTemperature: true,
        supportsTopP: true,
        supportsTopK: true, // Fireworks AI supports topK
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
   * Convert IR to Fireworks AI format.
   */
  public fromIR(request: IRChatRequest): FireworksAIRequest {
    const { messages } = normalizeSystemMessages(
      buildStructuredOutputFallbackMessages(request.messages, request.responseFormat),
      this.metadata.capabilities.systemMessageStrategy,
      this.metadata.capabilities.supportsMultipleSystemMessages
    );

    const fireworksMessages: FireworksAIMessage[] = messages.map((msg) => ({
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
                    url: mediaSourceToUrl(block.source, 'fireworks-ai-backend'),
                  },
                };
              }
              return { type: 'text', text: JSON.stringify(block) };
            }),
    }));

    const fireworksRequest: FireworksAIRequest = {
      model:
        request.parameters?.model ||
        this.config.defaultModel ||
        'accounts/fireworks/models/deepseek-v4-flash',
      messages: fireworksMessages,
      temperature: request.parameters?.temperature,
      max_tokens: request.parameters?.maxTokens,
      top_p: request.parameters?.topP,
      top_k: request.parameters?.topK, // Pass through topK
      frequency_penalty: request.parameters?.frequencyPenalty,
      presence_penalty: request.parameters?.presencePenalty,
      stop: request.parameters?.stopSequences ? [...request.parameters.stopSequences] : undefined,
      stream: request.stream || false,
    };

    // Add reasoning_effort for reasoning models (if specified in custom parameters)
    if (request.parameters?.custom?.reasoning_effort) {
      fireworksRequest.reasoning_effort = request.parameters.custom.reasoning_effort as
        | 'low'
        | 'medium'
        | 'high';
    }

    return fireworksRequest;
  }

  /**
   * Convert Fireworks AI response to IR.
   */
  public toIR(
    response: FireworksAIResponse,
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
      usage: {
        // Usage always present in Fireworks AI
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
   * Execute non-streaming request.
   */
  /**
   * Generate embeddings via the OpenAI-compatible /embeddings endpoint.
   */
  embed(request: IREmbedRequest, signal?: AbortSignal): Promise<IREmbedResponse> {
    return executeOpenAICompatibleEmbed({
      baseURL: this.baseURL,
      headers: this.getHeaders(),
      request,
      backendName: this.metadata.name,
      defaultModel: 'nomic-ai/nomic-embed-text-v1.5',
      signal,
    });
  }

  async execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse> {
    try {
      const fireworksRequest = this.fromIR(request);
      fireworksRequest.stream = false;

      const startTime = Date.now();
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(fireworksRequest),
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

      const data = (await response.json()) as FireworksAIResponse;
      return this.toIR(data, request, Date.now() - startTime);
    } catch (error) {
      if (error instanceof NetworkError || error instanceof ProviderError) {
        throw error;
      }

      throw new ProviderError({
        code: ErrorCode.PROVIDER_ERROR,
        message: `Fireworks AI request failed: ${error instanceof Error ? error.message : String(error)}`,
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
      const fireworksRequest = this.fromIR(request);
      fireworksRequest.stream = true;

      const streamingConfig = mergeStreamingConfig(this.config.streaming);
      const effectiveMode = getEffectiveStreamMode(request.streamMode, undefined, streamingConfig);
      const includeBoth = streamingConfig.includeBoth || effectiveMode === 'accumulated';

      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(fireworksRequest),
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
      let usage:
        | { promptTokens: number; completionTokens: number; totalTokens: number }
        | undefined;

      yield {
        type: 'start',
        sequence: sequence++,
        metadata: {
          ...request.metadata,
          provenance: {
            ...request.metadata.provenance,
            backend: this.metadata.name,
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
              const chunk = JSON.parse(data) as FireworksAIStreamChunk;
              const delta = chunk.choices[0]?.delta?.content;

              // Capture usage stats from streaming chunks
              if (chunk.usage) {
                usage = {
                  promptTokens: chunk.usage.prompt_tokens,
                  completionTokens: chunk.usage.completion_tokens,
                  totalTokens: chunk.usage.total_tokens,
                };
              }

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

                const doneChunk: IRStreamChunk = {
                  type: 'done',
                  sequence: sequence++,
                  finishReason: finishReasonMap[chunk.choices[0].finish_reason] || 'stop',
                  message: { role: 'assistant', content: contentBuffer },
                };

                // Include usage stats in done chunk
                if (usage) {
                  (doneChunk as any).usage = usage;
                }

                yield doneChunk;
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
   * Estimate cost.
   */
  estimateCost(request: IRChatRequest): Promise<number | null> {
    const pricing: Record<string, { input: number; output: number }> = {
      'accounts/fireworks/models/deepseek-v4-flash': { input: 0.2, output: 0.2 },
      'accounts/fireworks/models/llama-v3p1-70b-instruct': { input: 0.9, output: 0.9 },
      'accounts/fireworks/models/qwen2p5-72b-instruct': { input: 0.9, output: 0.9 },
      'accounts/fireworks/models/deepseek-v3': { input: 0.9, output: 2.0 },
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
