# @johnhenry/aimatey-frontend

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Faimatey-frontend.svg)](https://www.npmjs.com/package/@johnhenry/aimatey-frontend)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Faimatey-frontend.svg)](LICENSE)

> **Note:** Previously published as `aimatey-frontend@0.4.1`.

Frontend adapters for Aimatey - Universal AI Adapter System.

Part of the [aimatey](https://github.com/johnhenry/aimatey) monorepo.

## Installation

```bash
npm install @johnhenry/aimatey-frontend
```

## Overview

Frontend adapters convert provider-specific request formats to the Universal IR (Intermediate Representation) format used internally by Aimatey. This allows your application to accept requests in any provider's format and route them to any backend.

## Included Adapters

- **OpenAI** - OpenAI Chat Completions API format
- **Anthropic** - Anthropic Messages API format
- **Gemini** - Google Gemini API format
- **Mistral** - Mistral API format
- **Ollama** - Ollama API format
- **Chrome AI** - Chrome AI format
- **Generic** - Passthrough adapter for IR format

## Usage

```typescript
import { OpenAIFrontendAdapter, AnthropicFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { Bridge } from '@johnhenry/aimatey-core';

// Accept OpenAI-formatted requests
const openAIFrontend = new OpenAIFrontendAdapter();

// Accept Anthropic-formatted requests
const anthropicFrontend = new AnthropicFrontendAdapter();

// Create a bridge that accepts OpenAI format
const bridge = new Bridge(openAIFrontend, yourBackend);
```

## Generic Adapter

The Generic adapter passes IR format directly without conversion:

```typescript
import { GenericFrontendAdapter, createGenericFrontend } from '@johnhenry/aimatey-frontend';

const frontend = createGenericFrontend();
```

## API Reference

See the TypeScript definitions for detailed API documentation.

## License

MIT - see [LICENSE](./LICENSE) for details.
