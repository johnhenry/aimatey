/**
 * Frontend and Backend Adapter Interfaces
 *
 * Adapters are the core translation layer between provider-specific formats
 * and the universal Intermediate Representation (IR).
 *
 * Architecture:
 * - Frontend Adapters: Normalize provider-specific requests → IR
 * - Backend Adapters: Transform IR → provider API calls → IR responses
 * - Both implement common interface with metadata for router decisions
 *
 * @module
 */

import type { IRChatRequest, IRChatResponse, IRChatStream, IRCapabilities } from './ir.js';
import type { IREmbedRequest, IREmbedResponse } from './embeddings.js';
import type { IRDecisionRequest, IRDecisionResponse } from './decisions.js';
import type { AIModel, ListModelsOptions, ListModelsResult } from './models.js';
import type { StreamingConfig, StreamConversionOptions } from './streaming.js';

// ============================================================================
// Adapter Metadata
// ============================================================================

/**
 * Adapter identification and capability metadata.
 *
 * Used by router for backend selection and compatibility checking.
 */
export interface AdapterMetadata {
  /**
   * Unique adapter identifier (lowercase, no spaces).
   * Used for routing and logging.
   */
  readonly name: string;

  /**
   * Semantic version of adapter implementation.
   */
  readonly version: string;

  /**
   * Human-readable provider name.
   */
  readonly provider: string;

  /**
   * Adapter capabilities for router decisions.
   */
  readonly capabilities: IRCapabilities;

  /**
   * Optional adapter-specific configuration.
   */
  readonly config?: Record<string, unknown>;
}

// ============================================================================
// Frontend Adapter Interface
// ============================================================================

/**
 * Frontend adapter interface.
 *
 * Frontend adapters represent how developers want to interact with AI APIs.
 * They normalize provider-specific request formats into universal IR and
 * denormalize IR responses back to provider-specific formats.
 *
 * @template TRequest Provider-specific request type
 * @template TResponse Provider-specific response type
 * @template TStreamChunk Provider-specific stream chunk type
 */
export interface FrontendAdapter<TRequest = unknown, TResponse = unknown, TStreamChunk = unknown> {
  /**
   * Adapter metadata for identification and capabilities.
   */
  readonly metadata: AdapterMetadata;

  /**
   * Convert provider-specific request to universal IR.
   *
   * @param request Provider-specific request object
   * @returns Universal IR request
   * @throws {ValidationError} If request is invalid for this provider
   * @throws {AdapterConversionError} If conversion fails
   */
  toIR(request: TRequest): Promise<IRChatRequest>;

  /**
   * Convert universal IR response to provider-specific format.
   *
   * @param response Universal IR response
   * @returns Provider-specific response object
   * @throws {AdapterConversionError} If conversion fails
   */
  fromIR(response: IRChatResponse): Promise<TResponse>;

  /**
   * Convert universal IR stream to provider-specific stream format.
   *
   * @param stream Universal IR stream
   * @param options Optional stream conversion options (mode, transform, etc.)
   * @returns Provider-specific stream of chunks
   * @throws {StreamError} If stream processing fails
   */
  fromIRStream(
    stream: IRChatStream,
    options?: StreamConversionOptions
  ): AsyncGenerator<TStreamChunk, void, undefined>;

  /**
   * Optional: Validate provider-specific request before conversion.
   *
   * @param request Provider-specific request
   * @throws {ValidationError} If request is invalid
   */
  validate?(request: TRequest): Promise<void>;
}

// ============================================================================
// Backend Adapter Interface
// ============================================================================

/**
 * Configuration options for backend adapters.
 */
export interface BackendAdapterConfig {
  /**
   * API key for authentication.
   * Should be injected from environment or secure config.
   *
   * **Optional on the base config, and required by the adapters that actually
   * use one** -- see {@link ApiKeyBackendAdapterConfig}.
   *
   * This was required until #104, which forced every caller of an adapter that
   * does not authenticate this way to invent a dummy string for a field with
   * no consumer. The type gave no hint that it was inert, so a required
   * credential field also invited callers to put a *real* secret somewhere
   * nothing would ever read it.
   *
   * Adapters that ignore it entirely: AWS Bedrock (SigV4 via
   * `awsAccessKeyId`/`awsSecretAccessKey`), Ollama and the model runner
   * (local, unauthenticated). LM Studio and OmniRoute read it only to
   * substitute the string `'not-needed'` when it is absent.
   */
  readonly apiKey?: string;

