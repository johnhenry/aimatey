/**
 * Router Types and Interfaces
 *
 * The Router manages multiple backend adapters and provides intelligent routing,
 * fallback strategies, and parallel dispatch capabilities.
 *
 * @module
 */

import type { BackendAdapter, AdapterMetadata } from './adapters.js';
import type { IRChatRequest, IRChatResponse, IRChatStream, IRWarning } from './ir.js';
import type { AdapterError } from './errors.js';
import type { ModelTranslationConfig, ModelMapping } from './model-translation.js';

// Re-export ModelMapping for backward compatibility
export type { ModelMapping };

// ============================================================================
// Router Configuration
// ============================================================================

/**
 * Fallback strategies for handling backend failures.
 */
export const FallbackStrategy = {
  /**
   * No fallback - fail immediately if primary backend fails.
   */
  NONE: 'none',

  /**
   * Try backends sequentially in order until one succeeds.
   */
  SEQUENTIAL: 'sequential',

  /**
   * Try all backends in parallel, return first success.
   */
  PARALLEL: 'parallel',

  /**
   * Use custom fallback logic.
   */
  CUSTOM: 'custom',
} as const;

export type FallbackStrategy = (typeof FallbackStrategy)[keyof typeof FallbackStrategy];

/**
 * Routing strategies for selecting backends.
 */
export const RoutingStrategy = {
  /**
   * Use backend specified in request options.
   */
  EXPLICIT: 'explicit',

  /**
   * Route based on model name.
   */
  MODEL_BASED: 'model-based',

  /**
   * Route to least-cost backend.
   */
  COST_OPTIMIZED: 'cost-optimized',

  /**
   * Route to fastest backend (lowest latency).
   */
  LATENCY_OPTIMIZED: 'latency-optimized',

  /**
   * Round-robin load balancing.
   */
  ROUND_ROBIN: 'round-robin',

  /**
   * Random backend selection.
   */
  RANDOM: 'random',

  /**
   * Use custom routing logic.
   */
  CUSTOM: 'custom',
} as const;

export type RoutingStrategy = (typeof RoutingStrategy)[keyof typeof RoutingStrategy];

/**
 * Router configuration options.
 */
export interface RouterConfig {
  /**
   * Primary routing strategy.
   * @default 'explicit'
   */
  readonly routingStrategy?: RoutingStrategy;

  /**
   * Fallback strategy when primary backend fails.
   * @default 'sequential'
   */
  readonly fallbackStrategy?: FallbackStrategy;

  /**
   * Default backend to use if routing doesn't select one.
   */
  readonly defaultBackend?: string;

  /**
   * Interval for health checking backends (milliseconds).
   * Set to 0 to disable health checks.
   * @default 0
   */
  readonly healthCheckInterval?: number;

  /**
   * Enable circuit breaker pattern.
   *
   * Router-wide **default**: a backend registered with
   * `{ circuitBreaker: { enabled } }` overrides it for itself.
   * @default false
   */
  readonly enableCircuitBreaker?: boolean;

  /**
   * Number of consecutive failures before circuit breaker opens.
   *
   * Router-wide **default**: a backend registered with
   * `{ circuitBreaker: { threshold } }` overrides it for itself.
   * @default 5
   */
  readonly circuitBreakerThreshold?: number;

  /**
   * Time to wait before attempting to close circuit breaker (milliseconds).
   *
   * Router-wide **default**: a backend registered with
   * `{ circuitBreaker: { timeout } }` overrides it for itself, and
   * {@link Router.openCircuitBreaker}'s `timeoutMs` overrides both for the one
   * open it starts.
   * @default 60000
   */
  readonly circuitBreakerTimeout?: number;

  /**
   * Track latency statistics per backend.
   * @default true
   */
  readonly trackLatency?: boolean;

  /**
   * Track cost per backend (requires backends to implement estimateCost).
   * @default false
   */
  readonly trackCost?: boolean;

