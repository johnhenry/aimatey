---
"@johnhenry/aimatey-backend": patch
---

`TypeSafeBackendAdapter.decide()` now throws a `ProviderError` naming the question when the provider omits an answer, instead of silently skipping it and handing the caller an `answers` map with a hole in it. (The old comment claiming validation happened upstream was wrong; nothing upstream validated.)
