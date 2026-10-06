# Intermediate Representation (IR) Format

**Last Updated:** 2025-11-29

## Table of Contents

- [Overview](#overview)
- [Design Principles](#design-principles)
- [Message Types](#message-types)
- [Request Format](#request-format)
- [Response Format](#response-format)
- [Streaming Format](#streaming-format)
- [Metadata & Provenance](#metadata--provenance)
- [Tools & Function Calling](#tools--function-calling)
- [Structured Output](#structured-output)
- [Parameters](#parameters)
- [Capabilities](#capabilities)
- [Decision IR](#decision-ir)
- [Examples](#examples)

---

## Overview

The **Intermediate Representation (IR)** is the universal format that sits between frontend and backend adapters in the aimatey ecosystem. It represents chat requests, responses, and streams in a normalized, provider-agnostic way.

```
Client (OpenAI format)
        ↓
Frontend Adapter → IR Format → Backend Adapter
                                        ↓
                                Provider (Anthropic API)
```

The IR acts as a translation layer, allowing any client format to work with any backend provider.

---

## Design Principles

### 1. Provider-Agnostic
No provider-specific fields in core types. All providers map to the same IR structure.

### 2. Extensible
Support for metadata and custom fields allows provider-specific data to flow through without breaking compatibility.

### 3. Type-Safe
Uses TypeScript discriminated unions for runtime type checking and compile-time safety.

### 4. Stream-Friendly
First-class support for streaming responses with multiple streaming modes (delta and accumulated).

### 5. Semantic Drift Tracking
Captures transformations and compatibility warnings when converting between formats.

---

## Message Types

### MessageRole

The role of a participant in the conversation:

```typescript
type MessageRole = 'system' | 'user' | 'assistant' | 'tool';
```

**Role Mapping Across Providers:**

| IR Role | OpenAI | Anthropic | Gemini | Ollama |
|---------|---------|-----------|---------|---------|
| `system` | `system` | (separate param) | `systemInstruction` | `system` |
| `user` | `user` | `user` | `user` | `user` |
| `assistant` | `assistant` | `assistant` | `model` | `assistant` |
| `tool` | `tool` | `tool_result` | N/A | N/A |

### MessageContent

Messages can contain different types of content:

#### TextContent

Plain text content:

```typescript
interface TextContent {
  readonly type: 'text';
  readonly text: string;
}
```

**Example:**
```typescript
{
  type: 'text',
  text: 'Hello, how can I help you today?'
}
```

#### ImageContent

Image content from URL or base64:

```typescript
interface ImageContent {
  readonly type: 'image';
  readonly source:
    | {
        readonly type: 'url';
        readonly url: string;
      }
    | {
        readonly type: 'base64';
        readonly mediaType: string;
        readonly data: string;
      };
}
```

**Examples:**
```typescript
// Image from URL
{
  type: 'image',
  source: {
    type: 'url',
    url: 'https://example.com/photo.jpg'
  }
}

// Base64 image
{
  type: 'image',
  source: {
    type: 'base64',
    mediaType: 'image/jpeg',
    data: 'iVBORw0KGgo...'
  }
}
```

#### ToolUseContent

AI requesting to call a tool:

```typescript
interface ToolUseContent {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}
```

**Example:**
```typescript
{
  type: 'tool_use',
  id: 'toolu_01A2B3C4D5E6',
  name: 'get_weather',
  input: {
    location: 'San Francisco',
    units: 'celsius'
  }
}
```

#### ToolResultContent

Result from tool execution:

```typescript
interface ToolResultContent {
  readonly type: 'tool_result';
  readonly toolUseId: string;
  readonly content: string | TextContent[];
  readonly isError?: boolean;
}
```

**Example:**
```typescript
{
  type: 'tool_result',
  toolUseId: 'toolu_01A2B3C4D5E6',
  content: 'Temperature: 18°C, Conditions: Partly cloudy',
  isError: false
}
```

### IRMessage

A complete message in the conversation:

```typescript
interface IRMessage {
  readonly role: MessageRole;
  readonly content: string | readonly MessageContent[];
  readonly name?: string;
  readonly metadata?: Record<string, unknown>;
}
```

**Examples:**

```typescript
// Simple text message
{
  role: 'user',
  content: 'Hello, AI!'
}

// Multi-modal message with image
{
  role: 'user',
  content: [
    { type: 'text', text: 'What is in this image?' },
    {
      type: 'image',
      source: {
        type: 'url',
        url: 'https://example.com/photo.jpg'
      }
    }
  ]
}

// System message
{
  role: 'system',
  content: 'You are a helpful assistant specializing in technical support.'
}
```

---

## Request Format

### IRChatRequest

The complete request structure:

```typescript
interface IRChatRequest {
  readonly messages: readonly IRMessage[];
  readonly tools?: readonly IRTool[];
  readonly toolChoice?: 'auto' | 'required' | 'none' | { readonly name: string };
  readonly responseFormat?: IRResponseFormat;
  readonly parameters?: IRParameters;
  readonly metadata: IRMetadata;
  readonly stream?: boolean;
  readonly streamMode?: StreamMode;
}
```

**Field Descriptions:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `messages` | `IRMessage[]` | ✅ | Conversation messages (minimum 1) |
| `tools` | `IRTool[]` | ❌ | Available tools/functions |
| `toolChoice` | `string \| object` | ❌ | Tool selection strategy |
| `responseFormat` | `IRResponseFormat` | ❌ | JSON-schema-constrained output request (see [Structured Output](#structured-output)) |
| `parameters` | `IRParameters` | ❌ | Generation parameters (temperature, etc.) |
| `metadata` | `IRMetadata` | ✅ | Request tracking metadata |
| `stream` | `boolean` | ❌ | Enable streaming (default: false) |
| `streamMode` | `StreamMode` | ❌ | Streaming mode (default: 'delta') |

**Complete Example:**

```typescript
{
  messages: [
    {
      role: 'system',
      content: 'You are a helpful assistant.'
    },
    {
      role: 'user',
      content: 'What is the weather in Tokyo?'
    }
  ],
  tools: [
    {
      name: 'get_weather',
      description: 'Get current weather for a location',
      parameters: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'City name or coordinates'
          },
          units: {
            type: 'string',
            enum: ['celsius', 'fahrenheit'],
            default: 'celsius'
          }
        },
        required: ['location']
      }
    }
  ],
  toolChoice: 'auto',
  parameters: {
    model: 'gpt-4',
    temperature: 0.7,
    maxTokens: 1000,
    topP: 0.9
  },
  metadata: {
    requestId: 'req_abc123xyz',
    timestamp: 1701234567890,
    provenance: {
      frontend: 'openai'
    }
  },
  stream: false
}
```

---

## Response Format

### IRChatResponse

The complete response structure:

```typescript
interface IRChatResponse {
  readonly message: IRMessage;
  readonly finishReason: FinishReason;
  readonly usage?: IRUsage;
  readonly metadata: IRMetadata;
  readonly raw?: Record<string, unknown>;
}
```

**Field Descriptions:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | `IRMessage` | ✅ | Generated assistant message |
| `finishReason` | `FinishReason` | ✅ | Why generation stopped |
| `usage` | `IRUsage` | ❌ | Token usage statistics |
| `metadata` | `IRMetadata` | ✅ | Response tracking metadata |
| `raw` | `object` | ❌ | Provider-specific raw response |

### FinishReason

Why the generation completed:

```typescript
type FinishReason =
  | 'stop'           // Natural completion
  | 'length'         // Hit max tokens
  | 'tool_calls'     // Requested tool execution
  | 'content_filter' // Filtered by safety system
  | 'error'          // Error occurred
  | 'cancelled';     // Request cancelled
```

### IRUsage

Token usage statistics:

```typescript
interface IRUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly details?: Record<string, unknown>;
}
```

**Example Response:**

```typescript
{
  message: {
    role: 'assistant',
    content: 'The weather in Tokyo is currently 22°C with clear skies.'
  },
  finishReason: 'stop',
  usage: {
    promptTokens: 45,
    completionTokens: 18,
    totalTokens: 63
  },
  metadata: {
    requestId: 'req_abc123xyz',
    providerResponseId: 'chatcmpl-9A1B2C3D',
    timestamp: 1701234567890,
    provenance: {
      frontend: 'openai',
      backend: 'anthropic',
      middleware: ['logging', 'caching']
    }
  }
}
```

---

## Streaming Format

### Streaming Modes

The IR supports two streaming modes:

#### Delta Mode (Default)

Most efficient - each chunk contains only new content:

```typescript
// Chunk 1
{ type: 'content', delta: 'Hello', sequence: 0 }

// Chunk 2
{ type: 'content', delta: ' world', sequence: 1 }

// Chunk 3
{ type: 'content', delta: '!', sequence: 2 }
```

#### Accumulated Mode

Each chunk contains full text so far (Chrome AI style):

```typescript
// Chunk 1
{ type: 'content', delta: 'Hello', accumulated: 'Hello', sequence: 0 }

// Chunk 2
{ type: 'content', delta: ' world', accumulated: 'Hello world', sequence: 1 }

// Chunk 3
{ type: 'content', delta: '!', accumulated: 'Hello world!', sequence: 2 }
```

### Stream Chunk Types

```typescript
type IRStreamChunk =
  | StreamStartChunk
  | StreamContentChunk
  | StreamToolUseChunk
  | StreamMetadataChunk
  | StreamDoneChunk
  | StreamErrorChunk;
```

#### Chunk sequence numbers

Every chunk carries a `sequence`. **The first chunk of a stream carries `0`, and
each subsequent chunk carries exactly one more than the one before it.** The
counter is per-stream and spans all chunk types — a `metadata` chunk between two
`content` chunks consumes a number, and so does the terminal `done` or `error`
chunk. No number is reused and none is skipped.

Contiguity is what makes the field useful. In-process an async generator cannot
drop or reorder its own yields, so `sequence` is decoration. Once a stream
crosses a wire it is the only loss-detection primitive the IR has, and a gap can
only mean loss if a gap is illegal. A consumer that sees a gap, a repeat, or a
decrease has not received the stream that was sent, and should fail the turn
rather than render it — a truncated but fluent answer reads to a user as a real
answer.

`validateChunkSequence()` and `validateStream()` in `@johnhenry/aimatey-utils`
check exactly this rule, so consumers do not have to invent their own.

The terminal `error` chunk is the easiest place to break the rule, because it is
emitted from a `catch` that often cannot see the counter. Hoist the counter above
the `try`.

#### StreamStartChunk

Signals start of stream:

```typescript
interface StreamStartChunk {
  readonly type: 'start';
  readonly sequence: number;
  readonly metadata: IRMetadata;
}
```

#### StreamContentChunk

Content delta or accumulated:

```typescript
interface StreamContentChunk {
  readonly type: 'content';
  readonly sequence: number;
  readonly delta: string;           // Always present
  readonly accumulated?: string;    // Optional (accumulated mode)
  readonly role?: 'assistant';
}
```

#### StreamToolUseChunk

Tool call request:

```typescript
interface StreamToolUseChunk {
  readonly type: 'tool_use';
  readonly sequence: number;
  readonly id: string;
  readonly name: string;
  readonly inputDelta?: string;
}
```

#### StreamMetadataChunk

Usage or metadata updates:

```typescript
interface StreamMetadataChunk {
  readonly type: 'metadata';
  readonly sequence: number;
  readonly usage?: Partial<IRUsage>;
  readonly metadata?: Partial<IRMetadata>;
}
```

#### StreamDoneChunk

End of stream:

```typescript
interface StreamDoneChunk {
  readonly type: 'done';
  readonly sequence: number;
  readonly finishReason: FinishReason;
  readonly usage?: IRUsage;
  readonly message?: IRMessage;
}
```

#### StreamErrorChunk

Error during streaming:

```typescript
interface StreamErrorChunk {
  readonly type: 'error';
  readonly sequence: number;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
  };
}
```

### Streaming Example

```typescript
async function processStream(stream: IRChatStream) {
  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'start':
        console.log('Stream started:', chunk.metadata.requestId);
        break;

      case 'content':
        // Use delta for incremental updates
        process.stdout.write(chunk.delta);

        // Or use accumulated for full text replacement
        // console.clear();
        // console.log(chunk.accumulated || '');
        break;

      case 'tool_use':
        console.log('Tool call:', chunk.name);
        break;

      case 'metadata':
        if (chunk.usage) {
          console.log('Tokens used:', chunk.usage);
        }
        break;

      case 'done':
        console.log('\nFinished:', chunk.finishReason);
        if (chunk.usage) {
          console.log('Total tokens:', chunk.usage.totalTokens);
        }
        break;

      case 'error':
        console.error('Error:', chunk.error.message);
        break;
    }
  }
}
```

---

## Metadata & Provenance

### IRMetadata

Tracks requests through the adapter chain:

```typescript
interface IRMetadata {
  readonly requestId: string;
  readonly providerResponseId?: string;
  readonly timestamp: number;
  readonly provenance?: IRProvenance;
  readonly warnings?: readonly IRWarning[];
  readonly custom?: Record<string, unknown>;
}
```

**Field Descriptions:**

| Field | Description |
|-------|-------------|
| `requestId` | Client-generated unique ID (stable across retries) |
| `providerResponseId` | Provider's actual response ID (for correlation) |
| `timestamp` | Request timestamp (milliseconds since epoch) |
| `provenance` | Adapter chain information |
| `warnings` | Semantic drift warnings |
| `custom` | Application-specific metadata |

### IRProvenance

Tracks which adapters processed the request:

```typescript
interface IRProvenance {
  readonly frontend?: string;
  readonly backend?: string;
  readonly middleware?: readonly string[];
  readonly router?: string;
  readonly upstream?: IRProvenance;
}
```

**Example:**

```typescript
{
  frontend: 'anthropic',
  backend: 'openai',
  middleware: ['logging', 'caching', 'retry'],
  router: 'load-balancer'
}
```

#### Nested provenance (`upstream`)

The four flat fields describe a **single hop** — the adapters this process ran. When the
backend is itself a proxy onto another aimatey instance (a tunnel, a gateway, a self-hosted
relay, a test double wrapping a real `Router`), what the far side did goes in `upstream`
rather than overwriting them:

```typescript
// On the phone, for `phone -> desktop -> llama-cpp`:
{
  frontend: 'openai',
  backend: 'tunnel',        // what this device talked to
  upstream: {
    frontend: 'openai',
    backend: 'llama-cpp',   // what the desktop chose
    router: 'desktop-router'
  }
}
```

A reader that ignores `upstream` keeps reading the nearest hop, which is what a circuit
breaker, a usage counter, or a log line means by "the backend". A reader that wants the far
end walks `upstream` to the last link.

A proxying adapter attaches one with `withUpstreamProvenance()`, which keeps its own hop
intact:

```typescript
import { withUpstreamProvenance } from '@johnhenry/aimatey-types';

provenance: withUpstreamProvenance(
  { backend: this.metadata.name },
  farResponse.metadata.provenance
)
```

Forwarding the far side's provenance upward unchanged is the mistake this prevents: the
backend it names would silently become this process's backend.

### IRWarning

Documents transformations and compatibility issues:

```typescript
interface IRWarning {
  readonly category: WarningCategory;
  readonly severity: WarningSeverity;
  readonly message: string;
  readonly field?: string;
  readonly originalValue?: unknown;
  readonly transformedValue?: unknown;
  readonly source?: string;
  readonly details?: Record<string, unknown>;
}

type WarningCategory =
  // The request is not the request the caller wrote.
  | 'parameter-normalized'
  | 'parameter-clamped'
  | 'parameter-unsupported'
  | 'capability-unsupported'
  | 'token-limit-exceeded'
  | 'stop-sequences-truncated'
  | 'system-message-transformed'
  | 'content-type-unsupported'
  | 'tool-unsupported'
  | 'model-substituted'
  | 'routing-config-changed'
  | 'content-redacted'
  | 'cache-bypassed'
  // The request was served faithfully and the *delivery* was degraded.
  | 'request-queued'
  | 'transport-degraded'
  | 'provenance-lost';

type WarningSeverity = 'info' | 'warning' | 'error';
```

**Example Warning:**

```typescript
{
  category: 'parameter-normalized',
  severity: 'info',
  message: 'Temperature normalized from 0-2 range to 0-1 range',
  field: 'temperature',
  originalValue: 1.5,
  transformedValue: 0.75,
  source: 'gemini-backend'
}
```

---

## Tools & Function Calling

### IRTool

Tool/function definition:

```typescript
interface IRTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JSONSchema;
  readonly metadata?: Record<string, unknown>;
}
```

### JSONSchema

Parameter validation schema:

```typescript
interface JSONSchema {
  readonly type?: JSONSchemaType | readonly JSONSchemaType[];
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly properties?: Record<string, JSONSchema>;
  readonly required?: readonly string[];
  readonly items?: JSONSchema;
  readonly additionalProperties?: boolean | JSONSchema;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: string;
  readonly default?: unknown;
  readonly examples?: readonly unknown[];
}

type JSONSchemaType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null';
```

### Tool Definition Example

```typescript
const weatherTool: IRTool = {
  name: 'get_weather',
  description: 'Get current weather for a location',
  parameters: {
    type: 'object',
    properties: {
      location: {
        type: 'string',
        description: 'City name or coordinates',
        examples: ['San Francisco', '37.7749,-122.4194']
      },
      units: {
        type: 'string',
        description: 'Temperature units',
        enum: ['celsius', 'fahrenheit'],
        default: 'celsius'
      },
      include_forecast: {
        type: 'boolean',
        description: 'Include 5-day forecast',
        default: false
      }
    },
    required: ['location']
  }
};
```

---

## Structured Output

### IRResponseFormat

Requests that the backend constrain its response to a caller-supplied JSON schema. Reuses the `JSONSchema` type from [Tools & Function Calling](#tools--function-calling) - one schema type for both tool parameters and structured output.

```typescript
interface IRResponseFormat {
  readonly type: 'json_schema';
  readonly schema: JSONSchema;
  readonly strict?: boolean;
}
```

This is a **best-effort request, not a guarantee**. Callers should still validate the parsed response against their schema (e.g. with Zod) - `responseFormat` narrows the odds of malformed output, it doesn't replace consumer-side validation.

### Native vs. Fallback

Backends handle `responseFormat` one of two ways, reported via `IRCapabilities.structuredOutput: 'native' | 'fallback'` and, per-response, via `IRChatResponse.metadata.custom.responseFormatEnforced: boolean`:

- **Native** - the backend adapter maps `responseFormat` directly onto the provider's own schema-constrained output mechanism (e.g. OpenAI's `response_format`, Anthropic's `output_config.format`, Gemini's `generationConfig.responseSchema`). The provider enforces the shape server-side.
- **Fallback** - for backends with no native mechanism, the adapter appends a schema-instruction message to the prompt and best-effort-extracts/repairs JSON from the plain-text reply (stripping markdown code fences, locating the outermost balanced JSON span, and removing trailing commas on a single repair pass). A `capability-unsupported` `IRWarning` is added to `metadata.warnings` when this path is used.

| Backend | Support |
|---|---|
| OpenAI | Native (`response_format: { type: 'json_schema', json_schema: { schema } }`) |
| Anthropic | Native (`output_config: { format: { type: 'json_schema', schema } }`) |
| Gemini | Native (`generationConfig.responseSchema` + `responseMimeType: 'application/json'`) |
| Groq, DeepSeek, Inception, Moonshot, NVIDIA, LM Studio, SambaNova, OmniRoute | Native (OpenAI-compatible - inherit OpenAI's mapping unchanged) |
| All other backends (AI21, Anyscale, AWS Bedrock, Azure OpenAI, Cerebras, Cloudflare, Cohere, DeepInfra, Fireworks, Hugging Face, Mistral, Ollama, OpenRouter, Perplexity, Replicate, Together AI, xAI, GitHub Models, DashScope) | Fallback (prompt injection + best-effort JSON extraction) |

### Example

```typescript
const request: IRChatRequest = {
  messages: [{ role: 'user', content: 'Extract the name and age from: John is 30.' }],
  responseFormat: {
    type: 'json_schema',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' }
      },
      required: ['name', 'age']
    }
  },
  metadata: { requestId: 'req_1', timestamp: Date.now(), provenance: { frontend: 'openai' } }
};

// response.message.content -> '{"name":"John","age":30}'
// response.metadata.custom.responseFormatEnforced -> true (native) or false (fallback)
```

---

## Parameters

### IRParameters

Normalized generation parameters:

```typescript
interface IRParameters {
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly frequencyPenalty?: number;
  readonly presencePenalty?: number;
  readonly stopSequences?: readonly string[];
  readonly seed?: number;
  readonly user?: string;
  readonly custom?: Record<string, unknown>;
}
```

**Parameter Ranges:**

| Parameter | Range | Default | Description |
|-----------|-------|---------|-------------|
| `temperature` | 0.0 - 2.0 | 0.7 | Sampling randomness (higher = more random) |
| `maxTokens` | 1 - ∞ | varies | Maximum tokens to generate |
| `topP` | 0.0 - 1.0 | 1.0 | Nucleus sampling threshold |
| `topK` | 1 - ∞ | varies | Top-K sampling limit |
| `frequencyPenalty` | -2.0 - 2.0 | 0.0 | Penalize frequent tokens |
| `presencePenalty` | -2.0 - 2.0 | 0.0 | Penalize present tokens |

**Example:**

```typescript
{
  model: 'gpt-4',
  temperature: 0.7,
  maxTokens: 1000,
  topP: 0.9,
  frequencyPenalty: 0.5,
  presencePenalty: 0.2,
  stopSequences: ['\n\n', 'END'],
  seed: 42,
  user: 'user_123'
}
```

---

## Capabilities

### IRCapabilities

Describes what an adapter supports:

```typescript
interface IRCapabilities {
  readonly streaming: boolean;
  readonly multiModal: boolean;
  readonly tools?: boolean;
  readonly structuredOutput?: 'native' | 'fallback';
  readonly maxContextTokens?: number;
  readonly supportedModels?: readonly string[];
  readonly systemMessageStrategy: SystemMessageStrategy;
  readonly supportsMultipleSystemMessages: boolean;
  readonly supportsTemperature?: boolean;
  readonly supportsTopP?: boolean;
  readonly supportsTopK?: boolean;
  readonly supportsSeed?: boolean;
  readonly supportsFrequencyPenalty?: boolean;
  readonly supportsPresencePenalty?: boolean;
  readonly maxStopSequences?: number;
}

type SystemMessageStrategy =
  | 'separate-parameter'  // System in dedicated field (Anthropic, Gemini)
  | 'in-messages'         // System in message array (OpenAI, Ollama)
  | 'prepend-user'        // Prepended to first user message
  | 'not-supported';      // No system message support
```

**Example:**

```typescript
const openaiCapabilities: IRCapabilities = {
  streaming: true,
  multiModal: true,
  tools: true,
  maxContextTokens: 128000,
  supportedModels: ['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  systemMessageStrategy: 'in-messages',
  supportsMultipleSystemMessages: true,
  supportsTemperature: true,
  supportsTopP: true,
  supportsTopK: false,
  supportsSeed: true,
  supportsFrequencyPenalty: true,
  supportsPresencePenalty: true,
  maxStopSequences: 4
};
```

---

## Decision IR

Typed-decision ("System One") models are not chat models: given a `state` and a map of named, typed questions, they answer with typed values, usually with calibrated probabilities, in one forward pass. They have their own request/response pair, defined in `packages/aimatey-types/src/decisions.ts`. It reuses `IRMetadata` and `ImageContent` from the chat IR, but has no message list, no streaming and no finish reason. Backends opt in with the optional `BackendAdapter.decide()`; see the [Decisions guide](../packages/aimatey-docs/src/content/docs/guides/decisions.md).

### IRDecisionQuestion

A discriminated union on `type`:

```typescript
type IRDecisionQuestion =
  | {
      readonly type: 'choice';
      readonly instructions: string;
      /** Option name -> description of when it applies. */
      readonly criteria: Record<string, string>;
    }
  | {
      readonly type: 'score';
      readonly instructions: string;
      /** Ordered levels, low to high. */
      readonly criteria: readonly string[];
    }
  | {
      readonly type: 'noul';
      readonly instructions: string;
      /** Optional labels for each side of the yes/no question. */
      readonly criteria?: {
        readonly true: string;
        readonly false: string;
      };
    };
```

- `choice`: pick one option from a labeled set (up to about 255).
- `score`: place the state on an ordered spectrum of 2 to 10 labeled levels (Ollama allows 2 to 26).
- `noul`: a yes/no question answered as a calibrated probability. `criteria` pins what `true` and `false` mean, the recommended mitigation for option-name bias.

### IRDecisionRequest

```typescript
interface IRDecisionRequest {
  /** Text, a structured object, or an array: anything serializable. */
  readonly state: unknown;
  /** Named questions; answers come back under the same names. */
  readonly questions: Record<string, IRDecisionQuestion>;
  /** Images to consider alongside `state` (base64 in practice). */
  readonly images?: readonly ImageContent[];
  readonly parameters?: IRDecisionParameters;
  readonly metadata: IRMetadata;
}

interface IRDecisionParameters {
  readonly model?: string;
  readonly custom?: Record<string, unknown>;
}
```

### IRDecisionAnswer

Shaped by the question that produced it:

```typescript
type IRDecisionAnswer =
  | {
      readonly type: 'choice';
      /** The selected option name (a key of the question's `criteria`). */
      readonly value: string;
      readonly probabilities?: Record<string, number>;
      readonly confidence?: number;
      readonly reasoning?: string;
    }
  | {
      readonly type: 'score';
      /** Index (may be fractional) into the question's ordered `criteria`. */
      readonly value: number;
      readonly probabilities?: readonly number[];
      readonly confidence?: number;
      readonly reasoning?: string;
    }
  | {
      readonly type: 'noul';
      /** Calibrated probability of "yes", in [0, 1]. */
      readonly value: number;
      /** Concentration of [value, 1 - value] (noulConfidence). Not every provider reports it. */
      readonly confidence?: number;
      readonly reasoning?: string;
    };
```

`probabilities` and `confidence` are **optional** on `choice` and `score`: OpenRouter marks them optional and an answer from an LLM through structured output has neither. Absence means "the provider did not report it"; there is no sentinel such as `confidence: 0`, so consumers must handle `undefined`. For `noul` the probability itself is the answer; `confidence` is still a separate quantity there, the concentration of `[value, 1 - value]` (0 at a coin flip, 1 at certainty).

**What `confidence` means.** It is how *concentrated* the answer's distribution is, `1 - H(p) / ln(n)` with `H` the Shannon entropy and `n` the number of options: 1 for a one-hot distribution, 0 for a uniform one. It is **not** the probability of the winning option (a top probability of 0.987 over three options is a confidence of about 0.93, and `[0.42, 0.42, 0.16]` is about 0.07) and it is not accuracy; calibrate against labeled runs before trusting a threshold. `decisionConfidence(probabilities)` and `noulConfidence(p)` in `@johnhenry/aimatey-utils` are the one implementation, used wherever the library computes `confidence` itself (Together, temperature scaling, ensembles, neutral option keys, escalation bands). A provider that reports its own `confidence` (Jev, Ollama, Laya) is passed through as reported and may use a different measure. `reasoning` is free text from providers that explain themselves.

### IRDecisionResponse and IRDecisionUsage

```typescript
interface IRDecisionResponse {
  /** Provider's response id, when it sends one. */
  readonly id?: string;
  /** Provider that served the request, when the API is a gateway. */
  readonly provider?: string;
  /** Keyed by the request's question names. */
  readonly answers: Record<string, IRDecisionAnswer>;
  /** Model that actually answered. */
  readonly model: string;
  readonly usage?: IRDecisionUsage;
  readonly metadata: IRMetadata;
  readonly raw?: Record<string, unknown>;
}

interface IRDecisionUsage {
  readonly inputTokens: number;
  /** Often 0: decisions generate no text. */
  readonly outputTokens?: number;
  /** USD, when the provider reports it. */
  readonly cost?: number;
  readonly details?: Record<string, unknown>;
}
```

### DecisionOptions and DecisionMiddleware

Used by `Bridge.decide()` and `bridge.useDecision()`:

```typescript
interface DecisionOptions {
  readonly model?: string;
  readonly signal?: AbortSignal;
  /** Merged into the request's custom metadata. */
  readonly metadata?: Record<string, unknown>;
  /** Becomes `metadata.principal` on the IR request. */
  readonly principal?: string;
  readonly custom?: Record<string, unknown>;
}

type DecisionMiddleware = (
  request: IRDecisionRequest,
  next: (request: IRDecisionRequest) => Promise<IRDecisionResponse>
) => Promise<IRDecisionResponse>;
```

### Decision capabilities

`IRCapabilities` carries the decision fields (all optional): `decisions` (the backend implements `decide()`), `decisionModels`, `decisionImages`, `decisionTypes` (which of `choice` / `score` / `noul` it answers natively), `decisionsEmulated` (answered by a chat model through structured output, so no calibrated probabilities), `decisionsEmulatedTypes`, and `decisionLimits` with `maxQuestions`, `maxChoiceOptions`, `maxScoreLevels`, `maxStateTokens`, `maxImages` and `maxConcurrency`. `Router.decide()` and request validation use them to skip backends that cannot serve a request.

### Example

```typescript
const request: IRDecisionRequest = {
  state: { subject: 'Duplicate charge', body: 'Please refund me today.' },
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: { billing: 'invoices, refunds', technical: 'bugs, outages' },
    },
    urgency: { type: 'score', instructions: 'How urgent is it?', criteria: ['low', 'medium', 'high'] },
    refundRequested: { type: 'noul', instructions: 'Does the user request a refund?' },
  },
  metadata: { requestId: 'req_abc123', timestamp: Date.now() },
};
```

---

## Examples

### Simple Chat Request

```typescript
const request: IRChatRequest = {
  messages: [
    { role: 'user', content: 'Hello!' }
  ],
  parameters: {
    model: 'gpt-4',
    temperature: 0.7
  },
  metadata: {
    requestId: 'req_001',
    timestamp: Date.now(),
    provenance: { frontend: 'openai' }
  }
};
```

### Multi-Turn Conversation

```typescript
const request: IRChatRequest = {
  messages: [
    {
      role: 'system',
      content: 'You are a helpful coding assistant.'
    },
    {
      role: 'user',
      content: 'How do I create a Promise in JavaScript?'
    },
    {
      role: 'assistant',
      content: 'You can create a Promise using the Promise constructor...'
    },
    {
      role: 'user',
      content: 'Can you show me an example with async/await?'
    }
  ],
  parameters: {
    model: 'claude-3-5-sonnet',
    temperature: 0.5,
    maxTokens: 2000
  },
  metadata: {
    requestId: 'req_002',
    timestamp: Date.now(),
    provenance: { frontend: 'anthropic' }
  }
};
```

### Multi-Modal Request with Image

```typescript
const request: IRChatRequest = {
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'What breed of dog is in this image?'
        },
        {
          type: 'image',
          source: {
            type: 'url',
            url: 'https://example.com/dog.jpg'
          }
        }
      ]
    }
  ],
  parameters: {
    model: 'gpt-4-vision',
    maxTokens: 500
  },
  metadata: {
    requestId: 'req_003',
    timestamp: Date.now(),
    provenance: { frontend: 'openai' }
  }
};
```

### Function Calling Request

```typescript
const request: IRChatRequest = {
  messages: [
    {
      role: 'user',
      content: 'What is the weather in Paris and Tokyo?'
    }
  ],
  tools: [
    {
      name: 'get_weather',
      description: 'Get current weather for a location',
      parameters: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'City name'
          },
          units: {
            type: 'string',
            enum: ['celsius', 'fahrenheit']
          }
        },
        required: ['location']
      }
    }
  ],
  toolChoice: 'auto',
  parameters: {
    model: 'gpt-4',
    temperature: 0.3
  },
  metadata: {
    requestId: 'req_004',
    timestamp: Date.now(),
    provenance: { frontend: 'openai' }
  }
};
```

### Response with Tool Calls

```typescript
const response: IRChatResponse = {
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_01ABC',
        name: 'get_weather',
        input: {
          location: 'Paris',
          units: 'celsius'
        }
      },
      {
        type: 'tool_use',
        id: 'toolu_02DEF',
        name: 'get_weather',
        input: {
          location: 'Tokyo',
          units: 'celsius'
        }
      }
    ]
  },
  finishReason: 'tool_calls',
  usage: {
    promptTokens: 125,
    completionTokens: 45,
    totalTokens: 170
  },
  metadata: {
    requestId: 'req_004',
    providerResponseId: 'chatcmpl-XYZ',
    timestamp: Date.now(),
    provenance: {
      frontend: 'openai',
      backend: 'anthropic'
    }
  }
};
```

### Tool Results and Follow-up

```typescript
const followUpRequest: IRChatRequest = {
  messages: [
    {
      role: 'user',
      content: 'What is the weather in Paris and Tokyo?'
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_01ABC',
          name: 'get_weather',
          input: { location: 'Paris', units: 'celsius' }
        }
      ]
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          toolUseId: 'toolu_01ABC',
          content: 'Temperature: 18°C, Conditions: Partly cloudy'
        }
      ]
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_02DEF',
          name: 'get_weather',
          input: { location: 'Tokyo', units: 'celsius' }
        }
      ]
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          toolUseId: 'toolu_02DEF',
          content: 'Temperature: 25°C, Conditions: Clear skies'
        }
      ]
    }
  ],
  parameters: {
    model: 'gpt-4'
  },
  metadata: {
    requestId: 'req_005',
    timestamp: Date.now(),
    provenance: { frontend: 'openai' }
  }
};
```

---

## TypeScript Definitions

All IR types are defined in `packages/aimatey-types/src/ir.ts`.

For the complete, authoritative type definitions, refer to the source code:
- [ir.ts](../packages/aimatey-types/src/ir.ts) - Core IR types
- [streaming.ts](../packages/aimatey-types/src/streaming.ts) - Streaming configuration
- [decisions.ts](../packages/aimatey-types/src/decisions.ts) - Decision IR

---

## See Also

- [API Reference](./api.md) - Complete API documentation
- [Decisions guide](../packages/aimatey-docs/src/content/docs/guides/decisions.md) - Typed-decision models, `Bridge.decide()` and the decision patterns
- [Architecture Guide](../readme.md#architecture) - System architecture overview
- [Type Definitions](../packages/aimatey-types/readme.md) - TypeScript types package
