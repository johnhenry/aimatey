/**
 * Cohere Backend Adapter
 *
 * Adapts Universal IR to Cohere's v2 Chat API (`/v2/chat`): an OpenAI-like messages array with
 * native tool calling, plus Cohere's RAG `documents` and citations.
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
  ProviderError,
  StreamError,
  ErrorCode,
  createErrorFromHttpResponse,
  AdapterError,
} from '@johnhenry/aimatey-errors';
import { normalizeSystemMessages, getModelCache } from '@johnhenry/aimatey-utils';
import { getEffectiveStreamMode, mergeStreamingConfig } from '@johnhenry/aimatey-utils';
import {
  buildStaticResult,
  applyModelFilter,
  DEFAULT_COHERE_MODELS,
  buildStructuredOutputFallbackMessages,
  buildStreamDoneMessage,
  buildOpenAICompatResponseMessage,
  convertIRMessageToOpenAICompat,
  ToolCallAssembler,
  type OpenAICompatWireMessage,
  extractStructuredOutputJSON,
  buildResponseFormatFallbackWarning,
  type ModelCapabilityFilter,
  estimateTokens,
  streamErrorDetails,
} from '../shared.js';

// ============================================================================
// Cohere v2 API Types
// ============================================================================

/** A document passed to Cohere for RAG (`documents`). */
export interface CohereDocument {
  id?: string;
  data: Record<string, any>;
}

/** Cohere v2 `messages[]` entry. Same shape as OpenAI chat completions. */
export type CohereMessage = OpenAICompatWireMessage;

