# @johnhenry/aimatey-types

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Faimatey-types.svg)](https://www.npmjs.com/package/@johnhenry/aimatey-types)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Faimatey-types.svg)](LICENSE)

> **Note:** Previously published as `aimatey-types@0.5.1`.

TypeScript type definitions for the aimatey ecosystem

Part of the [aimatey](https://github.com/johnhenry/aimatey) monorepo.

## Installation

```bash
npm install @johnhenry/aimatey-types
```

## Exports

### Core IR Types
- `IRChatRequest` - Universal chat request format
- `IRChatResponse` - Universal chat response format
- `IRMessage` - Individual message in conversation
- `IRStreamChunk` - Streaming response chunk
- `IRParameters` - Generation parameters (temperature, maxTokens, etc.)
- `IRMetadata` - Request/response metadata and provenance
- `IRTool` - Tool/function definition
- `IRUsage` - Token usage statistics
- `IRResponseFormat` - Schema-constrained (structured) output request
- `ToolDefinition`, `RunToolsOptions`, `RunToolsResult` - agentic tool-calling loop types

### Adapter Interfaces
- `FrontendAdapter` - Interface for frontend adapters
- `BackendAdapter` - Interface for backend adapters
- `AdapterMetadata` - Adapter capability metadata

### Middleware
- `Middleware` - Middleware interface
- `MiddlewareContext` - Middleware execution context

### Streaming
- `StreamMode` - Streaming mode ('delta' | 'accumulated')
- `StreamingConfig` - Streaming configuration options

### Utilities
- `MessageRole` - Message role type
- `MessageContent` - Content block types
- `FinishReason` - Generation completion reasons
- `IRCapabilities` - Adapter capabilities
- `IRWarning` - Semantic drift warnings

## Usage

```typescript
import {
  IRChatRequest,
  IRChatResponse,
  IRMessage,
  IRStreamChunk,
  FrontendAdapter,
  BackendAdapter,
  Middleware
} from '@johnhenry/aimatey-types';

// Create a chat request
const request: IRChatRequest = {
  messages: [
    { role: 'user', content: 'Hello!' }
  ],
  parameters: {
    model: 'gpt-4',
    temperature: 0.7
  },
  metadata: {
    requestId: 'req_123',
    timestamp: Date.now(),
    provenance: { frontend: 'openai' }
  }
};

// Request schema-constrained (structured) output
const structuredRequest: IRChatRequest = {
  ...request,
  responseFormat: {
    type: 'json_schema',
    schema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    },
  },
};
```

## Documentation

For comprehensive documentation of the IR format, see:
- [IR Format Guide](../../docs/IR-FORMAT.md) - Complete specification with examples
- [API Reference](../../docs/api.md) - Full API documentation
- [Type Definitions](./src/ir.ts) - Authoritative TypeScript source

## License

MIT - see [LICENSE](./LICENSE) for details.