  /**
   * Enable capability-based routing.
   * When enabled, the router will select backends based on their model capabilities
   * matching the request requirements.
   * @default false
   */
  readonly capabilityBasedRouting?: boolean;

  /**
   * Optimization strategy for capability-based routing.
   * Determines how to weigh cost, speed, and quality when selecting models.
   * @default 'balanced'
   */
  readonly optimization?: 'cost' | 'speed' | 'quality' | 'balanced';

  /**
   * Custom optimization weights for capability-based routing.
   * Must sum to 1.0. Overrides optimization preset.
   */
  readonly optimizationWeights?: {
    cost: number; // 0-1
    speed: number; // 0-1
    quality: number; // 0-1
  };

  /**
   * Cache duration for model capability data in milliseconds.
   *
   * Also bounds how long the router trusts an adapter's
   * `discoverCapabilities()` answer before asking the far side again (#127);
   * a passing `checkHealth()` refreshes it early, and a discovery that throws
   * falls back to the last answer or the static `metadata.capabilities`.
   * @default 3600000 (1 hour)
   */
  readonly capabilityCacheDuration?: number;

  /**
   * Custom routing function.
   */
  readonly customRouter?: CustomRoutingFunction;

  /**
   * Custom fallback function.
   */
  readonly customFallback?: CustomFallbackFunction;

  /**
   * Model translation configuration for fallback scenarios.
   * Controls how model names are translated when falling back to different backends.
   * @default { strategy: 'hybrid', warnOnDefault: true, strictMode: false }
   */
  readonly modelTranslation?: ModelTranslationConfig;

  /**
   * Called when the router generates a warning. Currently emitted when:
   *
   * - a request's model is silently substituted with a backend's default
   *   model during hybrid translation (and `modelTranslation.warnOnDefault`
   *   is not disabled) — category `model-substituted`. That warning is also
   *   attached to the request metadata.
   * - unregistering a backend changes the router's own configuration, e.g.
   *   clearing `defaultBackend` because the backend it named was removed —
   *   category `routing-config-changed`. There is no request to attach this
   *   one to, so the hook is the only channel for it.
   */
  readonly onWarning?: (warning: IRWarning) => void;
}

/**
 * Custom routing function signature.
 */
export type CustomRoutingFunction = (
  request: IRChatRequest,
  availableBackends: readonly string[],
  context: RoutingContext
) => Promise<string | null>;

/**
 * Custom fallback function signature.
 */
export type CustomFallbackFunction = (
  request: IRChatRequest,
  failedBackend: string,
  error: AdapterError,
  attemptedBackends: readonly string[],
  availableBackends: readonly string[]
) => Promise<string | null>;

/**
 * Context provided to routing functions.
 */
export interface RoutingContext {
  /**
   * Backend statistics for making informed decisions.
   */
  readonly stats: RouterStats;

  /**
   * Request metadata.
   */
  readonly metadata: Record<string, unknown>;

  /**
   * Preferred backend from request options (if any).
   */
  readonly preferredBackend?: string;
}

// ============================================================================
// Backend Registry
// ============================================================================

/**
 * Circuit-breaker policy for one backend. Every field is optional; a field left
 * out inherits the router-wide value on {@link RouterConfig}.
 *
 * The router-wide settings assume every backend fails the same way. They do not:
 * a cloud API that blips for a few seconds and a LAN peer that is asleep for the
 * night want different thresholds and very different rest periods.
 */
export interface BackendCircuitBreakerOptions {
  /**
   * Whether this backend has a breaker at all. `false` exempts it from a router
   * that has one; `true` gives it one in a router that does not.
   * @default {@link RouterConfig.enableCircuitBreaker}
   */
  readonly enabled?: boolean;

  /**
   * Consecutive failures before this backend's breaker opens. A positive integer.
   * @default {@link RouterConfig.circuitBreakerThreshold}
   */
  readonly threshold?: number;