  /**
   * Base URL for API endpoint.
   * Useful for proxies or alternative endpoints.
   */
  readonly baseURL?: string;

  /**
   * Request timeout in milliseconds.
   * @default 30000
   */
  readonly timeout?: number;

  /**
   * Maximum number of retries for transient failures.
   * @default 0
   */
  readonly maxRetries?: number;

  /**
   * Enable debug logging.
   * @default false
   */
  readonly debug?: boolean;

  /**
   * Custom HTTP headers to include in requests.
   */
  readonly headers?: Record<string, string>;

  /**
   * Provider-specific configuration options.
   */
  readonly custom?: Record<string, unknown>;

  /**
   * Enable browser-compatible mode.
   *
   * ⚠️ **SECURITY WARNING**: Enabling browser mode may expose API keys in client-side code.
   * This option should ONLY be used for development and testing. Production applications
   * should always use proxy servers to protect API keys.
   *
   * Each provider implements browser compatibility differently:
   * - **Anthropic**: Adds `anthropic-dangerous-direct-browser-access: true` header
   * - **Gemini**: Already browser-compatible (API key in URL), this flag has no effect
   * - **OpenAI**: Already browser-compatible, this flag has no effect
   * - **Other providers**: May have provider-specific implementations
   *
   * @default false
   * @example
   * ```typescript
   * // Development only - DO NOT use in production!
   * const backend = new AnthropicBackendAdapter({
   *   apiKey: process.env.ANTHROPIC_API_KEY,
   *   browserMode: true  // ⚠️ Exposes API key in browser
   * });
   * ```
   */
  readonly browserMode?: boolean;

  // ---- Model Configuration ----

  /**
   * Default model to use when no model is specified in the request.
   * This provides a fallback model for requests that don't specify one.
   *
   * @example 'gpt-4o' for OpenAI, 'claude-3-5-sonnet-20241022' for Anthropic
   */
  readonly defaultModel?: string;

  // ---- Model Listing Configuration ----

  /**
   * Static model list (used when provider doesn't have listing endpoint
   * or to override remote list).
   *
   * Can be either:
   * - Array of model IDs (strings) - will be normalized to AIModel objects
   * - Array of full AIModel objects with capabilities
   */
  readonly models?: readonly (string | AIModel)[];

  /**
   * URL endpoint for fetching models (overrides default).
   * Used for custom model endpoints or proxies.
   */
  readonly modelsEndpoint?: string;

  /**
   * Enable model list caching.
   * @default true
   */
  readonly cacheModels?: boolean;

  /**
   * Cache TTL in milliseconds.
   * @default 3600000 (1 hour)
   */
  readonly modelsCacheTTL?: number;

  /**
   * Cache scope strategy.
   * - 'global': Share cache across all adapter instances (default)
   * - 'instance': Each adapter instance has its own cache
   * @default 'global'
   */
  readonly modelsCacheScope?: 'global' | 'instance';

  // ---- Streaming Configuration ----

  /**
   * Streaming configuration for this backend.
   *
   * Controls how streaming responses are delivered:
   * - mode: 'delta' (incremental only) or 'accumulated' (full text each chunk)
   * - includeBoth: Whether to provide both delta and accumulated in chunks
   * - bufferStrategy: How to buffer for accumulated mode
   *
   * @default { mode: 'delta', includeBoth: false, bufferStrategy: 'memory' }
   */
  readonly streaming?: StreamingConfig;
}

/**
 * A {@link BackendAdapterConfig} for an adapter that genuinely authenticates
 * with an API key, narrowing `apiKey` back to required.
 *
 * `apiKey` is optional on the base config because a good number of adapters
 * never read it (#104): AWS Bedrock signs with SigV4, Ollama and the model
 * runner talk to a local unauthenticated server, and LM Studio and OmniRoute
 * substitute `'not-needed'` when it is absent. Making it required for all of
 * them meant every such caller had to invent a dummy string.
 *
 * Requiring it *here* rather than dropping the requirement everywhere is the
 * other half of that change: an adapter that really does need a key must still
 * refuse to be constructed without one, so this is not a blanket weakening.
 *
 * @example
 * ```typescript
 * // Providers that authenticate with a bearer token or equivalent:
 * class OpenAIBackendAdapter {
 *   constructor(private readonly config: ApiKeyBackendAdapterConfig) {}
 * }
 * ```
 */
