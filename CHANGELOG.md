# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note:** All 23 publishable packages in this monorepo moved into the `@johnhenry` npm scope
> and restarted their version numbers at `0.0.0`. Each package's own CHANGELOG.md and readme.md
> record its prior unscoped name and last published version. Entries below this note continue to
> use the package names that were accurate at the time they were written.

## [Unreleased]

### Added
- New package `aimatey-models` (`@johnhenry/aimatey-models`): a data-only model catalog (status with dates
  and successor, recommended defaults, capabilities, context limits, pricing with `pricingAsOf`) with
  `mergeLiveModels`, `successorOf` and `isDeprecated`, a generator, staleness checks, and a weekly
  GitHub Action that opens a refresh PR. See `packages/aimatey-models/readme.md`
- Structured/schema-constrained output: `responseFormat` on `IRChatRequest`, with native
  mapping for OpenAI/Anthropic/Gemini and best-effort prompt-injection fallback for every
  other backend
- New package `aimatey-mcp`: MCP (Model Context Protocol) tool-calling via an injectable
  `McpClientLike` client (no hard dependency on any MCP SDK) - see `packages/mcp/readme.md`
- Five new backend provider adapters: Inception Labs (Mercury), Moonshot AI (Kimi), SambaNova,
  GitHub Models (free via any GitHub account), and DashScope / Alibaba Cloud Model Studio (Qwen)
- Default model bumps across several adapters (OpenAI, Anthropic, Gemini, xAI, Moonshot,
  OpenRouter) to their current-generation flagships

### Fixed
- CJS packaging: every package now writes a `dist/cjs/package.json` marker
  (`{"type":"commonjs"}`) after build, fixing `require()` resolution that broke under
  each package's root `"type":"module"`
- Anthropic: omit `temperature`/`top_p`/`top_k` for Claude Opus 4.7+/Sonnet 5, which return
  HTTP 400 if these sampling params are set to non-default values

### Changed
- **BREAKING**: Renamed package `aimatey-http-core` to `aimatey-http.core` for naming consistency with other multi-word packages
- Removed deprecated root-level `src/` directory (all code now in `packages/`)
- Added explicit `implements BackendAdapter` interface declarations to Groq, DeepSeek, LMStudio, and NVIDIA backend adapters for consistency

### Improved
- Enhanced documentation for streaming utilities:
  - `streaming-modes.ts`: Clarified purpose for delta/accumulated mode conversion
  - `streaming.ts`: Clarified purpose for general stream operations
  - Added usage examples to both modules showing when to use each

### Migration Guide

#### Package Rename: aimatey-http-core → aimatey-http.core

Update your imports:

```typescript
// Before (WRONG):
import { CoreHTTPHandler } from 'aimatey-http-core';

// After (CORRECT):
import { CoreHTTPHandler } from 'aimatey-http.core';
```

If you have this package in your `package.json`, update the dependency name:

```json
{
  "dependencies": {
    "aimatey-http.core": "*"
  }
}
```

This change aligns with the naming convention used by other multi-word packages:
- `aimatey-react.core`
- `aimatey-react.hooks`
- `aimatey-native.model-runner`
- etc.

### Internal Changes
- All backend adapters now explicitly declare interface implementation for better IDE support and type checking
- Consolidated package structure cleanup complete

## [1.0.0] - 2025-11-29

### Added
- Initial release of consolidated monorepo with 21 packages
- 24 backend provider adapters (OpenAI, Anthropic, Gemini, Mistral, Cohere, Groq, Ollama, and more)
- 7 frontend request adapters
- 10 middleware types (logging, caching, retry, telemetry, etc.)
- 6 HTTP framework integrations (Express, Fastify, Hono, Koa, Node.js, Deno)
- React hooks and components for chat interfaces
- SDK wrappers for OpenAI and Anthropic compatibility
- CLI tools for proxying and format conversion
- Universal IR (Intermediate Representation) format for provider-agnostic AI interactions

[Unreleased]: https://github.com/johnhenry/aimatey/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/johnhenry/aimatey/releases/tag/v1.0.0
