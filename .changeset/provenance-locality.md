---
"@johnhenry/aimatey-types": minor
---

`IRProvenance.locality` and `resolveEgress()` (#130): a per-hop record of the link a hop crossed (`'in-process' | 'same-host' | 'external'`), so a UI can answer "did this reply leave the device?" on a chain like `phone -> desktop -> llama-cpp`.

Set by the adapter that performed the hop, never inferred (the Bridge and Router do not stamp it). Absent means unknown and is treated as `'external'`: `resolveEgress(provenance)` returns the widest link across the chain, `{ locality, declared }`, failing closed for any undeclared hop. There is deliberately no `'same-owner'` member: that is an application trust assertion an adapter cannot originate. `IRMetadata.principal` is documented as relative to the hop that set it and never forwarded across `upstream`.

Additive; no breaking changes. Existing adapters are unaffected and read as `'external'` until they declare a locality.
