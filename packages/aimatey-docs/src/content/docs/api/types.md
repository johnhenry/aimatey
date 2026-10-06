---
title: "Types API"
description: "TypeScript type reference: IR request/response formats, adapter interfaces, and configuration types."
---

Complete TypeScript type definitions for aimatey.

## Core Types

### IRChatRequest

The universal request format (Intermediate Representation). Note that sampling
parameters live under `parameters`, not at the top level, and that `metadata` is
required.

```typescript
interface IRChatRequest {
  /** Conversation messages (at least one) */
  messages: readonly IRMessage[];

  /** Tool/function definitions */
  tools?: readonly IRTool[];

  /** Tool choice strategy */
  toolChoice?: 'auto' | 'required' | 'none' | { name: string };

  /** JSON-schema-constrained output request */
  responseFormat?: IRResponseFormat;

  /** Sampling and model parameters */
  parameters?: IRParameters;

  /** Request metadata (required) */
  metadata: IRMetadata;

  /** Enable streaming (default: false) */
  stream?: boolean;

  /** Preferred streaming mode: 'delta' (default) or 'accumulated' */
  streamMode?: StreamMode;
}
```

---

### IRParameters

Normalized sampling parameters, carried on `IRChatRequest.parameters`.

```typescript
interface IRParameters {
  /** Model identifier */
  model?: string;

  /** Sampling temperature (0.0-2.0) */
  temperature?: number;

  /** Maximum tokens to generate */
  maxTokens?: number;

  /** Nucleus sampling threshold (0.0-1.0) */
  topP?: number;

  /** Top-K sampling limit */
  topK?: number;

  /** Frequency penalty (-2.0 to 2.0) */
  frequencyPenalty?: number;

  /** Presence penalty (-2.0 to 2.0) */
  presencePenalty?: number;

  /** Stop sequences */
  stopSequences?: readonly string[];

  /** Random seed for deterministic generation */
  seed?: number;

  /** User identifier for abuse monitoring */
  user?: string;

  /** Provider-specific parameters, passed through untouched */
  custom?: Record<string, unknown>;
}
```

---

### IRMetadata

Request/response metadata. `requestId` and `timestamp` are required.

```typescript
interface IRMetadata {
  /** Unique request identifier, stable across retries and fallbacks */
  requestId: string;

  /** Provider's own response identifier, set by the backend */
  providerResponseId?: string;

  /** Request timestamp (ms since epoch) */
  timestamp: number;

  /** Adapter chain provenance */
  provenance?: IRProvenance;

  /** Semantic drift warnings collected during processing */
  warnings?: readonly IRWarning[];

  /** Custom metadata fields */
  custom?: Record<string, unknown>;
}
```

---

### IRChatResponse

The universal response format. There is no `choices` array - a response carries
exactly one assistant `message`.

```typescript
interface IRChatResponse {
  /** Generated message from the assistant */
  message: IRMessage;

  /** Why generation finished */
  finishReason: FinishReason;

  /** Token usage statistics */
  usage?: IRUsage;

  /** Response metadata (request metadata plus backend provenance) */
  metadata: IRMetadata;

  /** Provider-specific raw response data */
  raw?: Record<string, unknown>;
}

type FinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'error'
  | 'cancelled';
```

---

### IRStreamChunk

Stream chunks are a discriminated union keyed on `type`, each carrying a
monotonically increasing `sequence`.

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
  /** New text generated in this chunk - always present */
  delta: string;
  /** Full text so far, when the backend is in accumulated mode */
  accumulated?: string;
  role?: 'assistant';
}

interface StreamToolUseChunk {
  type: 'tool_use';
  sequence: number;
  id: string;
  name: string;
  /** Raw partial-JSON fragment of the tool arguments */
  inputDelta?: string;
  index?: number;
}

interface StreamMetadataChunk {
  type: 'metadata';
  sequence: number;
  usage?: Partial<IRUsage>;
  metadata?: Partial<IRMetadata>;
}

interface StreamDoneChunk {
  type: 'done';
  sequence: number;
  finishReason: FinishReason;
  usage?: IRUsage;
  message?: IRMessage;
}