  /**
   * How long this backend rests once open, in milliseconds. Non-negative.
   * @default {@link RouterConfig.circuitBreakerTimeout}
   */
  readonly timeout?: number;
}

/**
 * Per-backend settings accepted by {@link Router.register}.
 *
 * They belong to the *name*, like latency history: {@link Router.replace} and
 * {@link Router.clone} carry them over.
 */
export interface BackendRegistrationOptions {
  /** Circuit-breaker policy for this backend; see {@link BackendCircuitBreakerOptions}. */
  readonly circuitBreaker?: BackendCircuitBreakerOptions;
}

/**
 * The circuit-breaker policy a backend is actually running under: its own
 * overrides resolved against the router-wide defaults.
 */
export interface EffectiveCircuitBreakerPolicy {
  readonly enabled: boolean;
  readonly threshold: number;
  readonly timeout: number;
}

/**
 * Options for {@link Router.unregister}.
 */
export interface UnregisterOptions {
  /**
   * Also wait for requests already in flight on this backend.
   *
   * - `false` / omitted -- do not wait; `unregister()` returns the router synchronously.
   * - `true` -- return a promise that settles when every in-flight call, streams
   *   included, has finished.
   * - a number -- the same, but give up after that many milliseconds.
   *
   * Draining never cancels anything. It is observation, not revocation; see
   * {@link Router.unregister}.
   */
  readonly drain?: boolean | number;
}

/**
 * Outcome of `unregister(name, { drain })`.
 */
export interface UnregisterResult {
  /** `true` when the backend was idle (or became idle) before any timeout. */
  readonly drained: boolean;
  /** Calls still running when the promise settled; `0` whenever `drained` is `true`. */
  readonly inFlight: number;
}

/**
 * Information about a registered backend.
 */
export interface BackendInfo {
  /**
   * Backend identifier.
   */
  readonly name: string;

  /**
   * Backend adapter instance.
   */
  readonly adapter: BackendAdapter;

  /**
   * Backend metadata.
   */
  readonly metadata: AdapterMetadata;

  /**
   * Whether backend is currently healthy.
   */
  readonly isHealthy: boolean;

  /**
   * Last health check timestamp.
   */
  readonly lastHealthCheck?: number;

  /**
   * Circuit breaker state.
   */
  readonly circuitBreakerState: 'closed' | 'open' | 'half-open';

  /**
   * Consecutive failures count (for circuit breaker).
   */
  readonly consecutiveFailures: number;

  /**
   * The circuit-breaker policy in force for this backend: its registration
   * overrides resolved against the router-wide defaults. Read this to learn
   * which layer won.
   */
  readonly circuitBreaker: EffectiveCircuitBreakerPolicy;

  /**
   * Calls currently running on this backend: `execute()`, `embed()` and
   * `decide()` until they settle, and a stream from its first chunk request
   * until it ends, fails, or the consumer abandons it.
   */
  readonly inFlight: number;

  /**
   * Statistics for this backend.
   */
  readonly stats: BackendStats;
}

/**
 * Statistics for a single backend.
 */
export interface BackendStats {
  /**
   * Total requests routed to this backend.
   */
  readonly totalRequests: number;

  /**
   * Successful requests.
   */
  readonly successfulRequests: number;

  /**
   * Failed requests.
   */
  readonly failedRequests: number;

  /**
   * Success rate (0-100).
   */
  readonly successRate: number;

  /**
   * Average latency in milliseconds.
   */
  readonly averageLatencyMs: number;

  /**
   * P50 latency in milliseconds.
   */
  readonly p50LatencyMs: number;

  /**
   * P95 latency in milliseconds.
   */
  readonly p95LatencyMs: number;

  /**
   * P99 latency in milliseconds.
   */
  readonly p99LatencyMs: number;

  /**
   * Total estimated cost (if tracking enabled).
   */
  readonly totalCost?: number;

  /**
   * Average cost per request (if tracking enabled).
   */
  readonly averageCost?: number;
}

