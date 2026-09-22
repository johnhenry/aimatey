/**
 * Router Implementation
 *
 * The Router manages multiple backend adapters with intelligent routing,
 * fallback strategies, circuit breaker pattern, and health checking.
 * It implements the BackendAdapter interface so it can be used as a backend.
 *
 * @module
 */

import type { BackendAdapter, AdapterMetadata } from '@johnhenry/aimatey-types';
import type {
  IRChatRequest,
  IRChatResponse,
  IRChatStream,
  IRStreamChunk,
  StreamChunkType,
  StreamErrorChunk,
} from '@johnhenry/aimatey-types';
import type {
  Router as IRouter,
  RouterConfig,
  BackendInfo,
  BackendStats,
  RouterStats,
  RoutingContext,
  ModelMapping,
  ModelPatternMapping,
  ParallelDispatchOptions,
  ParallelDispatchResult,
} from '@johnhenry/aimatey-types';
import { AdapterError, ErrorCode, RouterError } from '@johnhenry/aimatey-errors';
import {
  createWarning,
  supportsEmbeddings,
  supportsChat,
  supportsChatStream,
} from '@johnhenry/aimatey-utils';
import type { IREmbedRequest, IREmbedResponse } from '@johnhenry/aimatey-types';
import type { TranslationResult } from './model-translation.js';
import type { AIModel } from '@johnhenry/aimatey-types';
import type { CapabilityRequirements, BackendModel } from './capability-matcher.js';
import { findBestModel } from './capability-matcher.js';
import { inferCapabilities } from './capability-inference.js';

// ============================================================================
// Internal Types
// ============================================================================

/**
 * Internal backend state tracking.
 */
interface BackendState {
  adapter: BackendAdapter;
  isHealthy: boolean;
  lastHealthCheck?: number;
  circuitBreakerState: 'closed' | 'open' | 'half-open';
  consecutiveFailures: number;
  circuitOpenedAt?: number;
  /**
   * Handle of the pending open -> half-open transition scheduled by
   * {@link Router.openCircuitBreaker}, held so the transition can be
   * cancelled.
   *
   * A breaker that stops being open -- closed by hand, reset, replaced,
   * unregistered, or opened again with a fresh rest period -- must not leave
   * an earlier timer armed. An armed timer from a previous open fires against
   * whatever the breaker looks like when it arrives, which cuts a later rest
   * period short, and it keeps this state object (and the adapter it names)
   * reachable after the backend has left the router.
   */
  circuitTimer?: ReturnType<typeof setTimeout>;
  latencies: number[];
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalCost: number;
}

/**
 * Mutable view of RouterConfig.
 *
 * `RouterConfig`'s fields are `readonly` for consumers, but the router owns
 * its config object and must be able to walk back a setting that has become
 * invalid — currently `defaultBackend`, when the backend it names is
 * unregistered. The router keeps a single config object and exposes it as
 * the readonly `config` property, so `config` (and `metadata.config`, which
 * is the same object) always reflects the live configuration.
 */
type MutableRouterConfig = {
  -readonly [K in keyof RouterConfig]: RouterConfig[K];
};

/**
 * Chunk types that carry model output, or end the stream, and therefore
 * commit the router to the backend that produced them.
 *
 * Everything else -- `start`, `metadata` -- is preamble that a consumer
 * cannot render, so it can be held back for as long as failing the stream
 * over to another backend is still possible.
 */
const COMMITTING_CHUNK_TYPES: ReadonlySet<StreamChunkType> = new Set<StreamChunkType>([
  'content',
  'tool_use',
  'done',
  'error',
]);

/**
 * Upper bound on preamble chunks held back while streaming fallback is still
 * possible.
 *
 * A backend that emits more than this before its first token is malformed;
 * rather than buffer without bound, the router flushes what it has, gives up
 * the option to fail over, and streams straight through.
 */
const MAX_HELD_STREAM_CHUNKS = 32;

// ============================================================================
// Router Implementation
// ============================================================================

/**
 * Router manages multiple backend adapters with intelligent routing.
 */
export class Router implements IRouter {
  readonly metadata: AdapterMetadata;
  readonly config: RouterConfig;

  /** Same object as `config`, typed mutably for router-owned updates. */
  private readonly mutableConfig: MutableRouterConfig;

  private backends: Map<string, BackendState> = new Map();
  private modelMapping: Map<string, string> = new Map(); // model -> backend (for routing)
  private modelTranslationMapping: Map<string, string> = new Map(); // model -> model (for translation)
  private backendTranslationMappings: Map<string, Map<string, string>> = new Map(); // backend -> (model -> model)
  private modelPatterns: ModelPatternMapping[] = [];
  private fallbackChain: string[] = [];
  private roundRobinIndex = 0;
  private healthCheckInterval?: NodeJS.Timeout;

