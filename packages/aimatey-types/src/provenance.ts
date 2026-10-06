/**
 * Provenance helpers.
 *
 * `IRProvenance` is defined in `ir.ts` alongside the rest of the IR. This module holds the
 * operations that are easy to get wrong: recording that the backend which answered was a
 * proxy rather than the thing that actually ran the model, and reading back out of a
 * nested chain which model that was.
 *
 * @module
 */

import type { IRProvenance, ProvenanceLocality } from './ir.js';

/**
 * True when a provenance says anything at all.
 *
 * Backend adapters that report no provenance conventionally return `{}` rather than
 * `undefined` (see every shipped adapter's `execute()`), so "the far side told us nothing"
 * arrives as an empty object about as often as it arrives as `undefined`.
 */
function isEmptyProvenance(provenance: IRProvenance): boolean {
  return Object.values(provenance).every((value) => value === undefined);
}

/**
 * Attach the provenance a proxied hop reported underneath this hop's own.
 *
 * A backend adapter that fronts another aimatey instance -- a tunnel, a gateway, a
 * self-hosted relay, a test double wrapping a real `Router` -- gets back a full
 * `IRProvenance` describing what the *far* side did. Forwarding that upward unchanged is
 * the bug this function exists to prevent:
 *
 * ```typescript
 * // WRONG -- the far side's backend becomes this process's backend.
 * metadata: { ...farResponse.metadata }
 * // A phone then reports `backend: 'llama-cpp'` for a request its desktop ran, which is
 * // indistinguishable from having run llama-cpp locally. Only one of those is true.
 * ```
 *
 * The near hop's own fields must stay authoritative, because that is what every existing
 * reader means: the Bridge's circuit breaker and usage counter key off `provenance.backend`
 * to decide which adapter to stop calling, and stopping `llama-cpp` on a far-side failure
 * would blame a backend this process cannot even reach.
 *
 * ```typescript
 * // RIGHT -- this adapter names itself, and the far side nests beneath it.
 * provenance: withUpstreamProvenance(
 *   { backend: this.metadata.name },
 *   farResponse.metadata.provenance
 * )
 * ```
 *
 * An `upstream` that is `undefined`, `{}`, or carries only undefined values is dropped
 * rather than recorded: an empty link would claim a hop exists while saying nothing about
 * it, and a consumer walking the chain to find the far end would stop on a link that names
 * nothing. A far side that itself proxied arrives with its own `upstream` already nested,
 * so chains longer than two hops need no special handling here.
 *
 * @param local Provenance for this hop -- the proxying adapter's own name, at minimum.
 * @param upstream What the far side reported, as-is; nested untouched when it says anything.
 * @returns `local` with `upstream` attached, or `local` unchanged when there is nothing to
 *   attach. Any `upstream` already on `local` is replaced.
 *
 * @example
 * ```typescript
 * // Inside a proxying BackendAdapter's execute():
 * const farResponse = await this.forwardOverTunnel(request);
 *
 * return {
 *   ...farResponse,
 *   metadata: {
 *     ...farResponse.metadata,
 *     provenance: withUpstreamProvenance(
 *       { backend: this.metadata.name },
 *       farResponse.metadata.provenance
 *     ),
 *   },
 * };
 * // => { backend: 'tunnel', upstream: { frontend: 'openai', backend: 'llama-cpp' } }
 * ```
 */
export function withUpstreamProvenance(
  local: IRProvenance,
  upstream: IRProvenance | undefined
): IRProvenance {
  if (upstream === undefined || isEmptyProvenance(upstream)) {
    return local;
  }

  return { ...local, upstream };
}