// ============================================================================
// Router Statistics
// ============================================================================

/**
 * Overall router statistics.
 */
export interface RouterStats {
  /**
   * Total requests routed.
   */
  readonly totalRequests: number;

  /**
   * Requests that succeeded on first try.
   */
  readonly successfulRequests: number;

  /**
   * Requests that failed completely.
   */
  readonly failedRequests: number;

  /**
   * Requests that required fallback.
   */
  readonly totalFallbacks: number;

  /**
   * Parallel/fan-out requests.
   */
  readonly parallelRequests: number;

  /**
   * Per-backend statistics.
   */
  readonly backendStats: Record<string, BackendStats>;

  /**
   * When statistics were last reset.
   */
  readonly sinceTimestamp: number;
}

// ============================================================================
// Parallel Dispatch Options
// ============================================================================

/**
 * Strategy for handling parallel dispatch results.
 */
export const ParallelStrategy = {
  /**
   * Return first successful response, cancel others.
   */
  FIRST: 'first',

  /**
   * Wait for all responses, return array of results.
   */
  ALL: 'all',

  /**
   * Return fastest successful response (with timeout).
   */
  FASTEST: 'fastest',

  /**
   * Use custom aggregation logic.
   */
  CUSTOM: 'custom',
} as const;

export type ParallelStrategy = (typeof ParallelStrategy)[keyof typeof ParallelStrategy];

/**
 * Options for parallel dispatch.
 */
export interface ParallelDispatchOptions {
  /**
   * Backend names to dispatch to.
   */
  readonly backends?: readonly string[];

  /**
   * Parallel dispatch strategy.
   * @default 'first'
   */
  readonly strategy?: ParallelStrategy;

  /**
   * Timeout for parallel requests (milliseconds).
   */
  readonly timeout?: number;

  /**
   * Cancel remaining requests on first success.
   * @default true
   */
  readonly cancelOnFirstSuccess?: boolean;

  /**
   * Custom aggregation function for 'custom' strategy.
   */
  readonly customAggregator?: (
    responses: Array<{ backend: string; response: IRChatResponse; latencyMs: number }>
  ) => IRChatResponse;
}

/**
 * Result of parallel dispatch.
 */
export interface ParallelDispatchResult {
  /**
   * Primary response (based on strategy).
   */
  readonly response: IRChatResponse;

  /**
   * All responses (only for 'all' strategy).
   */
  readonly allResponses?: Array<{
    readonly backend: string;
    readonly response: IRChatResponse;
    readonly latencyMs: number;
  }>;

  /**
   * Backends that succeeded.
   */
  readonly successfulBackends: readonly string[];

  /**
   * Backends that failed.
   */
  readonly failedBackends: Array<{
    readonly backend: string;
    readonly error: AdapterError;
  }>;

  /**
   * Total time for parallel dispatch (milliseconds).
   */
  readonly totalTimeMs: number;
}

// ============================================================================
// Model Mapping
// ============================================================================

/**
 * Model pattern to backend mapping.
 */
export interface ModelPatternMapping {
  /**
   * Regular expression pattern to match model names.
   */
  readonly pattern: RegExp;

  /**
   * Backend name to route matching models to.
   */
  readonly backend: string;

  /**
   * Optional target model name to use (for translation during fallback).
   * If not specified, original model name is passed through.
   */
  readonly targetModel?: string;

  /**
   * Pattern matching priority (higher = checked first).
   * @default 0
   */
  readonly priority?: number;
}

// ============================================================================
// Main Router Interface
// ============================================================================

/**
 * Router manages multiple backend adapters with intelligent routing.
 */
export interface Router extends BackendAdapter<unknown, unknown> {
  /**
   * Router configuration.
   */
  readonly config: RouterConfig;

  // ==========================================================================
  // Backend Management
  // ==========================================================================

