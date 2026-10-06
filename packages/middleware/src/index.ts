/**
 * Aimatey Middleware
 *
 * Consolidated package containing all middleware components.
 * Middleware provides cross-cutting concerns like caching, retry,
 * logging, and security for the AI adapter system.
 *
 * @module aimatey-middleware
 */

// Middleware components
export * from './caching.js';
export * from './conversation-history.js';
export * from './cost-tracking.js';
export * from './logging.js';
export * from './opentelemetry.js';
export * from './retry.js';
export * from './security.js';
export * from './telemetry.js';
export * from './transform.js';
export * from './validation.js';
export * from './embeddings.js';
export * from './decisions/index.js';