/**
 * The model that actually generated a response, read out of a provenance chain.
 *
 * `IRProvenance.servedModel` is a per-hop fact, so a proxied response holds more than one
 * hop and at most one of them served. This resolves the chain to a single answer for the
 * consumers that want one -- tracing (`ai.response.model`), a frontend adapter projecting
 * the IR back onto a provider wire shape, a UI reporting what answered.
 *
 * **Nearest-first.** The walk starts at the near hop and returns the first `servedModel` it
 * finds. In the canonical proxy chain that *is* the far end, because a hop that forwarded
 * rather than served leaves its own `servedModel` unset -- so `phone -> desktop ->
 * llama-cpp` resolves to llama-cpp's model without the walk needing to know which hop was
 * the last one.
 *
 * Nearest-first rather than strictly-last-link is deliberate. A hop's `servedModel` is a
 * true claim about that hop, so the nearest one is never *wrong* -- only potentially less
 * specific. Preferring it means a chain whose far hop is a provider that does not report
 * the served model at all (Cohere, Bedrock, HuggingFace, Replicate) can still resolve to a
 * nearer hop that does -- an HTTP-proxying adapter that parsed the served model off the
 * response body, say. Last-link-only would discard that and return `undefined`, trading
 * real coverage for purity.
 *
 * Returns `undefined` when no hop reported one. That is a load-bearing outcome, not a
 * failure: a consumer must be able to tell "not reported" from "reported as X", so callers
 * must leave their attribute or field **absent** rather than substituting the requested
 * model.
 *
 * @param provenance The near hop, or `undefined`.
 * @returns The nearest reported served model, or `undefined` if no hop reported one.
 *
 * @example
 * ```typescript
 * resolveServedModel({ backend: 'openai', servedModel: 'gpt-4-0613' });
 * // => 'gpt-4-0613'
 *
 * resolveServedModel({
 *   backend: 'tunnel',                       // forwarded; served nothing
 *   upstream: { backend: 'llama-cpp', servedModel: 'qwen2.5-7b-instruct' },
 * });
 * // => 'qwen2.5-7b-instruct'
 *
 * resolveServedModel({ backend: 'cohere' });
 * // => undefined -- Cohere does not echo the served model
 * ```
 */
export function resolveServedModel(provenance: IRProvenance | undefined): string | undefined {
  for (let hop = provenance; hop !== undefined; hop = hop.upstream) {
    if (hop.servedModel !== undefined && hop.servedModel.length > 0) {
      return hop.servedModel;
    }
  }

  return undefined;
}

/**
 * Widest-last ordering of {@link ProvenanceLocality}; a larger index reaches further.
 */
const LOCALITY_REACH: readonly ProvenanceLocality[] = ['in-process', 'same-host', 'external'];

/**
 * The widest link a request crossed anywhere along a provenance chain.
 *
 * `IRProvenance.locality` is a per-hop fact, so "did this reply leave the device?" is a
 * question about the whole chain. This is the one place that answers it, so no two
 * consumers walk the chain differently (the same reason `resolveServedModel` exists).
 *
 * **Fails closed.** A hop that did not declare a `locality` is *unknown*, and unknown is
 * treated as `'external'`: a proxy that forgot to say where it went must never read as
 * local. `undefined` provenance, an empty chain, and an `upstream` link that names
 * nothing all resolve to `'external'` with `declared: false`.
 *
 * A hop that carries no information at all (an empty `{}`) is skipped rather than
 * counted unknown, because it claims no hop exists -- the same rule
 * `withUpstreamProvenance` applies when attaching one. A chain made only of such hops is
 * still unknown overall.
 *
 * @param provenance The near hop, or `undefined`.
 * @returns `locality`: the widest link in the chain, unknown counted as `'external'`.
 *   `declared`: `true` only when every non-empty hop declared its own, so a UI can
 *   distinguish "external, as stated" from "external, because nobody said".
 *
 * @example
 * ```typescript
 * resolveEgress({ backend: 'llama-cpp', locality: 'in-process' });
 * // => { locality: 'in-process', declared: true }
 *
 * resolveEgress({
 *   backend: 'tunnel', locality: 'external',
 *   upstream: { backend: 'llama-cpp', locality: 'in-process' },
 * });
 * // => { locality: 'external', declared: true }   -- the phone crossed a network
 *
 * resolveEgress({ backend: 'tunnel', upstream: { backend: 'llama-cpp', locality: 'in-process' } });
 * // => { locality: 'external', declared: false }  -- the tunnel never said; fail closed
 * ```
 */
export function resolveEgress(provenance: IRProvenance | undefined): {
  readonly locality: ProvenanceLocality;
  readonly declared: boolean;
} {
  let widest = -1;
  let declared = true;
  let sawHop = false;

  for (let hop = provenance; hop !== undefined; hop = hop.upstream) {
    // `upstream` itself does not make a hop non-empty: it is a link, not a claim.
    const makesClaims = Object.entries(hop).some(
      ([key, value]) => key !== 'upstream' && value !== undefined
    );
    if (!makesClaims) {
      continue;
    }
    sawHop = true;

    const reach = hop.locality === undefined ? -1 : LOCALITY_REACH.indexOf(hop.locality);
    if (reach === -1) {
      // Absent, or a value from a newer version of the IR this copy cannot rank.
      declared = false;
    } else if (reach > widest) {
      widest = reach;
    }
  }

  if (!sawHop || !declared) {
    return { locality: 'external', declared: false };
  }
  return { locality: LOCALITY_REACH[widest] ?? 'external', declared: true };
}
