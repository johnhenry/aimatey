/**
 * Hugging Face Backend Adapter
 *
 * Adapts Universal IR to Hugging Face Inference API.
 * Access thousands of models through Hugging Face's unified API.
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
} from '@johnhenry/aimatey-types';
import {
  AdapterConversionError,
  NetworkError,
  ProviderError,
  ErrorCode,
  createErrorFromHttpResponse,
} from '@johnhenry/aimatey-errors';
import { normalizeRepetitionPenalty } from '@johnhenry/aimatey-utils';
import {
  buildStructuredOutputFallbackMessages,
  extractStructuredOutputJSON,
  buildResponseFormatFallbackWarning,
} from '../shared.js';

/**
 * Hugging Face API message format.
 */
export interface HuggingFaceMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Hugging Face API request.
 */
export interface HuggingFaceRequest {
  inputs:
    | string
    | {
        past_user_inputs?: string[];
        generated_responses?: string[];
        text: string;
      };
  parameters?: {
    temperature?: number;
    max_new_tokens?: number;
    top_p?: number;
    top_k?: number;
    repetition_penalty?: number;
    do_sample?: boolean;
    return_full_text?: boolean;
  };
  options?: {
    wait_for_model?: boolean;
    use_cache?: boolean;
  };
}

/**
 * Hugging Face API response.
 */
export interface HuggingFaceResponse {
  generated_text?: string;
  conversation?: {
    past_user_inputs: string[];
    generated_responses: string[];
  };
  error?: string;
}

/**
 * Backend adapter for Hugging Face Inference API.
 *
 * Supports text generation models from Hugging Face Hub.
 *
 * @example Basic Usage
 * ```typescript
 * import { HuggingFaceBackendAdapter } from '@johnhenry/aimatey';
 *
 * const adapter = new HuggingFaceBackendAdapter({
 *   apiKey: process.env.HUGGINGFACE_API_KEY,
 * });
 * ```
 *
 * @example With Specific Model
 * ```typescript
 * const adapter = new HuggingFaceBackendAdapter({
 *   apiKey: process.env.HUGGINGFACE_API_KEY,
 * });
 *
 * const response = await adapter.execute({
 *   messages: [{ role: 'user', content: 'Hello!' }],
 *   parameters: {
 *     model: 'mistralai/Mixtral-8x7B-Instruct-v0.1',
 *   },
 * });
 * ```
 *
 * @example With Inference Endpoints
 * ```typescript
 * const adapter = new HuggingFaceBackendAdapter({
 *   apiKey: process.env.HUGGINGFACE_API_KEY,
 *   baseURL: 'https://your-endpoint.aws.endpoints.huggingface.cloud',
 * });
 * ```
 */
export class HuggingFaceBackendAdapter implements BackendAdapter<
  HuggingFaceRequest,
  HuggingFaceResponse