interface StreamErrorChunk {
  type: 'error';
  sequence: number;
  error: { code: string; message: string; details?: Record<string, unknown> };
}
```

`IRChatStream` is the async generator these chunks arrive on:

```typescript
type IRChatStream = AsyncGenerator<IRStreamChunk, void, undefined>;
```

---

### IRMessage

A single message in a conversation. Tool calls and tool results are content
blocks, not separate `tool_calls` / `tool_call_id` fields.

```typescript
interface IRMessage {
  /** Message role */
  role: 'system' | 'user' | 'assistant' | 'tool';

  /** Message content: plain text or structured content blocks */
  content: string | readonly MessageContent[];

  /** Message name/identifier (tool messages, multi-user scenarios) */
  name?: string;

  /** Provider-specific metadata */
  metadata?: Record<string, unknown>;
}
```

---

### MessageContent

Structured content blocks. (There is no `IRContentPart`.)

```typescript
type MessageContent =
  | TextContent
  | ImageContent
  | AudioContent
  | DocumentContent
  | VideoContent
  | ToolUseContent
  | ToolResultContent;

interface TextContent {
  type: 'text';
  text: string;
}

interface ImageContent {
  type: 'image';
  source:
    | { type: 'url'; url: string }
    | { type: 'base64'; mediaType: string; data: string };
}

/** The AI asking to call a tool - replaces the OpenAI-style `tool_calls` array */
interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** The result of running a tool - replaces `tool_call_id` */
interface ToolResultContent {
  type: 'tool_result';
  toolUseId: string;
  content: string | TextContent[];
  isError?: boolean;
}
```

`AudioContent`, `DocumentContent` and `VideoContent` follow the same
`{ type, source }` shape as `ImageContent`.

---

### IRUsage

Token usage statistics (camelCase - there are no snake_case variants).

```typescript
interface IRUsage {
  /** Tokens in the prompt */
  promptTokens: number;

  /** Tokens in the completion */
  completionTokens: number;

  /** Total tokens (prompt + completion) */
  totalTokens: number;

  /** Provider-specific usage details */
  details?: Record<string, unknown>;
}
```

---

### IRTool

Tool/function definition. The tool is described directly - there is no
`{ type: 'function', function: {...} }` wrapper.

```typescript
interface IRTool {
  /** Tool name (must be a valid identifier) */
  name: string;

  /** Human-readable description of what the tool does */
  description: string;

  /** JSON Schema for the tool's parameters */
  parameters: JSONSchema;

  /** Provider-specific tool configuration */
  metadata?: Record<string, unknown>;
}
```

To ask for a specific tool, set `IRChatRequest.toolChoice` to `{ name: 'get_weather' }`;
`'auto'`, `'required'` and `'none'` are the other accepted values. (There is no
separate `IRToolChoice` type.)

---

### IRResponseFormat

JSON-schema-constrained output request.

```typescript
interface IRResponseFormat {
  type: 'json_schema';
  schema: JSONSchema;
  /** Reject/retry on schema violation where the backend supports it */
  strict?: boolean;
}
```

---

## Adapter Interfaces

### BackendAdapter

Interface for backend adapters.

```typescript
interface BackendAdapter<TRequest = unknown, TResponse = unknown> {
  /** Identification and capabilities (there is no bare `name` field) */
  readonly metadata: AdapterMetadata;

  /** Convert an IR request to the provider's request format */
  fromIR(request: IRChatRequest): TRequest;

  /** Convert a provider response to IR */
  toIR(response: TResponse, originalRequest: IRChatRequest, latencyMs: number): IRChatResponse;

  /** Execute a chat completion */
  execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse>;

  /** Execute a streaming chat completion - returns the stream, not a Promise */
  executeStream(request: IRChatRequest, signal?: AbortSignal): IRChatStream;

  /** Health check (optional) */
  healthCheck?(): Promise<boolean>;

  /** Estimate request cost in USD (optional) */
  estimateCost?(request: IRChatRequest): Promise<number | null>;

  /** List available models (optional) */
  listModels?(options?: ListModelsOptions): Promise<ListModelsResult>;

  /** Generate embeddings (optional) */
  embed?(request: IREmbedRequest, signal?: AbortSignal): Promise<IREmbedResponse>;

  /** Estimate embedding cost in USD (optional) */
  estimateEmbedCost?(request: IREmbedRequest): Promise<number | null>;

  /** Answer typed decision questions (optional; no chat support needed) */
  decide?(request: IRDecisionRequest, signal?: AbortSignal): Promise<IRDecisionResponse>;

