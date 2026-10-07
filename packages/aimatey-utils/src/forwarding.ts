/**
 * What a proxying adapter may forward (#124).
 *
 * A *proxying* backend adapter is one whose far side is another aimatey
 * instance across a process, device or trust boundary (a tunnel, a gateway, a
 * relay). In one process `metadata.custom` is a private convention between
 * two files and `raw` is the provider's own payload; across a boundary the
 * first is a claim the far side's middleware will obey and the second is an
 * unredacted payload the provider never knew would leave.
 *
 * The rules, per IR field, are encoded in the two functions below and
 * documented in `docs/IR-FORMAT.md` ("Forwarding across a proxy").
 *
 * @module
 */

import { withUpstreamProvenance } from '@johnhenry/aimatey-types';
import type {
  ProvenanceLocality,
  IRChatRequest,
  IRChatResponse,
  IRMetadata,
  IRWarning,
} from '@johnhenry/aimatey-types';
import { createProvenanceLostWarning } from './warnings.js';

/**
 * Prefix an application puts on a `metadata.custom` key to say "this may cross
 * a proxy". The library understands none of the keys; it only honours the mark.
 */
export const FORWARDED_CUSTOM_PREFIX = 'e2e:';

/** Options shared by {@link prepareForwardedRequest} and {@link prepareForwardedResponse}. */
export interface ForwardingOptions {
  /** The proxying adapter's own `metadata.name`: the hop being added. */
  readonly proxyName: string;

  /**
   * The link the proxy's own hop crossed to reach the far side (#174).
   * Defaults to `'external'`: a proxy exists to reach another process, device or
   * trust boundary, and the fail-closed answer for a hop that cannot say is the
   * widest. A proxy that knows its far side is on this host (a loopback daemon,
   * a unix socket) passes `localityForBaseURL(url)`; one that does not know
   * leaves the default.
   */
  readonly locality?: ProvenanceLocality;
}

/** Options for {@link prepareForwardedResponse}. */
export interface ForwardResponseOptions extends ForwardingOptions {
  /**
   * `true` when the far side is known to stamp `metadata.provenance`. A
   * response without it then gets a `provenance-lost` warning, which turns a
   * silent loss into a detectable one. Leave unset for a far side that never
   * stamped it: absent provenance then correctly means "not recorded".
   */
  readonly expectProvenance?: boolean;
}

function forwardableCustom(
  custom: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!custom) {
    return undefined;
  }
  const kept = Object.fromEntries(
    Object.entries(custom).filter(([key]) => key.startsWith(FORWARDED_CUSTOM_PREFIX))
  );
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/**
 * Prepare an IR request for sending to another aimatey instance.
 *
 * | field | rule |
 * |---|---|
 * | `messages`, `tools`, `toolChoice`, `responseFormat`, `parameters`, `stream` | forward unchanged |
 * | `metadata.requestId` | forward -- it is the correlation and cancel key (see `BackendAdapter.cancel`) |
 * | `metadata.timestamp`, `metadata.warnings` | forward |
 * | `metadata.provenance` | forward, with `proxyName` **appended** to `middleware`, never replacing |
 * | `metadata.principal` | **strip**: it names the caller as seen by this process; the far side sees the proxy as its caller and has its own principal |
 * | `metadata.custom` | **strip** every key not prefixed {@link FORWARDED_CUSTOM_PREFIX} |
 * | `metadata.providerResponseId` | strip (a response-side field) |
 *
 * `custom` is stripped by default because a proxy cannot safely read
 * anything out of it: an app that writes `{ local: true }` for its own
 * middleware would otherwise make a claim the far side obeys. The prefix lets
 * an application mark what may cross without the library understanding it.
 *
 * Pure: the input is not mutated.
 */
export function prepareForwardedRequest(
  request: IRChatRequest,
  options: ForwardingOptions
): IRChatRequest {
  const {
    custom,
    principal: _principal,
    providerResponseId: _dropped,
    ...metadata
  } = request.metadata;
  const forwardedCustom = forwardableCustom(custom);
  const provenance = request.metadata.provenance;

  const forwarded: IRMetadata = {
    ...metadata,
    ...(provenance
      ? {
          provenance: {
            ...provenance,
            middleware: [...(provenance.middleware ?? []), options.proxyName],
          },
        }
      : {}),
    ...(forwardedCustom ? { custom: forwardedCustom } : {}),
  };

  return { ...request, metadata: forwarded };
}

/**
 * Prepare a response received from another aimatey instance for returning to
 * this process's caller.
 *
 * | field | rule |
 * |---|---|
 * | `message`, `finishReason`, `usage` | forward unchanged |
 * | `raw` | **strip, always.** It is the far side's provider payload, unredacted, and doubles the response; the proxy's own hop has no provider payload to stamp, so it is absent |
 * | `metadata.requestId`, `providerResponseId`, `timestamp` | forward -- correlation with the far side's logs and the provider's billing |
 * | `metadata.provenance` | **rewrite**: `{ backend: proxyName, locality, upstream: <far provenance> }` via `withUpstreamProvenance`, so the near hop stays authoritative and the far side nests beneath it. `locality` is the proxy's own link: `'external'` unless {@link ForwardingOptions.locality} says otherwise |
 * | `metadata.warnings` | **merge** the far side's, each `source` rewritten to `<proxyName>/<source>` (`<proxyName>/upstream` when the far side named none), so a reader can tell which hop degraded; add `provenance-lost` when `expectProvenance` and none arrived |
 * | `metadata.custom` | strip every key not prefixed {@link FORWARDED_CUSTOM_PREFIX} |
 *
 * Pure: the input is not mutated.
 */
export function prepareForwardedResponse(
  response: IRChatResponse,
  options: ForwardResponseOptions
): IRChatResponse {
  const { raw: _raw, ...rest } = response;
  const {
    custom,
    provenance: farProvenance,
    warnings: farWarnings,
    ...metadata
  } = response.metadata;

  const warnings: IRWarning[] = (farWarnings ?? []).map((w) => ({
    ...w,
    source: `${options.proxyName}/${w.source ?? 'upstream'}`,
  }));
  const hasFarProvenance =
    farProvenance !== undefined && Object.values(farProvenance).some((v) => v !== undefined);
  if (options.expectProvenance && !hasFarProvenance) {
    warnings.push(createProvenanceLostWarning(options.proxyName, options.proxyName));
  }

  const forwardedCustom = forwardableCustom(custom);

  const forwarded: IRMetadata = {
    ...metadata,
    provenance: withUpstreamProvenance(
      { backend: options.proxyName, locality: options.locality ?? 'external' },
      farProvenance
    ),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(forwardedCustom ? { custom: forwardedCustom } : {}),
  };

  return { ...rest, metadata: forwarded };
}
