---
"@johnhenry/aimatey-patterns": patch
"@johnhenry/aimatey-http-core": patch
---

Declare the `@johnhenry/aimatey-utils` dependency both packages already import. It resolved only through workspace hoisting, so a published install could fail.
