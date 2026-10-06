/**
 * Core HTTP Handler
 *
 * Framework-agnostic HTTP request handler that can be adapted to any framework.
 * Contains all the core logic for CORS, auth, rate limiting, routing, and streaming.
 *
 * @module
 */

import type { Bridge } from '@johnhenry/aimatey-core';
import type {
  GenericRequest,
  GenericResponse,
  CoreHandlerOptions,
  ParsedGenericRequest,
} from './types.js';
import { GenericRateLimiter } from './rate-limiter.js';
import { RouteMatcher, applyPathPrefix } from './route-matcher.js';
import { createHealthCheck, createReadinessCheck, createLivenessCheck } from './health.js';
import { createMetricsHandler } from './metrics.js';
import { openaiEmbedRequestToIR, irToOpenAIEmbedResponse } from '@johnhenry/aimatey-utils';
import { normalizeCORSOptions } from './cors.js';
import { detectProviderFormat, sanitizeErrorMessage } from './response-formatter.js';
import { getHTTPStatusCode } from './status-mapping.js';
import { toUserMessage } from '@johnhenry/aimatey-errors';

/**
 * Core HTTP request handler (framework-agnostic)
 */
export class CoreHTTPHandler {
  private readonly bridge: Bridge;
  private readonly options: Required<
    Omit<
      CoreHandlerOptions,
      | 'validateAuth'
      | 'onError'
      | 'rateLimit'
      | 'routes'
      | 'cors'
      | 'health'
      | 'metrics'
      | 'embeddings'
    >
  > & {
    validateAuth?: CoreHandlerOptions['validateAuth'];
    onError?: CoreHandlerOptions['onError'];
    rateLimit?: CoreHandlerOptions['rateLimit'];
    routes?: CoreHandlerOptions['routes'];
    health?: CoreHandlerOptions['health'];
    metrics?: CoreHandlerOptions['metrics'];
    embeddings?: CoreHandlerOptions['embeddings'];
    corsOptions: ReturnType<typeof normalizeCORSOptions>;
  };
  private readonly rateLimiter: GenericRateLimiter | null;
  private readonly routeMatcher: RouteMatcher | null;
  private readonly routeRateLimiters = new Map<string, GenericRateLimiter>();
  private readonly healthHandlers: {
    full: (req: GenericRequest, res: GenericResponse) => Promise<void> | void;
    ready: (req: GenericRequest, res: GenericResponse) => Promise<void> | void;
    live: (req: GenericRequest, res: GenericResponse) => Promise<void> | void;
  } | null;
  private readonly metricsHandler: ((req: GenericRequest, res: GenericResponse) => void) | null;

  constructor(options: CoreHandlerOptions) {
    this.bridge = options.bridge;

    // Normalize options
    const corsOptions = normalizeCORSOptions(options.cors);

    // Apply path prefix to routes if provided
    let routes = options.routes;
    if (routes && options.pathPrefix) {
      routes = applyPathPrefix(routes, options.pathPrefix);
    }

    this.options = {
      bridge: this.bridge,
      corsOptions,
      validateAuth: options.validateAuth,
      onError: options.onError,
      headers: options.headers || {},
      timeout: options.timeout ?? 30000,
      pathPrefix: options.pathPrefix ?? '',
      rateLimit: options.rateLimit,
      routes,
      logging: options.logging ?? false,
      log: options.log ?? (() => {}), // no-op by default
      maxBodySize: options.maxBodySize ?? 10 * 1024 * 1024, // 10MB
      streaming: options.streaming ?? true,
      health: options.health,
      metrics: options.metrics,
      embeddings: options.embeddings,
    };

    // Create rate limiter if configured
    this.rateLimiter = this.options.rateLimit
      ? new GenericRateLimiter(this.options.rateLimit)
      : null;

    // Create route matcher if routes configured
    this.routeMatcher = this.options.routes ? new RouteMatcher(this.options.routes) : null;

    // Per-route rate limiters (replace the global limiter for their route)
    for (const route of this.options.routes ?? []) {
      if (route.rateLimit) {
        this.routeRateLimiters.set(route.path, new GenericRateLimiter(route.rateLimit));
      }
    }

    // Built-in health endpoints
    if (this.options.health?.enabled) {
      const healthCheck = createHealthCheck(this.bridge);
      this.healthHandlers = {
        full: (req, res) => healthCheck.handle(req, res),
        ready: createReadinessCheck(this.bridge),
        live: createLivenessCheck(),
      };
    } else {
      this.healthHandlers = null;
    }

    // Built-in metrics endpoint
    this.metricsHandler = this.options.metrics?.enabled
      ? createMetricsHandler({ bridge: this.bridge, prefix: this.options.metrics.prefix })
      : null;
  }

