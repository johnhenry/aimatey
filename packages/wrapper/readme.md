# @johnhenry/aimatey-wrapper

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Faimatey-wrapper.svg)](https://www.npmjs.com/package/@johnhenry/aimatey-wrapper)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Faimatey-wrapper.svg)](LICENSE)

> **Note:** Previously published as `aimatey-wrapper@0.2.4`.

SDK wrappers and utilities for Aimatey - Universal AI Adapter System.

Part of the [aimatey](https://github.com/johnhenry/aimatey) monorepo.

## Installation

```bash
npm install @johnhenry/aimatey-wrapper
```

## Overview

This package provides SDK-compatible wrappers that let you use familiar SDK patterns (like OpenAI's or Anthropic's) with any Aimatey backend. It also includes IR-native chat utilities for direct usage.

## Included Components

### SDK Wrappers
- **OpenAI SDK Wrapper** - Use OpenAI SDK patterns with any backend
- **Anthropic SDK Wrapper** - Use Anthropic SDK patterns with any backend
- **Chrome AI Wrapper** - Simplified Chrome AI interface
- **AnyMethod Wrapper** - Flexible method-based wrapper

### IR Utilities
- **Chat** - High-level chat interface with conversation management
- **Stream Utilities** - Stream processing helpers

## Usage

### OpenAI SDK Wrapper

```typescript
import { OpenAI } from '@johnhenry/aimatey-wrapper';

const client = new OpenAI({ backend: yourBackend });

const response = await client.chat.completions.create({
  model: 'gpt-5.6-terra',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

### Anthropic SDK Wrapper

```typescript
import { Anthropic } from '@johnhenry/aimatey-wrapper';

const client = new Anthropic({ backend: yourBackend });

const response = await client.messages.create({
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: 'Hello!' }],
  max_tokens: 1024,
});
```

### IR Chat Interface

```typescript
import { Chat, createChat } from '@johnhenry/aimatey-wrapper';

const chat = createChat({ backend: yourBackend });

// Send a message
const response = await chat.send('Hello!');

// Stream a response
for await (const chunk of chat.stream('Tell me a story')) {
  process.stdout.write(chunk.delta);
}
```

### Stream Utilities

```typescript
import { collectStream, streamToText } from '@johnhenry/aimatey-wrapper';

// Collect all chunks from a stream
const collected = await collectStream(stream);

// Convert stream to text
const text = await streamToText(stream);
```

## API Reference

See the TypeScript definitions for detailed API documentation.

## License

MIT - see [LICENSE](./LICENSE) for details.