  /**
   * Register a backend adapter under a name that is not yet in use.
   *
   * Throws if `name` is already registered — use {@link Router.replace} to
   * swap the adapter behind an existing name.
   *
   * `options.circuitBreaker` overrides the router-wide breaker settings for
   * this backend alone; omitted fields inherit {@link RouterConfig}. Invalid
   * values (a non-integer or non-positive `threshold`, a negative or
   * non-finite `timeout`) throw before anything is registered.
   */
  register(name: string, adapter: BackendAdapter, options?: BackendRegistrationOptions): Router;

  /**
   * Replace the adapter registered under an existing name, keeping the
   * backend's position in the registry and all routing configuration that
   * refers to it (fallback chain, model mappings, translation mappings).
   *
   * This is the supported way to change a backend's configuration — a rotated
   * API key, a new base URL, a different default model — without tearing the
   * backend out of the router.
   *
   * Cumulative accounting stats (request counts, latencies, cost) are carried
   * over, because they describe traffic the router sent to this logical
   * backend. Live health judgements (`isHealthy`, circuit breaker state,
   * consecutive failures) are reset, because they describe the *previous*
   * configuration and are stale the moment it is replaced. The per-backend
   * options given to {@link Router.register} are *kept*: they are policy about
   * the name, not a verdict about the adapter.
   *
   * Throws if `name` is not registered — use {@link Router.register} to add a
   * new backend.
   */
  replace(name: string, adapter: BackendAdapter): Router;

  /**
   * Unregister a backend adapter, along with every routing rule that refers
   * to it (fallback chain entries, model mappings, model patterns and
   * backend-specific translation mappings).
   *
   * Unregistering the backend named by `config.defaultBackend` clears
   * `defaultBackend` and emits a `routing-config-changed` warning through
   * {@link RouterConfig.onWarning} rather than failing. Unregistering the
   * last remaining backend is allowed: a router with no backends is a valid
   * transient state (it is also the state of a freshly constructed router),
   * and routing a request through it fails at request time with a routing
   * error.
   *
   * **Requests already in flight.** `unregister()` is not cancellation. A call
   * that has already been handed to the backend runs to its natural end: an
   * `execute()` resolves, a stream keeps yielding. The call retains the adapter
   * for exactly as long as it needs it; the router retains nothing. From the
   * moment `unregister()` returns:
   *
   * - no *new* request is routed to the name;
   * - the circuit-breaker recovery timer is cancelled;
   * - what the in-flight call goes on to do is **not accounted**: its outcome
   *   updates no counters, stats or breaker (the backend is gone, and a late
   *   failure must not trip the breaker of a different backend later
   *   registered under the same name).
   *
   * **This is not revocation.** If the answer must not be *delivered* -- a
   * revoked device, a rotated credential -- stop the call with the
   * `AbortSignal` you passed to it; only the transport can make that
   * guarantee. Use `unregister()` to stop sending *new* work.
   *
   * Pass `{ drain: true }` (or a timeout in milliseconds) to get a promise that
   * settles once the in-flight calls have finished. The backend is removed
   * synchronously either way; draining only lets the caller know when the
   * adapter is safe to dispose of.
   *
   * Throws if `name` is not registered (synchronously, with or without `drain`).
   */
  unregister(name: string, options?: { readonly drain?: false }): Router;
  unregister(name: string, options: { readonly drain: true | number }): Promise<UnregisterResult>;
  unregister(name: string, options?: UnregisterOptions): Router | Promise<UnregisterResult>;

  /**
   * Get a registered backend adapter.
   */
  get(name: string): BackendAdapter | undefined;

  /**
   * Check if backend is registered.
   */
  has(name: string): boolean;

  /**
   * List all registered backend names.
   */
  listBackends(): readonly string[];

  /**
   * Get information about all registered backends.
   */
  getBackendInfo(): BackendInfo[];
  /**
   * Get information about specific backend.
   */
  getBackendInfo(name: string): BackendInfo | undefined;

