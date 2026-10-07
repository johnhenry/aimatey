---
"@johnhenry/aimatey-frontend": minor
---

Add `OpenAIDecisionsFrontendAdapter`: accepts OpenAI Decisions API (`/v1/decisions`) request bodies (`input` string or `message` items with `input_text` / `input_image` parts, a `questions` array) and returns the `answers[]` response shape with `{ value, probability }` probability arrays and `usage` details. Decision hooks only; drive it with `Bridge.decideFrom()`.
