/**
 * Replicate Backend Adapter
 *
 * Adapts Universal IR to Replicate Predictions API.
 * Replicate has per-model API variations and async prediction workflow.
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
  buildStructuredOutputFallbackMessages,
  extractStructuredOutputJSON,
  buildResponseFormatFallbackWarning,
} from '../shared.js';

// ============================================================================
// Replicate API Types (Predictions API)
// ============================================================================

export interface ReplicateInput {
  prompt?: string; // For most chat models
  system_prompt?: string; // System message
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  top_k?: number;
  // Note: Input format varies significantly per model
}

export interface ReplicatePrediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  input: ReplicateInput;
  output?: string | string[]; // Can be string or array of strings
  error?: string;
  metrics?: {
    predict_time?: number;
  };
  urls?: {
    get: string;
    cancel: string;
  };
}

export interface ReplicateRequest {
  version: string; // Model version ID
  input: ReplicateInput;
  stream?: boolean;
}

// ============================================================================
// Replicate Backend Adapter
// ============================================================================

/**
 * Backend adapter for Replicate Predictions API.
 *
 * Features:
 * - Async prediction workflow
 * - Per-model API variations
 * - Limited streaming support
 * - Text-only (vision varies by model)
 * - No function calling
 * - Variable pricing per model
 *
 * Note: This adapter uses a simplified synchronous approach by polling.
 * For production, consider using webhooks or proper async patterns.
 */
export class ReplicateBackendAdapter implements BackendAdapter<
  ReplicateRequest,
  ReplicatePrediction
