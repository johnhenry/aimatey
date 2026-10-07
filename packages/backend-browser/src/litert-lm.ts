/**
 * LiteRT-LM Backend Adapter
 *
 * Runs on-device LLM chat in the browser via Google's LiteRT-LM Web runtime
 * (`@litert-lm/core`, WebGPU). Models are `.litertlm` bundles — e.g. Gemma-4
 * E2B/E4B from Hugging Face `litert-community` — downloaded once and executed
 * entirely client-side: no API key, no network calls after model load, no cost.
 *
 * `@litert-lm/core` is an OPTIONAL peer dependency, loaded lazily so this
 * package stays dependency-free for consumers that don't use this adapter.
 *
 * Web SDK limitations (early preview) surfaced as IR warnings when relevant:
 * text-only (no vision/audio), no tool calling, and no sampler parameters
 * (temperature/topK/topP/seed). WebGPU is required (Chrome 113+, Safari
 * 17.4+, Firefox 121+), and cross-origin isolation (COOP/COEP headers) may be
 * needed for threaded WASM. Not supported in Node.js.
 *
 * Note on naming: "LiteRT.js" (`@litertjs/core`) is Google's tensor-level
 * runtime and cannot run chat models; this adapter wraps LiteRT-LM, the
 * conversation runtime built on LiteRT.
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
import { AdapterError, ProviderError, ErrorCode } from '@johnhenry/aimatey-errors';
import { createWarning } from '@johnhenry/aimatey-utils';

// ============================================================================
// Structural types for @litert-lm/core (kept local: the peer is optional, so
// its types cannot appear in published declarations)
// ============================================================================

/** A streamed chunk from LiteRT-LM: content items, text ones carry `text`. */
interface LiteRtLmChunk {
  content: Array<{ type: string; text?: string }>;
}

interface LiteRtLmConversation {
  sendMessage(text: string): Promise<LiteRtLmChunk>;
  sendMessageStreaming(text: string): AsyncIterable<LiteRtLmChunk>;
  cancel(): void;
}

interface LiteRtLmEngine {
  createConversation(options?: {
    preface?: { messages: Array<{ role: string; content: string }> };
  }): Promise<LiteRtLmConversation>;
  delete(): Promise<void>;
}

/** The subset of the `@litert-lm/core` module surface this adapter uses. */
export interface LiteRtLmModule {
  Engine: {
    create(options: {
      model: string | Blob | ReadableStream;
      mainExecutorSettings?: { maxNumTokens?: number };
    }): Promise<LiteRtLmEngine>;
  };
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for the LiteRT-LM backend adapter.
 */
export interface LiteRtLmConfig {
  /**
   * The `.litertlm` model bundle: a URL (cached per URL across adapter
   * instances) or a Blob (cached per adapter instance only).
   *
   * @example 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm'
   */
  model: string | Blob;

  /**
   * Maximum tokens for the engine's main executor.
   * @default 8192
   */
  maxNumTokens?: number;

  /**
   * Test/DI seam: a preloaded module implementing the `@litert-lm/core`
   * surface. When omitted, the adapter dynamically imports the optional
   * peer dependency.
   */
  engineModule?: LiteRtLmModule;
}

// ============================================================================
// SDK loading + engine cache
// ============================================================================

/**
 * Lazily import the optional peer dependency with a friendly failure.
 */
async function loadLiteRtLm(): Promise<LiteRtLmModule> {
  try {
    // @ts-expect-error - Optional peer dependency, may not be installed
    return (await import('@litert-lm/core')) as LiteRtLmModule;
  } catch (error) {
    throw new AdapterError({
      code: ErrorCode.UNSUPPORTED_FEATURE,
      message:
        "LiteRT-LM backend requires the optional peer dependency '@litert-lm/core' — " +
        'install it with: npm install @litert-lm/core (browser/WebGPU only)',
      isRetryable: false,
      provenance: { backend: 'litert-lm-backend' },
      cause: error instanceof Error ? error : undefined,
    });
  }
}

/**
 * Engines keyed by model URL so multi-GB bundles are downloaded and compiled
 * once per page, shared across adapter instances. Blob models are cached on
 * the adapter instance instead (no stable global key).
 */
const engineCacheByUrl = new Map<string, Promise<LiteRtLmEngine>>();

/**
 * Test hook: clear the shared engine cache.
 */
export function clearLiteRtLmEngineCache(): void {
  engineCacheByUrl.clear();
}

// ============================================================================
// LiteRT-LM Backend Adapter
// ============================================================================

/**
 * Backend adapter for Google's LiteRT-LM Web runtime.
 *
 * @example
 * ```typescript
 * import { Bridge } from '@johnhenry/aimatey-core';
 * import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
 * import { LiteRtLmBackendAdapter } from '@johnhenry/aimatey-backend-browser';
 *
 * const backend = new LiteRtLmBackendAdapter({
 *   model:
 *     'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm',
 * });
 *
 * const bridge = new Bridge(new OpenAIFrontendAdapter(), backend);
 * for await (const chunk of bridge.chatStream({
 *   model: 'gemma-4-E2B-it-litert-lm', // informational; the loaded bundle decides
 *   messages: [{ role: 'user', content: 'Hello!' }],
 *   stream: true,
 * })) {
 *   process(chunk);
 * }
 * ```
 */
export class LiteRtLmBackendAdapter implements BackendAdapter {
  readonly metadata: AdapterMetadata;
  private readonly config: LiteRtLmConfig;
  private instanceEngine: Promise<LiteRtLmEngine> | null = null;

