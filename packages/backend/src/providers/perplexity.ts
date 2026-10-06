/**
 * Perplexity AI Backend Adapter
 *
 * Adapts Universal IR to Perplexity AI Chat Completions API.
 * Perplexity is OpenAI-compatible with search-augmented responses and citations.
 *
 * @module
 */

import type {
  BackendAdapter,
  ApiKeyBackendAdapterConfig,
  AdapterMetadata,
} from '@johnhenry/aimatey-types';
import type {
  IRDecisionRequest,
  IRDecisionResponse,
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
  buildStructuredOutputFallbackMessages,
  extractStructuredOutputJSON,
  buildResponseFormatFallbackWarning,
  estimateTokens,
} from '../shared.js';
import { decideViaSystemOne, estimateSystemOneCost } from '../decisions/systemone-client.js';

// ============================================================================
// Perplexity AI API Types (OpenAI-compatible with search extensions)
// ============================================================================

export type PerplexityMessageContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

export interface PerplexityMessage {
  role: 'system' | 'user' | 'assistant';
  content: PerplexityMessageContent;
}

export interface PerplexityRequest {
  model: string;
  messages: PerplexityMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string[];
  stream?: boolean;
  search_domain_filter?: string[]; // Perplexity-specific: limit search to domains
  return_citations?: boolean; // Perplexity-specific: include citations
  return_images?: boolean; // Perplexity-specific: include images
  search_recency_filter?: string; // Perplexity-specific: time filter (month, week, day, hour)
}

export interface PerplexityResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: PerplexityMessage;
    finish_reason: 'stop' | 'length' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  citations?: string[]; // Perplexity-specific: source URLs
}

export interface PerplexityStreamChunk {
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
  citations?: string[];
}

// ============================================================================
// Perplexity AI Backend Adapter
// ============================================================================

/**
 * Backend adapter for Perplexity AI Chat Completions API.
 *
 * Features:
 * - Search-augmented responses with real-time web search
 * - Citations and source URLs
 * - OpenAI-compatible API
 * - Online and offline models
 * - Domain filtering and recency filtering
 * - Pricing around $1 per 1M tokens
 */
export class PerplexityBackendAdapter implements BackendAdapter<
  PerplexityRequest,
  PerplexityResponse
