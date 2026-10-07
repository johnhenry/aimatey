---
title: "Intermediate Representation (IR) Format"
description: "Deep dive into aimatey's Intermediate Representation (IR), the universal format every adapter converts to and from."
---

The **Intermediate Representation (IR)** is the universal format that sits between frontend and backend adapters in aimatey. It normalizes chat requests, responses, and streams in a provider-agnostic way.

## Overview

```
Client (OpenAI format)
        ↓
Frontend Adapter → IR Format → Backend Adapter
                                        ↓
                                Provider (Anthropic API)
```

The IR acts as a translation layer, allowing any client format to work with any backend provider.

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

## Message Roles

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

## Message Content Types

### Text Content

```typescript
interface TextContent {
  type: 'text';
  text: string;
}
```

### Image Content

```typescript
interface ImageContent {
  type: 'image';
  source:
    | { type: 'url'; url: string }
    | { type: 'base64'; mediaType: string; data: string }
    | { type: 'ref'; ref: string; mediaType?: string; bytes?: number };
}
```

`AudioContent`, `DocumentContent` and `VideoContent` follow the same
`{ type, source }` shape.

A `ref` source names a payload a transport moves over its own blob channel; the
handle is opaque and is never fetched. **The transport must resolve it to a `url`
or `base64` source before the request reaches a backend.** Anything that cannot
resolve one refuses it with `UNSUPPORTED_FEATURE` - it is never dropped and never
sent to a provider as data. `Bridge` and `Router` enforce this after request
middleware has run (`assertNoUnresolvedBlobRefs()`); a backend that resolves
handles itself declares `capabilities.blobRefs: true`. Decision requests follow
the same rule, and must be resolved before `decide()` is called.

### Tool Use Content

```typescript
interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
```

### Tool Result Content

```typescript
interface ToolResultContent {
  type: 'tool_result';
  toolUseId: string;
  content: string | TextContent[];
  isError?: boolean;
}
```

## Request Format

### IRChatRequest

```typescript
interface IRChatRequest {
  messages: readonly IRMessage[];
  tools?: readonly IRTool[];
  toolChoice?: 'auto' | 'required' | 'none' | { name: string };
  responseFormat?: IRResponseFormat;
  parameters?: IRParameters;
  metadata: IRMetadata;
  stream?: boolean;
  streamMode?: StreamMode;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `messages` | `IRMessage[]` | ✅ | Conversation messages (minimum 1) |
| `tools` | `IRTool[]` | ❌ | Available tools/functions |
| `toolChoice` | `string \| object` | ❌ | Tool selection strategy |
| `responseFormat` | `IRResponseFormat` | ❌ | JSON-schema-constrained output request |
| `parameters` | `IRParameters` | ❌ | Generation parameters (model, temperature, ...) |
| `metadata` | `IRMetadata` | ✅ | Request tracking metadata |
| `stream` | `boolean` | ❌ | Enable streaming (default: `false`) |
| `streamMode` | `StreamMode` | ❌ | Streaming mode (default: `'delta'`) |

Note that the model and the sampling options are **not** top-level fields - they
live on `parameters` - and that `metadata` is required.

**Example:**
```typescript
{
  messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello!' }
  ],
  parameters: {
    model: 'gpt-4',
    temperature: 0.7,
    maxTokens: 150
  },
  metadata: {
    requestId: 'req_abc123xyz',
    timestamp: 1701234567890,
    provenance: { frontend: 'openai' }
  },
  stream: false
}
```

## Response Format

### IRChatResponse

```typescript
interface IRChatResponse {
  message: IRMessage;
  finishReason: FinishReason;
  usage?: IRUsage;
  metadata: IRMetadata;
  raw?: Record<string, unknown>;
}
```

A response carries exactly one assistant `message` - there is no `choices`
array, and no `id` / `object` / `created` / `model` fields. The provider's own
response id, when there is one, is `metadata.providerResponseId`.

```typescript
type FinishReason =
  | 'stop'           // Natural completion
  | 'length'         // Hit max tokens
  | 'tool_calls'     // Requested tool execution
  | 'content_filter' // Filtered by safety system
  | 'error'          // Error occurred
  | 'cancelled';     // Request cancelled

