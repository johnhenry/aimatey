---
'@johnhenry/aimatey-types': minor
'@johnhenry/aimatey-core': minor
---

`runTools` takes a `protocol` option (`'native'` by default, or a `ToolProtocol` object or a registered name). A protocol shapes the request and reads the reply; the loop keeps argument validation, the gate, `maxIterations`, `parallelToolCalls` and step reporting for every protocol. Adds `ToolProtocol` types, `registerToolProtocol`, and `RunToolsStep.protocol`. No behavior change for existing callers.
