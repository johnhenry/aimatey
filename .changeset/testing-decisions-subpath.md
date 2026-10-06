---
"@johnhenry/aimatey-testing": minor
---

New Vitest-free `@johnhenry/aimatey-testing/decisions` subpath export (`calibrationReport`, `fitTemperature`, `nameInvariance`, and the decision dataset capture helpers) so CLIs can import them outside a test run. The root export still re-exports them.
