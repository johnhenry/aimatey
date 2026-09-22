/**
 * Decision Utilities
 *
 * Shared helpers for typed-decision support: capability detection for
 * `decide()` and, symmetrically, for the chat methods that are no longer
 * guaranteed on every `BackendAdapter` now that decision-only backends
 * (Jev, Laya) exist.
 *
 * @module
 */

import type { BackendAdapter } from '@johnhenry/aimatey-types';

// ============================================================================
// Capability Detection
// ============================================================================

/**
 * Type guard: does this backend implement typed decisions?
 */
export function supportsDecisions(
  adapter: BackendAdapter
): adapter is BackendAdapter & Required<Pick<BackendAdapter, 'decide'>> {
  // Mirrors `supportsEmbeddings`: an inherited decide() can be explicitly
  // opted out of via the capability flag.
  return typeof adapter.decide === 'function' && adapter.metadata.capabilities.decisions !== false;
}

/**
 * Type guard: does this backend implement (non-streaming) chat?
 *
 * `execute`/`executeStream` became optional on `BackendAdapter` when
 * decision-only backends were added — most backends still implement both,
 * but nothing guarantees it anymore. `Bridge` and `Router` use this (and
 * {@link supportsChatStream}) to fail fast with `UNSUPPORTED_FEATURE`
 * rather than call an absent method.
 */
export function supportsChat(
  adapter: BackendAdapter
): adapter is BackendAdapter & Required<Pick<BackendAdapter, 'execute'>> {
  return typeof adapter.execute === 'function';
}

/**
 * Type guard: does this backend implement streaming chat?
 */
export function supportsChatStream(
  adapter: BackendAdapter
): adapter is BackendAdapter & Required<Pick<BackendAdapter, 'executeStream'>> {
  return typeof adapter.executeStream === 'function';
}
