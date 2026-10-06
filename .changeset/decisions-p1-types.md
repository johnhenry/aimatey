---
"@johnhenry/aimatey-types": minor
---

Decision IR v2. Mostly additive, with one **breaking change for consumers**:

**Breaking (consumers).** `probabilities` and `confidence` are now **optional** on `choice` and `score` answers (`IRDecisionAnswer`). OpenRouter's schema marks them optional and an LLM-emulated answer has neither; there is no `confidence: 0` sentinel. Any code that reads `answer.probabilities[...]`, `answer.probabilities.map(...)`, or `answer.confidence` as a number must now handle `undefined`. Code that only *produces* answers is unaffected.

**Breaking (implementers of `FrontendAdapter`).** `toIR`, `fromIR` and `fromIRStream` are now optional on `FrontendAdapter` (as `execute`/`fromIR` already are on `BackendAdapter`), so a decision-only frontend can be a real `FrontendAdapter`. Code that calls them through the interface type must check first (`supportsChatFrontend()` in `@johnhenry/aimatey-utils`); `Bridge` already does.

Additions:

- `IRDecisionRequest.images?: readonly ImageContent[]`; `IRCapabilities.decisionImages?`.
- `noul` questions accept `criteria?: { true: string; false: string }`.
- `reasoning?: string` on all three answer variants.
- `IRDecisionUsage.outputTokens?` and `cost?` (promoted from `details`).
- `IRDecisionResponse.id?` and `provider?`.
- `IRCapabilities.decisionTypes?` (`'choice' | 'score' | 'noul'`) and `decisionLimits?` (`maxQuestions`, `maxChoiceOptions`, `maxScoreLevels`, `maxStateTokens`, `maxImages`).
- `FrontendAdapter.decisionToIR?` / `decisionFromIR?`, used by `Bridge.decideFrom()`.
- `WarningCategory` gains `'response-malformed'` (used by `validateDecisionResponse`).
