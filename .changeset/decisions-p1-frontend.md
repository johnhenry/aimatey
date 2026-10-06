---
"@johnhenry/aimatey-frontend": minor
---

`TypeSafeFrontendAdapter` and `LayaFrontendAdapter` now implement `FrontendAdapter` through `decisionToIR` / `decisionFromIR`. **Breaking:** their decision-typed `toIR` / `fromIR` methods are renamed to those, because the chat-typed names on `FrontendAdapter` cannot carry decision types; call sites should use `Bridge.decideFrom()` or the renamed methods. Both accept `images` on the request and omit `probabilities` / `confidence` from converted answers when the IR has none (their native `probabilities` / `confidence` fields are now optional). Laya score answers still get a `legend` built from the original question.
