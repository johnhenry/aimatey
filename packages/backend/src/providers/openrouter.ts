/**
 * OpenRouter Backend Adapter
 *
 * Adapts Universal IR to OpenRouter Chat Completions API.
 * OpenRouter is OpenAI-compatible with unified access to 100+ models.
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
import { normalizeSystemMessages, mediaSourceToUrl } from '@johnhenry/aimatey-utils';
import { getEffectiveStreamMode, mergeStreamingConfig } from '@johnhenry/aimatey-utils';
import {
  buildStructuredOutputFallbackMessages,
  extractStructuredOutputJSON,
  buildResponseFormatFallbackWarning,
  buildToolsUnsupportedWarning,
  estimateTokens,
} from '../shared.js';
import { buildImageDroppedWarning, decideViaSystemOne } from '../decisions/systemone-client.js';

// ============================================================================
// OpenRouter API Types (OpenAI-compatible with extensions)
// ============================================================================

export type OpenRouterMessageContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: OpenRouterMessageContent;
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

export interface OpenRouterRequest {
  model: string;
  messages: OpenRouterMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string[];
  stream?: boolean;
  seed?: number;
  // OpenRouter-specific parameters
  transforms?: string[]; // Model-specific transformations
  route?: 'fallback'; // Fallback to alternative models
  provider?: {
    // Provider preferences
    order?: string[]; // Provider priority
    allow_fallbacks?: boolean;
  };
}

export interface OpenRouterResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: OpenRouterMessage;
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenRouterStreamChunk {
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
    finish_reason: 'stop' | 'length' | 'content_filter' | null;
  }>;
}

export interface OpenRouterConfig extends ApiKeyBackendAdapterConfig {
  siteUrl?: string; // Your site URL (for HTTP-Referer header)
  siteName?: string; // Your site name (for X-Title header)
  /**
   * Which decisions endpoint `decide()` uses: `'alpha'` (default,
   * `/api/alpha/decisions`) or `'systemone'` (`/api/v1/systemone`).
   */
  decisionsEndpoint?: 'alpha' | 'systemone';
}

// ============================================================================
// OpenRouter Backend Adapter
// ============================================================================

/**
 * Backend adapter for OpenRouter Chat Completions API.
 *
 * Features:
 * - Unified API for 100+ models from multiple providers
 * - OpenAI-compatible with extensions
 * - Automatic fallback routing
 * - Vision model support
 * - Function calling support
 * - Variable pricing depending on model
 */
export class OpenRouterBackendAdapter implements BackendAdapter<
  OpenRouterRequest,
  OpenRouterResponse
