/**
 * Type Definitions
 *
 * All type definitions for the Universal AI Adapter System.
 *
 * @module
 */

// IR (Intermediate Representation) types
export * from './ir.js';

// Provenance helpers
export * from './provenance.js';

// Adapter interfaces
export * from './adapters.js';

// Model types
export * from './models.js';
export * from './embeddings.js';
export * from './decisions.js';
export * from './tools.js';

// Error types (type definitions only, implementations in errors/)
export * from './errors.js';

// Bridge types
export * from './bridge.js';

// Router types
export * from './router.js';

// Middleware types
export * from './middleware.js';

// Model runner types
export * from './model-runner.js';

// Model translation types
export * from './model-translation.js';

// Streaming types
export * from './streaming.js';
