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
import { AdapterError, ProviderError, StreamError, ErrorCode } from '@johnhenry/aimatey-errors';
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

  /**
   * Called as the engine loads (download, then compile), for every load this
   * adapter waits on, including one already started by another adapter
   * instance for the same URL (the latest snapshot is replayed immediately).
   * Also see {@link LiteRtLmBackendAdapter.preload}.
   */
  onProgress?: (progress: LiteRtLmLoadProgress) => void;

  /**
   * Download the model bundle in the adapter instead of handing the URL to the
   * runtime, passing the runtime a byte-counting stream. This is what makes
   * byte progress (`loaded` / `total`) and mid-download abort possible:
   * `@litert-lm/core` fetches a URL itself with no progress or abort hook.
   * The request is the runtime's own (`fetch(url, { credentials: 'same-origin' })`),
   * plus an abort signal. Pass a function to use a custom `fetch`.
   *
   * Off by default (the URL is passed through unchanged); without it progress
   * is a single `loading` stage and abort takes effect after the runtime
   * finishes loading, because a runtime-owned download cannot be interrupted.
   *
   * @default false
   */
  fetchModel?: boolean | typeof fetch;
}

/**
 * Engine load stage.
 *
 * - `download`: model bytes are being fetched (or, for a Blob, read) by the adapter (`fetchModel`).
 * - `compile`: all bytes are in; the runtime is compiling the model for WebGPU. Cannot be interrupted.
 * - `loading`: download + compile as one step, reported when the runtime owns the download
 *   (`fetchModel` off), so bytes are unknown.
 * - `ready`: the engine is created.
 */
export type LiteRtLmLoadStage = 'download' | 'compile' | 'loading' | 'ready';

/**
 * A model-load progress event.
 */
export interface LiteRtLmLoadProgress {
  readonly stage: LiteRtLmLoadStage;
  /** Bytes received so far (0 for `loading`). */
  readonly loaded: number;
  /** Total bytes when known (Content-Length or Blob size). */
  readonly total?: number;
}

