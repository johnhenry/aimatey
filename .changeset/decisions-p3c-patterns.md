---
"@johnhenry/aimatey-patterns": minor
---

Decision patterns (#147), each a default-off factory: `createDecisionEscalation` (Vercel's `when` contract; reruns the whole request on a fallback, sums both stages' usage, records `metadata.custom.escalation`) with `evaluateDecisionCondition`, `validateDecisionCondition` and `decisionBands`; `createNeutralOptionKeys` (opt_1..n keys with the name folded into the description, optional seeded shuffle and `noulAsChoice`); `createDecisionEnsemble` (parallel members, mean/median/custom aggregation, agreement-aware confidence, intersected capabilities); `createStateScreening` (delimits untrusted state and optionally screens it with a noul question before the model); and `createTemperatureScaling` (per-type / per-option-count temperature). `createEmulatedDecisionBackend` now warns with the new `capability-emulated` category instead of `capability-unsupported`.