export interface CohereTool {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export interface CohereRequest {
  model: string;
  messages: CohereMessage[];
  tools?: CohereTool[];
  /** v2 only supports forcing (`REQUIRED`) or forbidding (`NONE`) tool use. */
  tool_choice?: 'REQUIRED' | 'NONE';
  temperature?: number;
  max_tokens?: number;
  p?: number; // top_p equivalent
  k?: number; // top_k
  seed?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop_sequences?: string[];
  stream?: boolean;
  // Cohere-specific RAG parameters
  documents?: CohereDocument[];
}

export interface CohereCitation {
  start: number;
  end: number;
  text: string;
  sources?: unknown[];
  content_index?: number;
  type?: string;
}

export type CohereFinishReason =
  | 'COMPLETE'
  | 'STOP_SEQUENCE'
  | 'MAX_TOKENS'
  | 'TOOL_CALL'
  | 'ERROR'
  | 'TIMEOUT';

export interface CohereUsage {
  billed_units?: { input_tokens?: number; output_tokens?: number };
  tokens?: { input_tokens?: number; output_tokens?: number };
}

export interface CohereResponse {
  id: string;
  finish_reason: CohereFinishReason;
  message: {
    role: 'assistant';
    content?: Array<{ type: string; text?: string; thinking?: string }>;
    tool_plan?: string;
    tool_calls?: Array<{
      id: string;
      type?: 'function';
      function: { name: string; arguments?: string };
    }>;
    citations?: CohereCitation[];
  };
  usage?: CohereUsage;
}

/** A v2 server-sent event payload (`data:` line). */
export interface CohereStreamEvent {
  type:
    | 'message-start'
    | 'content-start'
    | 'content-delta'
    | 'content-end'
    | 'tool-plan-delta'
    | 'tool-call-start'
    | 'tool-call-delta'
    | 'tool-call-end'
    | 'citation-start'
    | 'citation-end'
    | 'message-end'
    | 'debug';
  id?: string;
  index?: number;
  delta?: {
    finish_reason?: CohereFinishReason;
    usage?: CohereUsage;
    message?: {
      content?: { text?: string };
      tool_plan?: string;
      tool_calls?: {
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      };
      citations?: CohereCitation;
    };
  };
}

const COHERE_FINISH_REASONS: Record<string, FinishReason> = {
  COMPLETE: 'stop',
  STOP_SEQUENCE: 'stop',
  MAX_TOKENS: 'length',
  TOOL_CALL: 'tool_calls',
  ERROR: 'error',
  TIMEOUT: 'error',
};

function mapCohereFinishReason(reason: string | undefined): FinishReason {
  return COHERE_FINISH_REASONS[reason ?? 'COMPLETE'] ?? 'stop';
}

function mapCohereUsage(usage: CohereUsage | undefined) {
  const units = usage?.billed_units ?? usage?.tokens;
  if (!units || (units.input_tokens === undefined && units.output_tokens === undefined)) {
    return undefined;
  }
  const promptTokens = units.input_tokens ?? 0;
  const completionTokens = units.output_tokens ?? 0;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

/**
 * Resolve the chat base URL. Cohere's chat lives at `/v2`; a legacy `.../v1` base URL is mapped
 * to `/v2` and a bare origin (e.g. a proxy) gets `/v2` appended. Any other path is used as given.
 */
function resolveBaseURL(baseURL: string | undefined): string {
  const base = (baseURL || 'https://api.cohere.com/v2').replace(/\/+$/, '');
  if (/\/v1$/.test(base)) {
    return base.replace(/\/v1$/, '/v2');
  }
  return /^https?:\/\/[^/]+$/.test(base) ? `${base}/v2` : base;
}

// ============================================================================
// Cohere Backend Adapter
// ============================================================================

/**
 * Backend adapter for Cohere's v2 Chat API.
 *
 * Features:
 * - `/v2/chat` messages array (system / user / assistant / tool roles)
 * - Native tool calling (`tools`, `tool_calls`, `role: 'tool'` results, streamed tool calls)
 * - Document support and citation generation (RAG)
 * - Text-only (no vision support)
 * - Pricing from $0.15 per 1M tokens
 */
export class CohereBackendAdapter implements BackendAdapter<CohereRequest, CohereResponse> {
  readonly metadata: AdapterMetadata;
  private readonly config: ApiKeyBackendAdapterConfig;
  private readonly baseURL: string;
  /** Legacy v1 base, still used by `/models` and `/check-api-key`. */
  private readonly v1URL: string;
  private readonly modelCache: ReturnType<typeof getModelCache>;

  constructor(config: ApiKeyBackendAdapterConfig) {
    this.config = config;
    this.baseURL = resolveBaseURL(config.baseURL);
    this.v1URL = this.baseURL.replace(/\/v2$/, '/v1');
    this.modelCache = getModelCache(config.modelsCacheScope || 'global');
    this.metadata = {
      name: 'cohere-backend',
      version: '2.0.0',
      provider: 'Cohere',
      capabilities: {
        embeddings: true,
        embeddingModels: ['embed-v4.0', 'embed-english-v3.0', 'embed-multilingual-v3.0'],
        maxEmbeddingBatchSize: 96,
        streaming: true,
        multiModal: false, // Text-only
        tools: true,
        structuredOutput: 'fallback',
        maxContextTokens: 128000,
        systemMessageStrategy: 'separate-parameter', // Folded into one leading system message
        supportsMultipleSystemMessages: false,
        supportsTemperature: true,
        supportsTopP: true,
        supportsTopK: true,
        supportsSeed: true,
        supportsFrequencyPenalty: true,
        supportsPresencePenalty: true,
        maxStopSequences: 5,
      },
      config: {
        baseURL: this.baseURL,
      },
    };
  }

  /**
   * Convert IR to Cohere v2 format.
   */
  public fromIR(request: IRChatRequest): CohereRequest {
    const { messages, systemParameter } = normalizeSystemMessages(
      buildStructuredOutputFallbackMessages(request.messages, request.responseFormat),
      this.metadata.capabilities.systemMessageStrategy,
      this.metadata.capabilities.supportsMultipleSystemMessages
    );

    const wireMessages: CohereMessage[] = [];
    if (systemParameter) {
      wireMessages.push({
        role: 'system',
        content:
          typeof systemParameter === 'string'
            ? systemParameter
            : (systemParameter as any[])
                .map((block: any) => (block.type === 'text' ? block.text : ''))
                .join(''),
      });
    }
    for (const msg of messages) {
      for (const wire of convertIRMessageToOpenAICompat(msg, this.metadata.name)) {
        // An assistant turn that only carries tool calls has no content.
        if (wire.tool_calls?.length && wire.content === '') {
          delete (wire as { content?: unknown }).content;
        }
        wireMessages.push(wire);
      }
    }

    const cohereRequest: CohereRequest = {
      model: request.parameters?.model || this.config.defaultModel || 'command-r7b-12-2024',
      messages: wireMessages,
      temperature: request.parameters?.temperature,
      max_tokens: request.parameters?.maxTokens,
      p: request.parameters?.topP,
      k: request.parameters?.topK,
      seed: request.parameters?.seed,
      frequency_penalty: request.parameters?.frequencyPenalty,
      presence_penalty: request.parameters?.presencePenalty,
      stop_sequences: request.parameters?.stopSequences
        ? [...request.parameters.stopSequences]
        : undefined,
      stream: request.stream || false,
    };

    if (request.tools?.length) {
      let tools = request.tools;
      const choice = request.toolChoice;
      if (choice === 'required') {
        cohereRequest.tool_choice = 'REQUIRED';
      } else if (choice === 'none') {
        cohereRequest.tool_choice = 'NONE';
      } else if (choice !== undefined && choice !== 'auto') {
        // v2 cannot name a tool: force tool use and offer only the named one.
        const named = tools.filter((tool) => tool.name === choice.name);
        if (named.length > 0) {
          tools = named;
        }
        cohereRequest.tool_choice = 'REQUIRED';
      }
      cohereRequest.tools = tools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters as unknown as Record<string, unknown>,
        },
      }));
    }

    // Add Cohere-specific RAG parameters if provided
    if (request.parameters?.custom?.documents) {
      cohereRequest.documents = request.parameters.custom.documents as CohereDocument[];
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
    const rawText = (response.message?.content ?? [])
      .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
      .join('');
    const text = originalRequest.responseFormat ? extractStructuredOutputJSON(rawText) : rawText;
    const message: IRMessage = buildOpenAICompatResponseMessage(
      'assistant',
      text,
      response.message?.tool_calls
    );
    const citations = response.message?.citations;

    return {
      message,
      finishReason: mapCohereFinishReason(response.finish_reason),
      usage: mapCohereUsage(response.usage),
      metadata: {
        ...originalRequest.metadata,
        providerResponseId: response.id,
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
          ...(citations && citations.length > 0 ? { citations } : {}),
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

    const response = await fetch(`${this.baseURL}/embed`, {
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
      throw createErrorFromHttpResponse(
        response.status,
        response.statusText,
        errorBody,
        {
          backend: this.metadata.name,
        },
        response.headers
      );
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
          { backend: this.metadata.name },
          response.headers
        );
      }

      const data = (await response.json()) as CohereResponse;
      return this.toIR(data, request, Date.now() - startTime);
    } catch (error) {
      if (error instanceof AdapterError) {
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
   * Execute streaming request (v2 server-sent events).
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
        headers: { ...this.getHeaders(), Accept: 'text/event-stream' },
        body: JSON.stringify(cohereRequest),
        signal,
      });

      if (!response.ok) {
        throw createErrorFromHttpResponse(
          response.status,
          response.statusText,
          await response.text(),
          { backend: this.metadata.name },
          response.headers
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
      const citations: CohereCitation[] = [];
      const toolAssembler = new ToolCallAssembler();
      let finishReason: string | undefined;
      let usage: CohereUsage | undefined;
      const nextSequence = () => sequence++;

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

      const handleLine = function* (line: string): Generator<IRStreamChunk> {
        // SSE frames are `event: <type>` + `data: <json>`; the JSON also carries `type`.
        if (!line.startsWith('data:')) {
          return;
        }
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') {
          return;
        }
        let event: CohereStreamEvent;
        try {
          event = JSON.parse(payload) as CohereStreamEvent;
        } catch (parseError) {
          console.warn('Failed to parse Cohere stream chunk:', line, parseError);
          return;
        }
        const message = event.delta?.message;
        switch (event.type) {
          case 'content-delta': {
            const text = message?.content?.text;
            if (text) {
              contentBuffer += text;
              const contentChunk: IRStreamChunk = {
                type: 'content',
                sequence: sequence++,
                delta: text,
                role: 'assistant',
              };
              if (includeBoth) {
                (contentChunk as any).accumulated = contentBuffer;
              }
              yield contentChunk;
            }
            break;
          }
          case 'tool-call-start':
          case 'tool-call-delta': {
            const call = message?.tool_calls;
            if (call) {
              yield* toolAssembler.ingest(
                [
                  {
                    index: event.index ?? 0,
                    id: call.id,
                    function: { name: call.function?.name, arguments: call.function?.arguments },
                  },
                ],
                nextSequence
              );
            }
            break;
          }
          case 'citation-start':
            if (message?.citations) {
              citations.push(message.citations);
            }
            break;
          case 'message-end':
            finishReason = event.delta?.finish_reason ?? 'COMPLETE';
            usage = event.delta?.usage;
            break;
          default:
            // message-start, content-start/-end, tool-plan-delta, tool-call-end, citation-end
            break;
        }
      };

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
            yield* handleLine(line.trim());
          }
        }
        if (buffer.trim()) {
          yield* handleLine(buffer.trim());
        }
      } finally {
        reader.releaseLock();
      }

      if (finishReason === undefined) {
        throw new StreamError({
          code: ErrorCode.STREAM_ERROR,
          message: 'Cohere stream ended before message-end arrived',
          provenance: { backend: this.metadata.name },
        });
      }

      const mappedUsage = mapCohereUsage(usage);
      const doneChunk: IRStreamChunk = {
        type: 'done',
        sequence: sequence++,
        finishReason: mapCohereFinishReason(finishReason),
        ...(mappedUsage && { usage: mappedUsage }),
        message: buildStreamDoneMessage(contentBuffer, toolAssembler.calls),
      } as IRStreamChunk;

      // Include citations if present
      if (citations.length > 0) {
        (doneChunk as any).citations = citations;
      }

      yield doneChunk;
    } catch (error) {
      yield {
        type: 'error',
        sequence: sequence++,
        error: {
          code: error instanceof Error ? error.name : 'UNKNOWN_ERROR',
          message: error instanceof Error ? error.message : String(error),
          details: streamErrorDetails(error),
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
      const response = await fetch(`${this.v1URL}/check-api-key`, {
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
   * 3. API fetch (https://api.cohere.com/v1/models)
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
      const response = await fetch(`${this.v1URL}/models`, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(this.config.timeout || 30000),
      });

      if (!response.ok) {
        throw createErrorFromHttpResponse(
          response.status,
          response.statusText,
          await response.text(),
          { backend: this.metadata.name },
          response.headers
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
