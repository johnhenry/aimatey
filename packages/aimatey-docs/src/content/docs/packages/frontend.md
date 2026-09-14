---
title: "@johnhenry/aimatey-frontend"
description: "Guide to the frontend adapters in @johnhenry/aimatey-frontend: accept requests in OpenAI, Anthropic, Gemini, and other formats."
---

Frontend adapters define the input format for your AI requests. Write code in any API format you prefer - OpenAI, Anthropic, Google Gemini, or others.

## Installation

```bash
npm install @johnhenry/aimatey-frontend
```

## Overview

Frontend adapters translate your chosen API format into aimatey's Intermediate Representation (IR). This allows you to write code in whatever format you're most comfortable with.

**Available Adapters:**
- OpenAI (`/openai`)
- Anthropic (`/anthropic`)
- Google Gemini (`/gemini`)
- Ollama (`/ollama`)
- Mistral (`/mistral`)
- Chrome built-in AI (`/chrome-ai`)
- Generic IR (`/generic`)

## OpenAI Frontend Adapter

Use OpenAI's API format as input.

### Installation

```typescript
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend/openai';
```

### Usage

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend/openai';
import { AnthropicBackendAdapter } from '@johnhenry/aimatey-backend/anthropic';

const bridge = new Bridge(
  new OpenAIFrontendAdapter(),
  new AnthropicBackendAdapter({ apiKey: 'your-key' })
);

// Write in OpenAI format
const response = await bridge.chat({
  model: 'gpt-4',
  messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello!' }
  ],
  temperature: 0.7,
  max_tokens: 100
});
```

### Supported Features

- ✅ Chat completions
- ✅ Streaming
- ✅ Function calling/tools
- ✅ Vision (image inputs)
- ✅ System messages
- ✅ Temperature, top_p, max_tokens
- ✅ Stop sequences
- ✅ Presence/frequency penalties

### Request Format

```typescript
interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  stream?: boolean;
  user?: string;
  seed?: number;
  tools?: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: object } }>;
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
}
```

## Anthropic Frontend Adapter

Use Anthropic's API format as input.

### Installation

```typescript
import { AnthropicFrontendAdapter } from '@johnhenry/aimatey-frontend/anthropic';
```

### Usage

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import { AnthropicFrontendAdapter } from '@johnhenry/aimatey-frontend/anthropic';
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend/openai';

const bridge = new Bridge(
  new AnthropicFrontendAdapter(),
  new OpenAIBackendAdapter({ apiKey: 'your-key' })
);

// Write in Anthropic format
const response = await bridge.chat({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 100,
  messages: [
    { role: 'user', content: 'Hello!' }
  ],
  system: 'You are helpful.', // System message separate
  temperature: 0.7
});
```

### Key Differences from OpenAI

- System messages are a separate `system` parameter (not in messages array)
- `max_tokens` is **required**
- No `presence_penalty` or `frequency_penalty`
- Different tool/function calling format

### Supported Features

- ✅ Chat completions
- ✅ Streaming
- ✅ Tool use
- ✅ Vision (image inputs)
- ✅ System messages (as parameter)
- ✅ Temperature, top_p, top_k
- ✅ Stop sequences

## Google Gemini Frontend Adapter

Use Google's Gemini API format as input.

### Installation

```typescript
import { GeminiFrontendAdapter } from '@johnhenry/aimatey-frontend/gemini';
```

### Usage

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import { GeminiFrontendAdapter } from '@johnhenry/aimatey-frontend/gemini';
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend/openai';

const bridge = new Bridge(
  new GeminiFrontendAdapter(),
  new OpenAIBackendAdapter({ apiKey: 'your-key' })
);

