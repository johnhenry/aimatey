/**
 * Google Gemini Backend Adapter
 *
 * Adapts Universal IR to Google Gemini API.
 * Handles Gemini's systemInstruction field and content array format.
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
import { normalizeSystemMessages, requireResolvedContent } from '@johnhenry/aimatey-utils';
import { getModelCache } from '@johnhenry/aimatey-utils';
import { getEffectiveStreamMode, mergeStreamingConfig } from '@johnhenry/aimatey-utils';
import {
  buildStaticResult,
  applyModelFilter,
  DEFAULT_GEMINI_MODELS,
  buildToolsUnsupportedWarning,
  type ModelCapabilityFilter,
} from '../shared.js';
import type { ListModelsOptions, ListModelsResult, AIModel } from '@johnhenry/aimatey-types';

// ============================================================================
// Gemini API Types
// ============================================================================

export interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>;
}

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
  generationConfig?: {
    temperature?: number;
    topP?: number;
    topK?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    responseMimeType?: string;
    responseSchema?: Record<string, unknown>;
  };
}

export interface GeminiResponse {
  candidates: Array<{
    content: GeminiContent;
    finishReason: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'OTHER';
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  /**
   * The model version that generated the response ("Output only" in the Gemini API
   * reference for `GenerateContentResponse`).
   *
   * Gemini has no top-level `model` key, which is why the generic `raw.model` read the
   * OpenTelemetry middleware used before #113 could never see it. Declared here so
   * `toIR()` can put it on `provenance.servedModel` like every other provider's echo.
   */
  modelVersion?: string;
}

// ============================================================================
// Gemini Backend Adapter
// ============================================================================

export class GeminiBackendAdapter implements BackendAdapter<GeminiRequest, GeminiResponse> {
  readonly metadata: AdapterMetadata;
  private readonly config: ApiKeyBackendAdapterConfig;
  private readonly baseURL: string;
  private readonly modelCache: ReturnType<typeof getModelCache>;

  constructor(config: ApiKeyBackendAdapterConfig) {
    this.config = config;
    this.baseURL = config.baseURL || 'https://generativelanguage.googleapis.com/v1beta';
    this.modelCache = getModelCache(config.modelsCacheScope || 'global');

    // Note: Gemini is already browser-compatible by default (API key in URL query parameter)
    // The browserMode flag has no effect for this adapter

    this.metadata = {
      name: 'gemini-backend',
      version: '1.0.0',
      provider: 'Google Gemini',
      capabilities: {
        embeddings: true,
        embeddingModels: ['gemini-embedding-001'],
        maxEmbeddingBatchSize: 100,
        supportsEmbeddingDimensions: true,
        streaming: true,
        multiModal: true,
        tools: false,
        structuredOutput: 'native',
        maxContextTokens: 2000000,
        systemMessageStrategy: 'separate-parameter',
        supportsMultipleSystemMessages: false,
        supportsTemperature: true,
        supportsTopP: true,
        supportsTopK: true,
        supportsSeed: false,
        supportsFrequencyPenalty: false,
        supportsPresencePenalty: false,
        maxStopSequences: 5,
      },
      config: { baseURL: this.baseURL },
    };
  }

