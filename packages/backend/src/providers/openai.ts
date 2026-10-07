/**
 * OpenAI Backend Adapter
 *
 * Adapts Universal IR to OpenAI Chat Completions API.
 * Handles OpenAI's in-messages system message strategy and 0-2 temperature range.
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
import type { AIModel, ListModelsOptions, ListModelsResult } from '@johnhenry/aimatey-types';
import type { IREmbedRequest, IREmbedResponse } from '@johnhenry/aimatey-types';
import type { IRDecisionRequest, IRDecisionResponse } from '@johnhenry/aimatey-types';
import {
  AdapterConversionError,
  NetworkError,
  ProviderError,
  StreamError,
  ErrorCode,
  createErrorFromHttpResponse,
} from '@johnhenry/aimatey-errors';
import { normalizeSystemMessages, requireResolvedContent } from '@johnhenry/aimatey-utils';
import { getModelCache } from '@johnhenry/aimatey-utils';
import { getEffectiveStreamMode, mergeStreamingConfig } from '@johnhenry/aimatey-utils';
import { localityForBaseURL, servedByForBaseURL } from '@johnhenry/aimatey-utils';
import { postSystemOne, estimateSystemOneCost } from '../decisions/systemone-client.js';
import {
  buildOpenAIDecisionsRequest,
  parseOpenAIDecisionsResponse,
} from '../decisions/openai-decisions.js';
import { getModelPricingInfo } from '@johnhenry/aimatey-utils';
import {
  estimateTokens,
  buildStaticResult,
  applyModelFilter,
  buildStreamDoneMessage,
  executeOpenAICompatibleEmbed,
  safeParseJSON,
  type ModelCapabilityFilter,
  type StreamedToolCall,
} from '../shared.js';

// ============================================================================
// OpenAI API Types
// ============================================================================

/**
 * OpenAI message content.
 */
export type OpenAIMessageContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }
      | { type: 'input_audio'; input_audio: { data: string; format: string } }
    >;

/**
 * OpenAI message.
 */
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: OpenAIMessageContent;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

/**
 * OpenAI Chat Completions API request.
 */
export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  /**
   * Replaces `max_tokens` for gpt-5.x and o1/o3/o4 reasoning-model families,
   * which reject `max_tokens` outright. See `requiresMaxCompletionTokens`.
   */
  max_completion_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
  user?: string;
  seed?: number;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  }>;
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  response_format?: {
    type: 'json_schema';
    json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean };
  };
}

/**
 * OpenAI Chat Completions API response.
 */
export interface OpenAIResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: OpenAIMessage;
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * OpenAI streaming chunk.
 */
export interface OpenAIStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  }>;
  /** Final usage chunk (sent when stream_options.include_usage is set). */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
}

/**
 * OpenAI model object from /v1/models endpoint.
 */
export interface OpenAIModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

/**
 * OpenAI models list response.
 */
export interface OpenAIModelsResponse {
  object: 'list';
  data: OpenAIModel[];
}

/**
 * Whether a model requires `max_completion_tokens` instead of the legacy
 * `max_tokens` parameter. Covers the gpt-5.x family and o1/o3/o4 reasoning
 * models, which reject `max_tokens` with a 400 error.
 */
export function requiresMaxCompletionTokens(model: string): boolean {
  const normalized = model.toLowerCase();
  return normalized.includes('gpt-5') || /^o[134](-|$)/.test(normalized);
}

// ============================================================================
// OpenAI Backend Adapter
// ============================================================================

/** The Decisions API model (preview). */
export const OPENAI_DECISION_MODEL = 'gpt-6-luna';

/**
 * Config for {@link OpenAIBackendAdapter}.
 */
export type OpenAIBackendAdapterConfig = ApiKeyBackendAdapterConfig & {
  /**
   * Serve typed decisions via `POST <baseURL>/decisions` (OpenAI's Decisions
   * API). Defaults to `true` when `baseURL` is api.openai.com and `false`
   * otherwise, so OpenAI-compatible servers and the adapters that extend this
   * one keep reporting `decisions: false`; set it `true` for a proxy that
   * forwards `/decisions`.
   */
  readonly decisions?: boolean;
};

