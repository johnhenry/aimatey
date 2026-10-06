---
"@johnhenry/aimatey-backend": patch
---

`TypeSafeBackendAdapter` maps `usage.output_tokens` and `usage.cost` onto `usage.outputTokens` and `usage.cost` (`usage.details.cost` is kept for one release), sets `response.provider`, declares `decisionTypes`, `decisionLimits` (255 options, 10 levels, 32,000 state tokens, 0 images) and `decisionImages: false`, and tolerates answers without `probabilities` / `confidence`. Images on a request are dropped with a `capability-unsupported` warning rather than silently. Its `jev-1.13.0` model registration moved from the constructor into the registry seed in `@johnhenry/aimatey-utils`, which now also carries the other decision models.
