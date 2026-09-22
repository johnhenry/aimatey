/**
 * Bridge Implementation
 *
 * The Bridge connects frontend and backend adapters with middleware support.
 * It's the main entry point for making requests through the universal adapter system.
 *
 * @module
 */

import type {
  FrontendAdapter,
  BackendAdapter,
  InferFrontendRequest,
  InferFrontendResponse,
  InferFrontendStreamChunk,
} from '@johnhenry/aimatey-types';
import type {
  IRChatRequest,
  IRChatResponse,
  IRChatStream,
  IRProvenance,
} from '@johnhenry/aimatey-types';
import type {
  BridgeConfig,
  RequestOptions,
  Bridge as IBridge,
  BridgeStats,
  BridgeEventListener,
  BridgeEventData,
  RequestEvent,
  StreamEvent,
} from '@johnhenry/aimatey-types';
import type { Router } from '@johnhenry/aimatey-types';
import { BridgeEventType } from '@johnhenry/aimatey-types';
import type {
  Middleware,
  MiddlewareContext,
  MiddlewareRegistrationOptions,
  StreamingMiddleware,
} from '@johnhenry/aimatey-types';
import type { ListModelsOptions, ListModelsResult } from '@johnhenry/aimatey-types';
import {
  MiddlewareStack,
  createMiddlewareContext,
  createStreamingMiddlewareContext,
} from './middleware-stack.js';
import { AdapterError, ErrorCode, ValidationError } from '@johnhenry/aimatey-errors';
import {
  validateIRChatRequest,
  createGenerateObject,
  createStreamObject,
} from '@johnhenry/aimatey-utils';
import { createRunTools } from './run-tools.js';
import {
  supportsEmbeddings,
  chunkEmbedInputs,
  normalizeDimensions,
  createWarning,
  supportsChat,
  supportsChatStream,
  supportsDecisions,
} from '@johnhenry/aimatey-utils';
import type {
  EmbedMiddleware,
  EmbedOptions,
  IREmbedRequest,
  IREmbedResponse,
} from '@johnhenry/aimatey-types';
import type {
  DecisionMiddleware,
  DecisionOptions,
  IRDecisionRequest,
  IRDecisionResponse,
} from '@johnhenry/aimatey-types';

// ============================================================================
// Bridge Implementation
// ============================================================================

/**
 * Bridge connects frontend and backend adapters.
 *
 * @template TFrontend Frontend adapter type
 */
export class Bridge<
  TFrontend extends FrontendAdapter = FrontendAdapter,