  /** Estimate decision cost in USD (optional) */
  estimateDecisionCost?(request: IRDecisionRequest): Promise<number | null>;
}
```

Capabilities are read from `adapter.metadata.capabilities` (an
[`IRCapabilities`](#ircapabilities)); there is no `getCapabilities()` method.

---

### FrontendAdapter

Interface for frontend adapters.

```typescript
interface FrontendAdapter<TRequest = unknown, TResponse = unknown, TStreamChunk = unknown> {
  /** Identification and capabilities (there is no bare `name` field) */
  readonly metadata: AdapterMetadata;

  /** Convert a provider-specific request to IR (async) */
  toIR(request: TRequest): Promise<IRChatRequest>;

  /** Convert an IR response back to the provider's format (async) */
  fromIR(response: IRChatResponse): Promise<TResponse>;

  /** Convert an IR stream to the provider's stream format */
  fromIRStream(
    stream: IRChatStream,
    options?: StreamConversionOptions
  ): AsyncGenerator<TStreamChunk, void, undefined>;

  /** Validate a provider-specific request before conversion (optional) */
  validate?(request: TRequest): Promise<void>;
}
```

---

### AdapterMetadata

Identification and capability metadata carried by both adapter kinds.

```typescript
interface AdapterMetadata {
  /** Unique adapter identifier (lowercase, no spaces) */
  readonly name: string;

  /** Semantic version of the adapter implementation */
  readonly version: string;

  /** Human-readable provider name */
  readonly provider: string;

  /** Capabilities used for routing decisions */
  readonly capabilities: IRCapabilities;

  /** Optional adapter-specific configuration */
  readonly config?: Record<string, unknown>;
}
```

---

### IRCapabilities

Capability descriptor. (The name `BackendCapabilities` does not exist.)

```typescript
interface IRCapabilities {
  /** Supports streaming responses */
  streaming: boolean;

  /** Supports multi-modal content */
  multiModal: boolean;

  /** How system messages are handled */
  systemMessageStrategy:
    | 'separate-parameter'
    | 'in-messages'
    | 'prepend-user'
    | 'not-supported';

  /** Supports more than one system message */
  supportsMultipleSystemMessages: boolean;

  /** Supports tool/function calling */
  tools?: boolean;

  /** Audio / document / video input support */
  supportsAudio?: boolean;
  supportsDocuments?: boolean;
  supportsVideo?: boolean;

  /** Whether schema-constrained output is native or emulated */
  structuredOutput?: 'native' | 'fallback';

  /** Embedding support */
  embeddings?: boolean;
  embeddingModels?: readonly string[];
  maxEmbeddingBatchSize?: number;
  supportsEmbeddingDimensions?: boolean;

  /** Typed-decision support (see the Decisions guide) */
  decisions?: boolean;
  decisionModels?: readonly string[];
  decisionImages?: boolean;
  decisionTypes?: readonly ('choice' | 'score' | 'noul')[];
  decisionsEmulated?: boolean;
  decisionsEmulatedTypes?: readonly ('choice' | 'score' | 'noul')[];
  decisionLimits?: {
    maxQuestions?: number;
    maxChoiceOptions?: number;
    maxScoreLevels?: number;
    maxStateTokens?: number;
    maxImages?: number;
    maxConcurrency?: number;
  };

  /** Maximum context window size, in tokens */
  maxContextTokens?: number;

  /** Supported model identifiers */
  supportedModels?: readonly string[];

  /** Per-parameter support flags */
  supportsTemperature?: boolean;
  supportsTopP?: boolean;
  supportsTopK?: boolean;
  supportsSeed?: boolean;
  supportsFrequencyPenalty?: boolean;
  supportsPresencePenalty?: boolean;

  /** Maximum number of stop sequences */
  maxStopSequences?: number;
}
```

---

## Middleware Types

### Middleware

Middleware function type.

```typescript
type MiddlewareNext = () => Promise<IRChatResponse>;

type Middleware = (
  context: MiddlewareContext,
  next: MiddlewareNext
) => Promise<IRChatResponse>;

interface MiddlewareContext {
  /** The IR request being processed - middleware can inspect and modify it */
  request: IRChatRequest;

  /** Whether this is a streaming request */
  readonly isStreaming: boolean;

  /** Backend that will process the request (available after routing) */
  readonly backend?: BackendAdapter;

  /** Backend name/identifier */
  readonly backendName?: string;