  // Stats
  private stats = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    totalFallbacks: 0,
    parallelRequests: 0,
    sinceTimestamp: Date.now(),
  };

  constructor(config: Partial<RouterConfig> = {}) {
    this.mutableConfig = {
      routingStrategy: config.routingStrategy ?? 'explicit',
      fallbackStrategy: config.fallbackStrategy ?? 'sequential',
      defaultBackend: config.defaultBackend,
      healthCheckInterval: config.healthCheckInterval ?? 0,
      enableCircuitBreaker: config.enableCircuitBreaker ?? false,
      circuitBreakerThreshold: config.circuitBreakerThreshold ?? 5,
      circuitBreakerTimeout: config.circuitBreakerTimeout ?? 60000,
      trackLatency: config.trackLatency ?? true,
      trackCost: config.trackCost ?? false,
      capabilityBasedRouting: config.capabilityBasedRouting ?? false,
      optimization: config.optimization ?? 'balanced',
      optimizationWeights: config.optimizationWeights,
      capabilityCacheDuration: config.capabilityCacheDuration ?? 3600000, // 1 hour
      customRouter: config.customRouter,
      customFallback: config.customFallback,
      onWarning: config.onWarning,
      modelTranslation: config.modelTranslation ?? {
        strategy: 'hybrid',
        warnOnDefault: true,
        strictMode: false,
      },
    };
    this.config = this.mutableConfig;

    this.metadata = {
      name: 'router',
      version: '1.0.0',
      provider: 'Universal Router',
      capabilities: {
        streaming: true,
        multiModal: true,
        tools: true,
        systemMessageStrategy: 'in-messages',
        supportsMultipleSystemMessages: true,
      },
      config: this.config as Record<string, unknown>,
    };

    // Start health checking if enabled
    if (this.config.healthCheckInterval && this.config.healthCheckInterval > 0) {
      this.startHealthChecking();
    }
  }

  // ==========================================================================
  // Format Conversion (Not Applicable for Router)
  // ==========================================================================

  /**
   * Convert IR request to provider format.
   * Not applicable for Router - use the specific backend adapter instead.
   */
  fromIR(_request: IRChatRequest): unknown {
    throw new Error('fromIR() not applicable for Router - route to a specific backend first');
  }

  /**
   * Convert provider response to IR format.
   * Not applicable for Router - use the specific backend adapter instead.
   */
  toIR(_response: unknown, _originalRequest: IRChatRequest, _latencyMs: number): IRChatResponse {
    throw new Error('toIR() not applicable for Router - route to a specific backend first');
  }

  // ==========================================================================
  // Backend Management
  // ==========================================================================

  /**
   * Register a backend adapter under a name that is not yet in use.
   *
   * Registering is deliberately strict: a duplicate name is almost always a
   * double-initialization bug, not an intent to reconfigure. To swap the
   * adapter behind a name that already exists — the API-key-rotation case —
   * use {@link Router.replace}.
   */
  register(name: string, adapter: BackendAdapter): Router {
    if (this.backends.has(name)) {
      throw new AdapterError({
        code: ErrorCode.ROUTING_FAILED,
        message: `Backend '${name}' is already registered (use replace() to swap its adapter)`,
        isRetryable: false,
        provenance: { router: this.metadata.name },
      });
    }

    this.backends.set(name, {
      adapter,
      isHealthy: true,
      circuitBreakerState: 'closed',
      consecutiveFailures: 0,
      latencies: [],
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalCost: 0,
    });

    return this;
  }

  /**
   * Replace the adapter registered under an existing name.
   *
   * This is the supported way to change a backend's configuration in place —
   * a rotated API key, a new base URL, a different default model — without
   * removing it from the router. Everything that refers to the backend *by
   * name* keeps working untouched: registration order, the fallback chain,
   * model mappings, model patterns and backend-specific translation
   * mappings. (An unregister/register round trip loses all of that, which is
   * why it is not a substitute.)
   *
   * State handling is split deliberately:
   *
   * - **Carried over** — `totalRequests`, `successfulRequests`,
   *   `failedRequests`, `latencies`, `totalCost`. These are a cumulative
   *   accounting record of the traffic this router sent to this logical
   *   backend. `totalCost` in particular is money already spent; zeroing it
   *   on a credential change would silently corrupt spend tracking.
   * - **Reset** — `isHealthy`, `circuitBreakerState`, `consecutiveFailures`,
   *   `circuitOpenedAt`, `lastHealthCheck`. These are a live judgement about
   *   a configuration that no longer exists, and are stale by construction
   *   the moment it is replaced. Keeping them would defeat the motivating
   *   use case: an expired key produces auth failures, the failures trip the
   *   breaker, and a breaker left open would keep refusing the *new*,
   *   working key until `circuitBreakerTimeout` elapsed — or, if this is the
   *   only backend, fail every request outright.
   *
   * Callers who want a genuinely fresh slate can follow this with
   * {@link Router.resetStats}.
   *
   * @throws AdapterError ROUTING_FAILED if `name` is not registered.
   */
  replace(name: string, adapter: BackendAdapter): Router {
    const state = this.backends.get(name);
    if (!state) {
      throw new AdapterError({
        code: ErrorCode.ROUTING_FAILED,
        message: `Backend '${name}' is not registered (use register() to add it)`,
        isRetryable: false,
        provenance: { router: this.metadata.name },
      });
    }

    // Swap the adapter, keeping the accounting counters on the same state
    // object so registration order and cumulative stats survive.
    state.adapter = adapter;

    // The health/circuit-breaker verdict described the old configuration --
    // including any half-open transition still pending from it, which would
    // otherwise fire against the replacement's own breaker.
    this.clearCircuitTimer(state);
    state.isHealthy = true;
    state.circuitBreakerState = 'closed';
    state.consecutiveFailures = 0;
    state.circuitOpenedAt = undefined;
    state.lastHealthCheck = undefined;

    return this;
  }

  /**
   * Unregister a backend adapter, together with every routing rule that
   * refers to it.
   *
   * Removing a backend is always allowed, including the last one: a router
   * with no backends is a valid transient state — it is also the state of a
   * freshly constructed `new Router()` — and it surfaces as a routing error
   * on the next request, which is the right error at the right time. An app
   * whose only provider was just disconnected is in exactly that state.
   *
   * If the removed backend was `config.defaultBackend`, that setting is
   * cleared (it can no longer be honoured) and a `routing-config-changed`
   * warning is emitted through {@link RouterConfig.onWarning} so the change
   * is not silent.
   *
   * @throws AdapterError ROUTING_FAILED if `name` is not registered.
   */
  unregister(name: string): Router {
    const removed = this.backends.get(name);
    if (!removed) {
      throw new AdapterError({
        code: ErrorCode.ROUTING_FAILED,
        message: `Backend '${name}' is not registered`,
        isRetryable: false,
        provenance: { router: this.metadata.name },
      });
    }

    // A pending half-open transition belongs to a backend that no longer
    // exists. Cancelling it drops the router's last reference to the removed
    // state -- and to the adapter it names -- rather than holding both until
    // the timer expires.
    this.clearCircuitTimer(removed);

    this.backends.delete(name);

    // Drop routing rules that now point at a backend that no longer exists.
    // Every setter validates that the backends it names are registered, so
    // leaving these behind would break that invariant -- and a later
    // register() of a *different* adapter under the same name would silently
    // inherit the removed backend's routing rules and translation mappings.
    this.fallbackChain = this.fallbackChain.filter((backend) => backend !== name);
    this.modelPatterns = this.modelPatterns.filter((pattern) => pattern.backend !== name);
    this.backendTranslationMappings.delete(name);
    for (const [model, backend] of this.modelMapping.entries()) {
      if (backend === name) {
        this.modelMapping.delete(model);
      }
    }

    // The default backend can no longer be honoured -- clear it rather than
    // refusing to remove the backend.
    if (this.config.defaultBackend === name) {
      this.mutableConfig.defaultBackend = undefined;

      this.config.onWarning?.(
        createWarning(
          'routing-config-changed',
          `Backend '${name}' was unregistered while it was the router's defaultBackend; defaultBackend has been cleared`,
          {
            field: 'config.defaultBackend',
            originalValue: name,
            transformedValue: undefined,
            source: this.metadata.name,
          }
        )
      );
    }

    return this;
  }

  /**
   * Get a registered backend adapter.
   */
  get(name: string): BackendAdapter | undefined {
    return this.backends.get(name)?.adapter;
  }

  /**
   * Check if backend is registered.
   */
  has(name: string): boolean {
    return this.backends.has(name);
  }

  /**
   * List all registered backend names.
   */
  listBackends(): readonly string[] {
    return Array.from(this.backends.keys());
  }

  /**
   * Get information about all or specific backend.
   */
  getBackendInfo(): BackendInfo[];
  getBackendInfo(name: string): BackendInfo | undefined;
  getBackendInfo(name?: string): BackendInfo | BackendInfo[] | undefined {
    if (name !== undefined) {
      const state = this.backends.get(name);
      if (!state) {
        return undefined;
      }
      return this.createBackendInfo(name, state);
    }

    const infos: BackendInfo[] = [];
    for (const [backendName, state] of this.backends.entries()) {
      infos.push(this.createBackendInfo(backendName, state));
    }
    return infos;
  }

  // ==========================================================================
  // Routing Configuration
  // ==========================================================================

  /**
   * Set fallback chain for sequential failover.
   */
  setFallbackChain(chain: readonly string[]): Router {
    // Validate all backends exist
    for (const name of chain) {
      if (!this.backends.has(name)) {
        throw new AdapterError({
          code: ErrorCode.ROUTING_FAILED,
          message: `Backend '${name}' in fallback chain is not registered`,
          isRetryable: false,
          provenance: { router: this.metadata.name },
        });
      }
    }
    this.fallbackChain = [...chain];
    return this;
  }

  /**
   * Get current fallback chain.
   */
  getFallbackChain(): readonly string[] {
    return this.fallbackChain;
  }

  /**
   * Set model to backend mapping.
   */
  setModelMapping(mapping: ModelMapping): Router {
    this.modelMapping.clear();
    for (const [model, backend] of Object.entries(mapping)) {
      if (!this.backends.has(backend)) {
        throw new AdapterError({
          code: ErrorCode.ROUTING_FAILED,
          message: `Backend '${String(backend)}' in model mapping is not registered`,
          isRetryable: false,
          provenance: { router: this.metadata.name },
        });
      }
      this.modelMapping.set(model, backend);
    }
    return this;
  }

  /**
   * Get current model mapping.
   */
  getModelMapping(): ModelMapping {
    const mapping: ModelMapping = {};
    for (const [model, backend] of this.modelMapping.entries()) {
      mapping[model] = backend;
    }
    return mapping;
  }

  /**
   * Set model name translation mapping (for fallback scenarios).
   * Maps source model names to target model names.
   *
   * @example
   * ```typescript
   * router.setModelTranslationMapping({
   *   'gpt-4': 'claude-3-5-sonnet-20241022',
   *   'gpt-3.5-turbo': 'claude-3-5-haiku-20241022'
   * });
   * ```
   */
  setModelTranslationMapping(mapping: ModelMapping): Router {
    this.modelTranslationMapping.clear();
    for (const [sourceModel, targetModel] of Object.entries(mapping)) {
      this.modelTranslationMapping.set(sourceModel, targetModel);
    }
    return this;
  }

  /**
   * Get current model translation mapping.
   */
  getModelTranslationMapping(): ModelMapping {
    const mapping: ModelMapping = {};
    for (const [source, target] of this.modelTranslationMapping.entries()) {
      mapping[source] = target;
    }
    return mapping;
  }

  /**
   * Set backend-specific model translation mapping.
   * This takes priority over global model translation mapping.
   *
   * @example
   * ```typescript
   * router.setBackendTranslationMapping('anthropic', {
   *   'gpt-4': 'claude-3-5-sonnet-20241022',
   *   'gpt-3.5-turbo': 'claude-3-5-haiku-20241022'
   * });
   * ```
   */
  setBackendTranslationMapping(backendName: string, mapping: ModelMapping): Router {
    // Validate backend exists
    if (!this.backends.has(backendName)) {
      throw new AdapterError({
        code: ErrorCode.ROUTING_FAILED,
        message: `Backend '${backendName}' is not registered`,
        isRetryable: false,
        provenance: { router: this.metadata.name },
      });
    }

    // Create or get existing backend mapping
    let backendMapping = this.backendTranslationMappings.get(backendName);
    if (!backendMapping) {
      backendMapping = new Map();
      this.backendTranslationMappings.set(backendName, backendMapping);
    }

    // Clear and populate mapping
    backendMapping.clear();
    for (const [sourceModel, targetModel] of Object.entries(mapping)) {
      backendMapping.set(sourceModel, targetModel);
    }

    return this;
  }

  /**
   * Get backend-specific model translation mapping.
   */
  getBackendTranslationMapping(backendName: string): ModelMapping {
    const backendMapping = this.backendTranslationMappings.get(backendName);
    if (!backendMapping) {
      return {};
    }

    const mapping: ModelMapping = {};
    for (const [source, target] of backendMapping.entries()) {
      mapping[source] = target;
    }
    return mapping;
  }

  /**
   * Clear all model translation mappings.
   *
   * @returns This router for chaining
   */
  clearModelTranslationMapping(): Router {
    this.modelTranslationMapping.clear();
    return this;
  }

  /**
   * Clear backend-specific model translation mappings.
   *
   * @param backendName Optional backend name to clear. If not provided, clears all.
   * @returns This router for chaining
   */
  clearBackendTranslationMapping(backendName?: string): Router {
    if (backendName) {
      const backendMapping = this.backendTranslationMappings.get(backendName);
      if (backendMapping) {
        backendMapping.clear();
      }
    } else {
      for (const mapping of this.backendTranslationMappings.values()) {
        mapping.clear();
      }
    }
    return this;
  }

  /**
   * Set model pattern mappings.
   */
  setModelPatterns(patterns: readonly ModelPatternMapping[]): Router {
    // Validate all backends exist
    for (const pattern of patterns) {
      if (!this.backends.has(pattern.backend)) {
        throw new AdapterError({
          code: ErrorCode.ROUTING_FAILED,
          message: `Backend '${pattern.backend}' in model pattern is not registered`,
          isRetryable: false,
          provenance: { router: this.metadata.name },
        });
      }
    }
    this.modelPatterns = [...patterns];
    return this;
  }

  /**
   * Get current model patterns.
   */
  getModelPatterns(): readonly ModelPatternMapping[] {
    return this.modelPatterns;
  }

  // ==========================================================================
  // Routing Operations
  // ==========================================================================

  /**
   * Select backend for a request.
   */
  async selectBackend(request: IRChatRequest, preferredBackend?: string): Promise<string> {
    const context: RoutingContext = {
      stats: this.getStats(),
      metadata: request.metadata?.custom ?? {},
      preferredBackend,
    };

    // Try explicit preference first
    if (preferredBackend && this.isBackendAvailable(preferredBackend)) {
      return preferredBackend;
    }

    // Try capability-based routing if enabled
    if (this.config.capabilityBasedRouting) {
      const capabilityBackend = await this.selectBackendByCapabilities(request);
      if (capabilityBackend) {
        return capabilityBackend;
      }
    }

    // Apply routing strategy
    const strategy = this.config.routingStrategy ?? 'explicit';
    let selectedBackend: string | null = null;

    switch (strategy) {
      case 'explicit':
        selectedBackend = this.routeExplicit(preferredBackend);
        break;

      case 'model-based':
        selectedBackend = this.routeByModel(request);
        break;

      case 'cost-optimized':
        selectedBackend = this.routeByCost(request);
        break;

      case 'latency-optimized':
        selectedBackend = this.routeByLatency();
        break;

      case 'round-robin':
        selectedBackend = this.routeRoundRobin();
        break;

      case 'random':
        selectedBackend = this.routeRandom();
        break;

      case 'custom':
        if (this.config.customRouter) {
          selectedBackend = await this.config.customRouter(
            request,
            this.getAvailableBackends(),
            context
          );
        }
        break;
    }

    // Fallback to default backend
    if (!selectedBackend && this.config.defaultBackend) {
      selectedBackend = this.config.defaultBackend;
    }

    // A named preference that could not be honoured is a *substitution*, and
    // `fallbackStrategy: 'none'` ("fail immediately") is the caller opting out
    // of exactly that. Before this guard, an open circuit made the named
    // backend fail `isBackendAvailable()`, `routeExplicit()` returned null,
    // and the final-fallback branch below served the request from whichever
    // backend happened to be registered first -- silently, successfully, and
    // with no signal that the destination had changed (#134).
    //
    // The guard is deliberately limited to a named preference. When the caller
    // named nothing there is no substitution to refuse: the branch below is
    // simply how a router without a `defaultBackend` resolves at all, and
    // suppressing it there would leave a single-backend `'none'` router unable
    // to route anything.
    const refusesSubstitution =
      this.config.fallbackStrategy === 'none' && preferredBackend !== undefined;

    // Final fallback: first available backend
    if (!selectedBackend && !refusesSubstitution) {
      const available = this.getAvailableBackends();
      selectedBackend = available[0] ?? null;
    }

    if (!selectedBackend) {
      throw new AdapterError({
        code: ErrorCode.NO_BACKEND_AVAILABLE,
        message: 'No available backend for routing',
        isRetryable: false,
        provenance: { router: this.metadata.name },
      });
    }

    return selectedBackend;
  }

  /**
   * Execute request with automatic backend selection and fallback.
   */
  async execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse> {
    this.stats.totalRequests++;

    const preferredBackend = request.metadata?.custom?.backend as string | undefined;
    const attemptedBackends: string[] = [];

    try {
      // Select primary backend
      const primaryBackend = await this.selectBackend(request, preferredBackend);
      attemptedBackends.push(primaryBackend);

      // Translate model for this backend (attaches substitution warnings)
      const translatedRequest = this.applyModelTranslation(request, primaryBackend);

      // Try primary backend
      const response = await this.executeOnBackend(primaryBackend, translatedRequest, signal);
      this.stats.successfulRequests++;
      return response;
    } catch (primaryError) {
      // Handle fallback
      if (this.config.fallbackStrategy === 'none') {
        this.stats.failedRequests++;
        throw primaryError;
      }

      try {
        const response = await this.executeFallback(
          request,
          attemptedBackends,
          primaryError as AdapterError,
          signal
        );
        this.stats.successfulRequests++;
        this.stats.totalFallbacks++;
        return response;
      } catch (fallbackError) {
        this.stats.failedRequests++;
        throw fallbackError;
      }
    }
  }

  /**
   * Execute streaming request with automatic backend selection and fallback.
   *
   * ## Fallback is bounded by what the consumer has already seen
   *
   * Once model output has reached the consumer, no other backend can take
   * over: restarting would duplicate or contradict text the user is already
   * reading. From that point a failure surfaces as an `error` chunk, exactly
   * as it did before this method had fallback at all.
   *
   * *Before* that point nothing is observable, so failing over is both safe
   * and invisible. Chunks that carry no model output (`start`, `metadata`)
   * are therefore held back and flushed the instant the first committing
   * chunk -- `content`, `tool_use` or `done` -- arrives. The buffer never
   * waits on a timer or a chunk count, so it adds nothing to
   * time-to-first-token; it only defers chunks the consumer cannot render
   * anyway. A backend that dies mid-preamble is replaced without the caller
   * ever learning that it existed. See {@link MAX_HELD_STREAM_CHUNKS} for the
   * bound on that buffer.
   *
   * An `error` chunk that arrives before the stream has committed is treated
   * exactly like a thrown error: an in-band failure nobody has seen yet is
   * just as recoverable as an out-of-band one.
   *
   * ## Strategy
   *
   * Streaming fallback is always *sequential*, including under
   * `fallbackStrategy: 'parallel'`. Racing streams would start N generations
   * and abandon N-1 of them -- billable output for no latency gain, given
   * that a stream can only be moved before its first token anyway.
   * `'none'` disables fallback, and `'custom'` consults
   * {@link RouterConfig.customFallback}, both as they do for
   * {@link Router.execute}.
   *
   * An aborted request is never failed over: the caller asked to stop, not
   * for a different backend.
   */
  async *executeStream(request: IRChatRequest, signal?: AbortSignal): IRChatStream {
    this.stats.totalRequests++;

    const preferredBackend = request.metadata?.custom?.backend as string | undefined;
    const attemptedBackends: string[] = [];

    let lastError: unknown;
    /** A backend's own error chunk, preferred over a synthesized one. */
    let lastErrorChunk: StreamErrorChunk | undefined;
    let currentBackend: string | null;
    /**
     * Highest `sequence` handed to the consumer, so the terminal error chunk
     * continues this stream's numbering instead of restarting at 0 (#120).
     */
    let lastSequence = -1;

    try {
      currentBackend = await this.selectBackend(request, preferredBackend);
    } catch (selectionError) {
      // execute() falls back when selection itself fails, so this does too.
      lastError = selectionError;
      currentBackend = await this.nextStreamFallbackBackend(
        request,
        attemptedBackends,
        selectionError
      );
    }

    while (currentBackend !== null) {
      const backendName = currentBackend;
      attemptedBackends.push(backendName);

      /** Preamble chunks withheld while fallback is still possible. */
      const held: IRStreamChunk[] = [];
      /** True once anything has been yielded to the consumer. */
      let committed = false;
      /** This attempt's in-band error chunk, if it produced one. */
      let attemptErrorChunk: StreamErrorChunk | undefined;

      try {
        // Translate model for this backend (attaches substitution warnings)
        const translatedRequest = this.applyModelTranslation(request, backendName);
        const stream = this.executeStreamOnBackend(backendName, translatedRequest, signal);

        let aborted = false;

        for await (const chunk of stream) {
          // Check AbortSignal before yielding each chunk
          if (signal?.aborted) {
            aborted = true;
            break;
          }

          if (chunk.type === 'error' && !committed) {
            attemptErrorChunk = chunk;
            throw new AdapterError({
              code: ErrorCode.PROVIDER_ERROR,
              message: chunk.error.message,
              isRetryable: true,
              provenance: { router: this.metadata.name, backend: backendName },
            });
          }

          if (
            !committed &&
            !COMMITTING_CHUNK_TYPES.has(chunk.type) &&
            held.length < MAX_HELD_STREAM_CHUNKS
          ) {
            held.push(chunk);
            continue;
          }

          if (!committed) {
            committed = true;
            for (const heldChunk of held) {
              lastSequence = Math.max(lastSequence, heldChunk.sequence);
              yield heldChunk;
            }
            held.length = 0;
          }

          lastSequence = Math.max(lastSequence, chunk.sequence);
          yield chunk;
        }

        // A stream that produced nothing but preamble still owes the
        // consumer that preamble.
        if (!aborted) {
          for (const heldChunk of held) {
            lastSequence = Math.max(lastSequence, heldChunk.sequence);
            yield heldChunk;
          }
        }

        if (attemptedBackends.length > 1) {
          this.stats.totalFallbacks++;
        }
        this.stats.successfulRequests++;
        return;
      } catch (error) {
        lastError = error;
        lastErrorChunk = attemptErrorChunk;

        // A committed stream cannot be moved, and a cancelled request is not
        // a backend failure. Neither may be failed over.
        if (committed || signal?.aborted) {
          break;
        }

        currentBackend = await this.nextStreamFallbackBackend(request, attemptedBackends, error);
      }
    }

    this.stats.failedRequests++;
    // A backend's own error chunk is numbered against the stream *it* produced,
    // whose preamble this router may have withheld or replaced by failing over.
    // Renumber it onto the stream the consumer actually received, so the
    // terminal chunk is contiguous with what came before it (#120).
    yield {
      ...(lastErrorChunk ?? this.createStreamErrorChunk(lastError)),
      sequence: lastSequence + 1,
    };
  }

  /**
   * Dispatch request to multiple backends in parallel.
   */
  async dispatchParallel(
    request: IRChatRequest,
    options: ParallelDispatchOptions = {},
    signal?: AbortSignal
  ): Promise<ParallelDispatchResult> {
    this.stats.totalRequests++;
    this.stats.parallelRequests++;

    const {
      backends: targetBackends,
      strategy = 'first',
      timeout,
      cancelOnFirstSuccess = true,
    } = options;

    // Determine which backends to use
    const backendsToUse =
      targetBackends && targetBackends.length > 0
        ? targetBackends.filter((name) => this.isBackendAvailable(name))
        : this.getAvailableBackends();

    if (backendsToUse.length === 0) {
      throw new AdapterError({
        code: ErrorCode.NO_BACKEND_AVAILABLE,
        message: 'No available backends for parallel dispatch',
        isRetryable: false,
        provenance: { router: this.metadata.name },
      });
    }

    const startTime = Date.now();
    const abortController = new AbortController();
    const combinedSignal = signal
      ? this.combineSignals([signal, abortController.signal])
      : abortController.signal;

    // Create timeout if specified
    let timeoutId: NodeJS.Timeout | undefined;
    if (timeout) {
      timeoutId = setTimeout(() => abortController.abort(), timeout);
    }

    try {
      const promises = backendsToUse.map(async (backendName) => {
        const backendStartTime = Date.now();
        try {
          const response = await this.executeOnBackend(backendName, request, combinedSignal);
          return {
            backend: backendName,
            response,
            latencyMs: Date.now() - backendStartTime,
            success: true,
          };
        } catch (error) {
          return {
            backend: backendName,
            error: error instanceof AdapterError ? error : this.wrapError(error),
            success: false,
          };
        }
      });

      let results: Awaited<(typeof promises)[0]>[];

      if (strategy === 'first') {
        // Return the first *successful* response -- racing on settlement
        // (Promise.race) would abort the whole dispatch if the fastest
        // backend happened to fail, even though a slower backend might
        // still succeed.
        const { winner, settled } = await this.raceFirstSuccess(promises);
        if (cancelOnFirstSuccess && winner) {
          abortController.abort();
        }
        results = winner ? [winner] : settled;
      } else {
        // Wait for all responses
        results = await Promise.all(promises);
      }

      // Process results
      const successful = results.filter((r) => r.success);
      const failed = results
        .filter((r) => !r.success)
        .map((r) => ({
          backend: r.backend,
          error: r.error as AdapterError,
        }));

      if (successful.length === 0) {
        // Every leg failed, and each leg's error is right here - so the
        // composite reports what they actually were rather than asserting
        // retryable (#70). `RouterError` derives the classification.
        throw new RouterError({
          code: ErrorCode.ALL_BACKENDS_FAILED,
          message: `All parallel backends failed: ${failed.map((f) => f.backend).join(', ')}`,
          attemptedBackends: failed.map((f) => f.backend),
          backendErrors: failed.map((f) => f.error),
          provenance: { router: this.metadata.name },
        });
      }

      // 'fastest' picks the lowest-latency success; others take the first
      const primary =
        strategy === 'fastest'
          ? successful.reduce((best, candidate) =>
              (candidate.latencyMs ?? Infinity) < (best.latencyMs ?? Infinity) ? candidate : best
            )
          : successful[0];
      if (!primary?.response) {
        throw new AdapterError({
          code: ErrorCode.INTERNAL_ERROR,
          message: 'No successful response in parallel dispatch',
          isRetryable: false,
          provenance: { router: this.metadata.name },
        });
      }

      return {
        response: primary.response,
        allResponses:
          strategy === 'all'
            ? successful.map((s) => ({
                backend: s.backend,
                response: s.response!,
                latencyMs: s.latencyMs!,
              }))
            : undefined,
        successfulBackends: successful.map((s) => s.backend),
        failedBackends: failed,
        totalTimeMs: Date.now() - startTime,
      };
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  // ==========================================================================
  // Health & Circuit Breaking
  // ==========================================================================

  /**
   * Check health of all or specific backend.
   */
  async checkHealth(): Promise<Record<string, boolean>>;
  async checkHealth(name: string): Promise<boolean>;
  async checkHealth(name?: string): Promise<boolean | Record<string, boolean>> {
    if (name !== undefined) {
      const state = this.backends.get(name);
      if (!state) {
        return false;
      }

      try {
        const healthy = state.adapter.healthCheck ? await state.adapter.healthCheck() : true;
        state.isHealthy = healthy;
        state.lastHealthCheck = Date.now();
        return healthy;
      } catch {
        state.isHealthy = false;
        state.lastHealthCheck = Date.now();
        return false;
      }
    }

    // Check all backends
    const results: Record<string, boolean> = {};
    const promises = Array.from(this.backends.entries()).map(async ([backendName, state]) => {
      try {
        const healthy = state.adapter.healthCheck ? await state.adapter.healthCheck() : true;
        state.isHealthy = healthy;
        state.lastHealthCheck = Date.now();
        results[backendName] = healthy;
      } catch {
        state.isHealthy = false;
        state.lastHealthCheck = Date.now();
        results[backendName] = false;
      }
    });

    await Promise.all(promises);
    return results;
  }

  /**
   * Cancel a backend's pending open -> half-open transition, if one is armed.
   *
   * Called wherever a breaker stops being the open breaker that timer was
   * scheduled for: closed by hand, reset, replaced, unregistered, or opened
   * again with a fresh rest period.
   *
   * Leaving an old timer armed is not harmless. It carries no record of the
   * open it belongs to, so when it fires it half-opens whichever open the
   * breaker happens to be in -- ending a later rest period early and letting
   * a trial request through before the backend has had the time the caller
   * asked for. It also keeps this `BackendState`, and through it the adapter,
   * reachable after {@link Router.unregister} has dropped the backend.
   */
  private clearCircuitTimer(state: BackendState): void {
    if (state.circuitTimer !== undefined) {
      clearTimeout(state.circuitTimer);
      state.circuitTimer = undefined;
    }
  }

  /**
   * Manually open circuit breaker for a backend.
   *
   * Any transition still pending from an earlier open is cancelled first, so
   * the rest period this call starts is the one that is honoured.
   */
  openCircuitBreaker(name: string, timeoutMs?: number): void {
    const state = this.backends.get(name);
    if (!state) {
      throw new AdapterError({
        code: ErrorCode.ROUTING_FAILED,
        message: `Backend '${name}' not found`,
        isRetryable: false,
        provenance: { router: this.metadata.name },
      });
    }

    // A transition armed by an earlier open would fire against this one.
    this.clearCircuitTimer(state);

    state.circuitBreakerState = 'open';
    state.circuitOpenedAt = Date.now();

    // Auto-close after timeout
    const timeout = timeoutMs ?? this.config.circuitBreakerTimeout;
    if (timeout) {
      state.circuitTimer = setTimeout(() => {
        state.circuitTimer = undefined;
        if (state.circuitBreakerState === 'open') {
          state.circuitBreakerState = 'half-open';
        }
      }, timeout);
    }
  }

  /**
   * Manually close circuit breaker for a backend.
   */
  closeCircuitBreaker(name: string): void {
    const state = this.backends.get(name);
    if (!state) {
      throw new AdapterError({
        code: ErrorCode.ROUTING_FAILED,
        message: `Backend '${name}' not found`,
        isRetryable: false,
        provenance: { router: this.metadata.name },
      });
    }

    this.clearCircuitTimer(state);
    state.circuitBreakerState = 'closed';
    state.consecutiveFailures = 0;
    state.circuitOpenedAt = undefined;
  }

  /**
   * Reset circuit breaker statistics.
   */
  resetCircuitBreaker(name?: string): void {
    if (name) {
      const state = this.backends.get(name);
      if (state) {
        this.clearCircuitTimer(state);
        state.consecutiveFailures = 0;
        state.circuitBreakerState = 'closed';
        state.circuitOpenedAt = undefined;
      }
    } else {
      for (const state of this.backends.values()) {
        this.clearCircuitTimer(state);
        state.consecutiveFailures = 0;
        state.circuitBreakerState = 'closed';
        state.circuitOpenedAt = undefined;
      }
    }
  }

  /**
   * Check if circuit breaker is open for a backend.
   *
   * @param name Backend name
   * @returns true if circuit breaker is open, false otherwise
   */
  isCircuitBreakerOpen(name: string): boolean {
    const state = this.backends.get(name);
    if (!state) {
      return false;
    }
    return state.circuitBreakerState === 'open';
  }

  // ==========================================================================
  // Statistics & Monitoring
  // ==========================================================================

  /**
   * Get router statistics.
   */
  getStats(): RouterStats {
    const backendStats: Record<string, BackendStats> = {};

    for (const [name, state] of this.backends.entries()) {
      backendStats[name] = this.calculateBackendStats(state);
    }

    return {
      totalRequests: this.stats.totalRequests,
      successfulRequests: this.stats.successfulRequests,
      failedRequests: this.stats.failedRequests,
      totalFallbacks: this.stats.totalFallbacks,
      parallelRequests: this.stats.parallelRequests,
      backendStats,
      sinceTimestamp: this.stats.sinceTimestamp,
    };
  }

  /**
   * Reset router statistics.
   */
  resetStats(): void {
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalFallbacks: 0,
      parallelRequests: 0,
      sinceTimestamp: Date.now(),
    };

    for (const state of this.backends.values()) {
      state.totalRequests = 0;
      state.successfulRequests = 0;
      state.failedRequests = 0;
      state.latencies = [];
      state.totalCost = 0;
    }
  }

  /**
   * Get statistics for specific backend.
   */
  getBackendStats(name: string): BackendStats | undefined {
    const state = this.backends.get(name);
    if (!state) {
      return undefined;
    }
    return this.calculateBackendStats(state);
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Clone this router with a modified configuration.
   *
   * A clone is *this router with different settings*, not a fresh router
   * that happens to share adapters. It therefore inherits everything that
   * describes this router except the fields `config` overrides:
   *
   * - **Routing configuration** — backend registrations (in the same order,
   *   sharing the same adapter instances), the fallback chain, model
   *   mappings and model patterns, and — previously dropped, which is what
   *   made cross-provider fallback break in a clone — the global and
   *   per-backend *model translation* mappings.
   * - **Routing state** — the round-robin cursor, so a clone continues the
   *   rotation rather than restarting it.
   * - **Accounting** — router-level and per-backend request counts, latency
   *   samples and `totalCost`, on the same reasoning as
   *   {@link Router.replace}: this is a cumulative record of traffic that was
   *   really sent and money that was really spent, and a configuration change
   *   does not un-spend it.
   * - **Health verdict** — `isHealthy`, `lastHealthCheck`,
   *   `consecutiveFailures` and the circuit-breaker state.
   *
   * That last point is where `clone()` deliberately differs from
   * {@link Router.replace}, which *resets* the health verdict. The two agree
   * on the underlying rule: a health verdict survives exactly as long as the
   * thing it judged. `replace()` swaps in a different adapter, so the verdict
   * is stale by construction. `clone()` carries the *same adapter instances*
   * across, so an open circuit is still an accurate statement about them —
   * and silently re-arming a backend the breaker had just taken out of
   * rotation, merely because the caller cloned to change an unrelated
   * setting, is the more dangerous default.
   *
   * One exception: a clone that turns the circuit breaker *off* starts with
   * every circuit closed. Nothing in such a router calls the breaker, so an
   * inherited open circuit would never move back to half-open and the backend
   * would be unroutable forever.
   *
   * Callers who do want a fresh slate can follow this with
   * {@link Router.resetStats} and {@link Router.resetCircuitBreaker}.
   */
  clone(config: Partial<RouterConfig>): Router {
    const newRouter = new Router({ ...this.config, ...config });

    // Copy backend registrations, along with the state that describes the
    // adapter instance being shared rather than the config being changed.
    for (const [name, state] of this.backends.entries()) {
      newRouter.register(name, state.adapter);

      const clonedState = newRouter.backends.get(name);
      /* c8 ignore next 3 -- register() just created it */
      if (!clonedState) {
        continue;
      }

      // Accounting: traffic already sent, money already spent.
      clonedState.totalRequests = state.totalRequests;
      clonedState.successfulRequests = state.successfulRequests;
      clonedState.failedRequests = state.failedRequests;
      clonedState.latencies = [...state.latencies];
      clonedState.totalCost = state.totalCost;

      // Health verdict: still a statement about this same adapter instance.
      clonedState.isHealthy = state.isHealthy;
      clonedState.lastHealthCheck = state.lastHealthCheck;
      clonedState.consecutiveFailures = state.consecutiveFailures;

      // An open circuit is only inherited by a router that can reopen and
      // recover it; otherwise it would be permanent.
      if (newRouter.config.enableCircuitBreaker) {
        clonedState.circuitBreakerState = state.circuitBreakerState;
        clonedState.circuitOpenedAt = state.circuitOpenedAt;
      }
    }

    // Copy model mappings, including the translation mappings that make a
    // cross-provider fallback send a model name the target recognises.
    newRouter.modelMapping = new Map(this.modelMapping);
    newRouter.modelTranslationMapping = new Map(this.modelTranslationMapping);
    newRouter.backendTranslationMappings = new Map(
      Array.from(
        this.backendTranslationMappings,
        ([backend, mapping]): [string, Map<string, string>] => [backend, new Map(mapping)]
      )
    );
    newRouter.modelPatterns = [...this.modelPatterns];
    newRouter.fallbackChain = [...this.fallbackChain];
    newRouter.roundRobinIndex = this.roundRobinIndex;

    // Router-level accounting, kept consistent with the per-backend counters.
    newRouter.stats = { ...this.stats };

    return newRouter;
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }
  }

  // ==========================================================================
  // Private Helper Methods
  // ==========================================================================

  /**
   * Execute request on specific backend.
   */
  /**
   * Generate embeddings via the best available backend.
   *
   * Candidates are registered backends that implement embeddings and whose
   * circuit is not open, tried in fallback-chain order (default backend
   * first). Success/failure and cost are tracked like chat requests.
   */
  async embed(request: IREmbedRequest, signal?: AbortSignal): Promise<IREmbedResponse> {
    const candidates = this.getAvailableBackends().filter((name) => {
      const adapter = this.backends.get(name)?.adapter;
      return adapter !== undefined && supportsEmbeddings(adapter);
    });

    // Prefer fallback-chain order, then default backend, then registration order
    const ordered = [
      ...this.fallbackChain.filter((name) => candidates.includes(name)),
      ...(this.config.defaultBackend && candidates.includes(this.config.defaultBackend)
        ? [this.config.defaultBackend]
        : []),
      ...candidates,
    ].filter((name, index, all) => all.indexOf(name) === index);

    if (ordered.length === 0) {
      throw new AdapterError({
        code: ErrorCode.UNSUPPORTED_FEATURE,
        message: 'No registered backend supports embeddings',
        isRetryable: false,
        provenance: { router: this.metadata.name },
      });
    }

    let lastError: Error | undefined;

    for (const name of ordered) {
      const state = this.backends.get(name);
      if (!state) {
        continue;
      }

      if (this.config.enableCircuitBreaker) {
        try {
          this.checkCircuitBreaker(name, state);
        } catch {
          continue;
        }
      }

      state.totalRequests++;
      const startTime = Date.now();

      try {
        const adapter = state.adapter;
        if (!supportsEmbeddings(adapter)) {
          continue;
        }
        const response = await adapter.embed(request, signal);

        state.successfulRequests++;
        state.consecutiveFailures = 0;
        if (this.config.trackLatency) {
          state.latencies.push(Date.now() - startTime);
          if (state.latencies.length > 100) {
            state.latencies.shift();
          }
        }
        if (this.config.trackCost && adapter.estimateEmbedCost) {
          const cost = await adapter.estimateEmbedCost(request);
          if (cost !== null) {
            state.totalCost += cost;
          }
        }
        if (state.circuitBreakerState === 'half-open') {
          state.circuitBreakerState = 'closed';
        }

        return response;
      } catch (error) {
        lastError = error as Error;
        state.failedRequests++;
        state.consecutiveFailures++;
        if (
          this.config.enableCircuitBreaker &&
          state.consecutiveFailures >= (this.config.circuitBreakerThreshold ?? 5)
        ) {
          this.openCircuitBreaker(name);
        }
        // Fall through to the next candidate (sequential fallback)
        if (this.config.fallbackStrategy === 'none') {
          throw error;
        }
      }
    }

    // Only reached when every candidate was skipped before it was invoked
    // (circuit open, or the adapter lost embeddings support), so there is no
    // leaf failure to classify from and nothing was actually attempted.
    // `RouterError` answers non-retryable for that, which is the value this
    // site already had - see the same shape in `fallbackSequential` (#70).
    throw (
      lastError ??
      new RouterError({
        code: ErrorCode.ALL_BACKENDS_FAILED,
        message: 'All embedding-capable backends failed',
        provenance: { router: this.metadata.name },
      })
    );
  }

  private async executeOnBackend(
    name: string,
    request: IRChatRequest,
    signal?: AbortSignal
  ): Promise<IRChatResponse> {
    const state = this.backends.get(name);
    if (!state) {
      throw new AdapterError({
        code: ErrorCode.ROUTING_FAILED,
        message: `Backend '${name}' not found`,
        isRetryable: false,
        provenance: { router: this.metadata.name },
      });
    }

    // Check circuit breaker
    if (this.config.enableCircuitBreaker) {
      this.checkCircuitBreaker(name, state);
    }

    state.totalRequests++;
    const startTime = Date.now();

    if (!supportsChat(state.adapter)) {
      throw new AdapterError({
        code: ErrorCode.UNSUPPORTED_FEATURE,
        message: `Backend '${state.adapter.metadata.name}' does not support chat`,
        isRetryable: false,
        provenance: { backend: state.adapter.metadata.name },
      });
    }

    try {
      const response = await state.adapter.execute(request, signal);
      await this.recordSuccess(state, request, startTime);
      return response;
    } catch (error) {
      this.recordFailure(name, state);
      throw error;
    }
  }

  /**
   * Record a completed backend call that produced no fault.
   *
   * Shared by the streaming and non-streaming paths so that both report the
   * same shape through {@link Router.getBackendStats}: a success counted, the
   * consecutive-failure run broken, a latency sample taken, cost accrued, and
   * a half-open circuit closed by the evidence of a working request.
   *
   * `startTime` is the moment the request was handed to the adapter, so for a
   * stream the sample is full-response wall time -- the same quantity
   * `execute()` measures, which keeps `averageLatencyMs` coherent for a
   * backend serving both kinds of traffic. (Time-to-first-token is a
   * different, also useful metric; it would need its own field rather than
   * being mixed into this one.)
   */
  private async recordSuccess(
    state: BackendState,
    request: IRChatRequest,
    startTime: number
  ): Promise<void> {
    state.successfulRequests++;
    state.consecutiveFailures = 0;

    if (this.config.trackLatency) {
      const latency = Date.now() - startTime;
      state.latencies.push(latency);
      // Keep only last 100 latencies
      if (state.latencies.length > 100) {
        state.latencies.shift();
      }
    }

    // Track cost
    if (this.config.trackCost && state.adapter.estimateCost) {
      const cost = await state.adapter.estimateCost(request);
      if (cost !== null) {
        state.totalCost += cost;
      }
    }

    // Update circuit breaker
    if (state.circuitBreakerState === 'half-open') {
      state.circuitBreakerState = 'closed';
    }
  }

  /**
   * Record a failed backend call, tripping the circuit breaker once the
   * consecutive-failure threshold is reached.
   *
   * Shared by the streaming and non-streaming paths, so a backend that only
   * ever fails streamed requests trips its breaker just like one that fails
   * unary requests.
   */
  private recordFailure(name: string, state: BackendState): void {
    state.failedRequests++;
    state.consecutiveFailures++;

    if (
      this.config.enableCircuitBreaker &&
      state.consecutiveFailures >= (this.config.circuitBreakerThreshold ?? 5)
    ) {
      this.openCircuitBreaker(name);
    }
  }

  /**
   * Execute streaming request on specific backend.
   *
   * Backend lookup and the circuit-breaker check happen eagerly, before the
   * returned stream is iterated, so that a rejected backend throws while the
   * caller can still fail over to another one. Everything else is deferred to
   * {@link Router.trackStream}.
   */
  private executeStreamOnBackend(
    name: string,
    request: IRChatRequest,
    signal?: AbortSignal
  ): IRChatStream {
    const state = this.backends.get(name);
    if (!state) {
      throw new AdapterError({
        code: ErrorCode.ROUTING_FAILED,
        message: `Backend '${name}' not found`,
        isRetryable: false,
        provenance: { router: this.metadata.name },
      });
    }

    // Check circuit breaker. Note this runs before totalRequests is counted
    // (in trackStream), so a request the breaker refuses is never counted as
    // one this router sent.
    if (this.config.enableCircuitBreaker) {
      this.checkCircuitBreaker(name, state);
    }

    return this.trackStream(name, state, request, signal);
  }

  /**
   * Wrap a backend stream so its outcome reaches the same per-backend
   * accounting and circuit breaker as a non-streaming call.
   *
   * Three outcomes, all of which count one `totalRequests`:
   *
   * - **Success** -- a `done` chunk is seen, or the backend's iterator
   *   finishes without one. {@link Router.recordSuccess}.
   * - **Failure** -- the iterator throws, or yields an in-band `error` chunk.
   *   {@link Router.recordFailure}, which may trip the breaker.
   * - **Abandoned** -- the consumer stops reading (`break`, `return()`,
   *   `throw()`, or an aborted request). Counted as a completed request
   *   without fault, because cancelling a stream must never be able to trip a
   *   circuit breaker on a backend that did nothing wrong. It contributes no
   *   latency sample and no cost estimate: neither the elapsed time nor the
   *   generated output is the backend's, and it deliberately leaves
   *   `consecutiveFailures` and the breaker state untouched -- a stream the
   *   consumer walked away from is not evidence that a suspect backend has
   *   recovered.
   *
   * `totalRequests` is counted here rather than in
   * {@link Router.executeStreamOnBackend} so that a stream which is created
   * but never iterated is not counted as sent.
   */
  private async *trackStream(
    name: string,
    state: BackendState,
    request: IRChatRequest,
    signal?: AbortSignal
  ): IRChatStream {
    state.totalRequests++;
    const startTime = Date.now();

    if (!supportsChatStream(state.adapter)) {
      throw new AdapterError({
        code: ErrorCode.UNSUPPORTED_FEATURE,
        message: `Backend '${state.adapter.metadata.name}' does not support streaming chat`,
        isRetryable: false,
        provenance: { backend: state.adapter.metadata.name },
      });
    }

    let settled = false;

    try {
      for await (const chunk of state.adapter.executeStream(request, signal)) {
        if (!settled && chunk.type === 'error') {
          settled = true;
          this.recordFailure(name, state);
        } else if (!settled && chunk.type === 'done') {
          // Recorded before the chunk is handed over: a consumer that stops
          // reading at `done` is a normal, complete stream.
          settled = true;
          await this.recordSuccess(state, request, startTime);
        }

        yield chunk;
      }

      if (!settled) {
        settled = true;
        await this.recordSuccess(state, request, startTime);
      }
    } catch (error) {
      if (!settled) {
        settled = true;
        this.recordFailure(name, state);
      }
      throw error;
    } finally {
      if (!settled) {
        // Reached only when the consumer abandoned the iterator.
        settled = true;
        state.successfulRequests++;
      }
    }
  }

  /**
   * Execute fallback strategy.
   */
  private async executeFallback(
    request: IRChatRequest,
    attemptedBackends: string[],
    error: AdapterError,
    signal?: AbortSignal
  ): Promise<IRChatResponse> {
    const strategy = this.config.fallbackStrategy ?? 'sequential';

    if (strategy === 'sequential') {
      return this.fallbackSequential(request, attemptedBackends, signal);
    } else if (strategy === 'parallel') {
      return this.fallbackParallel(request, attemptedBackends, signal);
    } else if (strategy === 'custom' && this.config.customFallback) {
      const available = this.getAvailableBackends().filter(
        (name) => !attemptedBackends.includes(name)
      );
      const nextBackend = await this.config.customFallback(
        request,
        attemptedBackends[attemptedBackends.length - 1]!,
        error,
        attemptedBackends,
        available
      );

      if (nextBackend && !attemptedBackends.includes(nextBackend)) {
        attemptedBackends.push(nextBackend);
        return this.executeOnBackend(nextBackend, request, signal);
      }
    }

    throw error;
  }

  /**
   * Pick the next backend to try for a stream, or `null` to stop.
   *
   * The streaming counterpart of {@link Router.executeFallback}. It returns
   * one candidate at a time instead of driving the attempt itself, because
   * {@link Router.executeStream} has to interleave attempts with yielding.
   *
   * `'sequential'` and `'parallel'` resolve to the same candidate order --
   * the fallback chain, filtered to what is available, or every available
   * backend when no chain is configured. Streams are never raced: N parallel
   * generations of which N-1 are abandoned cost real money and buy no
   * latency, since a stream can only be moved before its first token anyway.
   */
  private async nextStreamFallbackBackend(
    request: IRChatRequest,
    attemptedBackends: readonly string[],
    error: unknown
  ): Promise<string | null> {
    const strategy = this.config.fallbackStrategy ?? 'sequential';

    if (strategy === 'none') {
      return null;
    }

    const available = this.getAvailableBackends().filter(
      (name) => !attemptedBackends.includes(name)
    );

    if (strategy === 'custom') {
      if (!this.config.customFallback) {
        return null;
      }

      const nextBackend = await this.config.customFallback(
        request,
        attemptedBackends[attemptedBackends.length - 1] ?? '',
        this.wrapError(error),
        [...attemptedBackends],
        available
      );

      return nextBackend && !attemptedBackends.includes(nextBackend) ? nextBackend : null;
    }

    const candidates =
      this.fallbackChain.length > 0
        ? this.fallbackChain.filter((name) => available.includes(name))
        : available;

    return candidates[0] ?? null;
  }

  /**
   * Build the terminal `error` chunk for a stream that could not be served.
   */
  private createStreamErrorChunk(error: unknown): StreamErrorChunk {
    return {
      type: 'error',
      // Overwritten by the caller with this stream's next sequence number.
      sequence: 0,
      error: {
        code: error instanceof AdapterError ? error.code : 'UNKNOWN_ERROR',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  /**
   * Translate a request's model for a backend and return the request to send.
   *
   * When hybrid translation falls back to the backend's default model (a
   * silent substitution) and `modelTranslation.warnOnDefault` is not
   * disabled, a `model-substituted` warning is attached to the request
   * metadata and `config.onWarning` is invoked.
   */
  private applyModelTranslation(request: IRChatRequest, backendName: string): IRChatRequest {
    const originalModel = request.parameters?.model ?? '';
    const translationResult = this.translateModelForBackend(originalModel, backendName);

    let translatedRequest: IRChatRequest = {
      ...request,
      parameters: {
        ...request.parameters,
        model: translationResult.translated,
      },
    };

    const warnOnDefault = this.config.modelTranslation?.warnOnDefault ?? true;
    if (translationResult.source === 'default' && warnOnDefault) {
      const warning = createWarning(
        'model-substituted',
        `Model '${originalModel}' has no translation for backend '${backendName}'; using its default model '${translationResult.translated}'`,
        {
          field: 'parameters.model',
          originalValue: originalModel,
          transformedValue: translationResult.translated,
          source: this.metadata.name,
        }
      );

      translatedRequest = {
        ...translatedRequest,
        metadata: {
          ...translatedRequest.metadata,
          warnings: [...(translatedRequest.metadata.warnings ?? []), warning],
        },
      };

      this.config.onWarning?.(warning);
    }

    return translatedRequest;
  }

  /**
   * Translate model name for a specific backend.
   *
   * Applies translation strategy: backend-specific exact → global exact → pattern → default → passthrough
   */
  private translateModelForBackend(modelName: string, backendName: string): TranslationResult {
    const strategy = this.config.modelTranslation?.strategy ?? 'hybrid';
    const strictMode = this.config.modelTranslation?.strictMode ?? false;

    // 0. Try backend-specific exact match (highest priority)
    if (strategy !== 'none') {
      const backendMapping = this.backendTranslationMappings.get(backendName);
      if (backendMapping) {
        const backendExactMatch = backendMapping.get(modelName);
        if (backendExactMatch) {
          return {
            translated: backendExactMatch,
            source: 'exact',
            wasTranslated: true,
          };
        }
      }
    }

    // 1. Try global exact match (all strategies except 'none')
    if (strategy !== 'none') {
      const exactMatch = this.modelTranslationMapping.get(modelName);
      if (exactMatch) {
        return {
          translated: exactMatch,
          source: 'exact',
          wasTranslated: true,
        };
      }
    }

    // 2. Try pattern match (pattern and hybrid strategies)
    if (strategy === 'pattern' || strategy === 'hybrid') {
      // Sort patterns by priority (higher priority first)
      const sortedPatterns = [...this.modelPatterns].sort((a, b) => {
        const priorityA = a.priority ?? 0;
        const priorityB = b.priority ?? 0;
        return priorityB - priorityA;
      });

      for (const patternMapping of sortedPatterns) {
        if (patternMapping.pattern.test(modelName)) {
          // Use targetModel if specified, otherwise original model
          const translated = patternMapping.targetModel ?? modelName;
          return {
            translated,
            source: 'pattern',
            wasTranslated: patternMapping.targetModel !== undefined,
          };
        }
      }
    }

    // 3. Try backend default (hybrid strategy only)
    if (strategy === 'hybrid') {
      const backendState = this.backends.get(backendName);
      const adapter = backendState?.adapter as { config?: { defaultModel?: string } } | undefined;
      const defaultModel = adapter?.config?.defaultModel;

      if (defaultModel) {
        // Warning emission happens in applyModelTranslation (which sees the
        // full request context); the result's source flags the substitution
        return {
          translated: defaultModel,
          source: 'default',
          wasTranslated: true,
        };
      }
    }

    // 4. No translation found
    if (strictMode) {
      throw new AdapterError({
        code: ErrorCode.ROUTING_FAILED,
        message: `No translation found for model: ${modelName}`,
        isRetryable: false,
        provenance: { router: this.metadata.name, backend: backendName },
      });
    }

    // Return original model (passthrough)
    return {
      translated: modelName,
      source: 'none',
      wasTranslated: false,
    };
  }

  /**
   * Sequential fallback: try backends one by one.
   */
  private async fallbackSequential(
    request: IRChatRequest,
    attemptedBackends: string[],
    signal?: AbortSignal
  ): Promise<IRChatResponse> {
    const available = this.getAvailableBackends().filter(
      (name) => !attemptedBackends.includes(name)
    );

    // Use fallback chain if configured
    const candidates =
      this.fallbackChain.length > 0
        ? this.fallbackChain.filter((name) => available.includes(name))
        : available;

    let lastError: Error | undefined;

    for (const backendName of candidates) {
      try {
        attemptedBackends.push(backendName);

        // Translate model for this backend (attaches substitution warnings)
        const translatedRequest = this.applyModelTranslation(request, backendName);

        return await this.executeOnBackend(backendName, translatedRequest, signal);
      } catch (error) {
        lastError = error as Error;
        continue;
      }
    }

    // Only reached when `candidates` was empty - every attempt sets
    // `lastError` and that is thrown as-is - so no backend was invoked and
    // there is nothing to derive a classification from. Non-retryable, the
    // value this site already had (#70).
    throw (
      lastError ??
      new RouterError({
        code: ErrorCode.ALL_BACKENDS_FAILED,
        message: 'All fallback backends failed',
        attemptedBackends,
        provenance: { router: this.metadata.name },
      })
    );
  }

  /**
   * Parallel fallback: try all remaining backends at once.
   */
  private async fallbackParallel(
    request: IRChatRequest,
    attemptedBackends: string[],
    signal?: AbortSignal
  ): Promise<IRChatResponse> {
    const available = this.getAvailableBackends().filter(
      (name) => !attemptedBackends.includes(name)
    );

    if (available.length === 0) {
      throw new AdapterError({
        code: ErrorCode.NO_BACKEND_AVAILABLE,
        message: 'No available fallback backends',
        isRetryable: false,
        provenance: { router: this.metadata.name },
      });
    }

    // Create promises with model translation for each backend
    const promises = available.map((backendName) => {
      const translatedRequest = this.applyModelTranslation(request, backendName);
      return this.executeOnBackend(backendName, translatedRequest, signal);
    });

    try {
      // Promise.any() resolves with the first *fulfilled* promise and only
      // rejects once every promise has rejected -- unlike Promise.race(),
      // a fast failure does not preempt a slower backend that would have
      // succeeded.
      return await Promise.any(promises);
    } catch (error) {
      // `Promise.any` only rejects once every leg has rejected, and it hands
      // back every rejection - so the composite is built from the actual
      // failures rather than asserting retryable (#70). A thrown non-Error
      // carries no classification, and becomes a non-retryable leaf.
      const raised = error instanceof AggregateError ? error.errors : [error];
      const backendErrors = raised.map((e: unknown) =>
        e instanceof Error ? e : new Error(String(e))
      );

      throw new RouterError({
        code: ErrorCode.ALL_BACKENDS_FAILED,
        message: `All parallel fallback backends failed: ${backendErrors.map((e) => e.message).join(', ')}`,
        attemptedBackends: available,
        backendErrors,
        provenance: { router: this.metadata.name },
      });
    }
  }

  /**
   * Check circuit breaker state.
   */
  private checkCircuitBreaker(name: string, state: BackendState): void {
    if (state.circuitBreakerState === 'open') {
      // Check if timeout has passed
      const timeout = this.config.circuitBreakerTimeout ?? 60000;
      if (state.circuitOpenedAt && Date.now() - state.circuitOpenedAt > timeout) {
        state.circuitBreakerState = 'half-open';
      } else {
        throw new AdapterError({
          code: ErrorCode.PROVIDER_UNAVAILABLE,
          message: `Circuit breaker is open for backend '${name}'`,
          isRetryable: true,
          provenance: { router: this.metadata.name, backend: name },
        });
      }
    }
  }

  /**
   * Get list of available backends.
   */
  private getAvailableBackends(): string[] {
    const available: string[] = [];

    for (const [name, state] of this.backends.entries()) {
      if (state.isHealthy && state.circuitBreakerState !== 'open') {
        available.push(name);
      }
    }

    return available;
  }

  /**
   * Check if a backend is available to be routed to.
   *
   * This is the exact predicate routing uses, so it is the only reliable way
   * to pre-flight "will a request actually go where I ask?". It is stricter
   * than {@link Router.isCircuitBreakerOpen}, which answers only the circuit
   * half: a backend that failed its last health check is unhealthy and will
   * not be routed to even though its circuit is closed.
   *
   * Returns `false` for a name that is not registered.
   */
  isBackendAvailable(name: string): boolean {
    const state = this.backends.get(name);
    if (!state) {
      return false;
    }
    return state.isHealthy && state.circuitBreakerState !== 'open';
  }

  /**
   * Routing: explicit backend selection.
   */
  private routeExplicit(preferredBackend?: string): string | null {
    if (preferredBackend && this.isBackendAvailable(preferredBackend)) {
      return preferredBackend;
    }
    return null;
  }

  /**
   * Routing: model-based selection.
   */
  private routeByModel(request: IRChatRequest): string | null {
    const model = request.parameters?.model;
    if (!model) {
      return null;
    }

    // Check exact mapping
    const exactMatch = this.modelMapping.get(model);
    if (exactMatch && this.isBackendAvailable(exactMatch)) {
      return exactMatch;
    }

    // Check pattern matching
    for (const pattern of this.modelPatterns) {
      if (pattern.pattern.test(model) && this.isBackendAvailable(pattern.backend)) {
        return pattern.backend;
      }
    }

    return null;
  }

  /**
   * Routing: cost-optimized selection.
   */
  private routeByCost(_request: IRChatRequest): string | null {
    if (!this.config.trackCost) {
      return null;
    }

    let bestBackend: string | null = null;
    let lowestAvgCost = Infinity;

    for (const [name, state] of this.backends.entries()) {
      if (!this.isBackendAvailable(name)) {
        continue;
      }

      const stats = this.calculateBackendStats(state);
      const avgCost = stats.averageCost ?? 0;

      if (avgCost < lowestAvgCost) {
        lowestAvgCost = avgCost;
        bestBackend = name;
      }
    }

    return bestBackend;
  }

  /**
   * Routing: latency-optimized selection.
   */
  private routeByLatency(): string | null {
    if (!this.config.trackLatency) {
      return null;
    }

    let bestBackend: string | null = null;
    let lowestLatency = Infinity;

    for (const [name, state] of this.backends.entries()) {
      if (!this.isBackendAvailable(name)) {
        continue;
      }

      const stats = this.calculateBackendStats(state);
      const avgLatency = stats.averageLatencyMs;

      if (avgLatency < lowestLatency) {
        lowestLatency = avgLatency;
        bestBackend = name;
      }
    }

    return bestBackend;
  }

  /**
   * Routing: round-robin selection.
   */
  private routeRoundRobin(): string | null {
    const available = this.getAvailableBackends();
    if (available.length === 0) {
      return null;
    }

    const backend = available[this.roundRobinIndex % available.length];
    this.roundRobinIndex++;

    return backend ?? null;
  }

  /**
   * Routing: random selection.
   */
  private routeRandom(): string | null {
    const available = this.getAvailableBackends();
    if (available.length === 0) {
      return null;
    }

    const index = Math.floor(Math.random() * available.length);
    return available[index] ?? null;
  }

  /**
   * Select backend based on capability requirements.
   * Returns the backend name with the best matching model, or null if none match.
   */
  private async selectBackendByCapabilities(request: IRChatRequest): Promise<string | null> {
    // Extract capability requirements from request metadata
    const capabilityRequirements = request.metadata?.custom?.capabilityRequirements as
      | CapabilityRequirements
      | undefined;

    // Build requirements from config if not provided
    const requirements: CapabilityRequirements = {
      required: capabilityRequirements?.required,
      preferred: capabilityRequirements?.preferred,
      optimization: capabilityRequirements?.optimization ?? this.config.optimization ?? 'balanced',
      weights: capabilityRequirements?.weights ?? this.config.optimizationWeights,
    };

    // Collect available models from all backends
    const availableModels: BackendModel[] = [];

    for (const backendName of this.getAvailableBackends()) {
      const backend = this.backends.get(backendName)?.adapter;
      if (!backend) {
        continue;
      }

      // Try to get models from backend's listModels()
      if (typeof backend.listModels === 'function') {
        try {
          const result = await backend.listModels();
          for (const model of result.models) {
            availableModels.push({ model, backend: backendName });
          }
        } catch {
          // If listModels fails, try to infer from requested model
          const requestedModel = request.parameters?.model;
          if (requestedModel) {
            const inferredModel: AIModel = {
              id: requestedModel,
              name: requestedModel,
              capabilities: inferCapabilities(requestedModel),
            };
            availableModels.push({ model: inferredModel, backend: backendName });
          }
        }
      } else {
        // Backend doesn't support listModels, try to infer from requested model
        const requestedModel = request.parameters?.model;
        if (requestedModel) {
          const inferredModel: AIModel = {
            id: requestedModel,
            name: requestedModel,
            capabilities: inferCapabilities(requestedModel),
          };
          availableModels.push({ model: inferredModel, backend: backendName });
        }
      }
    }

    if (availableModels.length === 0) {
      return null;
    }

    // Find best match
    const bestMatch = findBestModel(requirements, availableModels);

    if (!bestMatch?.meetsRequirements) {
      return null;
    }

    return bestMatch.backend;
  }

  /**
   * Calculate backend statistics.
   */
  private calculateBackendStats(state: BackendState): BackendStats {
    const successRate =
      state.totalRequests > 0 ? (state.successfulRequests / state.totalRequests) * 100 : 0;

    const sortedLatencies = [...state.latencies].sort((a, b) => a - b);
    const avgLatency =
      sortedLatencies.length > 0
        ? sortedLatencies.reduce((a, b) => a + b, 0) / sortedLatencies.length
        : 0;

    const p50 = sortedLatencies[Math.floor(sortedLatencies.length * 0.5)] ?? 0;
    const p95 = sortedLatencies[Math.floor(sortedLatencies.length * 0.95)] ?? 0;
    const p99 = sortedLatencies[Math.floor(sortedLatencies.length * 0.99)] ?? 0;

    const avgCost = state.totalRequests > 0 ? state.totalCost / state.totalRequests : 0;

    return {
      totalRequests: state.totalRequests,
      successfulRequests: state.successfulRequests,
      failedRequests: state.failedRequests,
      successRate,
      averageLatencyMs: avgLatency,
      p50LatencyMs: p50,
      p95LatencyMs: p95,
      p99LatencyMs: p99,
      totalCost: this.config.trackCost ? state.totalCost : undefined,
      averageCost: this.config.trackCost ? avgCost : undefined,
    };
  }

  /**
   * Create backend info from state.
   */
  private createBackendInfo(name: string, state: BackendState): BackendInfo {
    return {
      name,
      adapter: state.adapter,
      metadata: state.adapter.metadata,
      isHealthy: state.isHealthy,
      lastHealthCheck: state.lastHealthCheck,
      circuitBreakerState: state.circuitBreakerState,
      consecutiveFailures: state.consecutiveFailures,
      stats: this.calculateBackendStats(state),
    };
  }

  /**
   * Start periodic health checking.
   */
  private startHealthChecking(): void {
    if (this.healthCheckInterval) {
      return;
    }

    const interval = this.config.healthCheckInterval ?? 0;
    if (interval <= 0) {
      return;
    }

    this.healthCheckInterval = setInterval(() => {
      this.checkHealth().catch(() => {
        // Ignore errors in background health checks
      });
    }, interval);
  }

  /**
   * Combine multiple abort signals.
   */
  private combineSignals(signals: AbortSignal[]): AbortSignal {
    const controller = new AbortController();

    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort();
        break;
      }
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    return controller.signal;
  }

  /**
   * Wait for the first promise to fulfill with `.success === true`, only
   * settling on failure once *every* promise has settled unsuccessfully.
   *
   * Unlike `Promise.race()`, a fast failure does not preempt a slower
   * backend that would have succeeded -- the whole point of "first success"
   * parallel dispatch / fallback is to race on success, not on settlement.
   */
  private async raceFirstSuccess<T extends { success: boolean }>(
    promises: Promise<T>[]
  ): Promise<{ winner: T | null; settled: T[] }> {
    return new Promise((resolve) => {
      const settled: T[] = [];
      let remaining = promises.length;
      let resolved = false;

      for (const p of promises) {
        void p.then((result) => {
          settled.push(result);

          if (result.success) {
            if (!resolved) {
              resolved = true;
              resolve({ winner: result, settled });
            }
            return;
          }

          remaining -= 1;
          if (remaining === 0 && !resolved) {
            resolved = true;
            resolve({ winner: null, settled });
          }
        });
      }
    });
  }

  /**
   * Wrap unknown error as AdapterError.
   */
  private wrapError(error: unknown): AdapterError {
    if (error instanceof AdapterError) {
      return error;
    }

    return new AdapterError({
      code: ErrorCode.INTERNAL_ERROR,
      message: error instanceof Error ? error.message : String(error),
      isRetryable: false,
      provenance: { router: this.metadata.name },
      cause: error instanceof Error ? error : undefined,
    });
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new Router instance.
 */
export function createRouter(config?: Partial<RouterConfig>): Router {
  return new Router(config);
}