  /**
   * Generate embeddings via Gemini's batchEmbedContents endpoint.
   */
  async embed(request: IREmbedRequest, signal?: AbortSignal): Promise<IREmbedResponse> {
    const model = request.parameters?.model || this.config.defaultModel || 'gemini-embedding-001';
    const inputs = typeof request.input === 'string' ? [request.input] : [...request.input];
    const taskTypeMap: Record<string, string> = {
      query: 'RETRIEVAL_QUERY',
      document: 'RETRIEVAL_DOCUMENT',
      classification: 'CLASSIFICATION',
      clustering: 'CLUSTERING',
    };
    const taskType = request.parameters?.inputType
      ? taskTypeMap[request.parameters.inputType]
      : undefined;

    const endpoint = `${this.baseURL}/models/${model}:batchEmbedContents?key=${this.config.apiKey}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: inputs.map((text) => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
          ...(taskType && { taskType }),
          ...(request.parameters?.dimensions !== undefined && {
            outputDimensionality: request.parameters.dimensions,
          }),
        })),
      }),
      signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw createErrorFromHttpResponse(response.status, response.statusText, errorBody, {
        backend: this.metadata.name,
      });
    }

    const json = (await response.json()) as { embeddings: Array<{ values: number[] }> };
    const embeddings = json.embeddings.map((item, index) => ({ index, vector: item.values }));

    return {
      embeddings,
      model,
      dimensions: embeddings[0]?.vector.length ?? 0,
      metadata: {
        ...request.metadata,
        provenance: { ...request.metadata.provenance, backend: this.metadata.name },
      },
      raw: json as unknown as Record<string, unknown>,
    };
  }

  async execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse> {
    try {
      const geminiRequest = this.fromIR(request);
      const model = request.parameters?.model || this.config.defaultModel || 'gemini-3.6-flash';
      const endpoint = `${this.baseURL}/models/${model}:generateContent?key=${this.config.apiKey}`;

      const startTime = Date.now();
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.config.headers },
        body: JSON.stringify(geminiRequest),
        signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw createErrorFromHttpResponse(response.status, response.statusText, errorBody, {
          backend: this.metadata.name,
        });
      }

      const data = (await response.json()) as GeminiResponse;
      return this.toIR(data, request, Date.now() - startTime);
    } catch (error) {
      if (error instanceof NetworkError || error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError({
        code: ErrorCode.PROVIDER_ERROR,
        message: `Gemini request failed: ${error instanceof Error ? error.message : String(error)}`,
        isRetryable: true,
        provenance: { backend: this.metadata.name },
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  async *executeStream(request: IRChatRequest, signal?: AbortSignal): IRChatStream {
    let sequence = 0;
    try {
      const geminiRequest = this.fromIR(request);
      const model = request.parameters?.model || this.config.defaultModel || 'gemini-3.6-flash';
      const endpoint = `${this.baseURL}/models/${model}:streamGenerateContent?key=${this.config.apiKey}`;

      // Get effective streaming configuration
      const streamingConfig = mergeStreamingConfig(this.config.streaming);
      const effectiveMode = getEffectiveStreamMode(request.streamMode, undefined, streamingConfig);
      const includeBoth = streamingConfig.includeBoth || effectiveMode === 'accumulated';

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.config.headers },
        body: JSON.stringify(geminiRequest),
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
          provenance: { ...request.metadata.provenance, backend: this.metadata.name },
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

            try {
              const chunk: GeminiResponse = JSON.parse(data);
              const candidate = chunk.candidates?.[0];
              if (!candidate) {
                continue;
              }

              const content = candidate.content?.parts?.[0];
              if (content && 'text' in content) {
                contentBuffer += content.text;

                // Build content chunk with optional accumulated field
                const contentChunk: IRStreamChunk = {
                  type: 'content',
                  sequence: sequence++,
                  delta: content.text,
                  role: 'assistant',
                };

                // Add accumulated field if configured
                if (includeBoth) {
                  (contentChunk as any).accumulated = contentBuffer;
                }

                yield contentChunk;
              }

              if (candidate.finishReason) {
                const message: IRMessage = { role: 'assistant', content: contentBuffer };
                yield {
                  type: 'done',
                  sequence: sequence++,
                  finishReason: this.mapFinishReason(candidate.finishReason),
                  usage: chunk.usageMetadata
                    ? {
                        promptTokens: chunk.usageMetadata.promptTokenCount,
                        completionTokens: chunk.usageMetadata.candidatesTokenCount,
                        totalTokens: chunk.usageMetadata.totalTokenCount,
                      }
                    : undefined,
                  message,
                } as IRStreamChunk;
              }
            } catch (parseError) {
              console.warn('Failed to parse Gemini SSE chunk:', data, parseError);
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
      const response = await fetch(`${this.baseURL}/models?key=${this.config.apiKey}`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  estimateCost(_request: IRChatRequest): Promise<number | null> {
    return Promise.resolve(null); // Cost estimation not implemented for Gemini
  }

  /**
   * List available Gemini models.
   *
   * Fetches from Gemini's models API with fallback to static list.
   * Results are cached for 1 hour by default.
   */
  async listModels(options?: ListModelsOptions): Promise<ListModelsResult> {
    try {
      // 1. Check static config override first
      if (this.config.models && !options?.forceRefresh) {
        return buildStaticResult(this.config.models, 'google');
      }

      // 2. Check cache
      if (this.config.cacheModels !== false && !options?.forceRefresh) {
        const cached = this.modelCache.get(this.metadata.name);
        if (cached) {
          return applyModelFilter(cached, options?.filter as ModelCapabilityFilter);
        }
      }

      // 3. Fetch from Gemini API
      const endpoint = `${this.baseURL}/models?key=${this.config.apiKey}`;
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', ...this.config.headers },
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

      // 4. Transform to AIModel format
      const models = data.models
        .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((model) => this.transformGeminiModel(model));

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

      // 9. Final fallback to DEFAULT_GEMINI_MODELS
      const result: ListModelsResult = {
        models: [...DEFAULT_GEMINI_MODELS],
        source: 'static',
        fetchedAt: Date.now(),
        isComplete: true,
      };
      return applyModelFilter(result, options?.filter as ModelCapabilityFilter);
    }
  }

  /**
   * Transform Gemini API model to AIModel format.
   */
  private transformGeminiModel(model: any): AIModel {
    return {
      id: model.name.replace('models/', ''),
      name: model.displayName || model.name,
      description: model.description,
      ownedBy: 'google',
      capabilities: {
        maxTokens: model.outputTokenLimit || 8192,
        contextWindow: model.inputTokenLimit || 1000000,
        supportsStreaming: true,
        supportsVision: model.supportedGenerationMethods?.includes('generateContent'),
        supportsTools: true,
        supportsJSON: true,
      },
    };
  }

  /**
   * Invalidate the cached model list.
   */
  invalidateModelCache(): GeminiBackendAdapter {
    this.modelCache.invalidate(this.metadata.name);
    return this;
  }

  /**
   * Convert IR request to Gemini format.
   *
   * Public method for testing and debugging - see what will be sent to Gemini.
   */
  public fromIR(request: IRChatRequest): GeminiRequest {
    const { messages, systemParameter } = normalizeSystemMessages(
      request.messages,
      this.metadata.capabilities.systemMessageStrategy,
      this.metadata.capabilities.supportsMultipleSystemMessages
    );

    const contents: GeminiContent[] = messages.map((msg) => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts:
        typeof msg.content === 'string'
          ? [{ text: msg.content }]
          : msg.content.map((rawBlock) => {
              const c = requireResolvedContent(rawBlock, 'gemini-backend');
              switch (c.type) {
                case 'text':
                  return { text: c.text };

                case 'image':
                  if (c.source.type === 'base64') {
                    return {
                      inlineData: { mimeType: c.source.mediaType, data: c.source.data },
                    };
                  }
                  // URL-based images: Gemini supports fileData for URLs
                  return { text: `[Image: ${c.source.url}]` };

                case 'audio':
                  // Gemini supports audio via inlineData
                  if (c.source.type === 'base64') {
                    return {
                      inlineData: { mimeType: c.source.mediaType, data: c.source.data },
                    };
                  }
                  return {
                    text: c.transcript
                      ? `[Audio transcript: ${c.transcript}]`
                      : `[Audio: ${c.source.url}]`,
                  };

                case 'video':
                  // Gemini supports video via inlineData
                  if (c.source.type === 'base64') {
                    return {
                      inlineData: { mimeType: c.source.mediaType, data: c.source.data },
                    };
                  }
                  return { text: `[Video: ${c.source.url}]` };

                case 'document':
                  // Gemini supports documents (PDF) via inlineData
                  if (c.source.type === 'base64') {
                    return {
                      inlineData: { mimeType: c.source.mediaType, data: c.source.data },
                    };
                  }
                  return { text: `[Document: ${c.filename || c.source.url}]` };

                default:
                  return { text: JSON.stringify(c) };
              }
            }),
    }));

    const systemInstruction = systemParameter ? { parts: [{ text: systemParameter }] } : undefined;

    return {
      contents,
      systemInstruction,
      generationConfig: {
        // Pass temperature through unmodified, like every other backend
        // adapter -- do not rescale it. A previous `? value / 2 : undefined`
        // transform both applied an undocumented scale conversion and used
        // truthiness, which silently dropped an explicit `temperature: 0`.
        temperature: request.parameters?.temperature,
        topP: request.parameters?.topP,
        topK: request.parameters?.topK,
        maxOutputTokens: request.parameters?.maxTokens,
        stopSequences: request.parameters?.stopSequences
          ? [...request.parameters.stopSequences]
          : undefined,
        responseMimeType: request.responseFormat ? 'application/json' : undefined,
        responseSchema: request.responseFormat
          ? (request.responseFormat.schema as unknown as Record<string, unknown>)
          : undefined,
      },
    };
  }

  /**
   * Convert Gemini response to IR format.
   *
   * Public method for testing and debugging - parse Gemini responses manually.
   */
  public toIR(
    response: GeminiResponse,
    originalRequest: IRChatRequest,
    latencyMs: number
  ): IRChatResponse {
    const candidate = response.candidates[0];
    if (!candidate) {
      throw new AdapterConversionError({
        code: ErrorCode.ADAPTER_CONVERSION_ERROR,
        message: 'No candidates in Gemini response',
        provenance: { backend: this.metadata.name },
      });
    }

    const content = candidate.content.parts.map((p) => ('text' in p ? p.text : '')).join('');
    const message: IRMessage = { role: 'assistant', content };

    return {
      message,
      finishReason: this.mapFinishReason(candidate.finishReason),
      usage: response.usageMetadata
        ? {
            promptTokens: response.usageMetadata.promptTokenCount,
            completionTokens: response.usageMetadata.candidatesTokenCount,
            totalTokens: response.usageMetadata.totalTokenCount,
          }
        : undefined,
      metadata: {
        ...originalRequest.metadata,
        providerResponseId: undefined, // Gemini does not provide a response ID
        provenance: {
          ...originalRequest.metadata.provenance,
          backend: this.metadata.name,
          // Gemini reports the served model as `modelVersion`, not `model`.
          servedModel: response.modelVersion,
        },
        custom: {
          ...originalRequest.metadata.custom,
          latencyMs,
          ...(originalRequest.responseFormat ? { responseFormatEnforced: true } : {}),
        },
        warnings: originalRequest.tools?.length
          ? [
              ...(originalRequest.metadata.warnings ?? []),
              buildToolsUnsupportedWarning(this.metadata.name),
            ]
          : originalRequest.metadata.warnings,
      },
      raw: response as unknown as Record<string, unknown>,
    };
  }

  private mapFinishReason(reason: string): FinishReason {
    switch (reason) {
      case 'STOP':
        return 'stop';
      case 'MAX_TOKENS':
        return 'length';
      case 'SAFETY':
        return 'content_filter';
      default:
        return 'stop';
    }
  }
}