  /** Shared state for passing data between middleware */
  readonly state: Record<string, unknown>;

  /** Configuration from the bridge */
  readonly config: Record<string, unknown>;

  /** Abort signal for request cancellation */
  readonly signal?: AbortSignal;
}
```

Stream-native middleware uses the parallel `StreamingMiddleware` type and is
registered with `bridge.useStreaming()`:

```typescript
type StreamingMiddlewareNext = () => Promise<IRChatStream>;

type StreamingMiddleware = (
  context: StreamingMiddlewareContext,
  next: StreamingMiddlewareNext
) => Promise<IRChatStream>;
```

---

## Configuration Types

### BridgeConfig

Bridge configuration options, passed as the third `Bridge` constructor argument.
(There is no `BridgeOptions`.)

```typescript
interface BridgeConfig {
  /** Enable debug mode with detailed logging (default: false) */
  debug?: boolean;

  /** Global request timeout in ms (default: 30000) */
  timeout?: number;

  /** Maximum retries for transient failures (default: 0) */
  retries?: number;

  /** Default model when the request does not name one */
  defaultModel?: string;

  /** Router configuration, when the backend is a Router */
  routerConfig?: Partial<RouterConfig>;

  /** Add a request ID to metadata if not present (default: true) */
  autoRequestId?: boolean;

  /** Custom configuration options */
  custom?: Record<string, unknown>;
}
```

---

### RouterConfig

Router configuration options. (There is no `RouterOptions`, and backends are not
passed in the config - register them with `router.register(name, adapter)`.)

```typescript
interface RouterConfig {
  /** Backend selection strategy (default: 'explicit') */
  routingStrategy?: RoutingStrategy;

  /** What to do when a backend fails (default: 'none') */
  fallbackStrategy?: 'none' | 'sequential' | 'parallel' | 'custom';

  /** Backend used when the strategy makes no other choice */
  defaultBackend?: string;

  /** Background health check interval in ms (0 disables) */
  healthCheckInterval?: number;

  /** Circuit breaker */
  enableCircuitBreaker?: boolean;
  circuitBreakerThreshold?: number;
  circuitBreakerTimeout?: number;

  /** Statistics collection */
  trackLatency?: boolean;
  trackCost?: boolean;

  /** Route only to backends whose capabilities fit the request */
  capabilityBasedRouting?: boolean;
  capabilityCacheDuration?: number;

  /** Optimization target and weights */
  optimization?: 'cost' | 'speed' | 'quality' | 'balanced';
  optimizationWeights?: { cost?: number; speed?: number; quality?: number };

  /** Custom routing / fallback hooks */
  customRouter?: CustomRoutingFunction;
  customFallback?: CustomFallbackFunction;

  /** Cross-provider model name translation */
  modelTranslation?: ModelTranslationConfig;

  /** Called for each semantic-drift warning */
  onWarning?: (warning: IRWarning) => void;
}
```

There is no separate health-check options object: the interval is
`healthCheckInterval`, and checks can be run on demand with
`router.checkHealth()`.

---

### RoutingStrategy

Available routing strategies.

```typescript
type RoutingStrategy =
  | 'explicit'
  | 'model-based'
  | 'cost-optimized'
  | 'latency-optimized'
  | 'round-robin'
  | 'random'
  | 'custom';
```

---

### CustomRoutingFunction

Custom routing hook, set as `RouterConfig.customRouter`. It is async and returns
a backend *name* (or `null` to fall back to the default strategy). There is no
`CustomStrategyFunction`.

```typescript
type CustomRoutingFunction = (
  request: IRChatRequest,
  availableBackends: readonly string[],
  context: RoutingContext
) => Promise<string | null>;
```

---

### BackendInfo

Per-backend state, returned by `router.getBackendInfo()`. (There is no
`BackendHealthMap`.)

```typescript
interface BackendInfo {
  /** Backend identifier */
  name: string;

  /** The registered adapter */
  adapter: BackendAdapter;

  /** Adapter metadata */
  metadata: AdapterMetadata;

  /** Whether the backend is currently healthy */
  isHealthy: boolean;

  /** Timestamp of the last health check */
  lastHealthCheck?: number;

  /** Circuit breaker state */
  circuitBreakerState: 'closed' | 'open' | 'half-open';

  /** Consecutive failures (drives the circuit breaker) */
  consecutiveFailures: number;

