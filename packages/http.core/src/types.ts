/**
 * HTTP Core Types
 *
 * Unified type definitions for the HTTP adapter system.
 * These types allow us to write core logic once and adapt it to any framework.
 *
 * @module
 */

import type { StreamFraming } from './stream-framing.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Bridge } from '@johnhenry/aimatey-core';
import type { FrontendAdapter } from '@johnhenry/aimatey-types';

// ============================================================================
// Configuration Types (Must be defined first - no circular dependencies)
// ============================================================================

/**
 * CORS configuration options
 */
export interface CORSOptions {
  /**
   * Allowed origins (default: '*')
   */
  origin?: string | string[] | ((origin: string) => boolean);

  /**
   * Allowed HTTP methods (default: 'GET, POST, OPTIONS')
   */
  methods?: string | string[];

  /**
   * Allowed headers (default: 'Content-Type, Authorization')
   */
  allowedHeaders?: string | string[];

  /**
   * Exposed headers
   */
  exposedHeaders?: string | string[];

  /**
   * Allow credentials (default: true)
   */
  credentials?: boolean;

  /**
   * Max age for preflight cache in seconds (default: 86400)
   */
  maxAge?: number;
}

/**
 * Route matching configuration
 */
export interface RouteConfig {
  /**
   * Path pattern to match (supports simple wildcards)
   * Examples: '/v1/chat/completions', '/v1/messages', '/v1/*'
   */
  path: string;

  /**
   * HTTP methods to match (default: ['POST'])
   */
  methods?: string[];

  /**
   * Frontend adapter to use for this route
   */
  frontend: FrontendAdapter;

  /**
   * Optional bridge to use (overrides default)
   */
  bridge?: Bridge;

  /**
   * Per-route rate limit. Replaces the handler's global rate limit for
   * requests matching this route.
   */
  rateLimit?: GenericRateLimitOptions;
}

/**
 * Matched route information
 */
export interface MatchedRoute {
  /**
   * Route configuration
   */
  config: RouteConfig;

  /**
   * Path parameters (if any)
   */
  params: Record<string, string>;
}

// ============================================================================
// Generic Request/Response Interfaces (Framework-agnostic)
// ============================================================================

/**
 * Generic HTTP request interface (framework-agnostic)
 */
export interface GenericRequest {
  /**
   * HTTP method (GET, POST, etc.)
   */
  method: string;

  /**
   * Full request URL
   */
  url: string;

  /**
   * Request headers (normalized to lowercase keys)
   */
  headers: Record<string, string>;

  /**
   * Parsed request body (null if not yet parsed)
   */
  body: any;

  /**
   * URL parameters (e.g., /users/:id -> { id: '123' })
   */
  params?: Record<string, string>;

  /**
   * Query string parameters
   */
  query?: Record<string, string>;

  /**
   * Client IP address
   */
  ip?: string;
}

/**
 * Options for {@link GenericResponse.stream}.
 */
export interface GenericStreamOptions {
  /** Wire framing for the stream (default `'generic'`: SSE ending in `data: [DONE]`). */
  framing?: StreamFraming;
}

/**
 * Generic HTTP response interface (framework-agnostic)
 */
export interface GenericResponse {
  /**
   * Set HTTP status code
   */
  status(code: number): void;

  /**
   * Set response header
   */
  header(name: string, value: string): void;

  /**
   * Send JSON response
   */
  send(data: any): void;

  /**
   * Send a streaming response. `options.framing` picks the wire format
   * (SSE with `[DONE]` for OpenAI/generic, Gemini SSE or JSON array, Ollama
   * NDJSON...); without it the response is SSE `data:` lines ending in
   * `data: [DONE]`, as before.
   */
  stream(
    generator: AsyncGenerator<any, void, undefined>,
    options?: GenericStreamOptions
  ): Promise<void>;

  /**
   * Check if response is writable
   */
  isWritable(): boolean;
}

/**
 * Parsed HTTP request (after body parsing)
 */
