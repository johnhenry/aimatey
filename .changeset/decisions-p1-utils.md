---
"@johnhenry/aimatey-utils": minor
---

- Add `supportsChatFrontend()` and `supportsDecisionFrontend()`, the frontend-side mirrors of `supportsChat()` / `supportsDecisions()`.
- The model registry seed gains `kind: 'decision'` entries: `jev-1.13.0` (aliases `jev-latest`, `~typesafe/jev-latest`, `typesafe/jev-1.13`), `clef`, `clef-flash`, `pplx-decider-v1-27b`, `nimble`, `tev1`, `kev-4b` and `mercury-decide`, with input pricing (output is free). Their prices come from provider announcements and were not re-verified against first-party pricing pages.