  // ==========================================================================
  // Routing Configuration
  // ==========================================================================

  /**
   * Set fallback chain for sequential failover.
   */
  setFallbackChain(chain: readonly string[]): Router;

  /**
   * Get current fallback chain.
   */
  getFallbackChain(): readonly string[];

  /**
   * Set model to backend mapping.
   */
  setModelMapping(mapping: ModelMapping): Router;

  /**
   * Get current model mapping.
   */
  getModelMapping(): ModelMapping;

  /**
   * Set model pattern mappings.
   */
  setModelPatterns(patterns: readonly ModelPatternMapping[]): Router;

  /**
   * Get current model patterns.
   */
  getModelPatterns(): readonly ModelPatternMapping[];

  // ==========================================================================
  // Routing Operations
  // ==========================================================================

  /**
   * Select backend for a request.
   */
  selectBackend(request: IRChatRequest, preferredBackend?: string): Promise<string>;

  /**
   * Execute request with automatic backend selection and fallback.
   */
  execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse>;

  /**
   * Execute streaming request with automatic backend selection and fallback.
   */
  executeStream(request: IRChatRequest, signal?: AbortSignal): IRChatStream;

  /**
   * Dispatch request to multiple backends in parallel.
   */
  dispatchParallel(
    request: IRChatRequest,
    options?: ParallelDispatchOptions,
    signal?: AbortSignal
  ): Promise<ParallelDispatchResult>;

  // ==========================================================================
  // Health & Circuit Breaking
  // ==========================================================================

  /**
   * Check health of all backends.
   */
  checkHealth(): Promise<Record<string, boolean>>;
  /**
   * Check health of specific backend.
   */
  checkHealth(name: string): Promise<boolean>;

  /**
   * Manually open circuit breaker for a backend.
   *
   * `timeoutMs` is the rest period of **this open**, and is honoured in full:
   * it overrides the backend's own and the router-wide timeout alike, in both
   * directions (a longer value is not capped by a shorter configured one). It
   * is not remembered for later opens.
   */
  openCircuitBreaker(name: string, timeoutMs?: number): void;

  /**
   * Manually close circuit breaker for a backend.
   */
  closeCircuitBreaker(name: string): void;

  /**
   * Reset circuit breaker statistics.
   */
  resetCircuitBreaker(name?: string): void;

  /**
   * Check whether a backend is available to be routed to.
   *
   * This is the exact predicate routing uses, so it is the only reliable way
   * to pre-flight "will a request actually go where I ask?". It is stricter
   * than the circuit-breaker state alone: a backend that failed its last
   * health check is unhealthy and will not be routed to even though its
   * circuit is closed.
   *
   * Returns `false` for a name that is not registered.
   */
  isBackendAvailable(name: string): boolean;

  // ==========================================================================
  // Statistics & Monitoring
  // ==========================================================================

  /**
   * Get router statistics.
   */
  getStats(): RouterStats;

  /**
   * Reset router statistics.
   */
  resetStats(): void;

  /**
   * Get statistics for specific backend.
   */
  getBackendStats(name: string): BackendStats | undefined;

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Clone this router with a modified configuration.
   *
   * A clone is the same router with different settings, not a fresh one: it
   * inherits the backend registrations (sharing adapter instances), every
   * routing rule including the model *translation* mappings, the round-robin
   * cursor, the cumulative request/latency/cost accounting, and the health
   * verdict — `isHealthy` and the circuit-breaker state included, so cloning
   * to change one option cannot silently re-arm a backend the breaker had
   * taken out of rotation.
   *
   * The one exception is a clone that disables the circuit breaker: it starts
   * with all circuits closed, since nothing in it would ever recover one.
   *
   * Use `resetStats()` / `resetCircuitBreaker()` on the clone for a fresh
   * slate.
   */
  clone(config: Partial<RouterConfig>): Router;

  /**
   * Clean up resources.
   */
  dispose(): void;
}