> implements IBridge<TFrontend> {
  readonly frontend: TFrontend;
  readonly backend: BackendAdapter;
  readonly config: BridgeConfig;
  private middlewareStack: MiddlewareStack;
  private embedMiddleware: EmbedMiddleware[] = [];
  private decisionMiddleware: DecisionMiddleware[] = [];

  // Statistics tracking
  private _totalRequests = 0;
  private _successfulRequests = 0;
  private _failedRequests = 0;
  private _streamingRequests = 0;
  private _latencies: number[] = [];
  private static readonly MAX_LATENCY_SAMPLES = 1000; // Prevent unbounded memory growth
  private _errorCounts: Record<string, number> = {};
  /**
   * Per-backend success counts, keyed by the backend that actually served the request.
   *
   * Accumulated as requests succeed rather than derived at read time from
   * `this.backend.metadata.name`: on a router-backed bridge `this.backend` is the
   * *router*, so deriving it filed every success under `"router"` and per-backend
   * usage - the only thing the field exists to report - was unobservable (#68).
   */
  private _backendUsage: Record<string, number> = {};
  private _statsResetTimestamp = Date.now();

  // Event listeners, keyed by event type plus '*' for listeners on every event
  private _eventListeners: Map<string, Set<BridgeEventListener>> = new Map();

  /**
   * Create a new Bridge instance.
   *
   * @param frontend Frontend adapter
   * @param backend Backend adapter
   * @param config Bridge configuration
   */
  constructor(frontend: TFrontend, backend: BackendAdapter, config: Partial<BridgeConfig> = {}) {
    this.frontend = frontend;
    this.backend = backend;
    this.config = {
      debug: config.debug ?? false,
      timeout: config.timeout ?? 30000,
      retries: config.retries ?? 0,
      autoRequestId: config.autoRequestId ?? true,
      defaultModel: config.defaultModel,
      routerConfig: config.routerConfig,
      custom: config.custom,
    };
    this.middlewareStack = new MiddlewareStack();
  }

  // ==========================================================================
  // Core Request Methods
  // ==========================================================================

  /**
   * Execute a non-streaming chat completion request.
   */
  async chat(
    request: InferFrontendRequest<TFrontend>,
    options?: RequestOptions
  ): Promise<InferFrontendResponse<TFrontend>> {
    const startTime = Date.now();
    this._totalRequests++;

    // Steps 1-2 run before the retry loop, so their failures need the same accounting
    // the loop body gets - otherwise the request is counted as sent but never as failed
    // and no error event is emitted (#60).
    let irRequest: IRChatRequest | undefined;
    let enrichedRequest: IRChatRequest;
    try {
      // Step 1: Convert frontend request to IR
      irRequest = await this.frontend.toIR(request as any);

      // Step 2: Ensure metadata has requestId and timestamp
      enrichedRequest = this.enrichRequest(irRequest, options);

      // Step 2.5: A backend without execute() (e.g. a decision-only backend
      // like Jev/Laya) cannot serve a chat request at all -- fail before
      // entering the retry loop rather than retrying something that can
      // never succeed.
      if (!supportsChat(this.backend)) {
        throw new AdapterError({
          code: ErrorCode.UNSUPPORTED_FEATURE,
          message: `Backend '${this.backend.metadata.name}' does not support chat`,
          isRetryable: false,
          provenance: { backend: this.backend.metadata.name },
        });
      }
    } catch (error) {
      this.recordPreflightFailure(error, startTime, BridgeEventType.REQUEST_ERROR, irRequest);
      throw error;
    }

    // Emit REQUEST_START event
    this.emit({
      type: BridgeEventType.REQUEST_START,
      timestamp: Date.now(),
      requestId: enrichedRequest.metadata.requestId,
      request: enrichedRequest,
    } as RequestEvent);

    const maxAttempts = (this.config.retries ?? 0) + 1;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Step 3: Validate IR request
        validateIRChatRequest(enrichedRequest, {
          frontend: this.frontend.metadata.name,
        });

        // Step 4: Create middleware context
        const context = createMiddlewareContext(
          enrichedRequest,
          this.config as Record<string, unknown>,
          options?.signal,
          this.backend
        );

        // Step 5: Execute middleware stack + backend
        // Read `context.request` (not the enriched request captured above) so
        // request rewrites a middleware performed - redaction, sanitization,
        // history prepending - actually reach the backend.
        const irResponse = await this.middlewareStack.execute(context, async () => {
          // Call backend adapter
          // Non-null: chat() and executeIR() both check `backend.execute` exists
          // before reaching this closure -- TS narrowing doesn't survive the
          // closure boundary, so this asserts what the earlier guard verified.
          const response = await this.backend.execute!(context.request, options?.signal);
          this.narrowContextBackend(context, response.metadata.provenance?.backend);
          return response;
        });

        // Step 6: Enrich response with provenance
        const enrichedResponse = this.enrichResponse(irResponse, enrichedRequest);

        // Step 7: Convert IR response to frontend format
        const frontendResponse = await this.frontend.fromIR(enrichedResponse);

        // Track success
        this._successfulRequests++;
        this.recordBackendUsage(enrichedResponse.metadata.provenance?.backend);
        const durationMs = Date.now() - startTime;
        this.recordLatency(durationMs);

        // Emit REQUEST_SUCCESS event
        this.emit({
          type: BridgeEventType.REQUEST_SUCCESS,
          timestamp: Date.now(),
          requestId: enrichedRequest.metadata.requestId,
          request: enrichedRequest,
          response: enrichedResponse,
          durationMs,
        } as RequestEvent);

        return frontendResponse as InferFrontendResponse<TFrontend>;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on non-retryable errors or if this is the last attempt.
        //
        // An error that carries no classification is *not* retried (#70). The
        // two in-tree retry implementations used to disagree here - this loop
        // retried an unclassified error and `defaultShouldRetry` in
        // `createRetryMiddleware` did not - so the same fault was transient or
        // permanent depending on which retry a caller happened to configure.
        //
        // Non-retryable is the answer both now give, for three reasons: an
        // unclassified throwable is as likely a bug in the caller's own
        // adapter or middleware as a transient fault, and re-running it re-runs
        // every middleware side effect for something that cannot succeed;
        // `Router.wrapError` already classifies an unknown error non-retryable;
        // and this loop already wraps such an error as a non-retryable
        // `INTERNAL_ERROR` on the way out, so retrying it contradicted the
        // very classification it then handed the caller. A backend that wants
        // its failures retried should raise a classified `AdapterError` - the
        // in-tree HTTP backends already wrap fetch failures as `NetworkError`.
        //
        // Read duck-typed rather than through `instanceof AdapterError`: a
        // second copy of the errors package across the ESM/CJS boundary makes
        // `instanceof` quietly false, and silently losing retries to a
        // packaging artifact is the failure this whole issue is about.
        const isRetryable = (error as { isRetryable?: unknown } | undefined)?.isRetryable === true;
        if (!isRetryable || attempt >= maxAttempts) {
          break;
        }

        // Wait before retrying (simple exponential backoff)
        await this.delay(Math.min(1000 * Math.pow(2, attempt - 1), 10000));
      }
    }

    // Track failure
    this._failedRequests++;
    const errorCode = lastError instanceof AdapterError ? lastError.code : 'UNKNOWN';
    this._errorCounts[errorCode] = (this._errorCounts[errorCode] ?? 0) + 1;

    // Emit REQUEST_ERROR event
    this.emit({
      type: BridgeEventType.REQUEST_ERROR,
      timestamp: Date.now(),
      requestId: enrichedRequest.metadata.requestId,
      request: enrichedRequest,
      error: lastError,
      durationMs: Date.now() - startTime,
    } as RequestEvent);

    // Re-throw adapter errors, wrap others
    // lastError is guaranteed to be defined here (we only reach this point if all retries failed)
    if (!lastError) {
      throw new Error('Bridge execution failed with no error information');
    }

    if (lastError instanceof AdapterError) {
      throw lastError;
    }

    throw new AdapterError({
      code: ErrorCode.INTERNAL_ERROR,
      message: `Bridge execution failed: ${lastError.message}`,
      isRetryable: false,
      cause: lastError,
      provenance: {},
    });
  }

  /**
   * Execute a streaming chat completion request.
   */
  async *chatStream(
    request: InferFrontendRequest<TFrontend>,
    options?: RequestOptions
  ): AsyncGenerator<InferFrontendStreamChunk<TFrontend>, void, undefined> {
    const startTime = Date.now();
    this._totalRequests++;
    this._streamingRequests++;

    // Steps 1-3 run outside the try below, so their failures need the same accounting
    // the try does - otherwise the request is counted as sent but never as failed and
    // no error event is emitted (#60). The registered-backend check enrichRequest()
    // performs lands here.
    let irRequest: IRChatRequest | undefined;
    let enrichedRequest: IRChatRequest;
    try {
      // Step 1: Convert frontend request to IR
      irRequest = await this.frontend.toIR(request as any);

      // Step 2: Ensure streaming is enabled
      const streamingRequest: IRChatRequest = {
        ...irRequest,
        stream: true,
      };

      // Step 3: Ensure metadata has requestId and timestamp
      enrichedRequest = this.enrichRequest(streamingRequest, options);

      // Step 3.5: A backend without executeStream() (e.g. a decision-only
      // backend like Jev/Laya) cannot serve a streaming chat request.
      if (!supportsChatStream(this.backend)) {
        throw new AdapterError({
          code: ErrorCode.UNSUPPORTED_FEATURE,
          message: `Backend '${this.backend.metadata.name}' does not support streaming chat`,
          isRetryable: false,
          provenance: { backend: this.backend.metadata.name },
        });
      }
    } catch (error) {
      this.recordPreflightFailure(error, startTime, BridgeEventType.STREAM_ERROR, irRequest);
      throw error;
    }

    // Emit STREAM_START event
    this.emit({
      type: BridgeEventType.STREAM_START,
      timestamp: Date.now(),
      requestId: enrichedRequest.metadata.requestId,
      request: enrichedRequest,
    } as StreamEvent);

    try {
      // Step 4: Validate IR request
      validateIRChatRequest(enrichedRequest, {
        frontend: this.frontend.metadata.name,
      });

      // Step 5: Create streaming middleware context
      const context = createStreamingMiddlewareContext(
        enrichedRequest,
        this.config as Record<string, unknown>,
        options?.signal,
        this.backend
      );

      // Step 6: Execute middleware stack + backend
      // Read `context.request` (not the enriched request captured above) so
      // request rewrites a middleware performed actually reach the backend.
      const irStream = await this.middlewareStack.executeStream(context, () =>
        // Call backend adapter streaming
        Promise.resolve(
          this.trackContextBackend(
            // Non-null: chatStream() and executeIRStream() both check
            // `backend.executeStream` exists before reaching this point.
            this.backend.executeStream!(context.request, options?.signal),
            context
          )
        )
      );

      // Step 7: Stamp provenance, then convert IR stream to frontend format.
      // The usage tap sits *after* enrichStream so it reads the same resolved
      // provenance `chat()` reads off the enriched response, keeping the two paths
      // in agreement about who served the request (#68).
      let servedBy: string | undefined;
      const frontendStream = this.frontend.fromIRStream(
        this.captureStreamBackend(this.enrichStream(irStream), (name) => {
          servedBy = name;
        })
      );

      // Step 8: Yield chunks to caller
      let chunkSequence = 0;
      for await (const chunk of frontendStream) {
        // Check AbortSignal before yielding each chunk
        if (options?.signal?.aborted) {
          break;
        }
        chunkSequence++;
        yield chunk as InferFrontendStreamChunk<TFrontend>;
      }

      // Track success (after stream completes)
      this._successfulRequests++;
      this.recordBackendUsage(servedBy);
      const durationMs = Date.now() - startTime;
      this.recordLatency(durationMs);

      // Emit STREAM_COMPLETE event
      this.emit({
        type: BridgeEventType.STREAM_COMPLETE,
        timestamp: Date.now(),
        requestId: enrichedRequest.metadata.requestId,
        request: enrichedRequest,
        chunkSequence,
        durationMs,
      } as StreamEvent);
    } catch (error) {
      // Track failure
      this._failedRequests++;
      const errorCode = error instanceof AdapterError ? error.code : 'UNKNOWN';
      this._errorCounts[errorCode] = (this._errorCounts[errorCode] ?? 0) + 1;

      // Emit STREAM_ERROR event
      this.emit({
        type: BridgeEventType.STREAM_ERROR,
        timestamp: Date.now(),
        requestId: enrichedRequest.metadata.requestId,
        request: enrichedRequest,
        error: error instanceof Error ? error : new Error(String(error)),
        durationMs: Date.now() - startTime,
      } as StreamEvent);

      // Re-throw adapter errors, wrap others
      if (error instanceof AdapterError) {
        throw error;
      }

      throw new AdapterError({
        code: ErrorCode.INTERNAL_ERROR,
        message: `Bridge streaming failed: ${error instanceof Error ? error.message : String(error)}`,
        isRetryable: false,
        cause: error instanceof Error ? error : undefined,
        provenance: {},
      });
    }
  }

  // ==========================================================================
  // Model Listing
  // ==========================================================================

  /**
   * List available models from the backend.
   *
   * This delegates directly to the backend adapter's listModels() method.
   * Useful for discovering available models before making requests.
   *
   * @param options Options for listing models (filtering, cache control)
   * @returns List of available models, or null if backend doesn't support listing
   */
  async listModels(options?: ListModelsOptions): Promise<ListModelsResult | null> {
    if (!this.backend.listModels) {
      return null; // Backend doesn't support model listing
    }

    return await this.backend.listModels(options);
  }

  /**
   * Check if a specific model is available from the backend.
   *
   * @param modelId Model identifier to check
   * @returns true if model is available, false otherwise
   */
  async hasModel(modelId: string): Promise<boolean> {
    const result = await this.listModels();
    if (!result) {
      return true;
    } // Can't check, assume available

    return result.models.some((m) => m.id === modelId);
  }

  /**
   * Validate that a model is available (optional safety check).
   *
   * Note: This is an optional validation - the system doesn't automatically
   * validate models since cross-provider translation is supported.
   *
   * @param modelId Model identifier to validate
   * @throws {ValidationError} If model is not available
   */
  async validateModel(modelId: string): Promise<void> {
    const available = await this.hasModel(modelId);
    if (!available) {
      throw new ValidationError({
        code: ErrorCode.UNSUPPORTED_MODEL,
        message: `Model "${modelId}" is not available from backend "${this.backend.metadata.name}"`,
        validationDetails: [
          {
            field: 'model',
            value: modelId,
            reason: `Model not available from backend "${this.backend.metadata.name}"`,
            expected: 'Available model ID from backend',
          },
        ],
        provenance: {
          frontend: this.frontend.metadata.name,
          backend: this.backend.metadata.name,
        },
      });
    }
  }

  // ==========================================================================
  // Middleware Management
  // ==========================================================================

  /**
   * Add middleware to the bridge's middleware stack.
   *
   * The middleware runs on **both** `chat()` and `chatStream()`. On the
   * streaming path it is adapted: its request phase runs before the backend is
   * called (so request rewrites reach the backend), chunks pass straight
   * through, and its response phase runs once the stream has been consumed,
   * against a response assembled from the delivered chunks. Modifications it
   * makes to that response cannot be applied to a stream that has already been
   * delivered - use {@link useStreaming} for chunk-level control.
   *
   * Pass `{ name }` to say what this middleware is called when it fails - a
   * failure is reported as `Middleware "<name>" failed: ...`, which is the
   * only thing that says which of a chain of eight broke (#71). Without it
   * the name comes from the function's own `.name`, and failing that from its
   * registration position, `middleware[3]`.
   *
   * @param middleware Middleware to add
   * @param options Registration options; `name` identifies it in errors
   * @returns This bridge for chaining
   *
   * @example
   * ```typescript
   * // A factory's anonymous arrow has no name of its own - give it one.
   * bridge.use(createRetryMiddleware({ maxAttempts: 3 }), { name: 'retry' });
   * ```
   */
  use(middleware: Middleware, options?: MiddlewareRegistrationOptions): Bridge<TFrontend> {
    this.middlewareStack.use(middleware, options);
    return this;
  }

  /**
   * Add stream-native middleware to the bridge's middleware stack.
   *
   * Streaming middleware receives the `IRChatStream` from `next()` and may wrap
   * or transform it chunk by chunk. It runs on `chatStream()` only, interleaved
   * with `use()` middleware in registration order.
   *
   * Pass `{ name }` to say what this middleware is called when it fails; see
   * {@link use}.
   *
   * @param middleware Streaming middleware to add
   * @param options Registration options; `name` identifies it in errors
   * @returns This bridge for chaining
   *
   * @example
   * ```typescript
   * import { createStreamingCostTrackingMiddleware } from '@johnhenry/aimatey-middleware';
   *
   * bridge.useStreaming(createStreamingCostTrackingMiddleware({ logCosts: true }), {
   *   name: 'cost-tracking',
   * });
   * ```
   */
  useStreaming(
    middleware: StreamingMiddleware,
    options?: MiddlewareRegistrationOptions
  ): Bridge<TFrontend> {
    this.middlewareStack.useStreaming(middleware, options);
    return this;
  }

  /**
   * Remove middleware from the stack.
   *
   * @param middleware Middleware to remove
   * @returns This bridge for chaining
   */
  removeMiddleware(middleware: Middleware): Bridge<TFrontend> {
    this.middlewareStack.remove(middleware);
    return this;
  }

  /**
   * Remove stream-native middleware from the stack.
   *
   * @param middleware Streaming middleware to remove
   * @returns This bridge for chaining
   */
  removeStreamingMiddleware(middleware: StreamingMiddleware): Bridge<TFrontend> {
    this.middlewareStack.removeStreaming(middleware);
    return this;
  }

  /**
   * Clear all middleware from the stack (both standard and streaming).
   */
  clearMiddleware(): Bridge<TFrontend> {
    this.middlewareStack.clear();
    return this;
  }

  /**
   * Get all middleware registered through {@link use}, in order.
   *
   * These run on both the streaming and the non-streaming path.
   */
  getMiddleware(): readonly Middleware[] {
    return this.middlewareStack.getMiddleware();
  }

  /**
   * Get all stream-native middleware registered through {@link useStreaming},
   * in order.
   */
  getStreamingMiddleware(): readonly StreamingMiddleware[] {
    return this.middlewareStack.getStreamingMiddleware();
  }

  // ==========================================================================
  // Event Handling
  // ==========================================================================

  /**
   * Register an event listener.
   *
   * Six {@link BridgeEventType} values are emitted: `request:start`,
   * `request:success` and `request:error` from {@link chat}, and `stream:start`,
   * `stream:complete` and `stream:error` from {@link chatStream}. A `'*'` listener
   * receives all six.
   *
   * The remaining values are declared on the type but nothing emits them, so a
   * listener registered for `request:cancelled`, `stream:chunk`, `backend:selected`,
   * `backend:failover` or `middleware:executed` never fires.
   *
   * `executeIR()` and `executeIRStream()` are deliberately silent, so a `runTools()`
   * loop reports as the one request the caller made rather than one event per turn.
   *
   * Listeners are called synchronously and a listener that throws is swallowed, so one
   * failing listener can neither fail the request nor stop the others from running.
   *
   * @param event Event type to listen for, or '*' for all events
   * @param listener Callback function
   */
  on(event: BridgeEventType | '*', listener: BridgeEventListener): Bridge<TFrontend> {
    const key = event as string;
    if (!this._eventListeners.has(key)) {
      this._eventListeners.set(key, new Set());
    }
    this._eventListeners.get(key)!.add(listener);
    return this;
  }

  /**
   * Remove an event listener.
   *
   * @param event Event type
   * @param listener Callback function to remove
   */
  off(event: BridgeEventType | '*', listener: BridgeEventListener): Bridge<TFrontend> {
    const key = event as string;
    const listeners = this._eventListeners.get(key);
    if (listeners) {
      listeners.delete(listener);
    }
    return this;
  }

  /**
   * Register a one-time event listener, removed after the first matching event.
   *
   * See {@link on} for which events are actually emitted.
   *
   * @param event Event type to listen for
   * @param listener Callback function
   */
  once(event: BridgeEventType, listener: BridgeEventListener): Bridge<TFrontend> {
    const wrappedListener: BridgeEventListener = (eventData) => {
      this.off(event, wrappedListener);
      return listener(eventData);
    };
    return this.on(event, wrappedListener);
  }

  // ==========================================================================
  // Statistics & Monitoring
  // ==========================================================================

  /**
   * Get runtime statistics for this bridge.
   *
   * `backendUsage` is keyed by the backend that actually served each request, so on a
   * router-backed bridge it breaks down across the registered backends rather than
   * collapsing onto the router. It counts successes only - a failed request is in
   * `failedRequests` and `errorBreakdown`, not here - and a backend that has served
   * nothing since the last reset has no key at all rather than a zero.
   *
   * Every other field is bridge-wide by definition: `successRate` and the latency
   * percentiles describe the bridge, and `errorBreakdown` is keyed by error code.
   *
   * @returns Bridge statistics including request counts, latencies, and error breakdown
   */
  getStats(): BridgeStats {
    const sortedLatencies = [...this._latencies].sort((a, b) => a - b);
    const len = sortedLatencies.length;

    const getPercentile = (p: number): number => {
      if (len === 0) {
        return 0;
      }
      const index = Math.ceil((p / 100) * len) - 1;
      return sortedLatencies[Math.max(0, Math.min(index, len - 1))] ?? 0;
    };

    const avgLatency = len > 0 ? sortedLatencies.reduce((a, b) => a + b, 0) / len : 0;

    return {
      totalRequests: this._totalRequests,
      successfulRequests: this._successfulRequests,
      failedRequests: this._failedRequests,
      successRate:
        this._totalRequests > 0 ? (this._successfulRequests / this._totalRequests) * 100 : 100,
      streamingRequests: this._streamingRequests,
      averageLatencyMs: Math.round(avgLatency),
      p50LatencyMs: getPercentile(50),
      p95LatencyMs: getPercentile(95),
      p99LatencyMs: getPercentile(99),
      backendUsage: { ...this._backendUsage },
      errorBreakdown: { ...this._errorCounts },
      sinceTimestamp: this._statsResetTimestamp,
    };
  }

  /**
   * Reset all statistics to zero.
   */
  resetStats(): void {
    this._totalRequests = 0;
    this._successfulRequests = 0;
    this._failedRequests = 0;
    this._streamingRequests = 0;
    this._latencies = [];
    this._errorCounts = {};
    this._backendUsage = {};
    this._statsResetTimestamp = Date.now();
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Get the router backing this bridge, or `null` when there is none.
   *
   * A bridge constructed over a {@link Router} hands it back here, so the router's
   * surface - `listBackends()`, `getBackendInfo()`, `setFallbackChain()`, the health
   * and circuit-breaker controls - stays reachable through the object you were given.
   * A bridge wired to a plain backend adapter returns `null`.
   *
   * The check is structural rather than an `instanceof`, so consumers do not pull the
   * Router implementation in at runtime just to ask the question.
   *
   * @example
   * ```typescript
   * const router = bridge.getRouter();
   * if (router) {
   *   console.log(router.listBackends());
   * }
   * ```
   */
  getRouter(): Router | null {
    const candidate = this.backend as BackendAdapter & Partial<Router>;
    return typeof candidate.has === 'function' && typeof candidate.listBackends === 'function'
      ? (candidate as unknown as Router)
      : null;
  }

  /**
   * Check health of the backend.
   *
   * @returns true if backend is healthy, false otherwise
   */
  async checkHealth(): Promise<boolean> {
    if (this.backend.healthCheck) {
      return await this.backend.healthCheck();
    }
    return true; // Assume healthy if no health check is available
  }

  /**
   * Get a copy of the bridge configuration.
   *
   * @returns Readonly copy of the bridge configuration
   */
  getConfig(): Readonly<BridgeConfig> {
    return { ...this.config };
  }

  /**
   * Clone bridge with new configuration.
   */
  clone(config: Partial<BridgeConfig>): Bridge<TFrontend> {
    return new Bridge(this.frontend, this.backend, {
      ...this.config,
      ...config,
    });
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    // Cleanup logic if needed
  }

  /**
   * Execute an IR request directly (no frontend conversion).
   *
   * Runs the same enrich → validate → middleware → backend → enrich-response
   * pipeline as `chat()`, but takes and returns IR. Useful for agentic
   * loops (`runTools`) and programmatic callers that already speak IR.
   * Single-attempt: layer retry middleware for retries.
   *
   * Does not participate in bridge statistics or the event stream: `getStats()`
   * and the `REQUEST_*` events count `chat()` calls only, so a `runTools()` loop
   * reports as the one request the caller made rather than one per turn.
   */
  async executeIR(request: IRChatRequest, options?: RequestOptions): Promise<IRChatResponse> {
    if (!supportsChat(this.backend)) {
      throw new AdapterError({
        code: ErrorCode.UNSUPPORTED_FEATURE,
        message: `Backend '${this.backend.metadata.name}' does not support chat`,
        isRetryable: false,
        provenance: { backend: this.backend.metadata.name },
      });
    }

    const enrichedRequest = this.enrichRequest(request, options);

    validateIRChatRequest(enrichedRequest, {
      frontend: this.frontend.metadata.name,
    });

    const context = createMiddlewareContext(
      enrichedRequest,
      this.config as Record<string, unknown>,
      options?.signal,
      this.backend
    );

    const irResponse = await this.middlewareStack.execute(context, async () => {
      // Non-null: chat() and executeIR() both check `backend.execute` exists
      // before reaching this closure -- TS narrowing doesn't survive the
      // closure boundary, so this asserts what the earlier guard verified.
      const response = await this.backend.execute!(context.request, options?.signal);
      this.narrowContextBackend(context, response.metadata.provenance?.backend);
      return response;
    });

    return this.enrichResponse(irResponse, enrichedRequest);
  }

  /**
   * Execute a streaming IR request directly (no frontend conversion).
   *
   * Streaming counterpart to `executeIR()`: runs the same
   * enrich → validate → middleware → backend pipeline as `chatStream()`,
   * but takes and yields IR stream chunks directly instead of converting to
   * frontend-native ones. Used by `streamObject()` so structured-output
   * streaming works with any backend/frontend combination, not just
   * Anthropic's wire format.
   *
   * Like {@link executeIR}, it stays outside bridge statistics and the event stream.
   */
  async *executeIRStream(request: IRChatRequest, options?: RequestOptions): IRChatStream {
    if (!supportsChatStream(this.backend)) {
      throw new AdapterError({
        code: ErrorCode.UNSUPPORTED_FEATURE,
        message: `Backend '${this.backend.metadata.name}' does not support streaming chat`,
        isRetryable: false,
        provenance: { backend: this.backend.metadata.name },
      });
    }

    const streamingRequest: IRChatRequest = { ...request, stream: true };
    const enrichedRequest = this.enrichRequest(streamingRequest, options);

    validateIRChatRequest(enrichedRequest, {
      frontend: this.frontend.metadata.name,
    });

    const context = createStreamingMiddlewareContext(
      enrichedRequest,
      this.config as Record<string, unknown>,
      options?.signal,
      this.backend
    );

    const irStream = await this.middlewareStack.executeStream(context, () =>
      Promise.resolve(
        this.trackContextBackend(
          // Non-null: the guard above already verified this exists.
          this.backend.executeStream!(context.request, options?.signal),
          context
        )
      )
    );

    for await (const chunk of this.enrichStream(irStream)) {
      if (options?.signal?.aborted) {
        break;
      }
      yield chunk;
    }
  }

  // ==========================================================================
  // Embeddings
  // ==========================================================================

  /**
   * Register embedding middleware (runs outermost-first).
   */
  useEmbed(middleware: EmbedMiddleware): this {
    this.embedMiddleware.push(middleware);
    return this;
  }

  /**
   * Generate embeddings for one input or a batch.
   *
   * Builds the IR request directly (embedding input is universal, so no
   * frontend adapter is involved), chunks batches to the backend's limit,
   * and normalizes vector dimensions client-side when requested but not
   * natively supported — attaching a `parameter-normalized` warning.
   *
   * @throws AdapterError UNSUPPORTED_FEATURE when the backend lacks embed()
   */
  async embed(
    input: string | readonly string[],
    options: EmbedOptions = {}
  ): Promise<IREmbedResponse> {
    const backend = this.backend;
    if (!supportsEmbeddings(backend)) {
      throw new AdapterError({
        code: ErrorCode.UNSUPPORTED_FEATURE,
        message: `Backend '${backend.metadata.name}' does not support embeddings`,
        isRetryable: false,
        provenance: { backend: backend.metadata.name },
      });
    }

    const capabilities = backend.metadata.capabilities;
    const nativeDimensions =
      options.dimensions !== undefined && capabilities.supportsEmbeddingDimensions === true;

    if (
      options.dimensions !== undefined &&
      !nativeDimensions &&
      options.dimensionStrategy === 'native-only'
    ) {
      throw new AdapterError({
        code: ErrorCode.UNSUPPORTED_FEATURE,
        message: `Backend '${backend.metadata.name}' does not support native embedding dimensions`,
        isRetryable: false,
        provenance: { backend: backend.metadata.name },
      });
    }

    const request: IREmbedRequest = {
      input,
      parameters: {
        model: options.model,
        // Only pass dimensions through when natively supported
        ...(nativeDimensions && { dimensions: options.dimensions }),
        inputType: options.inputType,
        custom: options.custom,
      },
      metadata: {
        requestId: this.generateRequestId(),
        timestamp: Date.now(),
        provenance: { frontend: this.frontend.metadata.name },
        principal: options.principal,
        custom: options.metadata,
      },
    };

    // Compose the embed middleware chain around the core executor
    const execute = (finalRequest: IREmbedRequest): Promise<IREmbedResponse> =>
      this.executeEmbed(backend, finalRequest, options);

    const chain = this.embedMiddleware.reduceRight<
      (request: IREmbedRequest) => Promise<IREmbedResponse>
    >((next, middleware) => (req) => middleware(req, next), execute);

    return chain(request);
  }

  /**
   * Execute an embedding request with batch chunking and dimension
   * normalization.
   */
  private async executeEmbed(
    backend: BackendAdapter & Required<Pick<BackendAdapter, 'embed'>>,
    request: IREmbedRequest,
    options: EmbedOptions
  ): Promise<IREmbedResponse> {
    const inputs = typeof request.input === 'string' ? [request.input] : [...request.input];
    const maxBatchSize =
      options.maxBatchSize ?? backend.metadata.capabilities.maxEmbeddingBatchSize ?? inputs.length;

    let response: IREmbedResponse;

    if (inputs.length <= maxBatchSize) {
      response = await backend.embed(request, options.signal);
    } else {
      // Sequential batch execution (rate-limit friendly), merged in order
      const batches = chunkEmbedInputs(inputs, { maxBatchSize });
      const merged: { index: number; vector: readonly number[] }[] = [];
      let promptTokens = 0;
      let totalTokens = 0;
      let hasUsage = false;
      let model = '';
      let dimensions = 0;
      let lastMetadata = request.metadata;
      let offset = 0;

      for (const batch of batches) {
        const batchResponse = await backend.embed({ ...request, input: batch }, options.signal);
        for (const embedding of batchResponse.embeddings) {
          merged.push({ index: offset + embedding.index, vector: embedding.vector });
        }
        if (batchResponse.usage) {
          hasUsage = true;
          promptTokens += batchResponse.usage.promptTokens;
          totalTokens += batchResponse.usage.totalTokens;
        }
        model = batchResponse.model;
        dimensions = batchResponse.dimensions;
        lastMetadata = batchResponse.metadata;
        offset += batch.length;
      }

      response = {
        embeddings: merged.sort((a, b) => a.index - b.index),
        model,
        dimensions,
        usage: hasUsage ? { promptTokens, totalTokens } : undefined,
        metadata: lastMetadata,
      };
    }

    // Client-side dimension normalization when not handled natively
    const wantsDimensions = options.dimensions;
    if (
      wantsDimensions !== undefined &&
      response.dimensions !== wantsDimensions &&
      backend.metadata.capabilities.supportsEmbeddingDimensions !== true
    ) {
      const strategy = options.dimensionStrategy === 'pad' ? 'pad' : 'truncate';
      const warning = createWarning(
        'parameter-normalized',
        `Embedding dimensions normalized from ${response.dimensions} to ${wantsDimensions} via '${strategy}' (provider has no native dimensions support)`,
        {
          field: 'dimensions',
          originalValue: response.dimensions,
          transformedValue: wantsDimensions,
          source: this.backend.metadata.name,
        }
      );

      response = {
        ...response,
        embeddings: response.embeddings.map((embedding) => ({
          index: embedding.index,
          vector: normalizeDimensions(embedding.vector, wantsDimensions, strategy),
        })),
        dimensions: wantsDimensions,
        metadata: {
          ...response.metadata,
          warnings: [...(response.metadata.warnings ?? []), warning],
        },
      };
    }

    return response;
  }

  // ==========================================================================
  // Decisions
  // ==========================================================================

  /**
   * Register decision middleware (runs outermost-first).
   */
  useDecision(middleware: DecisionMiddleware): this {
    this.decisionMiddleware.push(middleware);
    return this;
  }

  /**
   * Answer typed questions about a state in a single call.
   *
   * Builds the IR request directly — like `embed()`, no frontend adapter
   * is involved, since a decision request has no chat-shaped equivalent
   * to translate from. Unlike `embed()`, the backend need not support
   * chat at all: `decide()` only requires `capabilities.decisions` and a
   * `decide()` method.
   *
   * @throws AdapterError UNSUPPORTED_FEATURE when the backend lacks decide()
   */
  async decide(
    state: unknown,
    questions: IRDecisionRequest['questions'],
    options: DecisionOptions = {}
  ): Promise<IRDecisionResponse> {
    const backend = this.backend;
    if (!supportsDecisions(backend)) {
      throw new AdapterError({
        code: ErrorCode.UNSUPPORTED_FEATURE,
        message: `Backend '${backend.metadata.name}' does not support typed decisions`,
        isRetryable: false,
        provenance: { backend: backend.metadata.name },
      });
    }

    const request: IRDecisionRequest = {
      state,
      questions,
      parameters: {
        model: options.model,
        custom: options.custom,
      },
      metadata: {
        requestId: this.generateRequestId(),
        timestamp: Date.now(),
        provenance: { frontend: this.frontend.metadata.name },
        principal: options.principal,
        custom: options.metadata,
      },
    };

    const execute = (finalRequest: IRDecisionRequest): Promise<IRDecisionResponse> =>
      backend.decide(finalRequest, options.signal).then((response) => ({
        ...response,
        metadata: {
          ...response.metadata,
          provenance: { ...response.metadata.provenance, backend: backend.metadata.name },
        },
      }));

    const chain = this.decisionMiddleware.reduceRight<
      (request: IRDecisionRequest) => Promise<IRDecisionResponse>
    >((next, middleware) => (req) => middleware(req, next), execute);

    return chain(request);
  }

  // ==========================================================================
  // Private Helper Methods
  // ==========================================================================

  /**
   * Enrich request with metadata (requestId, timestamp, provenance) and apply defaults.
   */
  private enrichRequest(request: IRChatRequest, options?: RequestOptions): IRChatRequest {
    // Always generate requestId if missing (frontend adapters should provide it)
    const requestId = request.metadata?.requestId || this.generateRequestId();

    const timestamp = request.metadata?.timestamp ?? Date.now();

    // Apply default model if not specified in request
    const model = request.parameters?.model ?? this.config.defaultModel;

    // Reject an override naming a backend the router has never heard of, before any
    // work is done - otherwise a typo is silently served by a different provider.
    if (options?.backend) {
      this.assertBackendRegistered(options.backend);
    }

    return {
      ...request,
      parameters: {
        ...request.parameters,
        ...(model && { model }),
      },
      metadata: {
        ...request.metadata,
        requestId,
        timestamp,
        provenance: {
          ...request.metadata?.provenance,
          frontend: this.frontend.metadata.name,
        },
        // Caller identity. The typed option wins over whatever the frontend
        // adapter put on the request, so the server that knows who is calling
        // has the last word; middleware that scopes shared state (caching)
        // reads it from here.
        ...(options?.principal !== undefined && { principal: options.principal }),
        custom: {
          ...request.metadata?.custom,
          ...options?.metadata,
          // `metadata.custom.backend` is the channel Router reads its explicit routing
          // decision from, so `options.backend` has to land there to have any effect.
          // Applied last: the typed, first-class option is authoritative over both an
          // inherited `metadata.custom.backend` and an untyped `options.metadata.backend`.
          ...(options?.backend && { backend: options.backend }),
        },
      },
    };
  }

  /**
   * Reject a per-request `backend` override naming a backend that is not registered.
   *
   * Only *unregistered* names are rejected. A backend that is registered but currently
   * unhealthy or circuit-open is left alone: the router's fallback machinery exists
   * precisely for that case, and throwing here would defeat it.
   *
   * When the bridge's backend is a single adapter rather than a router there is no
   * routing to override, so the option stays inert rather than throwing.
   *
   * @throws AdapterError ROUTING_FAILED when the name is not a registered backend
   */
  private assertBackendRegistered(name: string): void {
    const router = this.getRouter();
    if (!router || router.has(name)) {
      return;
    }

    const registered = router.listBackends();
    throw new AdapterError({
      code: ErrorCode.ROUTING_FAILED,
      message:
        `Requested backend '${name}' is not registered. ` +
        `Registered backends: ${registered.length > 0 ? registered.join(', ') : '(none)'}`,
      isRetryable: false,
      provenance: { frontend: this.frontend.metadata.name },
      details: { requestedBackend: name, registeredBackends: [...registered] },
    });
  }

  /**
   * Narrow `context.backend` from "what the bridge is about to call" to "what actually
   * served this request", once the routing decision has resolved (#64).
   *
   * The bridge seeds the context with its own backend before the chain runs, because a
   * middleware needs something to call for an extra turn from its very first line. For a
   * router-backed bridge that seed is the router - the provider is genuinely not chosen
   * yet, and a middleware executing through the router re-routes an extra turn the same
   * way the original request was routed. The specific provider only becomes knowable when
   * a response comes back and reports itself, so the field is narrowed then, which is
   * exactly what "available after routing decision" describes.
   *
   * Called from the bridge's innermost dispatch, so a middleware that calls `next()` more
   * than once sees the value for its most recent dispatch rather than a stale one.
   *
   * @param context Context handed to the middleware chain
   * @param backendName `provenance.backend` from the response, when the backend reported one
   */
  private narrowContextBackend(context: MiddlewareContext, backendName: string | undefined): void {
    if (!backendName || backendName === context.backendName) {
      return;
    }

    context.backendName = backendName;

    // Only a router can hand back the adapter behind the name. A plain adapter reporting
    // some other name keeps `backend` pointing at itself - it is still what ran.
    const selected = this.getRouter()?.get(backendName);
    if (selected) {
      context.backend = selected;
    }
  }

  /**
   * Streaming counterpart to {@link narrowContextBackend}.
   *
   * A stream is dispatched before it has produced anything, so the routing decision is
   * only visible once chunks start arriving. This passes the stream straight through and
   * narrows the context off the `start` chunk's provenance - early enough that the
   * response phase of every middleware, which runs once the stream is drained, sees the
   * backend that served it.
   */
  private async *trackContextBackend(
    stream: IRChatStream,
    context: MiddlewareContext
  ): IRChatStream {
    for await (const chunk of stream) {
      if (chunk.type === 'start') {
        this.narrowContextBackend(context, chunk.metadata?.provenance?.backend);
      }
      yield chunk;
    }
  }

  /**
   * Pass a stream through, reporting the backend named on its `start` chunk.
   *
   * `chat()` learns who served it from the enriched response; a stream has no single
   * response object, so the same answer is read off the `start` chunk - the chunk
   * backends carry response metadata on - once {@link enrichStream} has applied the
   * provenance rule to it.
   *
   * Distinct from {@link trackContextBackend}, which narrows the *middleware context*
   * off the raw pre-enrichment stream so middleware sees the value while the stream is
   * still running. This one runs after enrichment, for statistics only, and so is
   * deliberately not folded into {@link enrichStream}: that generator is shared with
   * `executeIRStream()`, which does not participate in bridge statistics.
   *
   * A stream with no `start` chunk, or a `start` chunk with no metadata for
   * {@link enrichStream} to stamp, reports `undefined` and the caller falls back to the
   * bridge's own backend name.
   *
   * @param stream Enriched IR stream to pass through
   * @param onBackend Called with `provenance.backend` from the start chunk
   */
  private async *captureStreamBackend(
    stream: IRChatStream,
    onBackend: (backendName: string | undefined) => void
  ): IRChatStream {
    for await (const chunk of stream) {
      if (chunk.type === 'start') {
        onBackend(chunk.metadata?.provenance?.backend);
      }
      yield chunk;
    }
  }

  /**
   * Account for a request that died before its execution pipeline ran.
   *
   * `_totalRequests` is incremented the moment a request arrives, but the work that
   * happens before the retry loop - `frontend.toIR()`, request enrichment, and the
   * registered-backend check enrichment performs - used to throw straight past the
   * failure accounting. `getStats()` then reported a request counted as sent, never
   * counted as failed, with no error event to explain it, so a caller watching
   * `successRate` saw it drift down for no visible reason (#60).
   *
   * This is accounting only. The caller re-throws the original error untouched, so
   * nothing about which error a caller sees changes.
   *
   * @param error Error that is about to be re-thrown
   * @param startTime When the request arrived, for `durationMs`
   * @param type `REQUEST_ERROR` on the non-streaming path, `STREAM_ERROR` on the streaming one
   * @param request The IR request, when conversion got far enough to produce one
   */
  private recordPreflightFailure(
    error: unknown,
    startTime: number,
    type: typeof BridgeEventType.REQUEST_ERROR | typeof BridgeEventType.STREAM_ERROR,
    request: IRChatRequest | undefined
  ): void {
    this._failedRequests++;
    const errorCode = error instanceof AdapterError ? error.code : 'UNKNOWN';
    this._errorCounts[errorCode] = (this._errorCounts[errorCode] ?? 0) + 1;

    // The event types require a request, but a `frontend.toIR()` that threw never
    // produced one. Report a stub carrying only what is known for certain rather than
    // dropping the event - a listener that learns nothing is the bug being fixed.
    const reported: IRChatRequest = request ?? {
      messages: [],
      metadata: {
        requestId: this.generateRequestId(),
        timestamp: startTime,
        provenance: { frontend: this.frontend.metadata.name },
      },
    };

    const details = {
      timestamp: Date.now(),
      requestId: reported.metadata.requestId,
      request: reported,
      error: error instanceof Error ? error : new Error(String(error)),
      durationMs: Date.now() - startTime,
    };

    const event: RequestEvent | StreamEvent =
      type === BridgeEventType.REQUEST_ERROR
        ? { type: BridgeEventType.REQUEST_ERROR, ...details }
        : { type: BridgeEventType.STREAM_ERROR, ...details };

    this.emit(event);
  }

  /**
   * Stamp bridge provenance without discarding what answered the request.
   *
   * `frontend` is authoritative - the bridge knows which frontend adapter it holds.
   * `backend` is not: when the configured backend is a {@link Router},
   * `this.backend.metadata.name` is the *router's* name, not the adapter that actually
   * served the request. So a `backend` already written further down the chain always
   * wins, and the bridge's own backend name is only the fallback for an adapter that
   * reported none.
   *
   * A router-backed bridge additionally records the router under `router` - the field
   * that exists for it - so the routing layer stays visible without overwriting the
   * backend that answered.
   *
   * The spread is what carries an `upstream` chain through (#110). When the backend that
   * answered was a proxy onto another aimatey instance, it reports its own name under
   * `backend` and nests the far side under `upstream`; the bridge stamps its own frontend
   * over the near hop and leaves the chain beneath it alone. The bridge cannot build that
   * chain itself - only the proxying adapter knows it forwarded - so its job here is to
   * not destroy one. See `withUpstreamProvenance` in `@johnhenry/aimatey-types`.
   */
  private resolveProvenance(provenance: IRProvenance | undefined): IRProvenance {
    const routerName = this.getRouter() ? this.backend.metadata.name : undefined;

    return {
      ...provenance,
      frontend: this.frontend.metadata.name,
      backend: provenance?.backend ?? this.backend.metadata.name,
      ...(routerName !== undefined && { router: provenance?.router ?? routerName }),
    };
  }

  /**
   * Enrich response with provenance and timing.
   */
  private enrichResponse(response: IRChatResponse, request: IRChatRequest): IRChatResponse {
    return {
      ...response,
      metadata: {
        ...response.metadata,
        requestId: request.metadata.requestId,
        provenance: this.resolveProvenance(response.metadata.provenance),
      },
    };
  }

  /**
   * Streaming counterpart to {@link enrichResponse}.
   *
   * A stream has no single response object to enrich, so the same provenance rule is
   * applied to the `start` chunk - the chunk backends carry response metadata on - and
   * every other chunk passes through untouched. Without this, `chatStream()` reported
   * whatever provenance the backend happened to volunteer while `chat()` always
   * reported some, so the two paths disagreed about the same request.
   *
   * `requestId` is deliberately left alone: backends set it on the start chunk to the
   * provider's own stream id (Anthropic's `msg_...`), which is more useful than
   * restating the bridge's.
   *
   * A start chunk carrying no metadata at all is passed through untouched rather than
   * given a fabricated one - `IRMetadata` requires a request id and timestamp the bridge
   * would have to invent.
   */
  private async *enrichStream(stream: IRChatStream): IRChatStream {
    for await (const chunk of stream) {
      if (chunk.type === 'start' && chunk.metadata) {
        yield {
          ...chunk,
          metadata: {
            ...chunk.metadata,
            provenance: this.resolveProvenance(chunk.metadata.provenance),
          },
        };
      } else {
        yield chunk;
      }
    }
  }

  /**
   * Generate unique request ID.
   */
  private generateRequestId(): string {
    // Use standard UUID v4 for request IDs
    return crypto.randomUUID();
  }

  /**
   * Generate a structured object matching a Zod schema using an LLM.
   *
   * This method uses tool calling to extract structured data from the LLM response,
   * validates it against the provided schema, and returns the typed object.
   *
   * @param options Configuration for object generation
   * @returns Promise resolving to the generated and validated object
   *
   * @example
   * ```typescript
   * const UserSchema = z.object({
   *   name: z.string(),
   *   age: z.number(),
   *   email: z.string().email(),
   * });
   *
   * const result = await bridge.generateObject({
   *   schema: UserSchema,
   *   prompt: 'Generate a user profile for Alice, age 30',
   *   model: 'gpt-4',
   * });
   *
   * console.log(result.object); // { name: 'Alice', age: 30, email: '...' }
   * ```
   */
  generateObject = createGenerateObject(this);

  /**
   * Run an agentic tool-execution loop: the model calls tools, their
   * handlers run (in parallel by default), results feed back, and the loop
   * continues until the model answers or maxIterations is reached.
   *
   * @example
   * ```typescript
   * const result = await bridge.runTools({
   *   prompt: 'What is the weather in SF?',
   *   tools: {
   *     get_weather: {
   *       description: 'Get current weather for a city',
   *       parameters: {
   *         type: 'object',
   *         properties: { city: { type: 'string' } },
   *         required: ['city'],
   *       },
   *       execute: async ({ city }) => fetchWeather(city),
   *     },
   *   },
   * });
   * console.log(result.text);
   * ```
   */
  runTools = createRunTools(this);

  /**
   * Stream a structured object matching a Zod schema using an LLM.
   *
   * This method uses streaming tool calling to incrementally build up a structured
   * object, yielding partial results as they become available.
   *
   * @param options Configuration for streaming object generation
   * @returns Async generator yielding partial objects and returning the final validated object
   *
   * @example
   * ```typescript
   * const ArticleSchema = z.object({
   *   title: z.string(),
   *   content: z.string(),
   *   tags: z.array(z.string()),
   * });
   *
   * const stream = bridge.streamObject({
   *   schema: ArticleSchema,
   *   prompt: 'Write a blog post about TypeScript',
   *   onPartial: (partial) => {
   *     console.log('Partial:', partial);
   *   },
   * });
   *
   * for await (const partial of stream) {
   *   console.log('Progress:', partial);
   * }
   * ```
   */
  streamObject = createStreamObject(this);

  /**
   * Emit an event to all registered listeners.
   *
   * @param event Event data to emit
   */
  private emit(event: BridgeEventData): void {
    // Emit to specific event type listeners
    const specificListeners = this._eventListeners.get(event.type);
    if (specificListeners) {
      for (const listener of specificListeners) {
        try {
          void listener(event);
        } catch {
          // Ignore listener errors to prevent breaking the chain
        }
      }
    }

    // Emit to wildcard listeners
    const wildcardListeners = this._eventListeners.get('*');
    if (wildcardListeners) {
      for (const listener of wildcardListeners) {
        try {
          void listener(event);
        } catch {
          // Ignore listener errors to prevent breaking the chain
        }
      }
    }
  }

  /**
   * Credit one success to the backend that served it.
   *
   * The name comes from the response's resolved `provenance.backend`, which #57 made
   * report the backend that actually answered rather than the bridge's wrapper. The
   * fallback covers an adapter that reports no provenance at all, and reproduces what
   * a single-backend bridge has always reported.
   *
   * Successes only, matching the field's name and its previous semantics: a failed
   * request is accounted for in `failedRequests` and `errorBreakdown`.
   *
   * @param backendName `provenance.backend` from the response, when one was reported
   */
  private recordBackendUsage(backendName: string | undefined): void {
    const name = backendName ?? this.backend.metadata.name;
    this._backendUsage[name] = (this._backendUsage[name] ?? 0) + 1;
  }

  /**
   * Record a latency sample, maintaining a rolling window to prevent unbounded memory growth.
   *
   * @param latencyMs Latency in milliseconds
   */
  private recordLatency(latencyMs: number): void {
    this._latencies.push(latencyMs);
    // Maintain rolling window to prevent memory leak in long-running applications
    if (this._latencies.length > Bridge.MAX_LATENCY_SAMPLES) {
      this._latencies.shift();
    }
  }

  /**
   * Delay execution for a specified number of milliseconds.
   *
   * @param ms Milliseconds to delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a new Bridge instance.
 *
 * @param frontend Frontend adapter
 * @param backend Backend adapter
 * @param config Bridge configuration
 * @returns Bridge instance
 */
export function createBridge<TFrontend extends FrontendAdapter>(
  frontend: TFrontend,
  backend: BackendAdapter,
  config?: Partial<BridgeConfig>
): Bridge<TFrontend> {
  return new Bridge(frontend, backend, config);
}
