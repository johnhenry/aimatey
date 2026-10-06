---
"@johnhenry/aimatey-types": patch
---

Add `IRCapabilities.decisionsEmulated` (the backend answers `decide()` with a chat model through structured output, so answers have no calibrated probabilities) and `IRCapabilities.decisionsEmulatedTypes` (question types answered by emulation rather than natively, e.g. Tev1's `noul` and `score`).
