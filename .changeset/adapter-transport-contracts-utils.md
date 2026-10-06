---
"@johnhenry/aimatey-utils": minor
---

Add the helpers behind the proxying-adapter contracts (#121, #124, #127).

- `prepareForwardedRequest(request, { proxyName })` / `prepareForwardedResponse(response, { proxyName, expectProvenance? })`: strip `raw` and `metadata.principal` always, forward only `metadata.custom` keys prefixed `FORWARDED_CUSTOM_PREFIX` (`'e2e:'`), append the proxy to the request's provenance middleware chain, nest the far side's provenance under the proxy via `withUpstreamProvenance`, merge far-side warnings with `source` rewritten to `<proxyName>/<source>`, and add `provenance-lost` when provenance was expected and missing. Pure.
- `withCancellation()` / `withStreamCancellation()`: call `adapter.cancel(requestId)` once when a signal aborts mid-call.
- `createCancellationRegistry({ tombstoneMs? })`: the far side's map from an incoming cancel's `requestId` to the in-flight `AbortController`.
- `resolveCapabilities(adapter, signal?)`: the discovered capabilities, or the static ones for an adapter that cannot discover.
- `supportsEmbeddings(adapter, capabilities?)` and `supportsDecisions(adapter, capabilities?)` take an optional second argument (default: static metadata, unchanged behaviour).
