/**
 * OpenTelemetry Middleware
 *
 * Provides distributed tracing and metrics export using OpenTelemetry.
 * OpenTelemetry packages are optional peer dependencies - this middleware
 * will check for their availability at runtime.
 *
 * @module
 */

import type {
  Middleware,
  MiddlewareContext,
  MiddlewareNext,
  TelemetrySink,
} from '@johnhenry/aimatey-types';
import type { IRChatResponse } from '@johnhenry/aimatey-types';
import { resolveServedModel } from '@johnhenry/aimatey-types';

// Type imports for OpenTelemetry (won't fail if packages aren't installed)
type Tracer = any;
type Span = any;

// ============================================================================
// Runtime Availability Check
// ============================================================================

let otelAvailable = false;
let api: any = null;
let TracerProvider: any = null;
let OTLPTraceExporter: any = null;
let Resource: any = null;
let SEMRESATTRS_SERVICE_NAME: any = null;
let SEMRESATTRS_SERVICE_VERSION: any = null;
let BatchSpanProcessor: any = null;

/**
 * Check if OpenTelemetry packages are available and load them.
 */
async function checkOpenTelemetryAvailability(): Promise<boolean> {
  if (otelAvailable) {
    return true;
  }

  try {
    // Use dynamic import() for ESM/CJS compatibility
    const [apiModule, sdkTraceBase, otlpExporter, resources, semanticConventions] =
      await Promise.all([
        import('@opentelemetry/api'),
        import('@opentelemetry/sdk-trace-base'),
        import('@opentelemetry/exporter-trace-otlp-http'),
        import('@opentelemetry/resources'),
        import('@opentelemetry/semantic-conventions'),
      ]);

    api = apiModule;
    TracerProvider = sdkTraceBase.BasicTracerProvider;
    BatchSpanProcessor = sdkTraceBase.BatchSpanProcessor;
    OTLPTraceExporter = otlpExporter.OTLPTraceExporter;
    Resource = resources.Resource;
    SEMRESATTRS_SERVICE_NAME = semanticConventions.SEMRESATTRS_SERVICE_NAME;
    SEMRESATTRS_SERVICE_VERSION = semanticConventions.SEMRESATTRS_SERVICE_VERSION;

    otelAvailable = true;
    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronous check if OpenTelemetry is already loaded.
 * Use checkOpenTelemetryAvailability() for the full check.
 */
function isOtelLoaded(): boolean {
  return otelAvailable;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Batch span processor configuration.
 */
export interface BatchSpanProcessorConfig {
  /**
   * Maximum queue size for buffering spans.
   * @default 2048
   */
  maxQueueSize?: number;

  /**
   * Maximum batch size per export.
   * @default 512
   */
  maxExportBatchSize?: number;

  /**
   * Scheduled delay (in milliseconds) for batching.
   * @default 5000
   */
  scheduledDelayMillis?: number;

  /**
   * Export timeout (in milliseconds).
   * @default 30000
   */
  exportTimeoutMillis?: number;
}

/**
 * Configuration for OpenTelemetry middleware.
 */
export interface OpenTelemetryConfig {
  /**
   * Service name for OpenTelemetry.
   * @default 'ai-matey'
   */
  serviceName?: string;

  /**
   * Service version for OpenTelemetry.
   * @default '0.1.0'
   */
  serviceVersion?: string;

  /**
   * OTLP endpoint URL.
   * @default 'http://localhost:4318/v1/traces'
   */
  endpoint?: string;

  /**
   * Custom headers for OTLP export.
   */
  headers?: Record<string, string>;

  /**
   * Sampling rate (0.0 to 1.0).
   * @default 1.0 (100%)
   */
  samplingRate?: number;

  /**
   * Custom resource attributes.
   */
  resourceAttributes?: Record<string, string>;

  /**
   * Whether to export spans.
   * @default true
   */
  exportSpans?: boolean;

  /**
   * Custom tracer name.
   * @default 'ai-matey-tracer'
   */
  tracerName?: string;

  /**
   * Batch span processor configuration.
   */
  batchSpanProcessorConfig?: BatchSpanProcessorConfig;

  /**
   * OTLP exporter timeout (in milliseconds).
   * @default 10000
   */
  exporterTimeoutMillis?: number;
}

/**
 * OpenTelemetry span attribute names.
 */
export const OpenTelemetryAttributes = {
  // Request attributes
  REQUEST_ID: 'ai.request.id',
  REQUEST_MODEL: 'ai.request.model',
  REQUEST_STREAM: 'ai.request.stream',
  REQUEST_MESSAGE_COUNT: 'ai.request.message_count',
  REQUEST_MAX_TOKENS: 'ai.request.max_tokens',

  // Response attributes
  RESPONSE_BACKEND: 'ai.response.backend',
  RESPONSE_FINISH_REASON: 'ai.response.finish_reason',
  RESPONSE_MODEL: 'ai.response.model',

  // Token usage attributes
  TOKENS_PROMPT: 'ai.tokens.prompt',
  TOKENS_COMPLETION: 'ai.tokens.completion',
  TOKENS_TOTAL: 'ai.tokens.total',

  // Provenance attributes
  FRONTEND: 'ai.frontend',
  BACKEND: 'ai.backend',

  // Performance attributes
  DURATION_MS: 'ai.duration.ms',
} as const;

// ============================================================================
// Tracer Provider Singleton
// ============================================================================

let globalTracerProvider: any = null;
let globalTracerProviderConfig: string | null = null;
let providerInitializationPromise: Promise<any> | null = null;

/**
 * Get or create the global tracer provider.
 *
 * WARNING: This uses a singleton pattern. If you call this multiple times
 * with different configs, only the first config will be used. To reset,
 * call shutdownOpenTelemetry() first.
 *
 * This function is NOT thread-safe for concurrent calls, but uses a promise
 * to prevent race conditions during initialization.
 */
async function getOrCreateTracerProvider(config: OpenTelemetryConfig): Promise<any> {
  // Create a config hash to detect configuration changes
  const configHash = JSON.stringify({
    serviceName: config.serviceName,
    serviceVersion: config.serviceVersion,
    endpoint: config.endpoint,
    exportSpans: config.exportSpans,
  });

  if (globalTracerProvider) {
    // Warn if trying to create with different config
    if (globalTracerProviderConfig && globalTracerProviderConfig !== configHash) {
      console.warn(
        '[OpenTelemetry] Tracer provider already initialized with different config. ' +
          'Call shutdownOpenTelemetry() to reset before creating with new config.'
      );
    }
    return globalTracerProvider;
  }

  // If initialization is in progress, wait for it
  if (providerInitializationPromise) {
    return providerInitializationPromise;
  }

  // Start initialization
  providerInitializationPromise = (() => {
    try {
      const {
        serviceName = 'ai-matey',
        serviceVersion = '0.1.0',
        endpoint = 'http://localhost:4318/v1/traces',
        headers = {},
        resourceAttributes = {},
        exportSpans = true,
        batchSpanProcessorConfig = {},
        exporterTimeoutMillis = 10000,
      } = config;

      // Create resource with service information
      const resource = new Resource({
        [SEMRESATTRS_SERVICE_NAME]: serviceName,
        [SEMRESATTRS_SERVICE_VERSION]: serviceVersion,
        ...resourceAttributes,
      });

      // Create tracer provider
      const provider = new TracerProvider({
        resource,
      });

      // Add span processor with OTLP exporter if spans should be exported
      if (exportSpans) {
        const exporter = new OTLPTraceExporter({
          url: endpoint,
          headers,
          timeoutMillis: exporterTimeoutMillis,
        });

        const processorConfig = {
          maxQueueSize: batchSpanProcessorConfig.maxQueueSize,
          maxExportBatchSize: batchSpanProcessorConfig.maxExportBatchSize,
          scheduledDelayMillis: batchSpanProcessorConfig.scheduledDelayMillis,
          exportTimeoutMillis: batchSpanProcessorConfig.exportTimeoutMillis,
        };

        provider.addSpanProcessor(new BatchSpanProcessor(exporter, processorConfig));
      }

      // Register the provider
      api.trace.setGlobalTracerProvider(provider);

      globalTracerProvider = provider;
      globalTracerProviderConfig = configHash;
      return Promise.resolve(provider);
    } finally {
      // Clear the initialization promise whether success or failure
      providerInitializationPromise = null;
    }
  })();

  return providerInitializationPromise;
}

// ============================================================================
// Sampling
// ============================================================================

/**
 * Determine if this request should be sampled.
 *
 * @internal Shared with the decision OpenTelemetry middleware.
 */
export function shouldSample(samplingRate: number): boolean {
  return Math.random() < samplingRate;
}

// ============================================================================
// Served Model
// ============================================================================

/**
 * The model that actually generated a response, or `undefined` if it cannot be determined.
 *
 * The OpenTelemetry GenAI semantic conventions draw a deliberate distinction:
 * `request.model` is "the name of the GenAI model a request is being made to" (e.g. `gpt-4`)
 * while `response.model` is "the name of the model that generated the response"
 * (e.g. `gpt-4-0613`). The two attributes exist in order to differ -- a provider may resolve
 * an alias to a dated snapshot, and aimatey's own router may substitute a model outright
 * (the `model-substituted` warning category).
 *
 * The primary source is the typed `IRProvenance.servedModel` field (#113), which every
 * backend adapter that can report a served model now fills from the provider's own response
 * payload. `resolveServedModel` walks a proxied chain to the hop that actually served, so a
 * `phone -> desktop -> llama-cpp` response reports llama-cpp's model rather than the tunnel's
 * name. This middleware needs no per-provider knowledge to read it -- notably, Gemini reports
 * its served model as `modelVersion`, and that difference is now the *adapter's* problem
 * rather than tracing's.
 *
 * `raw.model` is kept strictly as a **fallback**, for responses whose provenance predates the
 * typed field: an out-of-tree `BackendAdapter` written against the older IR (the field is
 * optional, so such an adapter still compiles), a response restored from a cache written by
 * an older version, or a recorded fixture. No adapter shipped in this repository reaches it.
 * It is deliberately not extended with per-provider keys -- adding `raw.modelVersion` for
 * Gemini here would re-couple tracing to payload shapes in the same change that decouples it.
 *
 * This deliberately does NOT fall back to the requested model. Reporting the requested model
 * as the served one would make `ai.response.model` a duplicate of `ai.request.model` by
 * construction, and would assert a model that never served in exactly the substitution case
 * the attribute exists to record. Leaving the attribute unset keeps "not reported"
 * distinguishable from "reported as X" -- which is the honest outcome for the four providers
 * that do not echo a served model at all (Cohere, Bedrock, HuggingFace, Replicate).
 */
function getServedModel(response: IRChatResponse): string | undefined {
  const servedModel = resolveServedModel(response.metadata.provenance);
  if (servedModel !== undefined) {
    return servedModel;
  }

  const model = response.raw?.['model'];
  return typeof model === 'string' && model.length > 0 ? model : undefined;
}

// ============================================================================
// Tracer Acquisition
// ============================================================================

/**
 * Load the optional OpenTelemetry packages and return a tracer from the
 * shared provider singleton, plus the loaded `@opentelemetry/api` module.
 *
 * The one place the "are the peer packages installed" check, the provider
 * setup and the tracer lookup live, shared by the chat and decision
 * middleware so both report spans through the same provider.
 *
 * @throws Error if OpenTelemetry packages are not installed
 * @internal
 */
export async function acquireTracer(
  config: OpenTelemetryConfig
): Promise<{ tracer: Tracer; api: any }> {
  // Check if OpenTelemetry is available
  const available = await checkOpenTelemetryAvailability();
  if (!available) {
    throw new Error(
      'OpenTelemetry packages are not installed. Please install:\n' +
        'npm install @opentelemetry/api @opentelemetry/sdk-trace-base ' +
        '@opentelemetry/exporter-trace-otlp-http @opentelemetry/resources ' +
        '@opentelemetry/semantic-conventions'
    );
  }

  const { tracerName = 'ai-matey-tracer' } = config;

  // Initialize tracer provider (async to handle race conditions)
  const provider = await getOrCreateTracerProvider(config);
  return { tracer: provider.getTracer(tracerName), api };
}

// ============================================================================
// Middleware Factory
// ============================================================================

/**
 * Create OpenTelemetry middleware.
 *
 * Provides distributed tracing with span creation, context propagation,
 * and metrics export via OpenTelemetry.
 *
 * **Note:** This middleware requires optional OpenTelemetry packages to be installed:
 * - `@opentelemetry/api`
 * - `@opentelemetry/sdk-trace-base`
 * - `@opentelemetry/exporter-trace-otlp-http`
 * - `@opentelemetry/resources`
 * - `@opentelemetry/semantic-conventions`
 *
 * Install with:
 * ```bash
 * npm install @opentelemetry/api @opentelemetry/sdk-trace-base \
 *   @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources \
 *   @opentelemetry/semantic-conventions
 * ```
 *
 * @param config OpenTelemetry configuration
 * @returns Promise that resolves to OpenTelemetry middleware
 * @throws Error if OpenTelemetry packages are not installed
 *
 * @example
 * ```typescript
 * import { createOpenTelemetryMiddleware } from '@johnhenry/aimatey-middleware';
 *
 * const otel = await createOpenTelemetryMiddleware({
 *   serviceName: 'my-ai-service',
 *   endpoint: 'http://localhost:4318/v1/traces',
 *   samplingRate: 1.0
 * });
 *
 * bridge.use(otel);
 * ```
 */
export async function createOpenTelemetryMiddleware(
  config: OpenTelemetryConfig = {}
): Promise<Middleware> {
  const { samplingRate = 1.0 } = config;
  const { tracer, api } = await acquireTracer(config);

  return async (context: MiddlewareContext, next: MiddlewareNext): Promise<IRChatResponse> => {
    // Check if we should sample this request
    const sampled = shouldSample(samplingRate);

    if (!sampled) {
      // Skip tracing for this request
      return next();
    }

    const requestId = context.request.metadata.requestId;

    // Create span for the request
    const span: Span = tracer.startSpan('aimatey-request', {
      attributes: {
        [OpenTelemetryAttributes.REQUEST_ID]: requestId,
        [OpenTelemetryAttributes.REQUEST_MODEL]: context.request.parameters?.model ?? 'unknown',
        [OpenTelemetryAttributes.REQUEST_STREAM]: String(context.request.stream ?? false),
        [OpenTelemetryAttributes.REQUEST_MESSAGE_COUNT]: context.request.messages.length,
        [OpenTelemetryAttributes.FRONTEND]:
          context.request.metadata.provenance?.frontend ?? 'unknown',
      },
    });

    // Add max_tokens if present
    if (context.request.parameters?.maxTokens) {
      span.setAttribute(
        OpenTelemetryAttributes.REQUEST_MAX_TOKENS,
        context.request.parameters.maxTokens
      );
    }

    const startTime = Date.now();

    try {
      // Execute within span context
      const spanContext = api.trace.setSpan(api.context.active(), span);

      // Call next middleware/handler in the span context.
      // `api` is deliberately `any` (optional peer dependency), so annotate the result:
      // without this every property access on `response` is unchecked, which is how a read
      // of a non-existent provenance field survived review (#112).
      const response: IRChatResponse = await api.context.with(spanContext, async () => {
        return await next();
      });

      const duration = Date.now() - startTime;

      // Add response attributes to span
      span.setAttribute(
        OpenTelemetryAttributes.RESPONSE_BACKEND,
        response.metadata.provenance?.backend ?? 'unknown'
      );
      span.setAttribute(OpenTelemetryAttributes.RESPONSE_FINISH_REASON, response.finishReason);
      span.setAttribute(OpenTelemetryAttributes.DURATION_MS, duration);

      const servedModel = getServedModel(response);
      if (servedModel !== undefined) {
        span.setAttribute(OpenTelemetryAttributes.RESPONSE_MODEL, servedModel);
      }

      // Add token usage if present
      if (response.usage) {
        if (response.usage.promptTokens) {
          span.setAttribute(OpenTelemetryAttributes.TOKENS_PROMPT, response.usage.promptTokens);
        }
        if (response.usage.completionTokens) {
          span.setAttribute(
            OpenTelemetryAttributes.TOKENS_COMPLETION,
            response.usage.completionTokens
          );
        }
        if (response.usage.totalTokens) {
          span.setAttribute(OpenTelemetryAttributes.TOKENS_TOTAL, response.usage.totalTokens);
        }
      }

      // Mark span as successful
      span.setStatus({ code: api.SpanStatusCode.OK });
      span.end();

      return response;
    } catch (error) {
      const duration = Date.now() - startTime;

      // Safely add error information to span
      // Wrap in try-catch to prevent span operations from masking the original error
      try {
        span.setAttribute(OpenTelemetryAttributes.DURATION_MS, duration);
        span.setAttribute('error', true);
        span.setAttribute('error.type', error instanceof Error ? error.name : 'unknown');

        if (error instanceof Error) {
          span.recordException(error);
          span.setStatus({
            code: api.SpanStatusCode.ERROR,
            message: error.message,
          });
        } else {
          span.setStatus({
            code: api.SpanStatusCode.ERROR,
            message: String(error),
          });
        }

        span.end();
      } catch (spanError) {
        // If span operations fail, log but don't mask the original error
        console.error('[OpenTelemetry] Failed to record error in span:', spanError);
        // Try to end the span anyway to prevent memory leak
        try {
          span.end();
        } catch {
          // Ignore - best effort to clean up
        }
      }

      // Always re-throw the original error
      throw error;
    }
  };
}

// ============================================================================
// OpenTelemetry Telemetry Sink
// ============================================================================

/**
 * OpenTelemetry-based telemetry sink.
 *
 * Implements the TelemetrySink interface using OpenTelemetry metrics.
 * This allows you to use the existing telemetry middleware with OpenTelemetry.
 *
 * **Note:** Currently uses spans for metrics as the OpenTelemetry metrics API
 * is still evolving. Consider using createOpenTelemetryMiddleware for full
 * tracing support.
 */
export class OpenTelemetryTelemetrySink implements TelemetrySink {
  private tracer: Tracer;

  private constructor(tracer: Tracer) {
    this.tracer = tracer;
  }

  /**
   * Create a new OpenTelemetryTelemetrySink instance.
   *
   * @param config OpenTelemetry configuration
   * @returns Promise that resolves to a new sink instance
   * @throws Error if OpenTelemetry packages are not installed
   */
  static async create(config: OpenTelemetryConfig = {}): Promise<OpenTelemetryTelemetrySink> {
    // Check if OpenTelemetry is available
    const available = await checkOpenTelemetryAvailability();
    if (!available) {
      throw new Error(
        'OpenTelemetry packages are not installed. Please install:\n' +
          'npm install @opentelemetry/api @opentelemetry/sdk-trace-base ' +
          '@opentelemetry/exporter-trace-otlp-http @opentelemetry/resources ' +
          '@opentelemetry/semantic-conventions'
      );
    }

    const { tracerName = 'ai-matey-telemetry-sink' } = config;

    // Initialize tracer provider (async to handle race conditions)
    const provider = await getOrCreateTracerProvider(config);
    const tracer = provider.getTracer(tracerName);

    return new OpenTelemetryTelemetrySink(tracer);
  }

  recordMetric(name: string, value: number, tags?: Record<string, string>): void {
    // Create a span for the metric (simplified approach)
    const span = this.tracer.startSpan(`metric.${name}`, {
      attributes: {
        'metric.name': name,
        'metric.value': value,
        ...tags,
      },
    });
    span.end();
  }

  recordEvent(name: string, data?: Record<string, unknown>): void {
    // Create a span for the event
    // Flatten and sanitize data to only include primitive types
    const attributes: Record<string, string | number | boolean> = {
      'event.name': name,
    };

    if (data) {
      for (const [key, value] of Object.entries(data)) {
        // Only include primitive types that OpenTelemetry supports
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          attributes[key] = value;
        } else if (value === null || value === undefined) {
          attributes[key] = String(value);
        } else {
          // For complex objects, stringify them
          attributes[key] = JSON.stringify(value);
        }
      }
    }

    const span = this.tracer.startSpan(`event.${name}`, {
      attributes,
    });
    span.end();
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if OpenTelemetry packages are installed and available.
 *
 * @returns Promise that resolves to true if OpenTelemetry is available
 *
 * @example
 * ```typescript
 * import { isOpenTelemetryAvailable } from '@johnhenry/aimatey-middleware';
 *
 * if (await isOpenTelemetryAvailable()) {
 *   console.log('OpenTelemetry is available!');
 * } else {
 *   console.log('OpenTelemetry packages not installed.');
 * }
 * ```
 */
export async function isOpenTelemetryAvailable(): Promise<boolean> {
  return checkOpenTelemetryAvailability();
}

/**
 * Synchronously check if OpenTelemetry is already loaded.
 * Use isOpenTelemetryAvailable() for async check with dynamic import.
 *
 * @returns True if OpenTelemetry is already loaded
 *
 * @example
 * ```typescript
 * import { isOpenTelemetryLoaded } from '@johnhenry/aimatey-middleware';
 *
 * if (isOpenTelemetryLoaded()) {
 *   console.log('OpenTelemetry is already loaded!');
 * }
 * ```
 */
export function isOpenTelemetryLoaded(): boolean {
  return isOtelLoaded();
}

/**
 * Force shutdown of the global tracer provider.
 * Useful for graceful shutdown in server applications.
 *
 * @returns Promise that resolves when shutdown is complete
 *
 * @example
 * ```typescript
 * import { shutdownOpenTelemetry } from '@johnhenry/aimatey-middleware';
 *
 * process.on('SIGTERM', async () => {
 *   await shutdownOpenTelemetry();
 *   process.exit(0);
 * });
 * ```
 */
export async function shutdownOpenTelemetry(): Promise<void> {
  if (globalTracerProvider) {
    await globalTracerProvider.shutdown();
    globalTracerProvider = null;
    globalTracerProviderConfig = null;
    providerInitializationPromise = null;
  }
}
