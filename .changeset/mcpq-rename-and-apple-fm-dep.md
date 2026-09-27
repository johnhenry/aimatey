---
"@johnhenry/aimatey-mcp": patch
"@johnhenry/aimatey-native-apple": patch
---

Fix two stale-reference/dependency-declaration issues found in a cross-library audit:

- `aimatey-mcp`'s readme and `src/types.ts` referenced the deprecated package name
  `@johnhenry/mcpq` for the reference MCP client. That name is deprecated on npm
  ("Renamed to @johnhenry/mcp-query. This name is reserved for a future CLI.") — updated
  every reference to point at the current package, `@johnhenry/mcp-query`. The API
  (`MCPClient`, `ConnectionConfig`, `webMcpToolServer()`) is unchanged between the two
  names, so no code examples needed to change, only the package name.
- `aimatey-native-apple` imports `@johnhenry/apple-foundation-models` at runtime
  (dynamic `import()` in `src/index.ts`) but never declared it in `package.json`,
  so a fresh install of this package alone wouldn't satisfy that import. Added it as
  an `optionalDependency` (`^0.0.0`, matching its current published version) rather
  than a hard dependency, since it's a macOS/Apple-Silicon-only native binding and
  this package already gracefully no-ops on unsupported platforms — matching how
  other consumers in this family (e.g. `orrery`) declare the same package.
