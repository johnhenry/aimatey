---
"@johnhenry/aimatey-types": patch
"@johnhenry/aimatey-frontend": minor
---

Add `LayaFrontendAdapter`, translating `Router.predict()`/`Agent.system_one()`-shaped calls (ConvAI's Laya, a self-hosted typed-decision model) into the Decision IR.

Frontend only, deliberately: Laya has no hosted API today -- confirmed, not assumed (no web-framework dependency in its `pyproject.toml`, and its only running instance is a quota-limited `ZeroGPU` demo Space, not something to build a production backend against). `LayaBackendAdapter` needs a new, separately-hosted Python wrapper service that doesn't exist yet; see `laya.ts`'s module comment for the exact contract that service should expose so the eventual backend adapter can be as thin as `TypeSafeBackendAdapter` is today.

Along the way: `IRDecisionAnswer`'s `noul` variant gained an optional `confidence` field. Laya reports one (`max(p, 1-p)`); Jev's wire format doesn't -- it's optional rather than absent so a provider that has it isn't forced to throw it away, and `LayaFrontendAdapter` derives it when the upstream response doesn't supply one.
