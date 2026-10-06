---
"@johnhenry/aimatey-core": minor
---

Add `Bridge.decideFrom(request, options?)`, the decision counterpart of `chat()`: it runs `frontend.decisionToIR()`, the decision middleware, `backend.decide()` and `frontend.decisionFromIR()`, so a TypeSafe- or Laya-shaped call returns the same shape. It throws `UNSUPPORTED_FEATURE` if the frontend lacks the decision hooks or the backend cannot decide. `Bridge.decide()` is unchanged (IR in, IR out). `chat()` and `chatStream()` now throw `UNSUPPORTED_FEATURE` for a frontend with no chat conversion instead of calling an absent method.
