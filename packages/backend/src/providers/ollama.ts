/**
 * Ollama Backend Adapter
 *
 * Adapts Universal IR to Ollama API.
 * Ollama uses a local server with OpenAI-compatible chat format.
 *
 * @module
 */

import type {
  BackendAdapter,
  BackendAdapterConfig,
  AdapterMetadata,
} from '@johnhenry/aimatey-types';
import type { IREmbedRequest, IREmbedResponse } from '@johnhenry/aimatey-types';
import type { IRDecisionRequest, IRDecisionResponse } from '@johnhenry/aimatey-types';
import type {
  IRChatRequest,
  IRChatResponse,
  IRChatStream,
  IRMessage,
  IRStreamChunk,
  IRWarning,
  MessageContent,
  FinishReason,
  ListModelsOptions,
  ListModelsResult,
  AIModel,
} from '@johnhenry/aimatey-types';
import {
  NetworkError,
  ProviderError,
  StreamError,
  ErrorCode,
  createErrorFromHttpResponse,
} from '@johnhenry/aimatey-errors';
import { normalizeSystemMessages, createWarning } from '@johnhenry/aimatey-utils';
import { getEffectiveStreamMode, mergeStreamingConfig } from '@johnhenry/aimatey-utils';
import {
  buildStaticResult,
  applyModelFilter,
  buildStructuredOutputFallbackMessages,
  extractStructuredOutputJSON,
  buildResponseFormatFallbackWarning,
  type ModelCapabilityFilter,
  type StreamedToolCall,
  buildStreamDoneMessage,
} from '../shared.js';
import { decideViaSystemOne } from '../decisions/systemone-client.js';

// ============================================================================
// Ollama API Types
// ============================================================================

/** A tool call as Ollama's `/api/chat` sends and accepts it. */
export interface OllamaToolCall {
  /** Present on newer Ollama versions; absent on older ones. */
  id?: string;
  function: {
    /** Position of the call within the message (newer Ollama versions). */
    index?: number;
    name: string;
    /** A JSON OBJECT -- not a JSON string as in OpenAI's wire format. */
    arguments?: Record<string, unknown>;
  };
}

/** A tool definition as Ollama's `/api/chat` accepts it. */
export interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Assistant messages: the tool calls the model made. */
  tool_calls?: OllamaToolCall[];
  /** `role: 'tool'` messages: the tool the result belongs to (Ollama >= 0.4). */
  tool_name?: string;
}

export interface OllamaRequest {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  options?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    num_predict?: number;
    stop?: string[];
  };
  stream?: boolean;
}

export interface OllamaResponse {
  model: string;
  created_at: string;
  message: OllamaMessage;
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

// ============================================================================
// Decision models
// ============================================================================

/**
 * Model families Ollama serves through `/v1/systemone` (typed-decision
 * models, not chat models). Ollama's `/api/tags` carries no "this is a
 * decision model" flag -- `details.family` is the backbone architecture
 * (`qwen35` for both nimble and tev1, indistinguishable from a chat qwen3.5)
 * -- so detection is by name. Extend this list as new decision models land
 * on ollama.com.
 */
export const OLLAMA_DECISION_MODEL_FAMILIES: readonly string[] = [
  'nimble',
  'tev1',
  'kev',
  'clef',
  'strands-decider',
  'laya',
];

const DECISION_MODEL_RE = new RegExp(
  `(^|[^a-z0-9])(${OLLAMA_DECISION_MODEL_FAMILIES.join('|')})($|[^a-z])`
);

/**
 * Whether an Ollama model is a typed-decision model, judged by its name
 * (`nimble:latest`, `tev1:0.8b`, `library/kev:4b`) or, for a re-tagged
 * model, by its GGUF `parent_model` (`Bespoke-Nimble-9B-...gguf`). The
 * match must start at a word boundary so `monkey` does not read as `kev`.
 */
export function isOllamaDecisionModel(name: string, parentModel?: string): boolean {
  const base = name.split(':')[0]!.split('/').pop()!.toLowerCase();
  return (
    DECISION_MODEL_RE.test(base) ||
    (parentModel !== undefined && DECISION_MODEL_RE.test(parentModel.toLowerCase()))
  );
}

// ============================================================================
// Ollama Backend Adapter
// ============================================================================

/**
 * Id for a tool call Ollama did not label. Older Ollama versions send no
 * `id`; the IR needs one to pair a `tool_result` with its `tool_use`. The id
 * is `call_<index>` -- deterministic, so replaying a recorded response yields
 * identical ids -- where `index` is the call's position in the assistant
 * message (across stream chunks too). Ids are unique within a turn, not
 * across turns; Ollama itself never reads them back.
 */
function generateToolCallId(index: number): string {
  return `call_${index}`;
}

export class OllamaBackendAdapter implements BackendAdapter<OllamaRequest, OllamaResponse> {
  readonly metadata: AdapterMetadata;
  private readonly config: BackendAdapterConfig;
  private readonly baseURL: string;

