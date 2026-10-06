---
"@johnhenry/aimatey-utils": minor
---

Add `validateDecisionResponse(request, response)`. It checks that a typed-decision response actually answers its request and **throws** a `ValidationError` for hard failures: an unanswered question, an answer whose `type` differs from its question's, a `choice` value that is not a `criteria` key, a `score` outside `[0, levels - 1]` or a `noul` outside `[0, 1]`, or any non-finite number. It **returns** `IRWarning`s (category `response-malformed`) for soft ones: probabilities that sum to 1 +/- 0.02 fails, or probability keys or length that do not match the question's `criteria`.
