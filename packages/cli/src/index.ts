/**
 * CLI Utilities and Interfaces
 *
 * ⚠️ WARNING: This module uses Node.js-specific APIs (child_process, readline, fs) and
 * is NOT browser-compatible. Import from '@johnhenry/aimatey-backend' for
 * browser-compatible adapters.
 *
 * @module cli
 */

// Export CLI utilities
export * from './utils/index.js';

// Export converters
export * from './converters/request-converters.js';
export * from './converters/response-converters.js';

// Export the decision wire codec (System One dialects <-> decision IR)
export * from './decisions.js';