interface IRUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  details?: Record<string, unknown>;
}
```

**Example:**
```typescript
{
  message: {
    role: 'assistant',
    content: 'Hello! How can I help you today?'
  },
  finishReason: 'stop',
  usage: {
    promptTokens: 10,
    completionTokens: 9,
    totalTokens: 19
  },
  metadata: {
    requestId: 'req_abc123xyz',
    providerResponseId: 'chatcmpl-abc123',
    timestamp: 1677858242000,
    provenance: { frontend: 'openai', backend: 'anthropic' }
  }
}
```

## Streaming Format

### IRStreamChunk

`IRStreamChunk` is a discriminated union keyed on `type`, and every chunk carries
a monotonically increasing `sequence`:

```typescript
type IRStreamChunk =
  | StreamStartChunk
  | StreamContentChunk
  | StreamToolUseChunk
  | StreamMetadataChunk
  | StreamDoneChunk
  | StreamErrorChunk;

interface StreamStartChunk {
  type: 'start';
  sequence: number;
  metadata: IRMetadata;
}

interface StreamContentChunk {
  type: 'content';
  sequence: number;
  delta: string;         // New text in this chunk - always present
  accumulated?: string;  // Full text so far (accumulated mode only)
  role?: 'assistant';
}

interface StreamToolUseChunk {
  type: 'tool_use';
  sequence: number;
  id: string;
  name: string;
  inputDelta?: string;   // Raw partial-JSON fragment of the tool arguments
  index?: number;
}

