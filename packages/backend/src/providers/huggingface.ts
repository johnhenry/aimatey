/**
 * Hugging Face Backend Adapter
 *
 * Adapts Universal IR to Hugging Face's OpenAI-compatible chat completions API,
 * served by the Inference Providers router (`https://router.huggingface.co/v1`) and by
 * dedicated Inference Endpoints (text-generation-inference's Messages API).
 * Supports streaming and native tool calling.
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
  AdapterConversionError,
  NetworkError,
  ProviderError,
  StreamError,
  ErrorCode,
  createErrorFromHttpResponse,
  AdapterError,
} from '@johnhenry/aimatey-errors';
import { normalizeSystemMessages } from '@johnhenry/aimatey-utils';
import { getEffectiveStreamMode, mergeStreamingConfig } from '@johnhenry/aimatey-utils';
import {
  buildStructuredOutputFallbackMessages,
  extractStructuredOutputJSON,
  buildResponseFormatFallbackWarning,
  buildStreamDoneMessage,
  buildOpenAICompatToolFields,
  buildOpenAICompatResponseMessage,
  convertIRMessageToOpenAICompat,
  openAICompatContentToText,
  ToolCallAssembler,
  type OpenAICompatToolFields,
  streamErrorDetails,
} from '../shared.js';

/** The Inference Providers router: OpenAI-compatible, one token for every provider behind it. */
const DEFAULT_BASE_URL = 'https://router.huggingface.co/v1';

/** The retired text-generation host. A `baseURL` set to it is mapped to the router. */
const LEGACY_BASE_URL = 'https://api-inference.huggingface.co';

/**
 * Resolve the chat-completions base URL.
 *
 * - unset, or the retired `https://api-inference.huggingface.co` host: the router.
 * - a bare origin, such as a dedicated Inference Endpoint
 *   (`https://xyz.endpoints.huggingface.cloud`): `/v1` is appended, because
 *   text-generation-inference serves chat completions at `<endpoint>/v1/chat/completions`.
 * - anything with a path (`.../v1`, a proxy prefix): used as given.
 */
function resolveBaseURL(baseURL: string | undefined): string {
  if (!baseURL) {
    return DEFAULT_BASE_URL;
  }
  const trimmed = baseURL.replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    if (url.origin === LEGACY_BASE_URL) {
      return DEFAULT_BASE_URL;
    }
    if (url.pathname === '' || url.pathname === '/') {
      return `${url.origin}/v1`;
    }
  } catch {
    // Not a parseable URL: use it unchanged and let fetch report it.
  }
  return trimmed;
}

/**
 * Hugging Face chat message (OpenAI-compatible).
 */
export interface HuggingFaceMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

/**
 * Hugging Face chat completions request.
 */
