---
"@johnhenry/aimatey-types": minor
"@johnhenry/aimatey-utils": minor
"@johnhenry/aimatey-core": minor
"@johnhenry/aimatey-backend": patch
"@johnhenry/aimatey-frontend": patch
---

The IR is documented as JSON, and media content can name a payload by a transport-resolved reference.

**JSON (#118).** New `JsonValue`, `JsonObject` and `JsonPrimitive` types, and the contract that the IR's free-form bags (`metadata.custom`, `parameters.custom`, tool `input`, warning `details`, `raw`) are JSON-valued, with `undefined` meaning absent everywhere. The bags stay typed `unknown` in this release: tightening them would reject every caller that stores a class instance or an optional `undefined` property. `findNonJsonValues()`, `isJsonSerializable()` and `assertJsonSerializable()` (utils) give a transport one shared answer, with the path of each offender, and are the migration path to typing the bags `JsonValue` at the next major.

**Blob references (#122) -- breaking for exhaustive consumers.** `ImageContent`, `AudioContent`, `DocumentContent` and `VideoContent` `source` gains a third member, `BlobRefSource` (`{ type: 'ref'; ref: string; mediaType?: string; bytes?: number }`). Code that narrows `source` with `type === 'url' ? ... : source.data` no longer type-checks; handle or reject the `ref` case (`requireResolvedContent()` / `mediaSourceToUrl()` in utils do this in one call). The contract: the transport that minted a handle resolves it before the request reaches a backend; anything that cannot resolve one refuses it with `UNSUPPORTED_FEATURE` -- never drops it, never sends it to a provider, never fetches it. `Bridge` and `Router` enforce it after request middleware (`assertNoUnresolvedBlobRefs()`), `Router` skips a backend that cannot resolve a reference for one that can without counting a failure, the shipped provider adapters refuse a reference handed to them directly, `validateDecisionRequest()` and the System One client reject one in `images`, and a backend that resolves handles itself declares the new `IRCapabilities.blobRefs`.