interface StreamDoneChunk {
  type: 'done';
  sequence: number;
  finishReason: FinishReason;
  usage?: IRUsage;
  message?: IRMessage;
}
```

`StreamMetadataChunk` (`usage` / `metadata` updates) and `StreamErrorChunk`
(`error: { code, message, details? }`) complete the union.

### Stream contract

- **Sequence.** `sequence` starts at 0 and increases by exactly 1 per chunk, across
  every chunk type, through the terminal chunk. `validateChunkSequence()` checks it.
- **Termination.** A stream ends with exactly one `done` or `error` chunk. An
  iterator that completes without one has been cut off, not finished. `Bridge` and
  `Router` apply `withTerminationGuard()`, which closes it with an `error` chunk
  (`code: 'stream-truncated'`, next sequence); the router counts that as a backend
  failure. A cancelled request is exempt.
- **Authoritative text.** The `delta`s, concatenated, are the text. `accumulated`,
  when present, MUST equal the running sum of the deltas (a proxy may drop it, but
  from every chunk or none). `done.message`, when present, is authoritative: it
  MUST equal the delta sum, and a disagreement is a transport fault, not a model
  fault. `validateStreamContract()` checks all of this; set
  `BridgeConfig.onContractViolation` to have the bridge check live.
- **Resumption.** A resumed stream is the same stream: numbering continues, `start`
  is not repeated. The first chunk after the join may carry
  `resumedFrom: { sequence }` (the last sequence the consumer held); its own
  `sequence` must be `resumedFrom.sequence + 1`.

### Streaming Modes

**Delta mode (default)** - each chunk carries only the new text:

```typescript
{ type: 'start',   sequence: 0, metadata }
{ type: 'content', sequence: 1, delta: 'Hello' }
{ type: 'content', sequence: 2, delta: ' there' }
{ type: 'done',    sequence: 3, finishReason: 'stop' }
```

**Accumulated mode** - each content chunk also carries the full text so far:

```typescript
{ type: 'content', sequence: 1, delta: 'Hello',  accumulated: 'Hello' }
{ type: 'content', sequence: 2, delta: ' there', accumulated: 'Hello there' }
```

**Consuming a stream:**
```typescript
for await (const chunk of stream) {
  switch (chunk.type) {
    case 'content':
      process.stdout.write(chunk.delta);
      break;
    case 'done':
      console.log('\nFinished:', chunk.finishReason);
      break;
    case 'error':
      throw new Error(chunk.error.message);
  }
}
```

## Serialization

The IR is JSON-shaped throughout - no `Date`, `Map`, `Blob`, `Uint8Array` or
function appears in any IR type - so it can cross any transport as JSON. The
free-form bags (`metadata.custom`, `parameters.custom`, tool `input`, warning
`details`, `raw`) are typed `unknown` but are JSON-valued **by contract**; `undefined`
means absent everywhere. `JsonValue` is the type of such a value, and
`assertJsonSerializable()` / `findNonJsonValues()` in `@johnhenry/aimatey-utils` check it
(with the path of each offender) so a transport does not hand-write its own walker.
The bags move to `JsonValue` at the next major.

## Tools & Function Calling

### IRTool Definition

A tool is described directly - there is no `{ type: 'function', function: {...} }`
wrapper.

```typescript
interface IRTool {
  name: string;
  description: string;
  parameters: JSONSchema;
  metadata?: Record<string, unknown>;
}
```

**Example:**
```typescript
{
  name: 'get_weather',
  description: 'Get current weather for a location',
  parameters: {
    type: 'object',
    properties: {
      location: { type: 'string', description: 'City name' },
      units: { type: 'string', enum: ['celsius', 'fahrenheit'] }
    },
    required: ['location']
  }
}
```

Tool selection is `IRChatRequest.toolChoice`: `'auto'`, `'required'`, `'none'`,
or `{ name: 'get_weather' }`.

## Parameters

### IRParameters

Generation parameters live on `IRChatRequest.parameters` and are camelCase:

```typescript
interface IRParameters {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stopSequences?: readonly string[];
  seed?: number;
  user?: string;
  custom?: Record<string, unknown>;
}
```

| Parameter | Range | Default | Description |
|-----------|-------|---------|-------------|
| `temperature` | 0.0 - 2.0 | 0.7 | Sampling randomness (higher = more random) |
| `maxTokens` | 1 - ∞ | varies | Maximum tokens to generate |
| `topP` | 0.0 - 1.0 | 1.0 | Nucleus sampling threshold |
| `topK` | 1 - ∞ | varies | Top-K sampling limit |
| `frequencyPenalty` | -2.0 - 2.0 | 0.0 | Penalize frequent tokens |
| `presencePenalty` | -2.0 - 2.0 | 0.0 | Penalize present tokens |

`stream` and `streamMode` are top-level fields on the request, not parameters.

### Provider Compatibility

Not all providers support all parameters. The IR format includes all common parameters, and adapters handle unsupported parameters gracefully.

## Capabilities

### IRCapabilities

Describes what a provider/backend supports:

```typescript
interface IRCapabilities {
  streaming: boolean;
  multiModal: boolean;
  systemMessageStrategy: SystemMessageStrategy;
  supportsMultipleSystemMessages: boolean;
  tools?: boolean;
  structuredOutput?: 'native' | 'fallback';
  maxContextTokens?: number;
  supportedModels?: readonly string[];
  supportsTemperature?: boolean;
  supportsTopP?: boolean;
  supportsTopK?: boolean;
  supportsSeed?: boolean;
  // ...audio/document/video flags, embedding support, penalty flags
}
```

Multi-modal support is `multiModal` (with `supportsAudio`, `supportsDocuments`
and `supportsVideo` for specific input types), schema-constrained output is
`structuredOutput`, and the context window is `maxContextTokens`.

An adapter's capabilities are read from `adapter.metadata.capabilities`.

## Decision IR

Typed-decision ("System One") models are not chat models: given a `state` and a map of named, typed questions, they answer with typed values, usually with calibrated probabilities, in one forward pass. They have their own request/response pair, defined in [`packages/aimatey-types/src/decisions.ts`](https://github.com/johnhenry/aimatey/blob/main/packages/aimatey-types/src/decisions.ts). It reuses `IRMetadata` and `ImageContent` from the chat IR, but has no message list, no streaming and no finish reason. Backends opt in with the optional `BackendAdapter.decide()`; see the [Decisions guide](/guides/decisions/).

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
      /** max(value, 1 - value). Not every provider reports it. */
      readonly confidence?: number;
      readonly reasoning?: string;
    };
```

`probabilities` and `confidence` are **optional** on `choice` and `score`: OpenRouter marks them optional and an answer from an LLM through structured output has neither. Absence means "the provider did not report it"; there is no sentinel such as `confidence: 0`, so consumers must handle `undefined`. For `noul` the probability itself is the answer; `confidence` is the distance from a coin flip. `reasoning` is free text from providers that explain themselves.

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

## Best Practices

1. **Always validate IR objects** before passing to adapters
2. **Use type guards** for content types
3. **Handle missing optional fields** gracefully
4. **Preserve metadata** when transforming
5. **Check capabilities** before using advanced features

## See Also

- [Frontend Adapters](/packages/frontend)
- [Backend Adapters](/packages/backend)
- [Decisions guide](/guides/decisions/)
- [Type Definitions](https://github.com/johnhenry/aimatey/blob/main/packages/aimatey-types)