> {
  readonly metadata: AdapterMetadata;
  private readonly config: ApiKeyBackendAdapterConfig;
  private readonly baseURL: string;

  constructor(config: ApiKeyBackendAdapterConfig) {
    this.config = config;
    this.baseURL = config.baseURL || 'https://api.perplexity.ai';
    this.metadata = {
      name: 'perplexity-backend',
      version: '1.0.0',
      provider: 'Perplexity AI',
      capabilities: {
        streaming: true,
        multiModal: false, // Text-only
        tools: false, // No function calling
        structuredOutput: 'fallback',
        maxContextTokens: 128000,
        systemMessageStrategy: 'in-messages',
        supportsMultipleSystemMessages: true,
        supportsTemperature: true,
        supportsTopP: true,
        supportsTopK: false,
        supportsSeed: false,
        supportsFrequencyPenalty: true,
        supportsPresencePenalty: true,
        maxStopSequences: 4,
        // Typed decisions via `/v1/decisions` (pplx-decider).
        decisions: true,
        decisionModels: ['pplx-decider-v1-27b'],
        decisionTypes: ['choice', 'score', 'noul'],
        decisionImages: true,
      },
      config: {
        baseURL: this.baseURL,
      },
    };
  }

  /**
   * Convert IR to Perplexity format.
   */
  public fromIR(request: IRChatRequest): PerplexityRequest {
    const { messages } = normalizeSystemMessages(
      buildStructuredOutputFallbackMessages(request.messages, request.responseFormat),
      this.metadata.capabilities.systemMessageStrategy,
      this.metadata.capabilities.supportsMultipleSystemMessages
    );

    const perplexityMessages: PerplexityMessage[] = messages.map((msg) => ({
      role: msg.role === 'tool' ? 'user' : msg.role, // Map tool to user
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
                    url:
                      block.source.type === 'url'
                        ? block.source.url
                        : `data:${block.source.mediaType};base64,${block.source.data}`,
                  },
                };
              }
              return { type: 'text', text: JSON.stringify(block) };
            }),
    }));

    const perplexityRequest: PerplexityRequest = {
      model:
        // 'llama-3.1-sonar-*-online' models were retired when Perplexity
        // renamed its lineup to the plain 'sonar' family.
        request.parameters?.model || this.config.defaultModel || 'sonar',
      messages: perplexityMessages,
      temperature: request.parameters?.temperature,
      max_tokens: request.parameters?.maxTokens,
      top_p: request.parameters?.topP,
      frequency_penalty: request.parameters?.frequencyPenalty,
      presence_penalty: request.parameters?.presencePenalty,
      stop: request.parameters?.stopSequences ? [...request.parameters.stopSequences] : undefined,
      stream: request.stream || false,
    };

    // Add Perplexity-specific parameters if provided in custom config
    if (request.parameters?.custom?.search_domain_filter) {
      perplexityRequest.search_domain_filter = request.parameters.custom
        .search_domain_filter as string[];
    }
    if (request.parameters?.custom?.return_citations !== undefined) {
      perplexityRequest.return_citations = request.parameters.custom.return_citations as boolean;
    }
    if (request.parameters?.custom?.return_images !== undefined) {
      perplexityRequest.return_images = request.parameters.custom.return_images as boolean;
    }
    if (request.parameters?.custom?.search_recency_filter) {
      perplexityRequest.search_recency_filter = request.parameters.custom
        .search_recency_filter as string;
    }

    return perplexityRequest;
  }

  /**
   * Convert Perplexity response to IR.
   */
  public toIR(
    response: PerplexityResponse,
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
          servedModel: response.model,
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
  async execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse> {
    try {
      const perplexityRequest = this.fromIR(request);
      perplexityRequest.stream = false;

      const startTime = Date.now();
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(perplexityRequest),
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

      const data = (await response.json()) as PerplexityResponse;
      return this.toIR(data, request, Date.now() - startTime);
    } catch (error) {
      if (error instanceof NetworkError || error instanceof ProviderError) {
        throw error;
      }

      throw new ProviderError({
        code: ErrorCode.PROVIDER_ERROR,
        message: `Perplexity AI request failed: ${error instanceof Error ? error.message : String(error)}`,
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
      const perplexityRequest = this.fromIR(request);
      perplexityRequest.stream = true;

      const streamingConfig = mergeStreamingConfig(this.config.streaming);
      const effectiveMode = getEffectiveStreamMode(request.streamMode, undefined, streamingConfig);
      const includeBoth = streamingConfig.includeBoth || effectiveMode === 'accumulated';

      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(perplexityRequest),
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
      let citations: string[] | undefined;

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
              const chunk = JSON.parse(data) as PerplexityStreamChunk;
              const delta = chunk.choices[0]?.delta?.content;

              // Capture citations
              if (chunk.citations && chunk.citations.length > 0) {
                citations = chunk.citations;
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

                // Include citations in done chunk
                if (citations && citations.length > 0) {
                  (doneChunk as any).citations = citations;
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
   * Answer a typed-decision request with pplx-decider (default
   * `pplx-decider-v1-27b`) via `POST <baseURL>/v1/decisions`. Answers are
   * System One-shaped. Images are sent as `images[]` of base64 data URLs; a
   * `url` source throws. UNVERIFIED: the plan documents "images" but not the
   * field name or encoding -- `images` of data URLs mirrors Clef; check the
   * live API before relying on it.
   */
  decide(request: IRDecisionRequest, signal?: AbortSignal): Promise<IRDecisionResponse> {
    return decideViaSystemOne(request, {
      url: `${this.baseURL.replace(/\/+$/, '')}/v1/decisions`,
      dialect: 'systemone',
      model: request.parameters?.model || this.config.defaultModel || 'pplx-decider-v1-27b',
      sendImages: true,
      imageFormat: 'data-url',
      headers: this.getHeaders(),
      signal,
      backendName: this.metadata.name,
      provider: 'perplexity',
    });
  }

  /** Input-token pricing from the model registry ($0.04 per 1M; output free). */
  estimateDecisionCost(request: IRDecisionRequest): Promise<number | null> {
    return Promise.resolve(
      estimateSystemOneCost(
        request,
        request.parameters?.model || this.config.defaultModel || 'pplx-decider-v1-27b'
      )
    );
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
      'llama-3.1-sonar-small-128k-online': { input: 0.2, output: 0.2 },
      'llama-3.1-sonar-large-128k-online': { input: 1.0, output: 1.0 },
      'llama-3.1-sonar-huge-128k-online': { input: 5.0, output: 5.0 },
      'llama-3.1-sonar-small-128k-chat': { input: 0.2, output: 0.2 },
      'llama-3.1-sonar-large-128k-chat': { input: 1.0, output: 1.0 },
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
