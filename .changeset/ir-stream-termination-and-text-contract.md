---
"@johnhenry/aimatey-types": minor
"@johnhenry/aimatey-utils": minor
"@johnhenry/aimatey-core": minor
---

The `IRChatStream` contract is now written down and enforced: a stream ends with exactly one terminal chunk, the deltas are the text, and a resumed stream continues its numbering.

**Termination.** An iterator that completed without a `done` or `error` chunk used to look like a finished reply, and `Router` credited it as a success, so the circuit breaker could not open on the failure that most resembles a healthy one. `Bridge` and `Router` now run every backend stream through the new `withTerminationGuard()` (utils), which closes a silent end with an `error` chunk (`code: 'stream-truncated'`, numbered as the next sequence), drops anything after a terminal chunk, and leaves a cancelled request alone.

**Behaviour change (core).** `Router` now counts a stream that ends without a terminal chunk as a backend failure (it may open the breaker, and a truncation before anything was delivered fails over). A third-party adapter that legitimately ended without `done` must now emit one. `tests/unit/router-streaming-fallback.test.ts` asserted the old behaviour and was updated.

**Authoritative text.** `StreamContentChunk.accumulated`, when present, MUST equal the running sum of `delta`; `StreamDoneChunk.message`, when present, is authoritative and MUST equal the delta sum (a mismatch is a transport fault, not a model fault); a proxy may drop `accumulated` only from every chunk of a stream. Every shipped backend already satisfied this; `convertChunkMode`'s `transform` option does not, and is documented as such. New in utils: `validateStreamContract()`, `monitorStreamContract()`, `createStreamContractMonitor()`, `getMessageText()`. New in types: `StreamContractViolation`, `StreamContractViolationCode`, and `BridgeConfig.onContractViolation` (opt-in dev/test check; costs nothing when unset).

**Resumption.** New optional `BaseStreamChunk.resumedFrom?: { sequence: number }` marks the first chunk after an interrupted stream was resumed; its `sequence` must be `resumedFrom.sequence + 1`. Additive. It is not a resume key (a per-stream id is a separate design, shared with cancellation, and is not decided here).

Documented in `docs/IR-FORMAT.md` and the docs-site IR page.
