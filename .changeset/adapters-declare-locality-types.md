---
"@johnhenry/aimatey-types": minor
"@johnhenry/aimatey-utils": minor
---

Adapters can declare where a hop went (#174, follow-up to #130). `localityForBaseURL(url)` (`'same-host'` for loopback, `localhost`, `*.localhost`, `127.0.0.0/8`, `::1` and unix sockets; `'external'` for everything else, including anything unparseable) and `servedByForBaseURL(url)` (`host[:port]` only; never credentials, path or query) are new in `@johnhenry/aimatey-utils`. New optional `IRProvenance.servedBy`: the host the adapter actually called, informational and never a trust signal, separate from `locality` and from `IRMetadata.principal`. `prepareForwardedResponse()` now marks the proxy's own hop `locality: 'external'` (override with the new `ForwardingOptions.locality`).

Breaking change: the provenance `prepareForwardedResponse()` returns now carries `locality: 'external'` on the proxy hop; a test that compares it with an exact object needs the extra field.
