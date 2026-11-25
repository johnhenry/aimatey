---
'@johnhenry/aimatey-tool-protocols': minor
---

Add the `code` tool protocol: the model writes JavaScript against a generated `tools.*` API and a `CodeExecutor` runs it. Includes `codeProtocol()`, `registerCodeProtocol()`, `generateToolsInterface()` and `andboxExecutor()` (sandboxed via the optional peer `@johnhenry/andbox` in wasm mode). Every tool call from a snippet goes through the same validation, gate and execute path as native calls.