> {
  readonly metadata: AdapterMetadata;
  private readonly config: ApiKeyBackendAdapterConfig;
  private readonly baseURL: string;

  constructor(config: ApiKeyBackendAdapterConfig) {
    this.config = config;
    this.baseURL = config.baseURL || 'https://api-inference.huggingface.co';

    this.metadata = {
      name: 'huggingface-backend',
      version: '1.0.0',
      provider: 'Hugging Face',
      capabilities: {
        streaming: false, // Hugging Face Inference API doesn't support streaming in the same way
        multiModal: false, // Text-only for standard inference
        tools: false,
        structuredOutput: 'fallback',
        maxContextTokens: 4096, // Varies by model
        systemMessageStrategy: 'in-messages',
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
   * Execute non-streaming chat completion request.
   */
  async execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse> {
    try {
      // Convert IR to Hugging Face format
      const hfRequest = this.fromIR(request);

      // Make HTTP request
      const startTime = Date.now();
      const response = await this.makeRequest(
        // Meta's Llama repos require accepting a gated license on HF, which
        // breaks a default that's supposed to "just work". Qwen3.5-9B is
        // ungated (Apache 2.0) and matches the ~8B-class lite tier other
        // aggregator adapters in this file default to.
        request.parameters?.model || this.config.defaultModel || 'Qwen/Qwen3.5-9B',
        hfRequest,
        signal
      );

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
        message: `Hugging Face request failed: ${error instanceof Error ? error.message : String(error)}`,
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
  async *executeStream(request: IRChatRequest, _signal?: AbortSignal): IRChatStream {
    // Hugging Face Inference API doesn't support streaming in the standard way
    // We'll simulate it by making a regular request and yielding chunks

    let sequence = 0;

    yield {
      type: 'start',
      sequence: sequence++,
      metadata: request.metadata,
    } as IRStreamChunk;

    try {
      const response = await this.execute(request, _signal);

      // Yield content as single chunk
      const content =
        typeof response.message.content === 'string'
          ? response.message.content
          : response.message.content
              .filter((c) => c.type === 'text')
              .map((c) => (c as { text: string }).text)
              .join('');

      yield {
        type: 'content',
        sequence: sequence++,
        delta: content,
        role: 'assistant',
      } as IRStreamChunk;

      yield {
        type: 'done',
        sequence: sequence++,
        finishReason: response.finishReason,
        usage: response.usage,
        message: response.message,
      } as IRStreamChunk;
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
   * Health check for Hugging Face API.
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Simple test request
      const response = await fetch(this.baseURL, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      // HF returns various status codes, 200 or 404 are both "healthy"
      return response.status === 200 || response.status === 404;
    } catch {
      return false;
    }
  }

  /**
   * Estimate cost for Hugging Face.
   */
  estimateCost(request: IRChatRequest): Promise<number | null> {
    // Hugging Face Inference API is free for public models (with rate limits)
    // Inference Endpoints are charged separately
    const estimatedTokens = this.estimateTokens(request);

    // If using a private Inference Endpoint, estimate ~$0.06 per 1000 tokens
    if (this.baseURL !== 'https://api-inference.huggingface.co') {
      return Promise.resolve((estimatedTokens / 1000) * 0.06);
    }

    // Free tier
    return Promise.resolve(0);
  }

  // ==========================================================================
  // Private Helper Methods
  // ==========================================================================

  /**
   * Convert IR request to Hugging Face format.
   *
   * Public method for testing and debugging - see what will be sent to Hugging Face.
   */
  public fromIR(request: IRChatRequest): HuggingFaceRequest {
    try {
      // Convert messages to prompt text
      const prompt = this.messagesToPrompt(
        buildStructuredOutputFallbackMessages(request.messages, request.responseFormat)
      );

      const temperature = request.parameters?.temperature;

      // `temperature: 0` is the IR/OpenAI spelling of "decode greedily". Hugging
      // Face spells the same intent as `do_sample: false` with the sampling
      // knobs *absent*, and rejects the literal zero:
      // text-generation-inference validates `temperature.unwrap_or(1.0) <= 0.0
      // -> ValidationError::Temperature` ("`temperature` must be strictly
      // positive") unconditionally, before and independently of `do_sample`
      // (`router/src/validation.rs`). So `do_sample: false` does not excuse the
      // zero -- the request never reaches the model.
      //
      // `top_p`/`top_k` have to go with it. They are not merely redundant under
      // `do_sample: false`; TGI's server *promotes* them back to sampling:
      //
      //   has_warpers = (temperature != 1.0) or (top_k != 0) or (top_p < 1.0) ...
      //   sampling    = do_sample or has_warpers
      //   self.choice = Sampling(...) if sampling else Greedy()
      //
      // (`server/text_generation_server/utils/tokens.py`, and the same per-request
      // promotion in the batched `HeterogeneousNextTokenChooser`.) Leaving either
      // one in the payload would silently override the `do_sample: false` we just
      // set and sample anyway. Omitting all three lets TGI's own defaults
      // (temperature 1.0, top_p 1.0, top_k 0) collapse `has_warpers` to false, so
      // `do_sample: false` decides, and the request decodes greedily as asked.
      const greedy = temperature === 0;

      return {
        inputs: prompt,
        parameters: {
          temperature: greedy ? undefined : temperature,
          max_new_tokens: request.parameters?.maxTokens,
          top_p: greedy ? undefined : request.parameters?.topP,
          top_k: greedy ? undefined : request.parameters?.topK,
          repetition_penalty: normalizeRepetitionPenalty(request.parameters?.frequencyPenalty),
          do_sample: temperature !== undefined && temperature > 0,
          return_full_text: false,
        },
        options: {
          wait_for_model: true,
          use_cache: true,
        },
      };
    } catch (error) {
      throw new AdapterConversionError({
        code: ErrorCode.ADAPTER_CONVERSION_ERROR,
        message: `Failed to convert IR to Hugging Face format: ${error instanceof Error ? error.message : String(error)}`,
        provenance: {
          backend: this.metadata.name,
        },
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Convert Hugging Face response to IR format.
   *
   * Public method for testing and debugging - parse Hugging Face responses manually.
   */
  public toIR(
    response: HuggingFaceResponse | HuggingFaceResponse[],
    originalRequest: IRChatRequest,
    latencyMs: number
  ): IRChatResponse {
    try {
      // Handle array response
      const hfResponse = Array.isArray(response) ? response[0] : response;

      if (!hfResponse || hfResponse.error) {
        throw new Error(hfResponse?.error || 'Empty response from Hugging Face');
      }

      const text = hfResponse.generated_text || '';

      const message: IRMessage = {
        role: 'assistant',
        content: originalRequest.responseFormat ? extractStructuredOutputJSON(text) : text,
      };

      return {
        message,
        finishReason: 'stop',
        usage: {
          promptTokens: this.estimateTokens(originalRequest),
          completionTokens: Math.ceil(text.length / 4),
          totalTokens: this.estimateTokens(originalRequest) + Math.ceil(text.length / 4),
        },
        metadata: {
          ...originalRequest.metadata,
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
            ...(originalRequest.responseFormat ? { responseFormatEnforced: false } : {}),
          },
          warnings: originalRequest.responseFormat
            ? [
                ...(originalRequest.metadata.warnings ?? []),
                buildResponseFormatFallbackWarning(this.metadata.name),
              ]
            : originalRequest.metadata.warnings,
        },
      };
    } catch (error) {
      throw new AdapterConversionError({
        code: ErrorCode.ADAPTER_CONVERSION_ERROR,
        message: `Failed to convert Hugging Face response to IR: ${error instanceof Error ? error.message : String(error)}`,
        provenance: {
          backend: this.metadata.name,
        },
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Convert messages to prompt text.
   */
  private messagesToPrompt(messages: Iterable<IRMessage>): string {
    const parts: string[] = [];

    for (const message of messages) {
      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .filter((c) => c.type === 'text')
              .map((c) => (c as { text: string }).text)
              .join('\n');

      if (message.role === 'system') {
        parts.push(`System: ${text}`);
      } else if (message.role === 'user') {
        parts.push(`User: ${text}`);
      } else if (message.role === 'assistant') {
        parts.push(`Assistant: ${text}`);
      }
    }

    // Add final assistant prompt
    parts.push('Assistant:');

    return parts.join('\n\n');
  }

  /**
   * Make HTTP request to Hugging Face API.
   */
  private async makeRequest(
    model: string,
    request: HuggingFaceRequest,
    signal?: AbortSignal
  ): Promise<HuggingFaceResponse | HuggingFaceResponse[]> {
    try {
      const url = model ? `${this.baseURL}/models/${model}` : this.baseURL;

      const response = await fetch(url, {
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

      const data = (await response.json()) as HuggingFaceResponse | HuggingFaceResponse[];
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
   * Get HTTP headers for Hugging Face API requests.
   */
  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
      ...this.config.headers,
    };
  }

  /**
   * Estimate token count for a request.
   */
  private estimateTokens(request: IRChatRequest): number {
    let totalChars = 0;

    for (const message of request.messages) {
      if (typeof message.content === 'string') {
        totalChars += message.content.length;
      } else {
        for (const block of message.content) {
          if (block.type === 'text') {
            totalChars += block.text.length;
          }
        }
      }
    }

    return Math.ceil(totalChars / 4);
  }
}

/**
 * Create a Hugging Face backend adapter.
 *
 * @param config - Adapter configuration
 * @returns Hugging Face backend adapter
 *
 * @example
 * ```typescript
 * import { createHuggingFaceAdapter } from '@johnhenry/aimatey';
 *
 * const adapter = createHuggingFaceAdapter({
 *   apiKey: process.env.HUGGINGFACE_API_KEY,
 * });
 * ```
 */
export function createHuggingFaceAdapter(
  config: ApiKeyBackendAdapterConfig
): HuggingFaceBackendAdapter {
  return new HuggingFaceBackendAdapter(config);
}