function isOpenAIHost(baseURL: string): boolean {
  try {
    return new URL(baseURL).hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

/**
 * Backend adapter for OpenAI Chat Completions API (and, on api.openai.com or
 * with `decisions: true`, the Decisions API via `decide()`).
 */
export class OpenAIBackendAdapter implements BackendAdapter<OpenAIRequest, OpenAIResponse> {
  readonly metadata: AdapterMetadata;
  protected readonly config: OpenAIBackendAdapterConfig;
  protected readonly baseURL: string;
  private readonly modelCache: ReturnType<typeof getModelCache>;

  /**
   * Create a new OpenAI backend adapter.
   *
   * @param config Backend adapter configuration
   * @param metadataOverride Optional metadata to override defaults (used by subclasses)
   */
  constructor(config: OpenAIBackendAdapterConfig, metadataOverride?: Partial<AdapterMetadata>) {
    this.config = config;
    this.baseURL = config.baseURL || 'https://api.openai.com/v1';
    const decisions = config.decisions ?? isOpenAIHost(this.baseURL);
    this.modelCache = getModelCache(config.modelsCacheScope || 'global');

    // Default OpenAI metadata
    const defaultMetadata: AdapterMetadata = {
      name: 'openai-backend',
      version: '1.0.0',
      provider: 'OpenAI',
      capabilities: {
        streaming: true,
        multiModal: true,
        tools: true,
        structuredOutput: 'native',
        embeddings: true,
        embeddingModels: ['text-embedding-3-small', 'text-embedding-3-large'],
        maxEmbeddingBatchSize: 2048,
        supportsEmbeddingDimensions: true,
        maxContextTokens: 128000,
        systemMessageStrategy: 'in-messages',
        supportsMultipleSystemMessages: false, // OpenAI prefers single system message
        supportsTemperature: true,
        supportsTopP: true,
        supportsTopK: false,
        supportsSeed: true,
        supportsFrequencyPenalty: true,
        supportsPresencePenalty: true,
        maxStopSequences: 4,
        ...(decisions && {
          // Typed decisions via `/decisions`; every limit below was enforced
          // by the live API on 2026-10-06 (fixtures/decisions-openai/).
          decisions: true,
          decisionModels: [OPENAI_DECISION_MODEL],
          decisionTypes: ['choice', 'score', 'noul'] as const,
          decisionImages: true,
          decisionLimits: { maxQuestions: 200, maxChoiceOptions: 255, maxScoreLevels: 10 },
        }),
      },
      config: {
        baseURL: this.baseURL,
      },
    };

    // Apply metadata overrides if provided (for subclasses)
    this.metadata = metadataOverride
      ? {
          ...defaultMetadata,
          ...metadataOverride,
          capabilities: {
            ...defaultMetadata.capabilities,
            ...metadataOverride.capabilities,
          },
          config: {
            ...defaultMetadata.config,
            ...metadataOverride.config,
          },
        }
      : defaultMetadata;

    // Not a decision backend: hide the methods, so `typeof adapter.decide`
    // (what the router and `supportsDecisions` test) is not 'function'. A
    // subclass that brings its own `decide()` (Inception) is left alone.
    if (!decisions && this.decide === OpenAIBackendAdapter.prototype.decide) {
      Object.defineProperty(this, 'decide', { value: undefined });
      Object.defineProperty(this, 'estimateDecisionCost', { value: undefined });
    }
  }

  /**
   * Answer a typed-decision request via OpenAI's Decisions API,
   * `POST <baseURL>/decisions` (default model `gpt-6-luna`). Uses the same
   * auth and `config.headers` as chat. Only present when decisions are
   * enabled (see {@link OpenAIBackendAdapterConfig.decisions}). Images go as
   * `data:` URLs; a `url` source throws. An object or array `state` is sent
   * as JSON text.
   */
  decide(request: IRDecisionRequest, signal?: AbortSignal): Promise<IRDecisionResponse> {
    const model = request.parameters?.model || this.config.defaultModel || OPENAI_DECISION_MODEL;
    const wire = buildOpenAIDecisionsRequest(request, { model, backendName: this.metadata.name });
    return postSystemOne(`${this.baseURL.replace(/\/+$/, '')}/decisions`, wire, {
      headers: this.getHeaders(),
      signal,
      backendName: this.metadata.name,
    }).then((json) =>
      parseOpenAIDecisionsResponse(json, request, {
        backendName: this.metadata.name,
        locality: localityForBaseURL(this.baseURL),
        servedBy: servedByForBaseURL(this.baseURL),
      })
    );
  }

  /**
   * Input-token cost from the model registry. OpenAI has published no
   * Decisions price, so this is `null` until the registry carries one.
   */
  estimateDecisionCost(request: IRDecisionRequest): Promise<number | null> {
    return Promise.resolve(
      estimateSystemOneCost(
        request,
        request.parameters?.model || this.config.defaultModel || OPENAI_DECISION_MODEL
      )
    );
  }

  /**
   * Execute non-streaming chat completion request.
   */
  async execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse> {
    try {
      // Convert IR to OpenAI format
      const openaiRequest = this.fromIR(request);

      // Make HTTP request
      const startTime = Date.now();
      const response = await this.makeRequest(openaiRequest, signal);

      // Convert response to IR
      const irResponse = this.toIR(response, request, Date.now() - startTime);

      return irResponse;
    } catch (error) {
      // Re-throw adapter errors
      if (
        error instanceof AdapterConversionError ||
        error instanceof NetworkError ||
        error instanceof ProviderError
      ) {
        throw error;
      }

      // Wrap unknown errors
      throw new ProviderError({
        code: ErrorCode.PROVIDER_ERROR,
        message: `OpenAI request failed: ${error instanceof Error ? error.message : String(error)}`,
        isRetryable: true,
        provenance: {
          backend: this.metadata.name,
        },
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Execute streaming chat completion request.
   */
  async *executeStream(request: IRChatRequest, signal?: AbortSignal): IRChatStream {
    let sequence = 0;
    try {
      // Convert IR to OpenAI format
      const openaiRequest = this.fromIR(request);
      openaiRequest.stream = true;

      // Get effective streaming configuration
      const streamingConfig = mergeStreamingConfig(this.config.streaming);
      const effectiveMode = getEffectiveStreamMode(request.streamMode, undefined, streamingConfig);
      const includeBoth = streamingConfig.includeBoth || effectiveMode === 'accumulated';

      // Make streaming HTTP request
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(openaiRequest),
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
          code: ErrorCode.STREAM_INTERRUPTED,
          message: 'Response body is null',
          provenance: {
            backend: this.metadata.name,
          },
        });
      }

      // Parse SSE stream
      let contentBuffer = '';

      let finishReasonReceived: FinishReason | null | undefined;
      let usage:
        | { promptTokens: number; completionTokens: number; totalTokens: number }
        | undefined;

      // Tool calls accumulated by OpenAI tool_calls[].index
      const toolCallsByIndex = new Map<number, StreamedToolCall>();
      let doneYielded = false;

      const buildDoneChunk = (): IRStreamChunk => {
        doneYielded = true;
        const finishReason =
          finishReasonReceived ?? (toolCallsByIndex.size > 0 ? 'tool_calls' : 'stop');
        return {
          type: 'done',
          sequence: sequence++,
          finishReason,
          usage,
          message: buildStreamDoneMessage(contentBuffer, [...toolCallsByIndex.values()]),
        } as IRStreamChunk;
      };

      // Yield start chunk
      yield {
        type: 'start',
        sequence: sequence++,
        metadata: {
          ...request.metadata,
          provenance: {
            ...request.metadata.provenance,
            backend: this.metadata.name,
            locality: localityForBaseURL(this.baseURL),
            servedBy: servedByForBaseURL(this.baseURL),
          },
        },
      } as IRStreamChunk;

      // Read stream
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
            // Skip empty lines
            if (!line.trim()) {
              continue;
            }

            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();

              if (data === '[DONE]') {
                // Stream complete - yield the done chunk (deferred until here
                // so the trailing include_usage chunk can be folded in)
                if (!doneYielded) {
                  yield buildDoneChunk();
                }
                continue;
              }

              try {
                const chunk: OpenAIStreamChunk = JSON.parse(data);

                // Final usage chunk (stream_options.include_usage) has empty choices
                if (chunk.usage) {
                  usage = {
                    promptTokens: chunk.usage.prompt_tokens,
                    completionTokens: chunk.usage.completion_tokens,
                    totalTokens: chunk.usage.total_tokens,
                  };
                }

                // Validate chunk structure
                if (!chunk.choices || chunk.choices.length === 0) {
                  if (!chunk.usage) {
                    console.warn('Invalid chunk structure: no choices', chunk);
                  }
                  continue;
                }

                const choice = chunk.choices[0];
                if (!choice) {
                  continue;
                }

                // Content delta
                if (choice.delta.content) {
                  contentBuffer += choice.delta.content;

                  // Build content chunk with optional accumulated field
                  const contentChunk: IRStreamChunk = {
                    type: 'content',
                    sequence: sequence++,
                    delta: choice.delta.content,
                    role: 'assistant',
                  };

                  // Add accumulated field if configured
                  if (includeBoth) {
                    (contentChunk as any).accumulated = contentBuffer;
                  }

                  yield contentChunk;
                }

                // Tool call deltas: accumulate by index and re-emit as IR chunks
                if (choice.delta.tool_calls) {
                  for (const toolCallDelta of choice.delta.tool_calls) {
                    let toolCall = toolCallsByIndex.get(toolCallDelta.index);

                    if (!toolCall) {
                      toolCall = {
                        id: toolCallDelta.id ?? `call_${toolCallDelta.index}`,
                        name: toolCallDelta.function?.name ?? '',
                        args: '',
                        index: toolCallDelta.index,
                      };
                      toolCallsByIndex.set(toolCallDelta.index, toolCall);
                    } else {
                      // id/name only arrive on the first delta; backfill if late
                      if (toolCallDelta.id) {
                        toolCall.id = toolCallDelta.id;
                      }
                      if (toolCallDelta.function?.name) {
                        toolCall.name = toolCallDelta.function.name;
                      }
                    }

                    const inputDelta = toolCallDelta.function?.arguments ?? '';
                    toolCall.args += inputDelta;

                    yield {
                      type: 'tool_use',
                      sequence: sequence++,
                      id: toolCall.id,
                      name: toolCall.name,
                      inputDelta,
                      index: toolCall.index,
                    } as IRStreamChunk;
                  }
                }

                // Finish reason: record it; the done chunk is yielded at [DONE]
                // (or stream end) so trailing usage data can be included
                if (choice.finish_reason && !finishReasonReceived) {
                  finishReasonReceived = this.mapFinishReason(choice.finish_reason);
                }
              } catch (parseError) {
                // Log parse errors but continue streaming
                console.warn('Failed to parse SSE chunk:', data, parseError);
                continue;
              }
            } else if (line.startsWith('event:')) {
              // OpenAI doesn't typically use event: lines, but handle them
              const eventType = line.slice(6).trim();
              if (eventType === 'error') {
                // Error event type
                console.warn('Error event type detected');
              }
            }
          }
        }

        // If stream ended without a [DONE] sentinel, yield the done chunk
        if (!doneYielded) {
          yield buildDoneChunk();
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      // Yield error chunk
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
   * Health check to verify OpenAI API is accessible.
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
   * Estimate cost for a request (rough heuristic).
   */
  estimateCost(request: IRChatRequest): Promise<number | null> {
    // Use shared token estimation utility
    const estimatedInputTokens = estimateTokens(request);
    // Price the requested model via the shared registry; fall back to the
    // flagship gpt-5.x input rate when the model is unknown
    const model = request.parameters?.model || this.config.defaultModel || 'gpt-5.6-luna';
    const inputPer1M = getModelPricingInfo(model)?.inputPer1M ?? 1.25;
    return Promise.resolve((estimatedInputTokens / 1_000_000) * inputPer1M);
  }

  /**
   * Generate embeddings via the /embeddings endpoint.
   */
  embed(request: IREmbedRequest, signal?: AbortSignal): Promise<IREmbedResponse> {
    return executeOpenAICompatibleEmbed({
      baseURL: this.baseURL,
      headers: this.getHeaders(),
      request,
      backendName: this.metadata.name,
      defaultModel: 'text-embedding-3-small',
      signal,
    });
  }

  /**
   * Estimate embedding cost in USD via the model registry.
   */
  estimateEmbedCost(request: IREmbedRequest): Promise<number | null> {
    const model = request.parameters?.model || 'text-embedding-3-small';
    const inputPer1M = getModelPricingInfo(model)?.inputPer1M;
    if (inputPer1M === undefined) {
      return Promise.resolve(null);
    }
    const inputs = typeof request.input === 'string' ? [request.input] : request.input;
    const totalChars = inputs.reduce((sum, text) => sum + text.length, 0);
    return Promise.resolve((Math.ceil(totalChars / 4) / 1_000_000) * inputPer1M);
  }

  /**
   * List available models from OpenAI.
   *
   * This method supports three sources:
   * 1. Static config (config.models) - highest priority
   * 2. Cache (if enabled and not expired)
   * 3. Remote API (/v1/models endpoint)
   */
  async listModels(options?: ListModelsOptions): Promise<ListModelsResult> {
    try {
      // 1. Check static config override first
      if (this.config.models && !options?.forceRefresh) {
        return buildStaticResult(this.config.models, 'openai');
      }

      // 2. Check cache
      if (this.config.cacheModels !== false && !options?.forceRefresh) {
        const cached = this.modelCache.get(this.metadata.name);
        if (cached) {
          return applyModelFilter(cached, options?.filter as ModelCapabilityFilter);
        }
      }

      // 3. Fetch from OpenAI API
      const endpoint = this.config.modelsEndpoint || `${this.baseURL}/models`;
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(this.config.timeout || 30000),
      });

      if (!response.ok) {
        throw createErrorFromHttpResponse(
          response.status,
          response.statusText,
          await response.text(),
          {
            backend: this.metadata.name,
          }
        );
      }

      const data = (await response.json()) as OpenAIModelsResponse;

      // 4. Transform to AIModel format
      const models = data.data.map((model) => this.transformOpenAIModel(model));

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
    } catch (error) {
      // If we have a cached result, return it as fallback
      if (!options?.forceRefresh) {
        const cached = this.modelCache.get(this.metadata.name);
        if (cached) {
          return cached;
        }
      }

      // Re-throw known errors
      if (error instanceof ProviderError || error instanceof NetworkError) {
        throw error;
      }

      // Wrap unknown errors
      throw new ProviderError({
        code: ErrorCode.PROVIDER_ERROR,
        message: `Failed to list OpenAI models: ${error instanceof Error ? error.message : String(error)}`,
        isRetryable: true,
        provenance: {
          backend: this.metadata.name,
        },
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Invalidate the cached model list.
   *
   * Forces the next listModels() call to fetch fresh data from the API
   * (unless static models are configured).
   *
   * @returns This adapter for method chaining
   */
  invalidateModelCache(): OpenAIBackendAdapter {
    this.modelCache.invalidate(this.metadata.name);
    return this;
  }

  // ==========================================================================
  // Private Helper Methods
  // ==========================================================================

  /**
   * Convert IR request to OpenAI format.
   *
   * Public method for testing and debugging - see what will be sent to OpenAI.
   */
  public fromIR(request: IRChatRequest): OpenAIRequest {
    try {
      // Normalize system messages (OpenAI uses in-messages strategy)
      const { messages } = normalizeSystemMessages(
        request.messages,
        this.metadata.capabilities.systemMessageStrategy,
        this.metadata.capabilities.supportsMultipleSystemMessages
      );

      // Convert messages (a single IR message may expand to multiple OpenAI
      // messages, e.g. tool results become separate role:'tool' messages)
      const openaiMessages: OpenAIMessage[] = messages.flatMap((msg) =>
        this.convertMessageToOpenAI(msg)
      );

      // Build OpenAI request
      const model = request.parameters?.model || this.config.defaultModel || 'gpt-5.6-luna';
      const openaiRequest: OpenAIRequest = {
        model,
        messages: openaiMessages,
        temperature: request.parameters?.temperature,
        ...(requiresMaxCompletionTokens(model)
          ? { max_completion_tokens: request.parameters?.maxTokens }
          : { max_tokens: request.parameters?.maxTokens }),
        top_p: request.parameters?.topP,
        frequency_penalty: request.parameters?.frequencyPenalty,
        presence_penalty: request.parameters?.presencePenalty,
        stop: request.parameters?.stopSequences ? [...request.parameters.stopSequences] : undefined,
        stream: request.stream,
        stream_options: request.stream ? { include_usage: true } : undefined,
        user: request.parameters?.user,
        seed: request.parameters?.seed,
        tools: request.tools?.map((tool) => ({
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters as unknown as Record<string, unknown>,
          },
        })),
        tool_choice: this.convertToolChoice(request.toolChoice),
        response_format: request.responseFormat
          ? {
              type: 'json_schema',
              json_schema: {
                name: 'response',
                schema: request.responseFormat.schema as unknown as Record<string, unknown>,
                strict: request.responseFormat.strict,
              },
            }
          : undefined,
      };

      return openaiRequest;
    } catch (error) {
      throw new AdapterConversionError({
        code: ErrorCode.ADAPTER_CONVERSION_ERROR,
        message: `Failed to convert IR to OpenAI format: ${error instanceof Error ? error.message : String(error)}`,
        provenance: {
          backend: this.metadata.name,
        },
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Convert OpenAI response to IR format.
   *
   * Public method for testing and debugging - parse OpenAI responses manually.
   */
  public toIR(
    response: OpenAIResponse,
    originalRequest: IRChatRequest,
    latencyMs: number
  ): IRChatResponse {
    try {
      const choice = response.choices[0];
      if (!choice) {
        throw new Error('No choices in OpenAI response');
      }

      // Convert message (including any tool calls)
      const text = this.convertMessageContentFromOpenAI(choice.message.content);
      const toolCalls = choice.message.tool_calls ?? [];

      const message: IRMessage =
        toolCalls.length > 0
          ? {
              role: 'assistant',
              content: [
                ...(text ? [{ type: 'text' as const, text }] : []),
                ...toolCalls.map((call) => ({
                  type: 'tool_use' as const,
                  id: call.id,
                  name: call.function.name,
                  input: safeParseJSON(call.function.arguments),
                })),
              ],
            }
          : {
              role: 'assistant',
              content: text,
            };

      // Map finish reason
      const finishReason = this.mapFinishReason(choice.finish_reason || 'stop');

      // Build IR response
      const irResponse: IRChatResponse = {
        message,
        finishReason,
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
            locality: localityForBaseURL(this.baseURL),
            servedBy: servedByForBaseURL(this.baseURL),
            servedModel: response.model,
          },
          custom: {
            ...originalRequest.metadata.custom,
            openaiResponseId: response.id,
            latencyMs,
            ...(originalRequest.responseFormat ? { responseFormatEnforced: true } : {}),
          },
        },
        raw: response as unknown as Record<string, unknown>,
      };

      return irResponse;
    } catch (error) {
      throw new AdapterConversionError({
        code: ErrorCode.ADAPTER_CONVERSION_ERROR,
        message: `Failed to convert OpenAI response to IR: ${error instanceof Error ? error.message : String(error)}`,
        provenance: {
          backend: this.metadata.name,
        },
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Convert IR toolChoice to OpenAI tool_choice.
   */
  private convertToolChoice(toolChoice: IRChatRequest['toolChoice']): OpenAIRequest['tool_choice'] {
    if (toolChoice === undefined) {
      return undefined;
    }
    if (typeof toolChoice === 'string') {
      return toolChoice;
    }
    return { type: 'function', function: { name: toolChoice.name } };
  }

  /**
   * Convert IR message to OpenAI message(s).
   *
   * Returns an array because OpenAI represents tool results as separate
   * role:'tool' messages (one per tool_use id), while the IR allows multiple
   * tool_result blocks inside a single message.
   */
  private convertMessageToOpenAI(message: IRMessage): OpenAIMessage[] {
    if (typeof message.content === 'string') {
      return [
        {
          role: message.role as 'system' | 'user' | 'assistant' | 'tool',
          content: message.content,
          name: message.name,
        },
      ];
    }

    // Partition structured content blocks
    const toolResults = message.content.filter((block) => block.type === 'tool_result');
    const toolUses = message.content.filter((block) => block.type === 'tool_use');
    const otherBlocks = message.content.filter(
      (block) => block.type !== 'tool_result' && block.type !== 'tool_use'
    );

    const messages: OpenAIMessage[] = [];

    // Each tool result becomes its own role:'tool' message
    for (const block of toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: block.toolUseId,
        content:
          typeof block.content === 'string'
            ? block.content
            : block.content.map((text) => text.text).join(''),
      });
    }

    // Remaining content (text/images) plus any tool calls form one message
    if (otherBlocks.length > 0 || toolUses.length > 0) {
      const content: OpenAIMessageContent =
        otherBlocks.length > 0
          ? otherBlocks.map((rawBlock) => {
              const block = requireResolvedContent(rawBlock, 'openai-backend');
              switch (block.type) {
                case 'text':
                  return { type: 'text' as const, text: block.text };

                case 'image':
                  if (block.source.type === 'url') {
                    return {
                      type: 'image_url' as const,
                      image_url: { url: block.source.url },
                    };
                  } else {
                    // Convert base64 to data URL
                    const dataUrl = `data:${block.source.mediaType};base64,${block.source.data}`;
                    return {
                      type: 'image_url' as const,
                      image_url: { url: dataUrl },
                    };
                  }

                case 'audio':
                  if (block.source.type === 'base64') {
                    // OpenAI supports input_audio for base64 audio content
                    return {
                      type: 'input_audio' as const,
                      input_audio: {
                        data: block.source.data,
                        format: block.source.mediaType.split('/')[1] || 'mp3',
                      },
                    };
                  } else {
                    // URL-based audio not natively supported; fall back to text
                    return {
                      type: 'text' as const,
                      text: block.transcript
                        ? `[Audio transcript: ${block.transcript}]`
                        : `[Audio: ${block.source.url}]`,
                    };
                  }

                case 'document':
                  // OpenAI has no document upload in chat; fall back to text
                  if (block.source.type === 'url') {
                    return {
                      type: 'text' as const,
                      text: `[Document: ${block.filename || block.source.url}]`,
                    };
                  } else {
                    return {
                      type: 'text' as const,
                      text: `[Document: ${block.filename || 'attachment'} (${block.source.mediaType})]`,
                    };
                  }

                case 'video':
                  // OpenAI has no video upload in chat; fall back to text
                  if (block.source.type === 'url') {
                    return { type: 'text' as const, text: `[Video: ${block.source.url}]` };
                  } else {
                    return {
                      type: 'text' as const,
                      text: `[Video: attachment (${block.source.mediaType})]`,
                    };
                  }

                default:
                  // Fallback to text for unsupported types
                  return { type: 'text' as const, text: JSON.stringify(block) };
              }
            })
          : '';

      messages.push({
        role: message.role as 'system' | 'user' | 'assistant' | 'tool',
        content,
        name: message.name,
        tool_calls:
          toolUses.length > 0
            ? toolUses.map((block) => ({
                id: block.id,
                type: 'function' as const,
                function: {
                  name: block.name,
                  arguments: JSON.stringify(block.input),
                },
              }))
            : undefined,
      });
    }

    return messages;
  }

  /**
   * Convert OpenAI message content to string.
   */
  private convertMessageContentFromOpenAI(content: OpenAIMessageContent): string {
    if (typeof content === 'string') {
      return content;
    }

    // Extract text from content blocks
    return content
      .map((block) => {
        if (block.type === 'text') {
          return block.text;
        }
        return '';
      })
      .join('');
  }

  /**
   * Map OpenAI finish reason to IR finish reason.
   */
  private mapFinishReason(finishReason: string | null): FinishReason {
    switch (finishReason) {
      case 'stop':
        return 'stop';
      case 'length':
        return 'length';
      case 'tool_calls':
        return 'tool_calls';
      case 'content_filter':
        return 'content_filter';
      default:
        return 'stop';
    }
  }

  /**
   * Make HTTP request to OpenAI API.
   */
  private async makeRequest(request: OpenAIRequest, signal?: AbortSignal): Promise<OpenAIResponse> {
    try {
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(request),
        signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw createErrorFromHttpResponse(response.status, response.statusText, errorBody, {
          backend: this.metadata.name,
        });
      }

      const data = (await response.json()) as OpenAIResponse;
      return data;
    } catch (error) {
      if (error instanceof TypeError && error.message.includes('fetch')) {
        throw new NetworkError({
          code: ErrorCode.NETWORK_ERROR,
          message: `Network request failed: ${error.message}`,
          provenance: {
            backend: this.metadata.name,
          },
          cause: error,
        });
      }
      throw error;
    }
  }

  /**
   * Get HTTP headers for OpenAI API requests.
   */
  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
      ...this.config.headers,
    };
  }

  /**
   * Transform OpenAI model object to AIModel.
   */
  private transformOpenAIModel(model: OpenAIModel): AIModel {
    return {
      id: model.id,
      name: model.id, // OpenAI doesn't provide separate display names
      created: new Date(model.created * 1000).toISOString(),
      ownedBy: model.owned_by,
      // Note: OpenAI /models endpoint doesn't include capability info
      // This would need to be enriched from a static mapping if needed
    };
  }
}