export type ApiKeyBackendAdapterConfig = BackendAdapterConfig & {
  readonly apiKey: string;
};

/**
 * Backend adapter interface.
 *
 * Backend adapters handle actual API calls to AI providers. They transform
 * universal IR into provider-specific API requests and normalize responses
 * back to IR.
 *
 * @template TRequest Provider-specific request type
 * @template TResponse Provider-specific response type
 */
export interface BackendAdapter<TRequest = unknown, TResponse = unknown> {
  /**
   * Adapter metadata for identification and capabilities.
   */
  readonly metadata: AdapterMetadata;

  /**
   * Convert universal IR request to provider-specific format (optional).
   *
   * Optional because chat is one capability among several a backend can
   * offer (see `embed?`/`decide?` below) — a decision-only backend (Jev,
   * Laya) has no chat request to convert and legitimately omits this
   * rather than faking one. Present whenever `execute`/`executeStream`
   * are; advertise chat support via `capabilities` fields such as
   * `maxContextTokens`/`systemMessageStrategy` being meaningful.
   *
   * Useful for:
   * - Debugging: Inspect what will be sent to the provider
   * - Testing: Test conversion logic without making API calls
   * - Transparency: See provider-specific request structure
   *
   * @param request Universal IR request
   * @returns Provider-specific request object
   * @throws {ValidationError} If request is invalid for this provider
   * @throws {AdapterConversionError} If conversion fails
   */
  fromIR?(request: IRChatRequest): TRequest;

  /**
   * Convert provider-specific response to universal IR (optional — see
   * {@link BackendAdapter.fromIR} for why).
   *
   * Useful for:
   * - Testing: Convert mock provider responses to IR
   * - Debugging: Parse provider responses manually
   * - Format conversion: Use backend as response converter
   *
   * @param response Provider-specific response object
   * @param originalRequest Original IR request (for context)
   * @param latencyMs Request latency in milliseconds
   * @returns Universal IR response
   * @throws {AdapterConversionError} If conversion fails
   */
  toIR?(response: TResponse, originalRequest: IRChatRequest, latencyMs: number): IRChatResponse;