  /**
   * Dispose of the handler and release resources.
   * Call this when the handler is no longer needed to prevent memory leaks.
   */
  dispose(): void {
    for (const limiter of this.routeRateLimiters.values()) {
      limiter.dispose();
    }
    this.routeRateLimiters.clear();
    if (this.rateLimiter) {
      this.rateLimiter.dispose();
    }
  }

  /**
   * Handle HTTP request
   */
  async handle(req: GenericRequest, res: GenericResponse): Promise<void> {
    try {
      // Handle CORS if enabled
      if (this.options.corsOptions) {
        const origin = req.headers.origin || req.headers['Origin'] || '';

        // Check if origin is allowed
        if (!this.isOriginAllowed(origin, this.options.corsOptions.origin)) {
          res.status(403);
          res.send({ error: 'Origin not allowed' });
          return;
        }

        // Set CORS headers
        if (
          typeof this.options.corsOptions.origin === 'string' &&
          this.options.corsOptions.origin === '*'
        ) {
          res.header('Access-Control-Allow-Origin', '*');
        } else if (origin) {
          res.header('Access-Control-Allow-Origin', origin);
          res.header('Vary', 'Origin');
        }

        if (this.options.corsOptions.credentials) {
          res.header('Access-Control-Allow-Credentials', 'true');
        }

        if (
          this.options.corsOptions.exposedHeaders &&
          this.options.corsOptions.exposedHeaders.length > 0
        ) {
          res.header(
            'Access-Control-Expose-Headers',
            Array.isArray(this.options.corsOptions.exposedHeaders)
              ? this.options.corsOptions.exposedHeaders.join(', ')
              : this.options.corsOptions.exposedHeaders
          );
        }

        // Handle preflight
        const isPreflightRequest =
          req.method === 'OPTIONS' &&
          origin &&
          (req.headers['access-control-request-method'] ||
            req.headers['Access-Control-Request-Method']);

        if (isPreflightRequest) {
          // Set preflight headers
          res.header(
            'Access-Control-Allow-Methods',
            Array.isArray(this.options.corsOptions.methods)
              ? this.options.corsOptions.methods.join(', ')
              : this.options.corsOptions.methods
          );

          const requestHeaders =
            req.headers['access-control-request-headers'] ||
            req.headers['Access-Control-Request-Headers'];
          if (requestHeaders) {
            res.header('Access-Control-Allow-Headers', requestHeaders);
          } else if (this.options.corsOptions.allowedHeaders) {
            res.header(
              'Access-Control-Allow-Headers',
              Array.isArray(this.options.corsOptions.allowedHeaders)
                ? this.options.corsOptions.allowedHeaders.join(', ')
                : this.options.corsOptions.allowedHeaders
            );
          }

          res.header('Access-Control-Max-Age', String(this.options.corsOptions.maxAge));

          // Send successful preflight response
          res.status(204);
          res.send('');
          return;
        }
      }

      // Check rate limit
      if (this.rateLimiter && res.isWritable()) {
        const isLimited = await this.rateLimiter.check(req, res);
        if (isLimited) {
          return; // Rate limiter already sent response
        }
      }

      // Built-in endpoints (health, metrics, embeddings) before route matching
      if (await this.handleBuiltinEndpoints(req, res)) {
        return;
      }

      // Validate authentication
      if (this.options.validateAuth) {
        const isAuthenticated = await this.options.validateAuth(req);
        if (!isAuthenticated) {
          const format = detectProviderFormat(req.url || '');
          res.status(401);
          res.send(this.formatErrorResponse(new Error('Unauthorized'), 401, format));
          return;
        }
      }

      // Parse request (create explicit object instead of spread to ensure all properties are copied)
      const parsedRequest: ParsedGenericRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body,
        params: req.params,
        query: req.query,
        ip: req.ip,
        stream: req.body?.stream === true,
      };

      // Log request if enabled
      if (this.options.logging && this.options.log) {
        this.options.log(`${parsedRequest.method} ${parsedRequest.url}`, parsedRequest.body);
      }

      // Check if request body exists for POST/PUT/PATCH
      if (['POST', 'PUT', 'PATCH'].includes(parsedRequest.method) && !parsedRequest.body) {
        const format = detectProviderFormat(parsedRequest.url || '');
        res.status(400);
        res.send(this.formatErrorResponse(new Error('Request body is required'), 400, format));
        return;
      }

      // Match route if route matcher configured
      let activeBridge = this.bridge;

      if (this.routeMatcher) {
        const matchedRoute = this.routeMatcher.match(req);

        // Per-route rate limit replaces the global one for matched routes
        if (matchedRoute) {
          const routeLimiter = this.routeRateLimiters.get(matchedRoute.config.path);
          if (routeLimiter && res.isWritable()) {
            const isLimited = await routeLimiter.check(req, res);
            if (isLimited) {
              return;
            }
          }
        }

        if (!matchedRoute) {
          res.status(404);
          res.send({ error: 'Route not found' });
          return;
        }

        // Use route-specific bridge if provided
        if (matchedRoute.config.bridge) {
          activeBridge = matchedRoute.config.bridge;
        }
      }

      // Apply custom headers
      if (this.options.headers) {
        for (const [key, value] of Object.entries(this.options.headers)) {
          res.header(key, value);
        }
      }

      // Handle streaming or non-streaming request
      if (this.options.streaming && parsedRequest.stream) {
        // Handle streaming request
        const stream = activeBridge.chatStream(parsedRequest.body);

        // Convert to async generator for generic response
        async function* convertStream() {
          for await (const chunk of stream) {
            yield chunk;
          }
        }

        await res.stream(convertStream());
      } else {
        // Handle non-streaming request
        const response = await activeBridge.chat(parsedRequest.body);

        // Send response
        res.status(200);
        res.send(response);
      }

      // Log response if enabled
      if (this.options.logging && this.options.log) {
        this.options.log(`${parsedRequest.method} ${parsedRequest.url} - 200 OK`);
      }
    } catch (error) {
      // Handle errors
      await this.handleError(error as Error, req, res);
    }
  }

  /**
   * Handle errors
   */
  /**
   * Serve built-in health/metrics/embeddings endpoints.
   *
   * @returns true when the request was handled
   */
  private async handleBuiltinEndpoints(
    req: GenericRequest,
    res: GenericResponse
  ): Promise<boolean> {
    const path = (req.url || '').split('?')[0] ?? '';

    // Health endpoints (GET, unauthenticated by design: probes need access)
    if (this.healthHandlers && req.method === 'GET') {
      const base = this.options.health?.path ?? '/health';
      if (path === `${base}/live`) {
        await this.healthHandlers.live(req, res);
        return true;
      }
      if (path === `${base}/ready`) {
        await this.healthHandlers.ready(req, res);
        return true;
      }
      if (path === base) {
        await this.healthHandlers.full(req, res);
        return true;
      }
    }

    // Metrics endpoint (GET; auth honored by default when configured)
    if (this.metricsHandler && req.method === 'GET') {
      const metricsPath = this.options.metrics?.path ?? '/metrics';
      if (path === metricsPath) {
        const requireAuth = this.options.metrics?.auth ?? Boolean(this.options.validateAuth);
        if (requireAuth && this.options.validateAuth) {
          const isAuthenticated = await this.options.validateAuth(req);
          if (!isAuthenticated) {
            res.status(401);
            res.send({ error: { message: 'Unauthorized' } });
            return true;
          }
        }
        this.metricsHandler(req, res);
        return true;
      }
    }

    // OpenAI-compatible embeddings endpoint (POST)
    if (this.options.embeddings?.enabled && req.method === 'POST') {
      const embedPath = this.options.embeddings.path ?? '/v1/embeddings';
      if (path === embedPath) {
        if (this.options.validateAuth) {
          const isAuthenticated = await this.options.validateAuth(req);
          if (!isAuthenticated) {
            res.status(401);
            res.send({ error: { message: 'Unauthorized' } });
            return true;
          }
        }

        const body = req.body as { model?: string; input?: string | string[] } | null;
        if (body?.input === undefined || !body.model) {
          res.status(400);
          res.send({ error: { message: "'model' and 'input' are required" } });
          return true;
        }

        try {
          const irRequest = openaiEmbedRequestToIR({
            model: body.model,
            input: body.input,
            ...(body as Record<string, unknown>),
          });
          const irResponse = await this.bridge.embed(irRequest.input, {
            model: irRequest.parameters?.model,
            dimensions: irRequest.parameters?.dimensions,
          });
          res.status(200);
          res.header('Content-Type', 'application/json');
          res.send(irToOpenAIEmbedResponse(irResponse));
        } catch (error) {
          await this.handleError(error as Error, req, res);
        }
        return true;
      }
    }

    return false;
  }

  private async handleError(
    error: Error,
    req: GenericRequest,
    res: GenericResponse
  ): Promise<void> {
    // Log error if enabled
    if (this.options.logging && this.options.log) {
      this.options.log(`Error: ${req.method} ${req.url}`, error);
    }

    // Call error handler
    if (this.options.onError) {
      await this.options.onError(error, req, res);
    } else {
      // Use built-in error formatting
      const format = detectProviderFormat(req.url || '');
      // The shared mapper, not a private copy. handler.ts used to carry its
      // own, and the two disagreed about identical input -- a timeout was 408
      // here and 504 there, among others (#105).
      const statusCode = getHTTPStatusCode(error);

      res.status(statusCode);
      res.send(this.formatErrorResponse(error, statusCode, format));
    }
  }

  /**
   * Check if origin is allowed
   */
  private isOriginAllowed(
    origin: string,
    allowedOrigin: string | string[] | ((origin: string) => boolean)
  ): boolean {
    if (!origin) {
      return true; // Allow requests without origin header
    }

    if (typeof allowedOrigin === 'string') {
      return allowedOrigin === '*' || allowedOrigin === origin;
    }

    if (Array.isArray(allowedOrigin)) {
      return allowedOrigin.includes(origin) || allowedOrigin.includes('*');
    }

    if (typeof allowedOrigin === 'function') {
      return allowedOrigin(origin);
    }

    return false;
  }

  /**
   * Format error response in provider-specific format
   */
  private formatErrorResponse(
    error: Error,
    statusCode: number,
    format: 'openai' | 'anthropic' | 'generic'
  ): any {
    const message = sanitizeErrorMessage(error, statusCode);
    // `message` is developer-facing; `userMessage` is what a client displays.
    const userMessage = toUserMessage(error);

    if (format === 'openai') {
      return {
        error: {
          message,
          userMessage,
          type: 'server_error',
          code: statusCode >= 500 ? 'internal_server_error' : 'invalid_request_error',
        },
      };
    }

    if (format === 'anthropic') {
      return {
        type: 'error',
        error: {
          type: statusCode >= 500 ? 'api_error' : 'invalid_request_error',
          message,
          userMessage,
        },
      };
    }

    // Generic format
    return {
      error: message,
      userMessage,
      statusCode,
    };
  }
}