// Write in Gemini format
const response = await bridge.chat({
  model: 'gemini-1.5-pro',
  contents: [
    {
      role: 'user',
      parts: [{ text: 'Hello!' }]
    }
  ],
  generationConfig: {
    temperature: 0.7,
    maxOutputTokens: 100
  }
});
```

### Key Differences

- Uses `contents` instead of `messages`
- Uses `parts` for multi-modal content
- Role is `model` instead of `assistant`
- Configuration in `generationConfig` object
- System instructions separate parameter

### Supported Features

- ✅ Chat completions
- ✅ Streaming
- ✅ Function calling
- ✅ Vision (native multi-modal support)
- ✅ System instructions
- ✅ Temperature, topP, topK
- ✅ Stop sequences
- ✅ Safety settings

## Ollama Frontend Adapter

Use Ollama's API format (compatible with local models).

### Installation

```typescript
import { OllamaFrontendAdapter } from '@johnhenry/aimatey-frontend/ollama';
```

### Usage

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import { OllamaFrontendAdapter } from '@johnhenry/aimatey-frontend/ollama';
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend/openai';

const bridge = new Bridge(
  new OllamaFrontendAdapter(),
  new OpenAIBackendAdapter({ apiKey: 'your-key' })
);

// Write in Ollama format
const response = await bridge.chat({
  model: 'llama3.2',
  messages: [
    { role: 'user', content: 'Hello!' }
  ],
  stream: false
});
```

### Supported Features

- ✅ Chat completions
- ✅ Streaming
- ✅ System messages
- ✅ Temperature, top_p, top_k
- ⚠️ Limited tool support (model-dependent)

## Mistral Frontend Adapter

Use Mistral's API format (very similar to OpenAI).

### Installation

```typescript
import { MistralFrontendAdapter } from '@johnhenry/aimatey-frontend/mistral';
```

### Usage

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import { MistralFrontendAdapter } from '@johnhenry/aimatey-frontend/mistral';
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend/openai';

const bridge = new Bridge(
  new MistralFrontendAdapter(),
  new OpenAIBackendAdapter({ apiKey: 'your-key' })
);

// Mistral format is very similar to OpenAI
const response = await bridge.chat({
  model: 'mistral-large-latest',
  messages: [
    { role: 'user', content: 'Hello!' }
  ],
  temperature: 0.7
});
```

## Groq and Other OpenAI-Compatible APIs

Groq's API is OpenAI-compatible, so there is no separate Groq frontend adapter -
use `OpenAIFrontendAdapter` for Groq-shaped requests. (Groq *as a provider* is
available on the backend side, as `@johnhenry/aimatey-backend/groq`.)

## Choosing a Frontend Adapter

### Use OpenAI Frontend Adapter if:
- You're familiar with OpenAI's API
- You want the most widely-used format
- Your codebase already uses OpenAI
- You need maximum compatibility

### Use Anthropic Frontend Adapter if:
- You prefer Anthropic's API design
- You want explicit system message separation
- Your codebase uses Claude

### Use Gemini Frontend Adapter if:
- You're working with Google AI Platform
- You need native multi-modal support
- You use Vertex AI

### Use Ollama Frontend Adapter if:
- You're working with local models
- You want a simple format
- You're developing locally

## Feature Compatibility Matrix

| Feature | OpenAI | Anthropic | Gemini | Ollama | Mistral | Chrome AI |
|---------|--------|-----------|--------|--------|---------|-----------|
| Chat | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Streaming | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Tools/Functions | ✅ | ✅ | ✅ | ⚠️ | ✅ | ❌ |
| Vision | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ❌ |
| System Messages | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

✅ Fully supported | ⚠️ Partially supported | ❌ Not supported

## Creating Custom Frontend Adapters

You can create your own frontend adapter:

`toIR()` and `fromIR()` are async, and `fromIRStream()` is required.

```typescript
import type {
  AdapterMetadata,
  FrontendAdapter,
  IRChatRequest,
  IRChatResponse,
  IRChatStream
} from '@johnhenry/aimatey-types';