/** Options for {@link LiteRtLmBackendAdapter.preload}. */
export interface LiteRtLmPreloadOptions {
  /** Stop waiting (and stop an adapter-managed download when nobody else needs it). */
  signal?: AbortSignal;
  /** Progress for this call, in addition to the config's `onProgress`. */
  onProgress?: (progress: LiteRtLmLoadProgress) => void;
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
const engineCacheByUrl = new Map<string, EngineLoad>();

/**
 * One in-flight (or finished) engine load, shared by everything waiting on it.
 * The load has its own AbortController so one caller's abort cannot kill a
 * download another caller still needs: the download is only cancelled when the
 * last waiter leaves, and only while it is still downloading.
 */
interface EngineLoad {
  promise: Promise<LiteRtLmEngine>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
  last?: LiteRtLmLoadProgress;
  listeners: Set<(progress: LiteRtLmLoadProgress) => void>;
}

function emitProgress(load: EngineLoad, progress: LiteRtLmLoadProgress): void {
  load.last = progress;
  for (const listener of [...load.listeners]) {
    try {
      listener(progress);
    } catch {
      // A throwing progress callback must not break the load
    }
  }
}

function cancelledError(backend: string): StreamError {
  return new StreamError({
    code: ErrorCode.STREAM_CANCELLED,
    message: 'LiteRT-LM request aborted',
    provenance: { backend },
  });
}

/**
 * Settle with `promise`, or reject as soon as `signal` aborts. Does not cancel
 * `promise` (the caller decides what keeps running).
 */
function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => Error
): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(onAbort());
  }
  return new Promise<T>((resolve, reject) => {
    const listener = (): void => reject(onAbort());
    signal.addEventListener('abort', listener, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', listener);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', listener);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

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
  private instanceEngine: EngineLoad | null = null;

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
    const cancelled = (): Error => cancelledError(this.metadata.name);
    let removeAbortListener = (): void => {};

    try {
      const engine = await this.loadEngine({ signal, onProgress: this.config.onProgress });

      const { preface, prompt } = this.buildConversationInput(request);
      conversation = await raceAbort(
        engine.createConversation(preface.length > 0 ? { preface: { messages: preface } } : {}),
        signal,
        cancelled
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

      // Cancel the runtime the moment the signal fires, not when the next chunk
      // arrives: a generation that never yields must still be stoppable.
      const activeConversation = conversation;
      let abortWaiter: Promise<never> | null = null;
      if (signal) {
        abortWaiter = new Promise<never>((_resolve, reject) => {
          const listener = (): void => {
            activeConversation.cancel();
            reject(cancelled());
          };
          if (signal.aborted) {
            listener();
          } else {
            signal.addEventListener('abort', listener, { once: true });
            removeAbortListener = () => signal.removeEventListener('abort', listener);
          }
        });
        abortWaiter.catch(() => {}); // rejection is consumed through the race below
      }

      const iterator = conversation.sendMessageStreaming(prompt)[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = iterator.next();
          const result = abortWaiter ? await Promise.race([next, abortWaiter]) : await next;
          if (result.done) {
            break;
          }
          for (const item of result.value.content) {
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
      } catch (error) {
        // Do not await: a runtime that ignores cancel() could hang return() forever
        void Promise.resolve(iterator.return?.()).catch(() => {});
        throw error;
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
    } finally {
      removeAbortListener();
    }
  }

  /**
   * Load the model ahead of the first request, with progress and abort.
   * Shares the same load as `execute`/`executeStream`: calling it first means
   * the first request starts with a ready engine, and the result is cached.
   *
   * Abort stops waiting at once. With `fetchModel` the download itself is
   * cancelled too (unless another caller still needs it). Once the runtime is
   * compiling it cannot be interrupted: the compile finishes in the background
   * and the engine stays cached for the next call.
   */
  async preload(options: LiteRtLmPreloadOptions = {}): Promise<void> {
    await this.loadEngine(options);
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
      cached.controller.abort(); // no-op once settled; stops a download still in flight
      try {
        const engine = await cached.promise;
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
   * Get (or start) the engine load — shared per model URL, per-instance for Blobs.
   */
  private acquireLoad(): EngineLoad {
    const { model } = this.config;

    const start = (evict: () => void): EngineLoad => {
      const load: EngineLoad = {
        promise: undefined as unknown as Promise<LiteRtLmEngine>,
        controller: new AbortController(),
        waiters: 0,
        settled: false,
        listeners: new Set(),
      };
      load.promise = this.createEngine(load);
      load.promise.then(
        () => {
          load.settled = true;
        },
        () => {
          load.settled = true;
          // Drop failed or aborted initializations so retries re-attempt
          evict();
        }
      );
      return load;
    };

    if (typeof model === 'string') {
      let cached = engineCacheByUrl.get(model);
      if (!cached) {
        const created = start(() => {
          if (engineCacheByUrl.get(model) === created) {
            engineCacheByUrl.delete(model);
          }
        });
        cached = created;
        engineCacheByUrl.set(model, created);
      }
      return cached;
    }

    if (!this.instanceEngine) {
      const created = start(() => {
        if (this.instanceEngine === created) {
          this.instanceEngine = null;
        }
      });
      this.instanceEngine = created;
    }
    return this.instanceEngine;
  }

  /**
   * Wait for the engine. Abort rejects immediately; the shared download is
   * cancelled only when the last waiter has left and it is still downloading.
   */
  private async loadEngine(options: {
    signal?: AbortSignal;
    onProgress?: (progress: LiteRtLmLoadProgress) => void;
  }): Promise<LiteRtLmEngine> {
    const { signal } = options;
    const cancelled = (): Error => cancelledError(this.metadata.name);
    if (signal?.aborted) {
      throw cancelled();
    }

    const load = this.acquireLoad();
    const listeners = [this.config.onProgress, options.onProgress].filter(
      (fn, index, all): fn is (progress: LiteRtLmLoadProgress) => void =>
        fn !== undefined && all.indexOf(fn) === index
    );
    for (const listener of listeners) {
      load.listeners.add(listener);
      if (load.last) {
        try {
          listener(load.last);
        } catch {
          // A throwing progress callback must not break the load
        }
      }
    }
    load.waiters++;

    try {
      return await raceAbort(load.promise, signal, cancelled);
    } finally {
      load.waiters--;
      for (const listener of listeners) {
        load.listeners.delete(listener);
      }
      if (load.waiters === 0 && !load.settled && load.last?.stage === 'download') {
        load.controller.abort();
      }
    }
  }

  private async createEngine(load: EngineLoad): Promise<LiteRtLmEngine> {
    const module = this.config.engineModule ?? (await loadLiteRtLm());
    const { model, fetchModel } = this.config;

    let source: string | Blob | ReadableStream = model;
    if (fetchModel) {
      source = await this.openModelStream(load, fetchModel === true ? fetch : fetchModel);
    } else {
      emitProgress(load, { stage: 'loading', loaded: 0 });
    }

    const engine = await module.Engine.create({
      model: source,
      mainExecutorSettings: { maxNumTokens: this.config.maxNumTokens ?? 8192 },
    });
    emitProgress(load, { stage: 'ready', loaded: load.last?.loaded ?? 0, total: load.last?.total });
    return engine;
  }

  /**
   * Fetch (or read) the model ourselves and hand the runtime a stream that
   * counts bytes. The load's own signal cancels the fetch.
   */
  private async openModelStream(
    load: EngineLoad,
    fetchImpl: typeof fetch
  ): Promise<ReadableStream<Uint8Array>> {
    const { model } = this.config;
    let body: ReadableStream<Uint8Array>;
    let total: number | undefined;

    if (typeof model === 'string') {
      emitProgress(load, { stage: 'download', loaded: 0 });
      const response = await fetchImpl(model, {
        credentials: 'same-origin',
        signal: load.controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new ProviderError({
          code: ErrorCode.PROVIDER_ERROR,
          message: `Failed to fetch model file from ${model}: HTTP ${response.status}`,
          isRetryable: response.status >= 500,
          provenance: { backend: this.metadata.name },
          statusCode: response.status,
        });
      }
      body = response.body;
      const length = Number(response.headers.get('content-length'));
      total = Number.isFinite(length) && length > 0 ? length : undefined;
    } else {
      body = model.stream() as ReadableStream<Uint8Array>;
      total = model.size;
    }

    const reader = body.getReader();
    let loaded = 0;
    emitProgress(load, { stage: 'download', loaded, total });
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          emitProgress(load, { stage: 'compile', loaded, total: total ?? loaded });
          controller.close();
          return;
        }
        loaded += value.byteLength;
        emitProgress(load, { stage: 'download', loaded, total });
        controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
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