  /** Request/latency/cost statistics */
  stats: BackendStats;
}
```

Health can also be queried directly: `router.checkHealth()` returns
`Promise<Record<string, boolean>>`, and `router.checkHealth(name)` returns
`Promise<boolean>`.

---

## Event Types

### BridgeEventType

The event names accepted by `bridge.on()` / `off()` / `once()`. (`BridgeEvent`
is an interface describing an event object, not a string union.)

```typescript
type BridgeEventType =
  | 'request:start'
  | 'request:success'
  | 'request:error'
  | 'request:cancelled'
  | 'stream:start'
  | 'stream:chunk'
  | 'stream:complete'
  | 'stream:error'
  | 'backend:selected'
  | 'backend:failover'
  | 'middleware:executed';
```

Only `request:start`, `request:success`, `request:error`, `stream:start`,
`stream:complete` and `stream:error` are actually emitted.

`Router` has no event emitter and no `RouterEvent` type - use
`router.getStats()`, `router.getBackendInfo()` and `router.checkHealth()` to
observe it.

---

## Utility Types

### ModelMapping

Model name mapping, used by `router.setModelMapping()`. It is a plain
source-name to target-name record.

```typescript
type ModelMapping = Record<string, string>;
```

---

### Token and cost estimates

There are no `TokenEstimate` or `CostEstimate` types. Token counts come back on
a response as [`IRUsage`](#irusage), and cost estimation is a single number:

```typescript
// Optional on BackendAdapter - estimated USD, or null when unavailable
const usd = await backend.estimateCost?.(request);
```

---

## Type Guards

### Type guard utilities

The shipped type guards narrow stream chunks. They live in
`@johnhenry/aimatey-utils`:

```typescript
import { isContentChunk, isDoneChunk, isErrorChunk } from '@johnhenry/aimatey-utils';

for await (const chunk of stream) {
  if (isContentChunk(chunk)) process.stdout.write(chunk.delta);
  else if (isErrorChunk(chunk)) throw new Error(chunk.error.message);
  else if (isDoneChunk(chunk)) console.log('\n', chunk.finishReason);
}
```

There are no `isIRChatRequest`, `isIRChatResponse`, `isIRChatCompletionChunk`,
`isBackendAdapter` or `isFrontendAdapter` guards - `IRStreamChunk` is a
discriminated union, so a plain `chunk.type === 'content'` check narrows it too.

---

## Import Examples

### Importing Types

```typescript
import type {
  IRChatRequest,
  IRChatResponse,
  IRStreamChunk,
  IRChatStream,
  IRMessage,
  IRUsage,
  AdapterMetadata,
  BackendAdapter,
  FrontendAdapter,
  Middleware
} from '@johnhenry/aimatey-types';
```

---

### Using Types

```typescript
import type {
  AdapterMetadata,
  BackendAdapter,
  IRChatRequest,
  IRChatResponse
} from '@johnhenry/aimatey-types';

class MyBackend implements BackendAdapter {
  readonly metadata: AdapterMetadata = {
    name: 'my-backend',
    version: '1.0.0',
    provider: 'My Provider',
    capabilities: {
      streaming: true,
      multiModal: false,
      systemMessageStrategy: 'in-messages',
      supportsMultipleSystemMessages: true
    }
  };

  fromIR(request: IRChatRequest): unknown {
    // Model and sampling parameters live under `parameters`
    const { messages, parameters } = request;
    return { model: parameters?.model, messages };
  }

  toIR(_response: unknown, originalRequest: IRChatRequest): IRChatResponse {
    return {
      message: { role: 'assistant', content: 'Hello' },
      finishReason: 'stop',
      metadata: originalRequest.metadata
    };
  }

  async execute(request: IRChatRequest): Promise<IRChatResponse> {
    return this.toIR(null, request);
  }

  async *executeStream(request: IRChatRequest) {
    yield { type: 'start' as const, sequence: 0, metadata: request.metadata };
    yield { type: 'content' as const, sequence: 1, delta: 'Hello' };
    yield { type: 'done' as const, sequence: 2, finishReason: 'stop' as const };
  }
}
```

---

## See Also

- [Bridge API](/api/bridge) - Bridge class reference
- [Router API](/api/router) - Router class reference
- [Middleware API](/api/middleware) - Middleware reference
- [IR Format Guide](/guides/architecture/ir-format) - IR format deep dive