  constructor(config: LiteRtLmConfig) {
    this.config = config;
    this.metadata = {
      name: 'litert-lm-backend',
      version: '1.0.0',
      provider: 'LiteRT-LM',
      capabilities: {
        streaming: true,
        multiModal: false,
        tools: false,
        embeddings: false,
        maxContextTokens: config.maxNumTokens ?? 8192,
        systemMessageStrategy: 'separate-parameter',
        supportsMultipleSystemMessages: false,
        supportsTemperature: false,
        supportsTopP: false,
        supportsTopK: false,
        supportsSeed: false,
        supportsFrequencyPenalty: false,
        supportsPresencePenalty: false,
        maxStopSequences: 0,
      },
      config: {
        model: typeof config.model === 'string' ? config.model : '[blob]',
      },
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
   * Execute a chat request (consumes the stream internally — LiteRT-LM is
   * streaming-native).
   */
  async execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse> {
    const chunks: string[] = [];
    for await (const chunk of this.executeStream(request, signal)) {
      if (chunk.type === 'content') {
        chunks.push(chunk.delta);
      } else if (chunk.type === 'done') {
        return {
          message: chunk.message ?? { role: 'assistant', content: chunks.join('') },
          finishReason: chunk.finishReason,
          usage: chunk.usage,
          metadata: {
            ...request.metadata,
            warnings: [...(request.metadata.warnings ?? []), ...this.collectWarnings(request)],
            provenance: {
              ...request.metadata.provenance,
              backend: this.metadata.name,
              locality: 'in-process',
            },
          },
        };
      } else if (chunk.type === 'error') {
        throw new ProviderError({
          code: ErrorCode.PROVIDER_ERROR,
          message: chunk.error.message,
          provenance: { backend: this.metadata.name },
        });
      }
    }

    // Fallback (stream ended without a done chunk)
    return {
      message: { role: 'assistant', content: chunks.join('') },
      finishReason: 'stop',
      metadata: {
        ...request.metadata,
        provenance: {
          ...request.metadata.provenance,
          backend: this.metadata.name,
          locality: 'in-process',
        },
      },
    };
  }

  /**
   * Execute a streaming chat request through LiteRT-LM.
   */
  async *executeStream(request: IRChatRequest, signal?: AbortSignal): IRChatStream {
    let conversation: LiteRtLmConversation | null = null;
    let sequence = 0;

    try {
      const engine = await this.getEngine();

      const { preface, prompt } = this.buildConversationInput(request);
      conversation = await engine.createConversation(
        preface.length > 0 ? { preface: { messages: preface } } : {}
      );

      yield {
        type: 'start',
        sequence: sequence++,
        metadata: {
          ...request.metadata,
          warnings: [...(request.metadata.warnings ?? []), ...this.collectWarnings(request)],
          provenance: {
            ...request.metadata.provenance,
            backend: this.metadata.name,
            locality: 'in-process',
          },
        },
      } as IRStreamChunk;

      let buffer = '';

      for await (const chunk of conversation.sendMessageStreaming(prompt)) {
        if (signal?.aborted) {
          conversation.cancel();
          throw new ProviderError({
            code: ErrorCode.PROVIDER_ERROR,
            message: 'LiteRT-LM generation aborted',
            provenance: { backend: this.metadata.name },
          });
        }

        for (const item of chunk.content) {
          if (item.type === 'text' && item.text) {
            buffer += item.text;
            yield {
              type: 'content',
              sequence: sequence++,
              delta: item.text,
              role: 'assistant',
            } as IRStreamChunk;
          }
        }
      }

      const message: IRMessage = { role: 'assistant', content: buffer };
      yield {
        type: 'done',
        sequence: sequence++,
        finishReason: 'stop',
        message,
      } as IRStreamChunk;
    } catch (error) {
      conversation?.cancel();
      yield {
        type: 'error',
        sequence: sequence++,
        error: {
          code: error instanceof AdapterError ? error.code : 'PROVIDER_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      } as IRStreamChunk;
    }
  }

  /**
   * Release the engine held by this adapter (and the shared cache entry for
   * URL models). Frees GPU/WASM memory.
   */
  async dispose(): Promise<void> {
    const cached =
      typeof this.config.model === 'string'
        ? engineCacheByUrl.get(this.config.model)
        : this.instanceEngine;

    if (typeof this.config.model === 'string') {
      engineCacheByUrl.delete(this.config.model);
    }
    this.instanceEngine = null;

    if (cached) {
      try {
        const engine = await cached;
        await engine.delete();
      } catch {
        // Engine failed to initialize; nothing to free
      }
    }
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  /**
   * Get (or create) the engine — shared per model URL, per-instance for Blobs.
   */
  private getEngine(): Promise<LiteRtLmEngine> {
    const { model } = this.config;

    if (typeof model === 'string') {
      let cached = engineCacheByUrl.get(model);
      if (!cached) {
        cached = this.createEngine();
        engineCacheByUrl.set(model, cached);
        // Drop failed initializations so retries re-attempt
        cached.catch(() => engineCacheByUrl.delete(model));
      }
      return cached;
    }

    if (!this.instanceEngine) {
      this.instanceEngine = this.createEngine();
      this.instanceEngine.catch(() => {
        this.instanceEngine = null;
      });
    }
    return this.instanceEngine;
  }

  private async createEngine(): Promise<LiteRtLmEngine> {
    const module = this.config.engineModule ?? (await loadLiteRtLm());
    return module.Engine.create({
      model: this.config.model,
      mainExecutorSettings: { maxNumTokens: this.config.maxNumTokens ?? 8192 },
    });
  }

  /**
   * Map IR messages onto LiteRT-LM's conversation model.
   *
   * System messages become the conversation preface. Because each request
   * creates a fresh conversation, prior turns are flattened into a
   * transcript-style prefix on the outgoing prompt (portable across the
   * early-preview API; a warning notes the flattening when it happens).
   */
  private buildConversationInput(request: IRChatRequest): {
    preface: Array<{ role: string; content: string }>;
    prompt: string;
  } {
    const preface: Array<{ role: string; content: string }> = [];
    const turns: Array<{ role: string; text: string }> = [];

    for (const message of request.messages) {
      const text = extractText(message);
      if (message.role === 'system') {
        preface.push({ role: 'system', content: text });
      } else {
        turns.push({ role: message.role, text });
      }
    }

    const last = turns.pop();
    const prompt = last?.text ?? '';

    if (turns.length === 0) {
      return { preface, prompt };
    }

    // Flatten earlier turns into a readable transcript prefix
    const transcript = turns
      .map((turn) => `${turn.role === 'assistant' ? 'Assistant' : 'User'}: ${turn.text}`)
      .join('\n');

    return {
      preface,
      prompt: `Previous conversation:\n${transcript}\n\nUser: ${prompt}`,
    };
  }

  /**
   * Warnings for request features the LiteRT-LM Web SDK drops.
   */
  private collectWarnings(request: IRChatRequest): IRWarning[] {
    const warnings: IRWarning[] = [];

    const droppedParameters = (['temperature', 'topP', 'topK', 'seed'] as const).filter(
      (key) => request.parameters?.[key] !== undefined
    );
    for (const parameter of droppedParameters) {
      warnings.push(
        createWarning(
          'parameter-unsupported',
          `LiteRT-LM Web does not support '${parameter}'; the parameter was dropped`,
          { field: `parameters.${parameter}`, source: this.metadata.name }
        )
      );
    }

    if (request.tools && request.tools.length > 0) {
      warnings.push(
        createWarning('tool-unsupported', 'LiteRT-LM Web does not support tool calling', {
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
          'LiteRT-LM Web is text-only; non-text content blocks were reduced to text',
          { source: this.metadata.name }
        )
      );
    }

    const flattenedTurns =
      request.messages.filter((message) => message.role !== 'system').length > 1;
    if (flattenedTurns) {
      warnings.push(
        createWarning(
          'system-message-transformed',
          'Prior turns were flattened into a transcript prefix (fresh LiteRT-LM conversation per request)',
          { source: this.metadata.name }
        )
      );
    }

    return warnings;
  }
}

/**
 * Extract plain text from an IR message (text blocks only).
 */
function extractText(message: IRMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/**
 * Create a LiteRT-LM backend adapter.
 */
export function createLiteRtLmAdapter(config: LiteRtLmConfig): LiteRtLmBackendAdapter {
  return new LiteRtLmBackendAdapter(config);
}
