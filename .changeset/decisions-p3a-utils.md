---
"@johnhenry/aimatey-utils": minor
---

Add `validateDecisionRequest(request, capabilities?)`. It throws `ValidationError` for empty questions or instructions, choices/scores with fewer than 2 options, question types the backend's `decisionTypes` excludes, counts over `decisionLimits` (`maxQuestions`, `maxChoiceOptions`, `maxScoreLevels`, `maxImages`) and images sent to a backend without `decisionImages`; it returns `IRWarning`s for instructions over 2000 characters, polar-word choice keys (option-name bias) and mostly non-Latin state for an English-only model. Without `capabilities`, only the shape checks run.