> {
  readonly metadata: AdapterMetadata;
  private readonly config: OpenRouterConfig;
  private readonly baseURL: string;
  private readonly siteUrl: string;
  private readonly siteName: string;

  constructor(config: OpenRouterConfig) {
    this.config = config;
    this.baseURL = config.baseURL || 'https://openrouter.ai/api/v1';
    this.siteUrl = config.siteUrl || '';
    this.siteName = config.siteName || 'AI Matey';

    this.metadata = {
      name: 'openrouter-backend',
      version: '1.0.0',
      provider: 'OpenRouter',
      capabilities: {
        streaming: true,
        multiModal: true, // Vision models available
        tools: false, // Function calling
        structuredOutput: 'fallback',
        maxContextTokens: 128000,
        systemMessageStrategy: 'in-messages',
        supportsMultipleSystemMessages: true,
        supportsTemperature: true,
        supportsTopP: true,
        supportsTopK: true,
        supportsSeed: true,
        supportsFrequencyPenalty: true,
        supportsPresencePenalty: true,
        maxStopSequences: 4,
        // Typed decisions routed to Jev, Kev, Mercury Decide, ... Ids: the
        // Jev ids are documented; the Kev and Mercury ids are best-effort
        // guesses at OpenRouter's slugs -- confirm against /models.
        decisions: true,
        decisionModels: [
          'typesafe/jev-1.13',
          '~typesafe/jev-latest',
          'jaredpalmer/kev-4b', // best-effort id
          'inception/mercury-decide', // best-effort id
        ],
        decisionTypes: ['choice', 'score', 'noul'],
        decisionImages: false,
        // Limits are Jev's (the default route); other models may differ.
        decisionLimits: { maxChoiceOptions: 255, maxScoreLevels: 10, maxStateTokens: 32_000 },
      },
      config: {
        baseURL: this.baseURL,
        siteUrl: this.siteUrl,
        siteName: this.siteName,
      },
    };
  }

  /**
   * Convert IR to OpenRouter format.
   */
  public fromIR(request: IRChatRequest): OpenRouterRequest {
    const { messages } = normalizeSystemMessages(
      buildStructuredOutputFallbackMessages(request.messages, request.responseFormat),
      this.metadata.capabilities.systemMessageStrategy,
      this.metadata.capabilities.supportsMultipleSystemMessages
    );

    const openrouterMessages: OpenRouterMessage[] = messages.map((msg) => ({
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
                    url: mediaSourceToUrl(block.source, 'openrouter-backend'),
                  },
                };
              }
              return { type: 'text', text: JSON.stringify(block) };
            }),
    }));

    const openrouterRequest: OpenRouterRequest = {
      // claude-3-haiku is retired on Anthropic's own API (Apr 2026) and EOL
      // on Bedrock Sept 2026; anthropic/claude-haiku-4.5 is the current
      // fast/cheap Claude tier (exact OpenRouter slug not independently
      // verified against their live catalog - confirm before relying on it).
      model: request.parameters?.model || this.config.defaultModel || 'anthropic/claude-haiku-4.5',
      messages: openrouterMessages,
      temperature: request.parameters?.temperature,
      max_tokens: request.parameters?.maxTokens,
      top_p: request.parameters?.topP,
      top_k: request.parameters?.topK,
      frequency_penalty: request.parameters?.frequencyPenalty,
      presence_penalty: request.parameters?.presencePenalty,
      stop: request.parameters?.stopSequences ? [...request.parameters.stopSequences] : undefined,
      stream: request.stream || false,
    };

    // Add seed if provided
    if (request.parameters?.seed !== undefined) {
      openrouterRequest.seed = request.parameters.seed;
    }

    // Add OpenRouter-specific parameters if provided
    if (request.parameters?.custom?.route) {
      openrouterRequest.route = request.parameters.custom.route as 'fallback';
    }
    if (request.parameters?.custom?.provider) {
      openrouterRequest.provider = request.parameters.custom.provider as any;
    }
    if (request.parameters?.custom?.transforms) {
      openrouterRequest.transforms = request.parameters.custom.transforms as string[];
    }

    return openrouterRequest;
  }

  /**
   * Convert OpenRouter response to IR.
   */
  public toIR(
    response: OpenRouterResponse,
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

    const message: IRMessage = {
      role: choice.message.role === 'assistant' ? 'assistant' : 'user',
      content: originalRequest.responseFormat
        ? extractStructuredOutputJSON(rawContent)
        : rawContent,
    };

    const finishReasonMap: Record<string, FinishReason> = {
      stop: 'stop',
      length: 'length',
      tool_calls: 'tool_calls',
      content_filter: 'stop',
    };

    const extraWarnings = [
      ...(originalRequest.responseFormat
        ? [buildResponseFormatFallbackWarning(this.metadata.name)]
        : []),
      ...(originalRequest.tools?.length ? [buildToolsUnsupportedWarning(this.metadata.name)] : []),
    ];

    // OpenRouter routes to whichever upstream provider it picked, so the model that answered
    // routinely differs from the one requested. Read once and used for both the typed field
    // and the deprecated `custom.actualModel` alias below, so the two cannot disagree.
    const servedModel = response.model;

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
          servedModel,
        },
        custom: {
          ...originalRequest.metadata.custom,
          latencyMs,
          /**
           * @deprecated since #113 -- read `metadata.provenance.servedModel` instead, or
           * `resolveServedModel(metadata.provenance)` for a proxied chain. Kept as an alias
           * for one minor because `custom` is typed `Record<string, unknown>`: removing a key
           * from it produces no compile error and no lint warning for an external consumer,
           * only `undefined` at runtime. Removed in the next major.
           */
          actualModel: servedModel,
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
  async execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse> {
    try {
      const openrouterRequest = this.fromIR(request);
      openrouterRequest.stream = false;

      const startTime = Date.now();
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(openrouterRequest),
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

      const data = (await response.json()) as OpenRouterResponse;
      return this.toIR(data, request, Date.now() - startTime);
    } catch (error) {
      if (error instanceof NetworkError || error instanceof ProviderError) {
        throw error;
      }

      throw new ProviderError({
        code: ErrorCode.PROVIDER_ERROR,
        message: `OpenRouter request failed: ${error instanceof Error ? error.message : String(error)}`,
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
      const openrouterRequest = this.fromIR(request);
      openrouterRequest.stream = true;

      const streamingConfig = mergeStreamingConfig(this.config.streaming);
      const effectiveMode = getEffectiveStreamMode(request.streamMode, undefined, streamingConfig);
      const includeBoth = streamingConfig.includeBoth || effectiveMode === 'accumulated';

      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(openrouterRequest),
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
              const chunk = JSON.parse(data) as OpenRouterStreamChunk;
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
                  content_filter: 'stop',
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
   * The decisions URL. `/api/alpha/decisions` is a sibling of the chat
   * `/api/v1` base, not a child of it, so the trailing `/v1` is replaced
   * (`https://openrouter.ai/api/v1` -> `https://openrouter.ai/api/alpha/decisions`).
   * `decisionsEndpoint: 'systemone'` uses `<baseURL>/systemone` instead.
   */
  private decisionsURL(): string {
    const base = this.baseURL.replace(/\/+$/, '');
    if (this.config.decisionsEndpoint === 'systemone') {
      return `${base}/systemone`;
    }
    return `${base.replace(/\/v1$/, '')}/alpha/decisions`;
  }

  /**
   * Answer a typed-decision request through OpenRouter's decisions API.
   * Uses the chat headers (auth plus site headers). `parameters.custom.provider`
   * (routing preferences), `trace`, `session_id` and `user` are passed
   * through; the response carries OpenRouter's `id`, `provider` and
   * `usage.cost`. Answers may lack `probabilities` / `confidence`. Images
   * are dropped upstream-side (not supported), so they are not sent and a
   * warning is attached.
   */
  decide(request: IRDecisionRequest, signal?: AbortSignal): Promise<IRDecisionResponse> {
    return decideViaSystemOne(request, {
      url: this.decisionsURL(),
      dialect: 'openrouter',
      model: request.parameters?.model || this.config.defaultModel || 'typesafe/jev-1.13',
      sendImages: false,
      headers: this.getHeaders(),
      signal,
      backendName: this.metadata.name,
      warnings: buildImageDroppedWarning(request, this.metadata.name, 'OpenRouter decisions'),
    });
  }

  /** Price depends on the routed model; read `usage.cost` from the response. */
  estimateDecisionCost(_request: IRDecisionRequest): Promise<number | null> {
    return Promise.resolve(null);
  }

  /**
   * Get HTTP headers.
   * OpenRouter requires HTTP-Referer and X-Title headers.
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
    };

    // Add OpenRouter-specific headers
    if (this.siteUrl) {
      headers['HTTP-Referer'] = this.siteUrl;
    }
    if (this.siteName) {
      headers['X-Title'] = this.siteName;
    }

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
   * OpenRouter pricing varies by model.
   */
  estimateCost(request: IRChatRequest): Promise<number | null> {
    const pricing: Record<string, { input: number; output: number }> = {
      'anthropic/claude-3-haiku': { input: 0.25, output: 1.25 },
      'anthropic/claude-3-sonnet': { input: 3.0, output: 15.0 },
      'anthropic/claude-3-opus': { input: 15.0, output: 75.0 },
      'openai/gpt-4o': { input: 2.5, output: 10.0 },
      'openai/gpt-4o-mini': { input: 0.15, output: 0.6 },
      'meta-llama/llama-3.1-8b-instruct': { input: 0.05, output: 0.05 },
      'meta-llama/llama-3.1-70b-instruct': { input: 0.35, output: 0.4 },
      'google/gemini-pro-1.5': { input: 1.25, output: 5.0 },
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