  constructor(config: BackendAdapterConfig) {
    this.config = config;
    this.baseURL = config.baseURL || 'http://localhost:11434';
    this.metadata = {
      name: 'ollama-backend',
      version: '1.0.0',
      provider: 'Ollama',
      capabilities: {
        // Typed decisions via `/v1/systemone` (Ollama >= 0.35); limits are
        // Ollama's documented ones: 64 questions, 255 options, 2-26 levels.
        decisions: true,
        decisionModels: ['nimble', 'tev1'],
        decisionTypes: ['choice', 'score', 'noul'],
        decisionImages: true,
        decisionLimits: { maxQuestions: 64, maxChoiceOptions: 255, maxScoreLevels: 26 },
        streaming: true,
        multiModal: false,
        // `tools` / `tool_calls` on `/api/chat`. Models that lack tool support
        // make Ollama answer HTTP 400 ("does not support tools"), which is
        // surfaced as the usual provider error.
        tools: true,
        structuredOutput: 'fallback',
        embeddings: true,
        maxContextTokens: 4096, // Varies by model
        systemMessageStrategy: 'in-messages',
        supportsMultipleSystemMessages: false,
        supportsTemperature: true,
        supportsTopP: true,
        supportsTopK: true,
        supportsSeed: false,
        supportsFrequencyPenalty: false,
        supportsPresencePenalty: false,
        maxStopSequences: 4,
      },
      config: { baseURL: this.baseURL },
    };
  }

