/**
 * Chrome AI Backend Adapter
 *
 * Adapts Universal IR to Chrome's built-in on-device model via the Prompt
 * API (`LanguageModel.create()` / `session.prompt()` / `session.promptStreaming()`,
 * Chrome 138+). Runs entirely client-side: no API key, no network calls
 * after the model is downloaded, no cost.
 *
 * This replaces an earlier version of this adapter that targeted Chrome's
 * pre-138 origin-trial API (`window.ai.languageModel`, tri-state
 * `readily`/`after-download`/`no` availability) - that surface no longer
 * exists in shipping Chrome.
 *
 * @module
 */

import type {
  BackendAdapter,
  AdapterMetadata,
  IRChatRequest,
  IRChatResponse,
  IRChatStream,
  IRMessage,
  IRStreamChunk,
  IRWarning,
} from '@johnhenry/aimatey-types';
import { ProviderError, ErrorCode } from '@johnhenry/aimatey-errors';
import {
  extractSystemMessages,
  combineSystemMessages,
  createWarning,
} from '@johnhenry/aimatey-utils';

// ============================================================================
// Chrome Prompt API types (kept local: a bleeding-edge browser global not
// consistently declared across TypeScript DOM lib versions)
// ============================================================================

export type LanguageModelAvailability =
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available';

export interface LanguageModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LanguageModelDownloadProgressEvent {
  loaded: number;
}

export interface LanguageModelMonitor {
  addEventListener(
    type: 'downloadprogress',
    listener: (event: LanguageModelDownloadProgressEvent) => void
  ): void;
}

export interface LanguageModelCreateOptions {
  initialPrompts?: LanguageModelMessage[];
  temperature?: number;
  topK?: number;
  signal?: AbortSignal;
  monitor?: (monitor: LanguageModelMonitor) => void;
}

export interface LanguageModelPromptOptions {
  /** JSON Schema constraining the response - maps from IR's `responseFormat.schema`. */
  responseConstraint?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface LanguageModelSession {
  prompt(input: string, options?: LanguageModelPromptOptions): Promise<string>;
  promptStreaming(input: string, options?: LanguageModelPromptOptions): ReadableStream<string>;
  destroy(): void;
  /** Cumulative tokens consumed so far in this session's context window. */
  readonly inputUsage?: number;
  /** Total context-window token budget for this session. */
  readonly inputQuota?: number;
}

/** The subset of the global `LanguageModel` Prompt API surface this adapter uses. */
export interface LanguageModelAPI {
  availability(): Promise<LanguageModelAvailability>;
  create(options?: LanguageModelCreateOptions): Promise<LanguageModelSession>;
}

declare global {
  var LanguageModel: LanguageModelAPI | undefined;
}

// ============================================================================
// Configuration
// ============================================================================

export interface ChromeAIConfig {
  temperature?: number;
  topK?: number;

  /** Called with download progress when availability is 'downloadable'/'downloading'. */
  onDownloadProgress?: (event: LanguageModelDownloadProgressEvent) => void;

