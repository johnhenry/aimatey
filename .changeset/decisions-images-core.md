---
"@johnhenry/aimatey-core": minor
"@johnhenry/aimatey-wrapper": patch
"@johnhenry/aimatey-cli": patch
---

`Bridge.decide()` and `decideBatch()` accept `options.images` and put them on the `IRDecisionRequest`; a backend without `decisionImages` still rejects them at validation. The decision wrappers (`createTypeSafeClient`, `createDecide`, `createDecisionModel`) no longer refuse image requests when the Bridge's frontend differs from the wrapper's, and the `decide` CLI passes `--image` through the option instead of a middleware.