export interface HuggingFaceRequest extends OpenAICompatToolFields {
  model: string;
  messages: HuggingFaceMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
  stop?: string[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
}

/**
 * Hugging Face chat completions response.
 */
export interface HuggingFaceResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices: Array<{
    index: number;
    message: HuggingFaceMessage;
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Backend adapter for Hugging Face chat completions.
 *
 * Talks to the Inference Providers router (`https://router.huggingface.co/v1`), which is
 * OpenAI-compatible: real SSE streaming, usage, and native tool calling. Authenticate with a
 * Hugging Face token that has the "Inference Providers" permission.
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
 * const response = await adapter.execute({
 *   messages: [{ role: 'user', content: 'Hello!' }],
 *   parameters: {
 *     // Optionally pin a provider: 'Qwen/Qwen3-32B:cerebras'
 *     model: 'meta-llama/Llama-3.1-8B-Instruct',
 *   },
 * });
 * ```
 *
 * @example With a dedicated Inference Endpoint
 * ```typescript
 * const adapter = new HuggingFaceBackendAdapter({
 *   apiKey: process.env.HUGGINGFACE_API_KEY,
 *   // `/v1` is appended when the URL has no path.
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
    this.baseURL = resolveBaseURL(config.baseURL);

    this.metadata = {
      name: 'huggingface-backend',
      version: '2.0.0',
      provider: 'Hugging Face',
      capabilities: {
        streaming: true,
        multiModal: false, // Text-only here
        tools: true, // Router chat completions: tools / tool_choice / tool_calls
        structuredOutput: 'fallback',
        maxContextTokens: 4096, // Varies by model
        systemMessageStrategy: 'in-messages',
        supportsMultipleSystemMessages: false,
        supportsTemperature: true,
        supportsTopP: true,
        supportsTopK: false,
        supportsSeed: true,
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
   * Execute non-streaming chat completion request.
   */
  async execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse> {
    try {
      const hfRequest = this.fromIR(request);
      const startTime = Date.now();
      const response = await this.makeRequest(hfRequest, signal);
      return this.toIR(response, request, Date.now() - startTime);
    } catch (error) {
      if (error instanceof AdapterError) {
        throw error;
      }
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
   * Execute streaming chat completion request (SSE).
   */
  async *executeStream(request: IRChatRequest, signal?: AbortSignal): IRChatStream {
    let sequence = 0;

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

    try {
      const hfRequest = this.fromIR(request);
      hfRequest.stream = true;
      hfRequest.stream_options = { include_usage: true };

      const streamingConfig = mergeStreamingConfig(this.config.streaming);
      const effectiveMode = getEffectiveStreamMode(request.streamMode, undefined, streamingConfig);
      const includeBoth = streamingConfig.includeBoth || effectiveMode === 'accumulated';

      const response = await this.post(hfRequest, signal);

      if (!response.body) {
        throw new StreamError({
          code: ErrorCode.STREAM_ERROR,
          message: 'No response body',
          provenance: { backend: this.metadata.name },
        });
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let contentBuffer = '';
      let finishReason: string | null = null;
      let usage: NonNullable<IRChatResponse['usage']> | undefined;
      const toolAssembler = new ToolCallAssembler();

      const handleLine = function* (line: string): Generator<IRStreamChunk, void, undefined> {
        if (!line.startsWith('data:')) {
          return;
        }
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') {
          return;
        }
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          throw new StreamError({
            code: ErrorCode.STREAM_ERROR,
            message: `Malformed Hugging Face stream event: ${data.slice(0, 200)}`,
            provenance: { backend: 'huggingface-backend' },
          });
        }
        if (chunk.error) {
          const detail =
            typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? 'stream error');
          throw new StreamError({
            code: ErrorCode.STREAM_ERROR,
            message: `Hugging Face stream error: ${detail}`,
            provenance: { backend: 'huggingface-backend' },
          });
        }
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          };
        }
        const choice = chunk.choices?.[0];
        const text = choice?.delta?.content;
        if (text) {
          contentBuffer += text;
          const contentChunk = {
            type: 'content',
            sequence: sequence++,
            delta: text,
            role: 'assistant',
            ...(includeBoth && { accumulated: contentBuffer }),
          } as IRStreamChunk;
          yield contentChunk;
        }
        for (const toolChunk of toolAssembler.ingest(choice?.delta?.tool_calls, () => sequence++)) {
          yield toolChunk;
        }
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
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

      if (!finishReason) {
        throw new StreamError({
          code: ErrorCode.STREAM_ERROR,
          message: 'Hugging Face stream ended before a finish_reason arrived',
          provenance: { backend: this.metadata.name },
        });
      }

      const message: IRMessage = buildStreamDoneMessage(contentBuffer, toolAssembler.calls);
      yield {
        type: 'done',
        sequence: sequence++,
        finishReason: this.mapFinishReason(finishReason),
        ...(usage && { usage }),
        message,
      } as IRStreamChunk;
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
   * Health check for Hugging Face API.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseURL}/models`, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      // Dedicated endpoints may not serve /models; 404 still means the host is up.
      return response.ok || response.status === 404;
    } catch {
      return false;
    }
  }

  /**
   * Estimate cost for Hugging Face.
   */
  estimateCost(request: IRChatRequest): Promise<number | null> {
    const estimatedTokens = this.estimateTokens(request);

    // Dedicated Inference Endpoint: estimate ~$0.06 per 1000 tokens.
    if (this.baseURL !== DEFAULT_BASE_URL) {
      return Promise.resolve((estimatedTokens / 1000) * 0.06);
    }

    // Router usage is billed per provider; no flat rate to estimate.
    return Promise.resolve(0);
  }

  // ==========================================================================
  // Conversion
  // ==========================================================================

  /**
   * Convert IR request to Hugging Face chat completions format.
   *
   * Public method for testing and debugging - see what will be sent to Hugging Face.
   */
  public fromIR(request: IRChatRequest): HuggingFaceRequest {
    try {
      const { messages } = normalizeSystemMessages(
        buildStructuredOutputFallbackMessages(request.messages, request.responseFormat),
        this.metadata.capabilities.systemMessageStrategy,
        this.metadata.capabilities.supportsMultipleSystemMessages
      );

      // Text-only: flatten content parts to a string.
      const hfMessages: HuggingFaceMessage[] = messages
        .flatMap((msg) => convertIRMessageToOpenAICompat(msg, this.metadata.name))
        .map((msg) => ({
          ...msg,
          content:
            msg.tool_calls && !msg.content?.length ? '' : openAICompatContentToText(msg.content),
        }));

      return {
        // Meta's Llama repos require accepting a gated license on HF, which breaks a default
        // that's supposed to "just work". Qwen3.5-9B is ungated (Apache 2.0) and matches the
        // ~8B-class lite tier other aggregator adapters default to.
        model: request.parameters?.model || this.config.defaultModel || 'Qwen/Qwen3.5-9B',
        messages: hfMessages,
        temperature: request.parameters?.temperature,
        max_tokens: request.parameters?.maxTokens,
        top_p: request.parameters?.topP,
        frequency_penalty: request.parameters?.frequencyPenalty,
        presence_penalty: request.parameters?.presencePenalty,
        seed: request.parameters?.seed,
        stop: request.parameters?.stopSequences ? [...request.parameters.stopSequences] : undefined,
        stream: request.stream,
        ...buildOpenAICompatToolFields(request),
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
    response: HuggingFaceResponse,
    originalRequest: IRChatRequest,
    latencyMs: number
  ): IRChatResponse {
    const choice = response?.choices?.[0];
    if (!choice) {
      throw new AdapterConversionError({
        code: ErrorCode.ADAPTER_CONVERSION_ERROR,
        message: 'No choices in Hugging Face response',
        provenance: { backend: this.metadata.name },
      });
    }

    const rawContent = openAICompatContentToText(choice.message.content);
    const content = originalRequest.responseFormat
      ? extractStructuredOutputJSON(rawContent)
      : rawContent;
    const message: IRMessage = buildOpenAICompatResponseMessage(
      'assistant',
      content,
      choice.message.tool_calls
    );

    const promptTokens = response.usage?.prompt_tokens ?? this.estimateTokens(originalRequest);
    const completionTokens = response.usage?.completion_tokens ?? Math.ceil(rawContent.length / 4);

    return {
      message,
      finishReason: this.mapFinishReason(choice.finish_reason || 'stop'),
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: response.usage?.total_tokens ?? promptTokens + completionTokens,
      },
      metadata: {
        ...originalRequest.metadata,
        ...(response.id && { providerResponseId: response.id }),
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

  private mapFinishReason(reason: string | null): FinishReason {
    switch (reason) {
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

  // ==========================================================================
  // HTTP
  // ==========================================================================

  /**
   * POST to `<baseURL>/chat/completions`; throws a mapped error on a non-2xx status.
   */
  private async post(request: HuggingFaceRequest, signal?: AbortSignal): Promise<Response> {
    try {
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(request),
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
      return response;
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

  private async makeRequest(
    request: HuggingFaceRequest,
    signal?: AbortSignal
  ): Promise<HuggingFaceResponse> {
    const response = await this.post(request, signal);
    return (await response.json()) as HuggingFaceResponse;
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