> {
  readonly metadata: AdapterMetadata;
  private readonly config: ApiKeyBackendAdapterConfig;
  private readonly baseURL: string;
  private readonly maxPollAttempts: number = 60; // Max 60 attempts (60 seconds)
  private readonly pollInterval: number = 1000; // Poll every 1 second

  constructor(config: ApiKeyBackendAdapterConfig) {
    this.config = config;
    this.baseURL = config.baseURL || 'https://api.replicate.com/v1';
    this.metadata = {
      name: 'replicate-backend',
      version: '1.0.0',
      provider: 'Replicate',
      capabilities: {
        streaming: true, // Limited streaming support
        multiModal: false, // Varies by model
        tools: false, // No function calling
        structuredOutput: 'fallback',
        maxContextTokens: 4096, // Varies by model
        systemMessageStrategy: 'separate-parameter', // Uses system_prompt
        supportsMultipleSystemMessages: false,
        supportsTemperature: true,
        supportsTopP: true,
        supportsTopK: true,
        supportsSeed: false,
        supportsFrequencyPenalty: false,
        supportsPresencePenalty: false,
        maxStopSequences: 0,
      },
      config: {
        baseURL: this.baseURL,
      },
    };
  }

  /**
   * Convert IR to Replicate format.
   */
  public fromIR(request: IRChatRequest): ReplicateRequest {
    const { messages, systemParameter } = normalizeSystemMessages(
      buildStructuredOutputFallbackMessages(request.messages, request.responseFormat),
      this.metadata.capabilities.systemMessageStrategy,
      this.metadata.capabilities.supportsMultipleSystemMessages
    );

    // Build prompt from conversation history
    const prompt = messages
      .map((msg) => {
        const content =
          typeof msg.content === 'string'
            ? msg.content
            : msg.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
        return `${msg.role === 'user' ? 'User' : 'Assistant'}: ${content}`;
      })
      .join('\n\n');

    const input: ReplicateInput = {
      prompt,
      temperature: request.parameters?.temperature,
      max_tokens: request.parameters?.maxTokens,
      top_p: request.parameters?.topP,
      top_k: request.parameters?.topK,
    };

    // Add system prompt
    if (systemParameter) {
      input.system_prompt =
        typeof systemParameter === 'string'
          ? systemParameter
          : (systemParameter as any[])
              .map((msg: any) => (msg.type === 'text' ? msg.text : ''))
              .join('');
    }

    return {
      version:
        request.parameters?.model || this.config.defaultModel || 'meta/meta-llama-3-8b-instruct',
      input,
      stream: request.stream || false,
    };
  }

  /**
   * Convert Replicate prediction to IR.
   */
  public toIR(
    prediction: ReplicatePrediction,
    originalRequest: IRChatRequest,
    latencyMs: number
  ): IRChatResponse {
    let content = '';

    if (typeof prediction.output === 'string') {
      content = prediction.output;
    } else if (Array.isArray(prediction.output)) {
      content = prediction.output.join('');
    }

    if (originalRequest.responseFormat) {
      content = extractStructuredOutputJSON(content);
    }

    const message: IRMessage = {
      role: 'assistant',
      content,
    };

    const finishReasonMap: Record<string, FinishReason> = {
      succeeded: 'stop',
      failed: 'stop',
      canceled: 'stop',
    };

    return {
      message,
      finishReason: finishReasonMap[prediction.status] || 'stop',
      usage: undefined, // Replicate doesn't provide token counts
      metadata: {
        ...originalRequest.metadata,
        providerResponseId: prediction.id,
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
          latencyMs: prediction.metrics?.predict_time
            ? prediction.metrics.predict_time * 1000
            : latencyMs,
          ...(originalRequest.responseFormat ? { responseFormatEnforced: false } : {}),
        },
        warnings: originalRequest.responseFormat
          ? [
              ...(originalRequest.metadata.warnings ?? []),
              buildResponseFormatFallbackWarning(this.metadata.name),
            ]
          : originalRequest.metadata.warnings,
      },
      raw: prediction as unknown as Record<string, unknown>,
    };
  }

  /**
   * Execute non-streaming request.
   * Uses polling to wait for async prediction.
   */
  async execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse> {
    try {
      const replicateRequest = this.fromIR(request);

      const startTime = Date.now();

      // Create prediction
      const createResponse = await fetch(`${this.baseURL}/predictions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(replicateRequest),
        signal,
      });

      if (!createResponse.ok) {
        throw createErrorFromHttpResponse(
          createResponse.status,
          createResponse.statusText,
          await createResponse.text(),
          { backend: this.metadata.name }
        );
      }

      let prediction = (await createResponse.json()) as ReplicatePrediction;

      // Poll for completion
      let attempts = 0;
      while (
        prediction.status !== 'succeeded' &&
        prediction.status !== 'failed' &&
        prediction.status !== 'canceled' &&
        attempts < this.maxPollAttempts
      ) {
        await new Promise((resolve) => setTimeout(resolve, this.pollInterval));

        const pollResponse = await fetch(prediction.urls!.get, {
          method: 'GET',
          headers: this.getHeaders(),
          signal,
        });

        if (!pollResponse.ok) {
          throw createErrorFromHttpResponse(
            pollResponse.status,
            pollResponse.statusText,
            await pollResponse.text(),
            { backend: this.metadata.name }
          );
        }

        prediction = (await pollResponse.json()) as ReplicatePrediction;
        attempts++;
      }

      if (prediction.status === 'failed') {
        throw new ProviderError({
          code: ErrorCode.PROVIDER_ERROR,
          message: `Replicate prediction failed: ${prediction.error || 'Unknown error'}`,
          isRetryable: false,
          provenance: { backend: this.metadata.name },
        });
      }

      if (attempts >= this.maxPollAttempts) {
        throw new ProviderError({
          code: ErrorCode.PROVIDER_ERROR,
          message: 'Replicate prediction timed out',
          isRetryable: true,
          provenance: { backend: this.metadata.name },
        });
      }

      return this.toIR(prediction, request, Date.now() - startTime);
    } catch (error) {
      if (error instanceof NetworkError || error instanceof ProviderError) {
        throw error;
      }

      throw new ProviderError({
        code: ErrorCode.PROVIDER_ERROR,
        message: `Replicate request failed: ${error instanceof Error ? error.message : String(error)}`,
        isRetryable: true,
        provenance: { backend: this.metadata.name },
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Execute streaming request.
   * Replicate streaming is limited and varies by model.
   */
  async *executeStream(request: IRChatRequest, signal?: AbortSignal): IRChatStream {
    let sequence = 0;
    try {
      const replicateRequest = this.fromIR(request);
      replicateRequest.stream = true;

      const streamingConfig = mergeStreamingConfig(this.config.streaming);
      const effectiveMode = getEffectiveStreamMode(request.streamMode, undefined, streamingConfig);
      const includeBoth = streamingConfig.includeBoth || effectiveMode === 'accumulated';

      const response = await fetch(`${this.baseURL}/predictions`, {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          Prefer: 'wait', // Request streaming
        },
        body: JSON.stringify(replicateRequest),
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

          // Replicate streams raw output text
          if (buffer) {
            const delta = buffer;
            buffer = '';
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
        }

        // Stream ended
        yield {
          type: 'done',
          sequence: sequence++,
          finishReason: 'stop',
          message: { role: 'assistant', content: contentBuffer },
        } as IRStreamChunk;
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
      Authorization: `Token ${this.config.apiKey}`,
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
   * Replicate pricing varies significantly per model.
   */
  estimateCost(_request: IRChatRequest): Promise<number | null> {
    // Replicate pricing is complex and per-second, not per-token
    // Returning null as cost estimation is not reliable
    return Promise.resolve(null);
  }
}