  /**
   * Generate embeddings via Ollama's /api/embed endpoint.
   */
  async embed(request: IREmbedRequest, signal?: AbortSignal): Promise<IREmbedResponse> {
    const model = request.parameters?.model || this.config.defaultModel || 'nomic-embed-text';
    const inputs = typeof request.input === 'string' ? [request.input] : [...request.input];

    const response = await fetch(`${this.baseURL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: inputs, truncate: request.parameters?.truncate }),
      signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw createErrorFromHttpResponse(response.status, response.statusText, errorBody, {
        backend: this.metadata.name,
      });
    }

    const json = (await response.json()) as {
      model?: string;
      embeddings: number[][];
      prompt_eval_count?: number;
    };

    const embeddings = json.embeddings.map((vector, index) => ({ index, vector }));

    return {
      embeddings,
      model: json.model ?? model,
      dimensions: embeddings[0]?.vector.length ?? 0,
      usage:
        json.prompt_eval_count !== undefined
          ? { promptTokens: json.prompt_eval_count, totalTokens: json.prompt_eval_count }
          : undefined,
      metadata: {
        ...request.metadata,
        provenance: { ...request.metadata.provenance, backend: this.metadata.name },
      },
      raw: json as unknown as Record<string, unknown>,
    };
  }

  /**
   * Answer a typed-decision request via Ollama's `/v1/systemone`.
   *
   * Needs a decision model (`nimble`, `tev1`, ... -- see
   * {@link isOllamaDecisionModel}); defaults to `nimble`. Images go through
   * as base64 only: a `url` image source throws a `ProviderError` rather
   * than being silently dropped, because Ollama does not fetch URLs and a
   * decision made without the image the caller sent would be a wrong answer
   * to a different question. `parameters.custom.keepAlive` becomes
   * `keep_alive`. Decision calls are slow on CPU (nimble is ~2 minutes), so
   * pass a `signal` to bound them. Node's `fetch` itself gives up on a
   * response that sends no headers for 5 minutes, which a cold load of a
   * large model on CPU can exceed.
   */
  decide(request: IRDecisionRequest, signal?: AbortSignal): Promise<IRDecisionResponse> {
    return decideViaSystemOne(request, {
      url: `${this.baseURL}/v1/systemone`,
      dialect: 'systemone',
      model: request.parameters?.model || this.config.defaultModel || 'nimble',
      sendImages: true,
      headers: this.config.headers,
      signal,
      backendName: this.metadata.name,
    });
  }

  /** Local inference is free. */
  estimateDecisionCost(_request: IRDecisionRequest): Promise<number | null> {
    return Promise.resolve(0);
  }

  async execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse> {
    try {
      const ollamaRequest = this.fromIR(request);
      ollamaRequest.stream = false; // Explicitly disable streaming for non-streaming requests
      const startTime = Date.now();

      const response = await fetch(`${this.baseURL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.config.headers },
        body: JSON.stringify(ollamaRequest),
        signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw createErrorFromHttpResponse(response.status, response.statusText, errorBody, {
          backend: this.metadata.name,
        });
      }

      const data = (await response.json()) as OllamaResponse;
      return this.toIR(data, request, Date.now() - startTime);
    } catch (error) {
      if (error instanceof NetworkError || error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError({
        code: ErrorCode.PROVIDER_ERROR,
        message: `Ollama request failed: ${error instanceof Error ? error.message : String(error)}`,
        isRetryable: true,
        provenance: { backend: this.metadata.name },
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  async *executeStream(request: IRChatRequest, signal?: AbortSignal): IRChatStream {
    let sequence = 0;
    try {
      const ollamaRequest = this.fromIR(request);
      ollamaRequest.stream = true;

      // Get effective streaming configuration
      const streamingConfig = mergeStreamingConfig(this.config.streaming);
      const effectiveMode = getEffectiveStreamMode(request.streamMode, undefined, streamingConfig);
      const includeBoth = streamingConfig.includeBoth || effectiveMode === 'accumulated';

      const response = await fetch(`${this.baseURL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.config.headers },
        body: JSON.stringify(ollamaRequest),
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
          warnings: this.withToolChoiceWarnings(request),
        },
      } as IRStreamChunk;

      // Ollama delivers each tool call whole (arguments is a finished object),
      // so every call becomes a single `tool_use` chunk carrying the complete
      // JSON in `inputDelta` rather than incremental fragments.
      const toolCalls: StreamedToolCall[] = [];

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
            if (!line.trim()) {
              continue;
            }

            try {
              const chunk: OllamaResponse = JSON.parse(line);

              if (chunk.message?.content) {
                contentBuffer += chunk.message.content;

                // Build content chunk with optional accumulated field
                const contentChunk: IRStreamChunk = {
                  type: 'content',
                  sequence: sequence++,
                  delta: chunk.message.content,
                  role: 'assistant',
                };

                // Add accumulated field if configured
                if (includeBoth) {
                  (contentChunk as any).accumulated = contentBuffer;
                }

                yield contentChunk;
              }

              for (const call of chunk.message?.tool_calls ?? []) {
                const index = toolCalls.length;
                const toolCall: StreamedToolCall = {
                  id: call.id ?? generateToolCallId(index),
                  name: call.function.name,
                  args: JSON.stringify(call.function.arguments ?? {}),
                  index,
                };
                toolCalls.push(toolCall);
                yield {
                  type: 'tool_use',
                  sequence: sequence++,
                  id: toolCall.id,
                  name: toolCall.name,
                  inputDelta: toolCall.args,
                  index,
                } as IRStreamChunk;
              }

              if (chunk.done) {
                const message: IRMessage = buildStreamDoneMessage(contentBuffer, toolCalls);
                yield {
                  type: 'done',
                  sequence: sequence++,
                  finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
                  usage:
                    chunk.prompt_eval_count && chunk.eval_count
                      ? {
                          promptTokens: chunk.prompt_eval_count,
                          completionTokens: chunk.eval_count,
                          totalTokens: chunk.prompt_eval_count + chunk.eval_count,
                        }
                      : undefined,
                  message,
                } as IRStreamChunk;
              }
            } catch (parseError) {
              console.warn('Failed to parse Ollama JSONL chunk:', line, parseError);
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
      const response = await fetch(`${this.baseURL}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  estimateCost(_request: IRChatRequest): Promise<number | null> {
    return Promise.resolve(null); // Ollama is free (local)
  }

  /**
   * Convert IR request to Ollama format.
   *
   * Public method for testing and debugging - see what will be sent to Ollama.
   */
  public fromIR(request: IRChatRequest): OllamaRequest {
    const { messages } = normalizeSystemMessages(
      buildStructuredOutputFallbackMessages(request.messages, request.responseFormat),
      this.metadata.capabilities.systemMessageStrategy,
      this.metadata.capabilities.supportsMultipleSystemMessages
    );

    const ollamaMessages = this.convertMessages(messages);
    // `toolChoice: 'none'` is honoured by not offering the tools at all.
    const offerTools =
      request.tools && request.tools.length > 0 && request.toolChoice !== 'none'
        ? request.tools
        : undefined;

    return {
      model: request.parameters?.model || this.config.defaultModel || 'llama3.2',
      messages: ollamaMessages,
      ...(offerTools
        ? {
            tools: offerTools.map((tool) => ({
              type: 'function' as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters as unknown as Record<string, unknown>,
              },
            })),
          }
        : {}),
      options: {
        temperature: request.parameters?.temperature,
        top_p: request.parameters?.topP,
        top_k: request.parameters?.topK,
        num_predict: request.parameters?.maxTokens,
        stop: request.parameters?.stopSequences ? [...request.parameters.stopSequences] : undefined,
      },
      stream: request.stream,
    };
  }

  /**
   * Convert IR messages to Ollama messages.
   *
   * - `tool_use` blocks become the assistant message's `tool_calls`
   *   (`arguments` stays an object).
   * - Each `tool_result` block becomes its own `role: 'tool'` message; the
   *   `tool_name` is resolved from the matching earlier `tool_use` id when
   *   there is one (Ollama >= 0.4 uses it, older versions ignore it).
   * - Remaining text keeps the previous behaviour (text joined, other block
   *   types JSON-stringified).
   */
  private convertMessages(messages: readonly IRMessage[]): OllamaMessage[] {
    const toolNames = new Map<string, string>();
    const out: OllamaMessage[] = [];

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        out.push({ role: msg.role, content: msg.content });
        continue;
      }

      const textOf = (blocks: readonly MessageContent[]): string =>
        blocks.map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('');

      const toolUses = msg.content.filter((c) => c.type === 'tool_use');
      const toolResults = msg.content.filter((c) => c.type === 'tool_result');
      const rest = msg.content.filter((c) => c.type !== 'tool_use' && c.type !== 'tool_result');

      for (const use of toolUses) {
        toolNames.set(use.id, use.name);
      }

      for (const result of toolResults) {
        const toolName = toolNames.get(result.toolUseId);
        out.push({
          role: 'tool',
          content:
            typeof result.content === 'string'
              ? result.content
              : result.content.map((t) => t.text).join(''),
          ...(toolName ? { tool_name: toolName } : {}),
        });
      }

      if (toolUses.length > 0) {
        out.push({
          role: 'assistant',
          content: textOf(rest),
          tool_calls: toolUses.map((use) => ({
            function: { name: use.name, arguments: { ...use.input } },
          })),
        });
      } else if (rest.length > 0 || toolResults.length === 0) {
        out.push({ role: msg.role, content: textOf(rest) });
      }
    }

    return out;
  }

  /**
   * `parameter-unsupported` warnings for the part of `toolChoice` Ollama has
   * no wire equivalent for (`'required'` and a forced `{ name }`); `'auto'`
   * is Ollama's behaviour and `'none'` is honoured by omitting the tools.
   */
  private withToolChoiceWarnings(request: IRChatRequest): IRWarning[] | undefined {
    const existing = request.metadata.warnings;
    const choice = request.toolChoice;
    if (!request.tools?.length || choice === undefined || choice === 'auto' || choice === 'none') {
      return existing ? [...existing] : undefined;
    }
    return [
      ...(existing ?? []),
      createWarning(
        'parameter-unsupported',
        `Ollama's /api/chat has no tool_choice; toolChoice ${
          typeof choice === 'string' ? `'${choice}'` : `{ name: '${choice.name}' }`
        } was not forwarded and the model decides whether to call a tool.`,
        { field: 'toolChoice', source: this.metadata.name }
      ),
    ];
  }

  /**
   * Convert Ollama response to IR format.
   *
   * Public method for testing and debugging - parse Ollama responses manually.
   */
  public toIR(
    response: OllamaResponse,
    originalRequest: IRChatRequest,
    latencyMs: number
  ): IRChatResponse {
    const content = originalRequest.responseFormat
      ? extractStructuredOutputJSON(response.message.content)
      : response.message.content;
    const toolCalls = response.message.tool_calls ?? [];
    const message: IRMessage =
      toolCalls.length > 0
        ? {
            role: 'assistant',
            content: [
              ...(content ? [{ type: 'text' as const, text: content }] : []),
              ...toolCalls.map((call, index) => ({
                type: 'tool_use' as const,
                id: call.id ?? generateToolCallId(index),
                name: call.function.name,
                input: call.function.arguments ?? {},
              })),
            ],
          }
        : { role: 'assistant', content };
    const finishReason: FinishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';

    return {
      message,
      finishReason,
      usage:
        response.prompt_eval_count && response.eval_count
          ? {
              promptTokens: response.prompt_eval_count,
              completionTokens: response.eval_count,
              totalTokens: response.prompt_eval_count + response.eval_count,
            }
          : undefined,
      metadata: {
        ...originalRequest.metadata,
        providerResponseId: undefined, // Ollama does not provide a response ID
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
        warnings: originalRequest.responseFormat
          ? [
              ...(this.withToolChoiceWarnings(originalRequest) ?? []),
              buildResponseFormatFallbackWarning(this.metadata.name),
            ]
          : this.withToolChoiceWarnings(originalRequest),
      },
      raw: response as unknown as Record<string, unknown>,
    };
  }

  /**
   * List locally available models from Ollama.
   *
   * Priority order:
   * 1. Static config override (this.config.models)
   * 2. API fetch (http://localhost:11434/api/tags)
   * 3. Empty array (Ollama not running or no models installed)
   *
   * Note: Unlike cloud providers, Ollama models are local and dynamic.
   * No caching or fallback list - always fetches fresh from local server.
   *
   * @param options - Optional filter settings
   * @returns Promise resolving to list of locally installed models
   */
  async listModels(options?: ListModelsOptions): Promise<ListModelsResult> {
    try {
      // 1. Check static config override first
      if (this.config.models) {
        return buildStaticResult(this.config.models, 'ollama');
      }

      // 2. Fetch from Ollama local API
      const response = await fetch(`${this.baseURL}/api/tags`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', ...this.config.headers },
        signal: AbortSignal.timeout(this.config.timeout || 5000),
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

      // 3. Transform to AIModel format
      const models = data.models.map((model) => this.transformOllamaModel(model));

      // 4. Build result
      const result: ListModelsResult = {
        models,
        source: 'remote',
        fetchedAt: Date.now(),
        isComplete: true,
      };

      // 5. Apply filter if requested
      return applyModelFilter(result, options?.filter as ModelCapabilityFilter);
    } catch {
      // 6. Return empty list if Ollama not running or error
      // No fallback models for Ollama since it's dynamic/local
      const result: ListModelsResult = {
        models: [],
        source: 'static',
        fetchedAt: Date.now(),
        isComplete: true,
      };
      return applyModelFilter(result, options?.filter as ModelCapabilityFilter);
    }
  }

  /**
   * Transform Ollama API model to AIModel format.
   */
  private transformOllamaModel(model: any): AIModel {
    // Parse parameter size from details (e.g., "3B", "7B", "13B")
    const paramSize = model.details?.parameter_size || 'unknown';

    if (isOllamaDecisionModel(model.name, model.details?.parent_model)) {
      return {
        id: model.name,
        name: model.name,
        description: `Typed-decision model (${paramSize})`,
        ownedBy: 'ollama',
        capabilities: {
          contextWindow: model.details?.context_length || 4096,
          supportsStreaming: false,
          supportsVision: true,
          supportsTools: false,
          supportsJSON: false,
        },
        metadata: { kind: 'decision' },
      };
    }

    return {
      id: model.name,
      name: model.name,
      description: `${model.details?.family || 'Local'} model (${paramSize})`,
      ownedBy: 'ollama',
      capabilities: {
        maxTokens: 4096,
        contextWindow: model.details?.context_length || 4096,
        supportsStreaming: true,
        supportsVision: false,
        supportsTools: false,
        supportsJSON: false,
      },
    };
  }
}
