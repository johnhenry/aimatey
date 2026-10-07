/**
 * GitHub Models Backend Adapter
 *
 * Adapts Universal IR to GitHub Models' Chat Completions API.
 * GitHub Models is OpenAI-compatible and free to any GitHub account (rate
 * limits scale with Copilot subscription tier), fronting models from OpenAI,
 * Meta, DeepSeek, Mistral, Microsoft, and Cohere.
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
// GitHub Models API Types (OpenAI-compatible)
// ============================================================================

export type GitHubModelsMessageContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

export interface GitHubModelsMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: GitHubModelsMessageContent;
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

export interface GitHubModelsRequest {
  model: string;
  messages: GitHubModelsMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string[];
  stream?: boolean;
}

export interface GitHubModelsResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: GitHubModelsMessage;
    finish_reason: 'stop' | 'length' | 'tool_calls' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface GitHubModelsStreamChunk {
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
// GitHub Models Backend Adapter
// ============================================================================

/**
 * Backend adapter for GitHub Models' Chat Completions API.
 *
 * Features:
 * - Free access via any GitHub account (rate limits scale with Copilot tier)
 * - OpenAI-compatible API (models.github.ai/inference)
 * - Models from OpenAI, Meta, DeepSeek, Mistral, Microsoft, Cohere
 * - Vision model support (gpt-4o, llama-3.2-vision, etc.)
 */
export class GitHubModelsBackendAdapter implements BackendAdapter<
  GitHubModelsRequest,
  GitHubModelsResponse
> {
  readonly metadata: AdapterMetadata;
  private readonly config: ApiKeyBackendAdapterConfig;
  private readonly baseURL: string;

  constructor(config: ApiKeyBackendAdapterConfig) {
    this.config = config;
    this.baseURL = config.baseURL || 'https://models.github.ai/inference';
    this.metadata = {
      name: 'github-models-backend',
      version: '1.0.0',
      provider: 'GitHub Models',
      capabilities: {
        embeddings: true,
        maxEmbeddingBatchSize: 100,
        streaming: true,
        multiModal: true, // gpt-4o, gpt-4.1, llama-3.2-vision, etc.
        tools: false, // Function calling
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
      },
      config: {
        baseURL: this.baseURL,
      },
    };
  }

  /**
   * Convert IR to GitHub Models format.
   */
  public fromIR(request: IRChatRequest): GitHubModelsRequest {
    const { messages } = normalizeSystemMessages(
      buildStructuredOutputFallbackMessages(request.messages, request.responseFormat),
      this.metadata.capabilities.systemMessageStrategy,
      this.metadata.capabilities.supportsMultipleSystemMessages
    );

    const githubMessages: GitHubModelsMessage[] = messages.map((msg) => ({
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
                    url: mediaSourceToUrl(block.source, 'github-models-backend'),
                  },
                };
              }
              return { type: 'text', text: JSON.stringify(block) };
            }),
    }));

    return {
      model: request.parameters?.model || this.config.defaultModel || 'openai/gpt-4o-mini',
      messages: githubMessages,
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
   * Convert GitHub Models response to IR.
   */
  public toIR(
    response: GitHubModelsResponse,
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
      defaultModel: 'openai/text-embedding-3-small',
      signal,
    });
  }

  /**
   * Execute non-streaming request.
   */
  async execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse> {
    try {
      const githubRequest = this.fromIR(request);
      githubRequest.stream = false;

      const startTime = Date.now();
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(githubRequest),
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

      const data = (await response.json()) as GitHubModelsResponse;
      return this.toIR(data, request, Date.now() - startTime);
    } catch (error) {
      if (error instanceof NetworkError || error instanceof ProviderError) {
        throw error;
      }

      throw new ProviderError({
        code: ErrorCode.PROVIDER_ERROR,
        message: `GitHub Models request failed: ${error instanceof Error ? error.message : String(error)}`,
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
      const githubRequest = this.fromIR(request);
      githubRequest.stream = true;

      const streamingConfig = mergeStreamingConfig(this.config.streaming);
      const effectiveMode = getEffectiveStreamMode(request.streamMode, undefined, streamingConfig);
      const includeBoth = streamingConfig.includeBoth || effectiveMode === 'accumulated';

      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(githubRequest),
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
              const chunk = JSON.parse(data) as GitHubModelsStreamChunk;
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
   * Health check. Hits the public (unauthenticated) model catalog rather than
   * `/chat/completions`, which has no cheap no-op request shape to send.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch('https://models.github.ai/catalog/models', {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Estimate cost. GitHub Models is free — usage counts against the caller's
   * Copilot subscription rate limits, not per-token billing.
   */
  estimateCost(_request: IRChatRequest): Promise<number | null> {
    return Promise.resolve(null);
  }
}