  /**
   * Execute non-streaming chat completion request (optional).
   *
   * Optional for the same reason as {@link BackendAdapter.fromIR}: chat is
   * not the only capability a backend can implement. `Bridge.chat()`
   * checks for this before calling it and throws `UNSUPPORTED_FEATURE`
   * (the same pattern `Bridge.embed()`/`Bridge.decide()` already use) if a
   * backend that lacks it is used for a chat request.
   *
   * @param request Universal IR request
   * @param signal Optional AbortSignal for cancellation
   * @returns Universal IR response
   * @throws {AuthenticationError} If API key is invalid
   * @throws {ValidationError} If request is invalid for this provider
   * @throws {ProviderError} If provider API returns error
   * @throws {NetworkError} If network request fails
   * @throws {AdapterConversionError} If response parsing fails
   */
  execute?(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse>;

  /**
   * Execute streaming chat completion request (optional — see
   * {@link BackendAdapter.execute} for why).
   *
   * @param request Universal IR request
   * @param signal Optional AbortSignal for cancellation
   * @returns Universal IR stream of chunks
   * @throws {AuthenticationError} If API key is invalid
   * @throws {ValidationError} If request is invalid for this provider
   * @throws {ProviderError} If provider API returns error
   * @throws {NetworkError} If network request fails
   * @throws {StreamError} If stream parsing or processing fails
   */
  executeStream?(request: IRChatRequest, signal?: AbortSignal): IRChatStream;

  /**
   * Optional: Health check to verify backend is available.
   *
   * @returns true if backend is healthy and available
   */
  healthCheck?(): Promise<boolean>;

  /**
   * Optional: Estimate cost for a request.
   *
   * @param request IR request to estimate cost for
   * @returns Estimated cost in USD (or null if unavailable)
   */
  estimateCost?(request: IRChatRequest): Promise<number | null>;

  /**
   * Optional: List available models from this backend.
   *
   * Behavior depends on provider:
   * - Providers with API endpoints (OpenAI, Groq): Fetch from API with caching
   * - Providers without endpoints (Anthropic): Return static list from config or defaults
   * - Can be overridden via config.models or config.modelsEndpoint
   *
   * @param options Options for listing models (filtering, cache control)
   * @returns List of available models with metadata
   * @throws {ProviderError} If remote fetch fails
   * @throws {NetworkError} If network request fails
   */
  listModels?(options?: ListModelsOptions): Promise<ListModelsResult>;

  /**
   * Generate embeddings (optional capability).
   *
   * Present when the provider offers an embeddings API; advertise it via
   * `capabilities.embeddings`. Accepts single or batched input and must
   * preserve input order in the response.
   */
  embed?(request: IREmbedRequest, signal?: AbortSignal): Promise<IREmbedResponse>;

  /**
   * Estimate the cost of an embedding request in USD (optional).
   */
  estimateEmbedCost?(request: IREmbedRequest): Promise<number | null>;

  /**
   * Answer a typed-decision request (optional capability).
   *
   * Present when the provider offers a "System One" typed-decision API
   * (Jev, Laya); advertise it via `capabilities.decisions`. Unlike
   * `embed?`, a backend can implement this with **no** chat support at
   * all — `fromIR`/`toIR`/`execute`/`executeStream` are all optional
   * precisely so a decision-only backend isn't forced to fake them.
   */
  decide?(request: IRDecisionRequest, signal?: AbortSignal): Promise<IRDecisionResponse>;

  /**
   * Estimate the cost of a decision request in USD (optional).
   */
  estimateDecisionCost?(request: IRDecisionRequest): Promise<number | null>;
}

// ============================================================================
// Adapter Registry
// ============================================================================

/**
 * Registry for managing available adapters.
 *
 * Used internally by routers and bridges to discover and instantiate adapters.
 */
export interface AdapterRegistry {
  /**
   * Register a frontend adapter type.
   *
   * @param name Unique adapter identifier
   * @param adapterClass Frontend adapter constructor
   */
  registerFrontend<T extends FrontendAdapter>(name: string, adapterClass: new () => T): void;

  /**
   * Register a backend adapter type.
   *
   * @param name Unique adapter identifier
   * @param adapterClass Backend adapter constructor
   */
  registerBackend<T extends BackendAdapter>(
    name: string,
    adapterClass: new (config: BackendAdapterConfig) => T
  ): void;

  /**
   * Get frontend adapter instance by name.
   *
   * @param name Adapter identifier
   * @returns Frontend adapter instance
   * @throws {Error} If adapter not found
   */
  getFrontend(name: string): FrontendAdapter;

  /**
   * Get backend adapter instance by name.
   *
   * @param name Adapter identifier
   * @param config Backend configuration
   * @returns Backend adapter instance
   * @throws {Error} If adapter not found
   */
  getBackend(name: string, config: BackendAdapterConfig): BackendAdapter;

  /**
   * List all registered frontend adapters.
   */
  listFrontends(): string[];

  /**
   * List all registered backend adapters.
   */
  listBackends(): string[];

  /**
   * Check if frontend adapter is registered.
   */
  hasFrontend(name: string): boolean;

  /**
   * Check if backend adapter is registered.
   */
  hasBackend(name: string): boolean;
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Adapter pair for type-safe frontend/backend combinations.
 */
export type AdapterPair<
  TFrontend extends FrontendAdapter = FrontendAdapter,
  TBackend extends BackendAdapter = BackendAdapter,
> = {
  readonly frontend: TFrontend;
  readonly backend: TBackend;
};

/**
 * Infer provider request type from frontend adapter.
 */
export type InferFrontendRequest<T extends FrontendAdapter> =
  T extends FrontendAdapter<infer TRequest, any, any> ? TRequest : never;

/**
 * Infer provider response type from frontend adapter.
 */
export type InferFrontendResponse<T extends FrontendAdapter> =
  T extends FrontendAdapter<any, infer TResponse, any> ? TResponse : never;

/**
 * Infer provider stream chunk type from frontend adapter.
 */
export type InferFrontendStreamChunk<T extends FrontendAdapter> =
  T extends FrontendAdapter<any, any, infer TStreamChunk> ? TStreamChunk : never;
