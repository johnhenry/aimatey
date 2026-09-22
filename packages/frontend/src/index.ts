/**
 * Aimatey Frontend Adapters
 *
 * Consolidated package containing all frontend adapters.
 * Each frontend adapter handles converting provider-specific
 * request/response formats to Universal IR and vice versa.
 *
 * @module aimatey-frontend
 */

// Frontend adapters
export * from './adapters/openai.js';
export * from './adapters/anthropic.js';
export * from './adapters/gemini.js';
export * from './adapters/mistral.js';
export * from './adapters/ollama.js';
export * from './adapters/chrome-ai.js';
export * from './adapters/generic.js';
export * from './adapters/typesafe.js';
export * from './adapters/laya.js';
