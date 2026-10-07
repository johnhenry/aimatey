/**
 * Function Backend Adapter
 *
 * A generic backend adapter that accepts async functions for execute and stream operations.
 * Useful for testing, custom integrations, and creating backend adapters from simple functions.
 *
 * @module
 */

import type {
  BackendAdapter,
  AdapterMetadata,
  IRCapabilities,
  ProvenanceLocality,
} from '@johnhenry/aimatey-types';
import type {
  IRChatRequest,
  IRChatResponse,
  IRChatStream,
  IRStreamChunk,
} from '@johnhenry/aimatey-types';
import type { ListModelsOptions, ListModelsResult } from '@johnhenry/aimatey-types';

// ============================================================================
// Function Types
// ============================================================================

/**
 * Execute function signature for non-streaming requests.
 */
export type ExecuteFunction = (
  request: IRChatRequest,
  signal?: AbortSignal
) => Promise<IRChatResponse>;

/**
 * Execute stream function signature for streaming requests.
 */
export type ExecuteStreamFunction = (
  request: IRChatRequest,
  signal?: AbortSignal
) => AsyncIterable<IRStreamChunk>;

/**
 * Health check function signature.
 */
export type HealthCheckFunction = () => Promise<boolean>;

/**
 * Estimate cost function signature.
 */
export type EstimateCostFunction = (request: IRChatRequest) => Promise<number | null>;

/**
 * List models function signature.
 */
export type ListModelsFunction = (options?: ListModelsOptions) => Promise<ListModelsResult>;

/**
 * FromIR conversion function signature.
 */
export type FromIRFunction<TRequest = IRChatRequest> = (request: IRChatRequest) => TRequest;

/**
 * ToIR conversion function signature.
 */
export type ToIRFunction<TResponse = IRChatResponse> = (
  response: TResponse,
  originalRequest: IRChatRequest,
  latencyMs: number
) => IRChatResponse;

// ============================================================================
// Configuration
// ============================================================================

/**
 * Partial adapter metadata for customization.
 */
export interface FunctionBackendMetadata {
  /** Adapter name (default: 'function-backend') */
  name?: string;
  /** Adapter version (default: '1.0.0') */
  version?: string;
  /** Provider name (default: 'Function') */
  provider?: string;
  /** Custom capabilities */
  capabilities?: Partial<IRCapabilities>;
}

/**
 * Configuration for the function backend adapter.
 */
export interface FunctionBackendConfig<TRequest = IRChatRequest, TResponse = IRChatResponse> {
  /**
   * Execute function for non-streaming requests.
   * Required.
   */
  execute: ExecuteFunction;

  /**
   * Execute stream function for streaming requests.
   * Optional - if not provided, streaming will not be supported.
   */
  executeStream?: ExecuteStreamFunction;

  /**
   * Custom metadata for the adapter.
   */
  metadata?: FunctionBackendMetadata;

  /**
   * What the function does with a request, for `IRProvenance.locality`:
   * `'in-process'` for a function that computes locally, `'same-host'` for one
   * that calls a daemon on this machine, `'external'` for one that calls out.
   *
   * Only the author of the function knows, so the adapter does not guess: left
   * unset, no `locality` is declared and consumers fail closed to `'external'`.
   */
  locality?: ProvenanceLocality;

  /**
   * Custom fromIR conversion function.
   * Default: returns request unchanged.
   */
  fromIR?: FromIRFunction<TRequest>;

  /**
   * Custom toIR conversion function.
   * Default: returns response unchanged with updated metadata.
   */
  toIR?: ToIRFunction<TResponse>;

  /**
   * Custom health check function.
   * Default: returns true.
   */
  healthCheck?: HealthCheckFunction;

  /**
   * Custom cost estimation function.
   * Default: returns null.
   */
  estimateCost?: EstimateCostFunction;

  /**
   * Custom list models function.
   * Default: returns empty list.
   */
  listModels?: ListModelsFunction;
}

// ============================================================================
// Function Backend Adapter
// ============================================================================

