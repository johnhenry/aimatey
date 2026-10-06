/**
 * Capability resolution (#127).
 *
 * `AdapterMetadata.capabilities` is static and synchronous; an adapter whose
 * far side is another machine can implement `discoverCapabilities()` to say
 * what it offers *now*. This is the one place that decides which of the two a
 * caller gets.
 *
 * @module
 */

import type { BackendAdapter, IRCapabilities } from '@johnhenry/aimatey-types';

/**
 * Resolve the capabilities a backend currently offers.
 *
 * - No `discoverCapabilities()`, or `metadata.capabilitiesResolved === true`:
 *   the static `metadata.capabilities`, without a call.
 * - Otherwise: whatever discovery returns, which **replaces** the static value
 *   rather than merging into it (the far side is authoritative).
 *
 * Discovery errors propagate. A caller that can proceed on the static lower
 * bound (the `Router` does) catches and falls back; one that cannot should
 * see the failure.
 *
 * The synchronous guards (`supportsEmbeddings`, `supportsDecisions`) do not
 * call this: they keep reading static metadata, and accept the result of this
 * function as an optional second argument.
 */
export async function resolveCapabilities(
  adapter: Pick<BackendAdapter, 'metadata' | 'discoverCapabilities'>,
  signal?: AbortSignal
): Promise<IRCapabilities> {
  if (
    typeof adapter.discoverCapabilities !== 'function' ||
    adapter.metadata.capabilitiesResolved === true
  ) {
    return adapter.metadata.capabilities;
  }
  return adapter.discoverCapabilities(signal);
}