  /**
   * Test/DI seam: a preloaded object implementing the `LanguageModel`
   * surface. When omitted, the adapter reads `globalThis.LanguageModel`.
   */
  languageModel?: LanguageModelAPI;
}

function getLanguageModel(config: ChromeAIConfig): LanguageModelAPI | undefined {
  if (config.languageModel) {
    return config.languageModel;
  }
  return typeof globalThis !== 'undefined'
    ? (globalThis as typeof globalThis & { LanguageModel?: LanguageModelAPI }).LanguageModel
    : undefined;
}

/** Extract plain text from an IR message (text blocks only). */
function extractText(message: IRMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

// ============================================================================
// Chrome AI Backend Adapter
// ============================================================================

/**
 * Backend adapter for Chrome's built-in on-device model (Prompt API).
 *
 * @example
 * ```typescript
 * import { Bridge } from '@johnhenry/aimatey-core';
 * import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
 * import { ChromeAIBackendAdapter } from '@johnhenry/aimatey-backend-browser';
 *
 * const backend = new ChromeAIBackendAdapter();
 * if ((await backend.checkAvailability()) === 'unavailable') {
 *   // fall back to a hosted backend
 * }
 *
 * const bridge = new Bridge(new OpenAIFrontendAdapter(), backend);
 * const response = await bridge.chat({
 *   messages: [{ role: 'user', content: 'Hello!' }],
 * });
 * ```
 */
export class ChromeAIBackendAdapter implements BackendAdapter {
  readonly metadata: AdapterMetadata;
  private readonly config: ChromeAIConfig;

  constructor(config: ChromeAIConfig = {}) {
    this.config = config;
    this.metadata = {
      name: 'chrome-ai-backend',
      version: '2.0.0',
      provider: 'Chrome AI',
      capabilities: {
        streaming: true,
        multiModal: false, // text-only for now; Prompt API image/audio input is a future follow-up
        tools: false,
        embeddings: false,
        structuredOutput: 'native', // via responseConstraint
        maxContextTokens: 4096, // varies by device/model; Prompt API exposes no fixed constant
        systemMessageStrategy: 'in-messages', // folded into initialPrompts
        supportsMultipleSystemMessages: false, // combined into one leading initialPrompts entry
        supportsTemperature: true,
        supportsTopP: false,
        supportsTopK: true,
        supportsSeed: false,
        supportsFrequencyPenalty: false,
        supportsPresencePenalty: false,
        maxStopSequences: 0,
      },
      config: {},
    };
  }

  /**
   * Convert IR request to provider format (passthrough - uses IR internally).
   */
  fromIR(request: IRChatRequest): IRChatRequest {
    return request;
  }

  /**
   * Convert provider response to IR format (passthrough - uses IR internally).
   */
  toIR(
    response: IRChatResponse,
    _originalRequest: IRChatRequest,
    _latencyMs: number
  ): IRChatResponse {
    return response;
  }

  /**
   * Check Chrome AI's on-device model availability directly, exposing the
   * Prompt API's own tri-state (plus `unavailable` for "no LanguageModel
   * global at all") so callers can gate UI - e.g. show a download prompt
   * for `'downloadable'` rather than just failing.
   */
  async checkAvailability(): Promise<LanguageModelAvailability> {
    const languageModel = getLanguageModel(this.config);
    if (!languageModel) {
      return 'unavailable';
    }
    try {
      return await languageModel.availability();
    } catch {
      return 'unavailable';
    }
  }

  /**
   * Boolean convenience wrapper over {@link checkAvailability} (required by
   * `BackendAdapter`). True unless the model is fully `'unavailable'`.
   */
  async healthCheck(): Promise<boolean> {
    return (await this.checkAvailability()) !== 'unavailable';
  }

  /**
   * Chrome AI is free - it runs entirely on-device.
   */
  estimateCost(_request: IRChatRequest): Promise<number | null> {
    return Promise.resolve(0);
  }

  /**
   * Execute a non-streaming chat request using Chrome's Prompt API.
   */
  async execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse> {
    const startTime = Date.now();
    let session: LanguageModelSession | undefined;

    try {
      const built = await this.createSession(request, signal);
      session = built.session;

      const text = await session.prompt(built.promptText, this.buildPromptOptions(request, signal));

      return {
        message: { role: 'assistant', content: text },
        finishReason: 'stop',
        metadata: this.buildMetadata(request, built.warnings, session, startTime),
      };
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError({
        code: ErrorCode.PROVIDER_ERROR,
        message: `Chrome AI request failed: ${error instanceof Error ? error.message : String(error)}`,
        isRetryable: false,
        provenance: { backend: this.metadata.name },
        cause: error instanceof Error ? error : undefined,
      });
    } finally {
      session?.destroy();
    }
  }

  /**
   * Execute a streaming chat request using Chrome's Prompt API.
   */
  async *executeStream(request: IRChatRequest, signal?: AbortSignal): IRChatStream {
    let session: LanguageModelSession | undefined;
    let sequence = 0;

    try {
      const built = await this.createSession(request, signal);
      session = built.session;

      yield {
        type: 'start',
        sequence: sequence++,
        metadata: {
          ...request.metadata,
          warnings: built.warnings.length
            ? [...(request.metadata.warnings ?? []), ...built.warnings]
            : request.metadata.warnings,
          provenance: {
            ...request.metadata.provenance,
            backend: this.metadata.name,
            locality: 'in-process',
          },
        },
      } as IRStreamChunk;

      const stream = session.promptStreaming(
        built.promptText,
        this.buildPromptOptions(request, signal)
      );
      const reader = stream.getReader();
      let buffer = '';

      try {
        while (true) {
          if (signal?.aborted) {
            throw new Error('Chrome AI generation aborted');
          }

          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += value;
          yield {
            type: 'content',
            sequence: sequence++,
            delta: value,
            role: 'assistant',
          } as IRStreamChunk;
        }

        yield {
          type: 'done',
          sequence: sequence++,
          finishReason: 'stop',
          message: { role: 'assistant', content: buffer },
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
    } finally {
      session?.destroy();
    }
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  /**
   * Create a Prompt API session for one request: checks availability, maps
   * IR messages onto `initialPrompts` (all but the last message) plus a
   * final prompt string (the last message), and collects any semantic-drift
   * warnings along the way.
   */
  private async createSession(
    request: IRChatRequest,
    signal?: AbortSignal
  ): Promise<{ session: LanguageModelSession; promptText: string; warnings: IRWarning[] }> {
    const languageModel = getLanguageModel(this.config);
    if (!languageModel) {
      throw new ProviderError({
        code: ErrorCode.PROVIDER_UNAVAILABLE,
        message:
          'Chrome AI (Prompt API) is not available - requires Chrome 138+ with the ' +
          '`LanguageModel` global (chrome://flags/#prompt-api-for-gemini-nano may be required)',
        provenance: { backend: this.metadata.name },
      });
    }

    const availability = await languageModel.availability();
    if (availability === 'unavailable') {
      throw new ProviderError({
        code: ErrorCode.PROVIDER_UNAVAILABLE,
        message: 'Chrome AI is unavailable on this device',
        provenance: { backend: this.metadata.name },
      });
    }

    const warnings: IRWarning[] = [];

    if (request.tools && request.tools.length > 0) {
      warnings.push(
        createWarning('tool-unsupported', 'Chrome AI (Prompt API) does not support tool calling', {
          source: this.metadata.name,
        })
      );
    }

    const hasNonText = request.messages.some(
      (message) =>
        typeof message.content !== 'string' &&
        message.content.some((block) => block.type !== 'text')
    );
    if (hasNonText) {
      warnings.push(
        createWarning(
          'content-type-unsupported',
          'Chrome AI (Prompt API) backend adapter is text-only; non-text content blocks were dropped',
          { source: this.metadata.name }
        )
      );
    }

    const { systemMessages, otherMessages } = extractSystemMessages(request.messages);
    const systemText = combineSystemMessages(systemMessages);

    const lastMessage = otherMessages[otherMessages.length - 1];
    if (lastMessage && lastMessage.role !== 'user') {
      warnings.push(
        createWarning(
          'system-message-transformed',
          "Chrome AI expects the final turn to be role:'user'; the last message was not - " +
            'behavior may be unreliable',
          { source: this.metadata.name }
        )
      );
    }

    const history = otherMessages.slice(0, -1);
    const initialPrompts: LanguageModelMessage[] = [
      ...(systemText ? [{ role: 'system' as const, content: systemText }] : []),
      ...history.map((message) => ({
        role: message.role as 'user' | 'assistant',
        content: extractText(message),
      })),
    ];

    const promptText = lastMessage ? extractText(lastMessage) : '';

    const session = await languageModel.create({
      initialPrompts: initialPrompts.length > 0 ? initialPrompts : undefined,
      temperature: request.parameters?.temperature ?? this.config.temperature,
      topK: request.parameters?.topK ?? this.config.topK,
      signal,
      monitor: this.config.onDownloadProgress
        ? (monitor) => {
            monitor.addEventListener('downloadprogress', (event) => {
              this.config.onDownloadProgress?.(event);
            });
          }
        : undefined,
    });

    return { session, promptText, warnings };
  }

  private buildPromptOptions(
    request: IRChatRequest,
    signal?: AbortSignal
  ): LanguageModelPromptOptions {
    return {
      signal,
      ...(request.responseFormat
        ? {
            responseConstraint: request.responseFormat.schema as unknown as Record<string, unknown>,
          }
        : {}),
    };
  }

  private buildMetadata(
    request: IRChatRequest,
    warnings: IRWarning[],
    session: LanguageModelSession,
    startTime: number
  ): IRChatResponse['metadata'] {
    return {
      ...request.metadata,
      provenance: {
        ...request.metadata.provenance,
        backend: this.metadata.name,
        locality: 'in-process',
      },
      warnings: warnings.length
        ? [...(request.metadata.warnings ?? []), ...warnings]
        : request.metadata.warnings,
      custom: {
        ...request.metadata.custom,
        latencyMs: Date.now() - startTime,
        ...(request.responseFormat ? { responseFormatEnforced: true } : {}),
        ...(session.inputUsage !== undefined
          ? { inputUsage: session.inputUsage, inputQuota: session.inputQuota }
          : {}),
      },
    };
  }
}