export interface ParsedGenericRequest extends GenericRequest {
  /**
   * Parsed request body (guaranteed to be parsed)
   */
  body: any;

  /**
   * Whether streaming is requested
   */
  stream?: boolean;
}

// ============================================================================
// Generic Handler Types (Framework-agnostic)
// ============================================================================

/**
 * Auth validator for generic requests
 */
export type GenericAuthValidator = (req: GenericRequest) => boolean | Promise<boolean>;

/**
 * Error handler for generic requests/responses
 */
export type GenericErrorHandler = (
  error: Error,
  req: GenericRequest,
  res: GenericResponse
) => void | Promise<void>;

/**
 * Rate limit key generator for generic requests
 */
export type GenericRateLimitKeyGenerator = (req: GenericRequest) => string;

/**
 * Rate limit handler for generic requests/responses
 */
export type GenericRateLimitHandler = (
  req: GenericRequest,
  res: GenericResponse,
  retryAfter: number
) => void | Promise<void>;

/**
 * Generic rate limit options
 */
export interface GenericRateLimitOptions {
  /**
   * Maximum number of requests per window
   */
  max: number;

  /**
   * Time window in milliseconds (default: 60000 = 1 minute)
   */
  windowMs?: number;

  /**
   * Generate rate limit key from request (default: IP address)
   */
  keyGenerator?: GenericRateLimitKeyGenerator;

  /**
   * Handler called when rate limit exceeded
   */
  handler?: GenericRateLimitHandler;

  /**
   * Skip rate limiting for certain requests
   */
  skip?: (req: GenericRequest) => boolean | Promise<boolean>;

  /**
   * Custom headers to include in rate limit responses
   */
  headers?: boolean;
}

/**
 * Core handler options
 */
export interface CoreHandlerOptions {
  /**
   * Bridge instance connecting frontend and backend adapters
   */
  bridge: Bridge;

  /**
   * CORS configuration
   */
  cors?: CORSOptions;

  /**
   * Authentication validator
   */
  validateAuth?: GenericAuthValidator;

  /**
   * Error handler
   */
  onError?: GenericErrorHandler;

  /**
   * Custom response headers
   */
  headers?: Record<string, string>;

  /**
   * Request timeout in milliseconds
   */
  timeout?: number;

  /**
   * Path prefix for all routes
   */
  pathPrefix?: string;

  /**
   * Rate limiting configuration
   */
  rateLimit?: GenericRateLimitOptions;

  /**
   * Route configurations for multi-endpoint support
   */
  routes?: RouteConfig[];

  /**
   * Built-in health endpoints. When enabled, GET {path}, {path}/ready,
   * and {path}/live are served before route matching.
   * @default disabled
   */
  health?: {
    enabled: boolean;
    /** Base path. @default '/health' */
    path?: string;
  };

  /**
   * Built-in Prometheus metrics endpoint (GET, text exposition format).
   * @default disabled
   */
  metrics?: {
    enabled: boolean;
    /** Endpoint path. @default '/metrics' */
    path?: string;
    /** Require validateAuth for scrapes. @default true when validateAuth is set */
    auth?: boolean;
    /** Metric name prefix. @default 'ai_matey' */
    prefix?: string;
  };

  /**
   * OpenAI-compatible embeddings endpoint (POST {path}), executed via the
   * bridge's backend `embed()` capability.
   * @default disabled
   */
  embeddings?: {
    enabled: boolean;
    /** Endpoint path. @default '/v1/embeddings' */
    path?: string;
  };

  /**
   * Enable request/response logging
   */
  logging?: boolean;

  /**
   * Log function
   */
  log?: (message: string, ...args: any[]) => void;

  /**
   * Maximum request body size in bytes
   */
  maxBodySize?: number;

  /**
   * Enable streaming support
   */
  streaming?: boolean;
}

// ============================================================================
// Node.js-Specific Types (Backward Compatibility)
// ============================================================================

