---
'@johnhenry/aimatey-tool-protocols': minor
---

`code` protocol prompt v2: a worked two-step example (fetch and log, then answer in a later reply), a rule never to call `final()` in the same snippet as a tool call whose result has not been seen, and a rule to read result types from the interface instead of guessing. New `codeProtocol({ systemPrompt })` option to supply your own prompt builder; the old prompt is available as the internal `buildLegacyCodePrompt` for ablations.