export class CustomFrontendAdapter
  implements FrontendAdapter<CustomRequest, CustomResponse, CustomChunk>
{
  readonly metadata: AdapterMetadata = {
    name: 'custom',
    version: '1.0.0',
    provider: 'Custom',
    capabilities: {
      streaming: true,
      multiModal: false,
      systemMessageStrategy: 'in-messages',
      supportsMultipleSystemMessages: true
    }
  };

  // Convert custom format to IR
  async toIR(request: CustomRequest): Promise<IRChatRequest> {
    return {
      messages: request.conversation.map((msg) => ({
        role: msg.sender === 'human' ? 'user' : 'assistant',
        content: msg.text
      })),
      parameters: {
        model: request.modelName,
        temperature: request.temp,
        maxTokens: request.maxLength
      },
      metadata: {
        requestId: crypto.randomUUID(),
        timestamp: Date.now(),
        provenance: { frontend: 'custom' }
      }
    };
  }

  // Convert IR back to custom format
  async fromIR(response: IRChatResponse): Promise<CustomResponse> {
    return {
      reply: typeof response.message.content === 'string' ? response.message.content : '',
      tokens: response.usage?.totalTokens ?? 0
    };
  }

  // Stream support
  async *fromIRStream(stream: IRChatStream) {
    for await (const chunk of stream) {
      if (chunk.type === 'content') {
        yield { text: chunk.delta, done: false };
      } else if (chunk.type === 'done') {
        yield { text: '', done: true };
      }
    }
  }
}
```

## Best Practices

### 1. Choose Based on Your Codebase

If your codebase already uses a specific API format, use that frontend adapter:

```typescript
// Existing OpenAI code
const openaiResponse = await openai.chat.completions.create({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello' }]
});

// Easy migration - use OpenAI frontend adapter
const bridge = new Bridge(
  new OpenAIFrontendAdapter(), // Same format!
  new AnthropicBackendAdapter({ apiKey })
);
```

### 2. Frontend is Independent of Backend

Mix and match any frontend with any backend:

```typescript
// OpenAI format → Anthropic backend
new Bridge(new OpenAIFrontendAdapter(), new AnthropicBackendAdapter({ apiKey }));

// Anthropic format → OpenAI backend
new Bridge(new AnthropicFrontendAdapter(), new OpenAIBackendAdapter({ apiKey }));

// Gemini format → Groq backend
new Bridge(new GeminiFrontendAdapter(), new GroqBackendAdapter({ apiKey }));
```

### 3. Type Safety

Use TypeScript for frontend-specific request types:

```typescript
import type {
  OpenAIRequest,
  OpenAIResponse,
  OpenAIStreamChunk
} from '@johnhenry/aimatey-frontend/openai';

const bridge = new Bridge(
  new OpenAIFrontendAdapter(),
  new AnthropicBackendAdapter({ apiKey })
);

const request: OpenAIRequest = {
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello' }]
};

const response: OpenAIResponse = await bridge.chat(request);

// Streaming chunks are typed as OpenAIStreamChunk
for await (const chunk of bridge.chatStream({ ...request, stream: true })) {
  const delta: OpenAIStreamChunk = chunk;
  process.stdout.write(delta.choices[0]?.delta?.content ?? '');
}
```

## Semantic Drift

When converting between formats, some features may not map perfectly. This is called "semantic drift."

### Example: System Messages

```typescript
// OpenAI: system messages in array
{
  messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello' }
  ]
}

// Anthropic: system separate
{
  system: 'You are helpful.',
  messages: [
    { role: 'user', content: 'Hello' }
  ]
}
```

The adapter handles this automatically, but be aware of potential drift.

### Handling Drift

Frontend adapters track and warn about semantic drift:

```typescript
const response = await bridge.chat(request);

if (response.warnings) {
  console.warn('Semantic drift detected:', response.warnings);
}
```

## See Also

- [Backend Adapters](/packages/backend) - Available backend providers
- [IR Format](/guides/architecture/ir-format) - Intermediate representation details
- [Core Package](/packages/core) - Bridge and Router documentation
- [Tutorial: Simple Bridge](/tutorials/beginner/simple-bridge) - Step-by-step guide