/**
 * HTTP request handler compatible with Node.js http.createServer
 */
export type HTTPRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * Auth validator function (Node.js-specific)
 * @deprecated Use GenericAuthValidator for framework-agnostic code
 */
export type AuthValidator = (req: IncomingMessage) => boolean | Promise<boolean>;

/**
 * Error handler function (Node.js-specific)
 * @deprecated Use GenericErrorHandler for framework-agnostic code
 */
export type ErrorHandler = (
  error: Error,
  req: IncomingMessage,
  res: ServerResponse
) => void | Promise<void>;

/**
 * Rate limit key generator (Node.js-specific)
 * @deprecated Use GenericRateLimitKeyGenerator for framework-agnostic code
 */
export type RateLimitKeyGenerator = (req: IncomingMessage) => string;

/**
 * Rate limit handler (called when limit exceeded) (Node.js-specific)
 * @deprecated Use GenericRateLimitHandler for framework-agnostic code
 */
export type RateLimitHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  retryAfter: number
) => void | Promise<void>;

/**
 * Rate limiting configuration (Node.js-specific)
 */
export interface RateLimitOptions {
  /**
   * Maximum number of requests per window
   */
  max: number;

  /**
   * Time window in milliseconds (default: 60000 = 1 minute)
   */
  windowMs?: number;

  /**
   * Generate rate limit key from request (default: IP address)
   */
  keyGenerator?: RateLimitKeyGenerator;

  /**
   * Handler called when rate limit exceeded
   */
  handler?: RateLimitHandler;

  /**
   * Skip rate limiting for certain requests
   */
  skip?: (req: IncomingMessage) => boolean | Promise<boolean>;

  /**
   * Custom headers to include in rate limit responses
   */
  headers?: boolean;
}

/**
 * HTTP listener configuration options
 * Supports both Node.js-specific and generic types for framework compatibility
 */
export interface HTTPListenerOptions {
  /**
   * CORS configuration (default: enabled with sensible defaults)
   */
  cors?: boolean | CORSOptions;

  /**
   * Authentication validator (accepts both Node.js and generic types)
   */
  validateAuth?: AuthValidator | GenericAuthValidator;

  /**
   * Error handler (accepts both Node.js and generic types)
   */
  onError?: ErrorHandler | GenericErrorHandler;

  /**
   * Custom response headers
   */
  headers?: Record<string, string>;

  /**
   * Request timeout in milliseconds (default: 30000)
   */
  timeout?: number;

  /**
   * Path prefix for all routes (e.g., '/v1')
   */
  pathPrefix?: string;

  /**
   * Rate limiting configuration (accepts both Node.js and generic types)
   */
  rateLimit?: RateLimitOptions | GenericRateLimitOptions;

  /**
   * Route configurations for multi-endpoint support
   */
  routes?: RouteConfig[];

  /**
   * Enable request/response logging (default: false)
   */
  logging?: boolean;

  /**
   * Log function (default: console.log)
   */
  log?: (message: string, ...args: any[]) => void;

  /**
   * Maximum request body size in bytes (default: 10MB)
   */
  maxBodySize?: number;

  /**
   * Enable streaming support (default: true)
   */
  streaming?: boolean;
}

// ============================================================================
// Internal Types
// ============================================================================

/**
 * Parsed HTTP request
 */
export interface ParsedRequest {
  /**
   * Request body (parsed JSON)
   */
  body: any;

  /**
   * Request headers
   */
  headers: Record<string, string>;

  /**
   * Request path (without query string)
   */
  path: string;

  /**
   * HTTP method
   */
  method: string;

  /**
   * Query parameters
   */
  query: Record<string, string>;

  /**
   * Whether streaming is requested
   */
  stream?: boolean;
}

/**
 * Rate limit state
 */
export interface RateLimitState {
  /**
   * Number of requests in current window
   */
  count: number;

  /**
   * Window start timestamp
   */
  resetTime: number;
}
