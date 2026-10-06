---
"@johnhenry/aimatey-testing": patch
---

`calibrationReport` now takes the predicted probability of being right from `probabilities` (the mass on the answer's own label for `choice`, on the rounded level for `score`, `max(value, 1 - value)` for `noul`) instead of `answer.confidence`, which is a concentration measure rather than P(correct). `confidence` is used only when a `choice` / `score` answer has no `probabilities`. Bucket `meanConfidence` and ECE change accordingly.