/**
 * Generic function-based backend adapter.
 *
 * Accepts async functions for execute and stream operations, making it easy to:
 * - Create custom backends from simple functions
 * - Write integration tests with controlled behavior
 * - Wrap external services or APIs
 * - Create mock backends with specific responses
 *
 * @example
 * ```typescript
 * // Simple echo backend
 * const echoBackend = new FunctionBackendAdapter({
 *   execute: async (request) => ({
 *     message: { role: 'assistant', content: `Echo: ${request.messages[0]?.content}` },
 *     finishReason: 'stop',
 *     metadata: { requestId: request.metadata.requestId, provenance: {} },
 *   }),
 * });
 *
 * // Backend with streaming
 * const streamingBackend = new FunctionBackendAdapter({
 *   execute: async (request) => ({ ... }),
 *   executeStream: async function* (request) {
 *     yield { type: 'start', sequence: 0 };
 *     yield { type: 'content', sequence: 1, delta: 'Hello', role: 'assistant' };
 *     yield { type: 'done', sequence: 2, finishReason: 'stop', message: { ... } };
 *   },
 * });
 * ```
 */
export class FunctionBackendAdapter<
  TRequest = IRChatRequest,
  TResponse = IRChatResponse,
> implements BackendAdapter<TRequest, TResponse> {
  readonly metadata: AdapterMetadata;

  private readonly executeFn: ExecuteFunction;
  private readonly executeStreamFn?: ExecuteStreamFunction;
  private readonly fromIRFn: FromIRFunction<TRequest>;
  private readonly toIRFn: ToIRFunction<TResponse>;
  private readonly healthCheckFn: HealthCheckFunction;
  private readonly estimateCostFn: EstimateCostFunction;
  private readonly listModelsFn: ListModelsFunction;
  private readonly locality: ProvenanceLocality | undefined;

  /**
   * Create a new function-based backend adapter.
   *
   * @param config Configuration with execute function and optional customizations
   */
  constructor(config: FunctionBackendConfig<TRequest, TResponse>) {
    // Store functions
    this.executeFn = config.execute;
    this.locality = config.locality;
    this.executeStreamFn = config.executeStream;

    // Set up conversion functions with defaults
    this.fromIRFn = config.fromIR || ((request) => request as unknown as TRequest);
    this.toIRFn =
      config.toIR || ((response, _request, _latency) => response as unknown as IRChatResponse);

    // Set up optional functions with defaults
    this.healthCheckFn = config.healthCheck || (() => Promise.resolve(true));
    this.estimateCostFn = config.estimateCost || (() => Promise.resolve(null));
    this.listModelsFn =
      config.listModels ||
      (() =>
        Promise.resolve({
          models: [],
          source: 'static' as const,
          fetchedAt: Date.now(),
          isComplete: true,
        }));

    // Build metadata
    const customMetadata = config.metadata || {};
    const name = customMetadata.name || 'function-backend';

    this.metadata = {
      name,
      version: customMetadata.version || '1.0.0',
      provider: customMetadata.provider || 'Function',
      capabilities: {
        streaming: !!config.executeStream,
        multiModal: customMetadata.capabilities?.multiModal ?? false,
        tools: customMetadata.capabilities?.tools ?? false,
        maxContextTokens: customMetadata.capabilities?.maxContextTokens ?? 128000,
        systemMessageStrategy: customMetadata.capabilities?.systemMessageStrategy ?? 'in-messages',
        supportsMultipleSystemMessages:
          customMetadata.capabilities?.supportsMultipleSystemMessages ?? true,
        supportsTemperature: customMetadata.capabilities?.supportsTemperature ?? true,
        supportsTopP: customMetadata.capabilities?.supportsTopP ?? true,
        supportsTopK: customMetadata.capabilities?.supportsTopK ?? false,
        supportsSeed: customMetadata.capabilities?.supportsSeed ?? false,
        supportsFrequencyPenalty: customMetadata.capabilities?.supportsFrequencyPenalty ?? false,
        supportsPresencePenalty: customMetadata.capabilities?.supportsPresencePenalty ?? false,
        maxStopSequences: customMetadata.capabilities?.maxStopSequences ?? 4,
        ...customMetadata.capabilities,
      },
      config: {},
    };
  }

  /**
   * Convert IR request to provider-specific format.
   * Default implementation returns the request unchanged.
   */
  fromIR(request: IRChatRequest): TRequest {
    return this.fromIRFn(request);
  }

  /**
   * Convert provider response to IR format.
   * Default implementation returns the response with updated metadata.
   */
  toIR(response: TResponse, originalRequest: IRChatRequest, latencyMs: number): IRChatResponse {
    const irResponse = this.toIRFn(response, originalRequest, latencyMs);

    // Ensure backend name is in provenance
    return {
      ...irResponse,
      metadata: {
        ...irResponse.metadata,
        provenance: {
          ...irResponse.metadata.provenance,
          backend: this.metadata.name,
          ...(this.locality !== undefined && { locality: this.locality }),
        },
      },
    };
  }

  /**
   * Execute non-streaming chat completion request.
   */
  async execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse> {
    const startTime = Date.now();
    const response = await this.executeFn(request, signal);
    const latencyMs = Date.now() - startTime;

    // Ensure backend name is in provenance
    return {
      ...response,
      metadata: {
        ...response.metadata,
        provenance: {
          ...response.metadata.provenance,
          backend: this.metadata.name,
          ...(this.locality !== undefined && { locality: this.locality }),
        },
        custom: {
          ...response.metadata.custom,
          latencyMs,
        },
      },
    };
  }

  /**
   * Execute streaming chat completion request.
   */
  async *executeStream(request: IRChatRequest, signal?: AbortSignal): IRChatStream {
    if (!this.executeStreamFn) {
      yield {
        type: 'error',
        sequence: 0,
        error: {
          code: 'STREAMING_NOT_SUPPORTED',
          message:
            'This function backend does not support streaming. Provide an executeStream function in the config.',
        },
      } as IRStreamChunk;
      return;
    }

    yield* this.executeStreamFn(request, signal);
  }

  /**
   * Health check to verify backend is available.
   */
  async healthCheck(): Promise<boolean> {
    return this.healthCheckFn();
  }

  /**
   * Estimate cost for a request.
   */
  async estimateCost(request: IRChatRequest): Promise<number | null> {
    return this.estimateCostFn(request);
  }

  /**
   * List available models.
   */
  async listModels(options?: ListModelsOptions): Promise<ListModelsResult> {
    return this.listModelsFn(options);
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a simple function backend from an execute function.
 *
 * @param execute Execute function
 * @param name Optional adapter name
 * @returns FunctionBackendAdapter instance
 *
 * @example
 * ```typescript
 * const backend = createFunctionBackend(async (request) => ({
 *   message: { role: 'assistant', content: 'Hello!' },
 *   finishReason: 'stop',
 *   metadata: { requestId: request.metadata.requestId, provenance: {} },
 * }));
 * ```
 */
export function createFunctionBackend(
  execute: ExecuteFunction,
  name?: string
): FunctionBackendAdapter {
  return new FunctionBackendAdapter({
    execute,
    metadata: name ? { name } : undefined,
  });
}

/**
 * Create an echo backend that reflects the user's message.
 *
 * @param prefix Optional prefix for echo response (default: 'Echo: ')
 * @returns FunctionBackendAdapter instance
 *
 * @example
 * ```typescript
 * const backend = createSimpleEchoBackend();
 * const response = await backend.execute({ messages: [{ role: 'user', content: 'Hello' }], ... });
 * // response.message.content === 'Echo: Hello'
 * ```
 */
export function createSimpleEchoBackend(prefix = 'Echo: '): FunctionBackendAdapter {
  return new FunctionBackendAdapter({
    execute: (request) => {
      const userMessage = request.messages.find((m) => m.role === 'user');
      const content =
        typeof userMessage?.content === 'string'
          ? userMessage.content
          : JSON.stringify(userMessage?.content || '');

      return Promise.resolve({
        message: { role: 'assistant', content: `${prefix}${content}` },
        finishReason: 'stop',
        metadata: {
          requestId: request.metadata.requestId,
          timestamp: Date.now(),
          provenance: {},
        },
      });
    },
    metadata: { name: 'echo-backend' },
  });
}

/**
 * Create a static response backend that always returns the same response.
 *
 * @param response Static response content
 * @returns FunctionBackendAdapter instance
 *
 * @example
 * ```typescript
 * const backend = createStaticBackend('I am a static response.');
 * ```
 */
export function createStaticBackend(response: string): FunctionBackendAdapter {
  return new FunctionBackendAdapter({
    execute: (request) =>
      Promise.resolve({
        message: { role: 'assistant', content: response },
        finishReason: 'stop',
        metadata: {
          requestId: request.metadata.requestId,
          timestamp: Date.now(),
          provenance: {},
        },
      }),
    metadata: { name: 'static-backend' },
  });
}
