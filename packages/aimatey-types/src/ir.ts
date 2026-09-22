/**
 * Intermediate Representation (IR) Types
 *
 * The IR is the universal format that sits between frontend and backend adapters.
 * It represents chat requests, responses, and streams in a normalized, provider-agnostic way.
 *
 * Design principles:
 * - Provider-agnostic: No provider-specific fields in core types
 * - Extensible: Support for metadata and custom fields
 * - Type-safe: Use discriminated unions for runtime type checking
 * - Stream-friendly: First-class support for streaming responses
 *
 * @module
 */

import type { StreamMode } from './streaming.js';

// ============================================================================
// Message Types
// ============================================================================

/**
 * Message role in a conversation.
 *
 * Maps to roles across all major providers:
 * - system: Initial instructions/context (some providers use special parameter)
 * - user: Messages from the user
 * - assistant: Messages from the AI
 * - tool: Results from tool/function calls
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * Text content block.
 */
export interface TextContent {
  readonly type: 'text';
  readonly text: string;
}

/**
 * Image content block.
 *
 * Supports both URLs and base64-encoded images.
 *
 * @example
 * ```typescript
 * // Image from URL
 * const imageUrl: ImageContent = {
 *   type: 'image',
 *   source: {
 *     type: 'url',
 *     url: 'https://example.com/image.jpg'
 *   }
 * };
 *
 * // Base64 image
 * const imageBase64: ImageContent = {
 *   type: 'image',
 *   source: {
 *     type: 'base64',
 *     mediaType: 'image/jpeg',
 *     data: 'iVBORw0KGgo...'
 *   }
 * };
 * ```
 */
export interface ImageContent {
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

/**
 * Audio content block.
 *
 * Supports both URLs and base64-encoded audio files.
 *
 * @example
 * ```typescript
 * // Audio from URL
 * const audioUrl: AudioContent = {
 *   type: 'audio',
 *   source: {
 *     type: 'url',
 *     url: 'https://example.com/recording.mp3'
 *   }
 * };
 *
 * // Base64 audio with transcript
 * const audioBase64: AudioContent = {
 *   type: 'audio',
 *   source: {
 *     type: 'base64',
 *     mediaType: 'audio/mp3',
 *     data: 'SGVsbG8gd29ybGQ...'
 *   },
 *   transcript: 'Hello world'
 * };
 * ```
 */
export interface AudioContent {
  readonly type: 'audio';
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
  /** Optional transcript for accessibility and fallback. */
  readonly transcript?: string;
}

/**
 * Document content block.
 *
 * Supports both URLs and base64-encoded documents (e.g., PDFs).
 *
 * @example
 * ```typescript
 * // Document from URL
 * const docUrl: DocumentContent = {
 *   type: 'document',
 *   source: {
 *     type: 'url',
 *     url: 'https://example.com/report.pdf'
 *   },
 *   filename: 'report.pdf'
 * };
 *
 * // Base64 document
 * const docBase64: DocumentContent = {
 *   type: 'document',
 *   source: {
 *     type: 'base64',
 *     mediaType: 'application/pdf',
 *     data: 'JVBERi0xLjQ...'
 *   },
 *   filename: 'invoice.pdf'
 * };
 * ```
 */
export interface DocumentContent {
  readonly type: 'document';
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
  /** Optional filename for display and download purposes. */
  readonly filename?: string;
}

/**
 * Video content block.
 *
 * Supports both URLs and base64-encoded video files.
 *
 * @example
 * ```typescript
 * // Video from URL
 * const videoUrl: VideoContent = {
 *   type: 'video',
 *   source: {
 *     type: 'url',
 *     url: 'https://example.com/clip.mp4'
 *   },
 *   poster: 'https://example.com/clip-thumb.jpg'
 * };
 *
 * // Base64 video
 * const videoBase64: VideoContent = {
 *   type: 'video',
 *   source: {
 *     type: 'base64',
 *     mediaType: 'video/mp4',
 *     data: 'AAAAIGZ0eXBpc29t...'
 *   }
 * };
 * ```
 */
export interface VideoContent {
  readonly type: 'video';
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
  /** Optional poster/thumbnail URL for preview. */
  readonly poster?: string;
}

/**
 * Tool use request (AI wants to call a tool).
 */
export interface ToolUseContent {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/**
 * Tool result (response from tool execution).
 */
export interface ToolResultContent {
  readonly type: 'tool_result';
  readonly toolUseId: string;
  readonly content: string | TextContent[];
  readonly isError?: boolean;
}

/**
 * Union of all content types.
 *
 * Uses discriminated union pattern for type-safe content handling.
 */
export type MessageContent =
  | TextContent
  | ImageContent
  | AudioContent
  | DocumentContent
  | VideoContent
  | ToolUseContent
  | ToolResultContent;

/**
 * A message in the conversation.
 *
 * Messages can have either simple string content or structured content blocks.
 * The IR normalizes both formats into a consistent representation.
 *
 * @example
 * ```typescript
 * // Simple text message
 * const textMessage: IRMessage = {
 *   role: 'user',
 *   content: 'Hello, AI!'
 * };
 *
 * // Multi-modal message with image
 * const multiModalMessage: IRMessage = {
 *   role: 'user',
 *   content: [
 *     { type: 'text', text: 'What is in this image?' },
 *     {
 *       type: 'image',
 *       source: {
 *         type: 'url',
 *         url: 'https://example.com/photo.jpg'
 *       }
 *     }
 *   ]
 * };
 *
 * // System message
 * const systemMessage: IRMessage = {
 *   role: 'system',
 *   content: 'You are a helpful assistant.'
 * };
 * ```
 */
export interface IRMessage {
  /**
   * Message role (system, user, assistant, tool).
   */
  readonly role: MessageRole;

  /**
   * Message content.
   * Can be a simple string or array of content blocks.
   */
  readonly content: string | readonly MessageContent[];

  /**
   * Optional message name/identifier.
   * Used for tool messages or multi-user scenarios.
   */
  readonly name?: string;

  /**
   * Provider-specific metadata.
   * Stored but not processed by IR.
   */
  readonly metadata?: Record<string, unknown>;
}

// ============================================================================
// Tool/Function Definitions
// ============================================================================

/**
 * JSON Schema type definitions.
 */
export type JSONSchemaType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null';

/**
 * JSON Schema for tool parameters.
 *
 * Simplified schema supporting common validation patterns.
 */
export interface JSONSchema {
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

/**
 * Tool/function definition.
 *
 * Describes a tool that the AI can call.
 *
 * @example
 * ```typescript
 * const weatherTool: IRTool = {
 *   name: 'get_weather',
 *   description: 'Get current weather for a location',
 *   parameters: {
 *     type: 'object',
 *     properties: {
 *       location: {
 *         type: 'string',
 *         description: 'City name or coordinates'
 *       },
 *       units: {
 *         type: 'string',
 *         enum: ['celsius', 'fahrenheit'],
 *         default: 'celsius'
 *       }
 *     },
 *     required: ['location']
 *   }
 * };
 * ```
 */
export interface IRTool {
  /**
   * Tool name (must be valid identifier).
   */
  readonly name: string;

  /**
   * Human-readable description of what the tool does.
   */
  readonly description: string;

  /**
   * JSON Schema for tool parameters.
   */
  readonly parameters: JSONSchema;

  /**
   * Provider-specific tool configuration.
   */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Structured/schema-constrained output request.
 *
 * Asks the backend to constrain its response to a caller-supplied JSON
 * schema. Backends with a native mechanism (e.g. OpenAI, Anthropic, Gemini)
 * map this directly; others emulate it via prompt injection and best-effort
 * JSON extraction (see `IRCapabilities.structuredOutput` and
 * `IRChatResponse.metadata.custom.responseFormatEnforced`).
 *
 * This is a best-effort request, not a guarantee - callers should still
 * validate the parsed response against their schema (e.g. with Zod).
 *
 * @example
 * ```typescript
 * const responseFormat: IRResponseFormat = {
 *   type: 'json_schema',
 *   schema: {
 *     type: 'object',
 *     properties: { answer: { type: 'string' } },
 *     required: ['answer']
 *   }
 * };
 * ```
 */
export interface IRResponseFormat {
  /**
   * Format type. Currently only JSON Schema-constrained output is supported.
   */
  readonly type: 'json_schema';

  /**
   * JSON Schema the response must conform to.
   */
  readonly schema: JSONSchema;

  /**
   * Hint: reject/retry on schema violation where the backend supports it.
   */
  readonly strict?: boolean;
}

// ============================================================================
// Request Parameters
// ============================================================================

/**
 * Normalized request parameters.
 *
 * Common parameters across all providers, normalized to consistent ranges.
 * Provider-specific parameters can be added to `custom` field.
 *
 * @example
 * ```typescript
 * const params: IRParameters = {
 *   model: 'gpt-4',
 *   temperature: 0.7,
 *   maxTokens: 1000,
 *   topP: 0.9,
 *   frequencyPenalty: 0.0,
 *   presencePenalty: 0.0,
 *   stopSequences: ['\n\n', 'END']
 * };
 * ```
 */
export interface IRParameters {
  /**
   * Model identifier.
   * Provider-specific model name.
   */
  readonly model?: string;

  /**
   * Sampling temperature (0.0 to 2.0).
   * Higher values make output more random.
   * @default 0.7
   */
  readonly temperature?: number;

  /**
   * Maximum tokens to generate.
   * Actual limit depends on model and provider.
   */
  readonly maxTokens?: number;

  /**
   * Nucleus sampling threshold (0.0 to 1.0).
   * Alternative to temperature.
   */
  readonly topP?: number;

  /**
   * Top-K sampling limit.
   * Only consider top K tokens.
   */
  readonly topK?: number;

  /**
   * Frequency penalty (-2.0 to 2.0).
   * Penalize tokens based on frequency in text so far.
   */
  readonly frequencyPenalty?: number;

  /**
   * Presence penalty (-2.0 to 2.0).
   * Penalize tokens based on whether they appear in text so far.
   */
  readonly presencePenalty?: number;

  /**
   * Stop sequences.
   * Generation stops when any sequence is encountered.
   */
  readonly stopSequences?: readonly string[];

  /**
   * Random seed for deterministic generation.
   */
  readonly seed?: number;

  /**
   * User identifier for abuse monitoring.
   */
  readonly user?: string;

  /**
   * Provider-specific parameters.
   * Passed through to backend without modification.
   */
  readonly custom?: Record<string, unknown>;
}

// ============================================================================
// Capabilities
// ============================================================================

/**
 * System message handling strategy.
 */
export type SystemMessageStrategy =
  | 'separate-parameter'
  | 'in-messages'
  | 'prepend-user'
  | 'not-supported';

/**
 * Adapter capabilities metadata.
 *
 * Describes what an adapter supports for routing and validation.
 *
 * @example
 * ```typescript
 * const openaiCapabilities: IRCapabilities = {
 *   streaming: true,
 *   multiModal: true,
 *   tools: true,
 *   maxContextTokens: 128000,
 *   supportedModels: ['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo'],
 *   systemMessageStrategy: 'in-messages',
 *   supportsMultipleSystemMessages: true,
 *   supportsTemperature: true,
 *   supportsTopP: true,
 *   supportsTopK: false,
 *   supportsSeed: true
 * };
 * ```
 */
export interface IRCapabilities {
  /**
   * Supports streaming responses.
   */
  readonly streaming: boolean;

  /**
   * Supports multi-modal content (images, etc.).
   */
  readonly multiModal: boolean;

  /**
   * Supports audio inputs.
   */
  readonly supportsAudio?: boolean;

  /**
   * Supports document inputs (e.g., PDFs).
   */
  readonly supportsDocuments?: boolean;

  /**
   * Supports video inputs.
   */
  readonly supportsVideo?: boolean;

  /**
   * Supports tool/function calling.
   */
  readonly tools?: boolean;

  /**
   * Whether structured/schema-constrained output (`IRChatRequest.responseFormat`)
   * is enforced natively by the provider's API, or emulated via a
   * prompt-injection + best-effort JSON extraction fallback.
   */
  readonly structuredOutput?: 'native' | 'fallback';

  /**
   * Whether the backend can generate embeddings (implements `embed()`).
   */
  readonly embeddings?: boolean;

  /**
   * Embedding model ids offered by the backend.
   */
  readonly embeddingModels?: readonly string[];

  /**
   * Maximum number of inputs per embedding request (batch limit).
   */
  readonly maxEmbeddingBatchSize?: number;

  /**
   * Whether the provider accepts a native `dimensions` parameter
   * (e.g. OpenAI text-embedding-3, Matryoshka-style models).
   */
  readonly supportsEmbeddingDimensions?: boolean;

  /**
   * Whether the backend can answer typed-decision requests (implements
   * `decide()`) — see `decisions.ts`. A "System One" model (Jev, Laya),
   * not a chat model; a backend can support this without supporting
   * chat at all.
   */
  readonly decisions?: boolean;

  /**
   * Decision model ids offered by the backend.
   */
  readonly decisionModels?: readonly string[];

  /**
   * Maximum context window size (tokens).
   */
  readonly maxContextTokens?: number;

  /**
   * List of supported model identifiers.
   */
  readonly supportedModels?: readonly string[];

  /**
   * How system messages are handled.
   */
  readonly systemMessageStrategy: SystemMessageStrategy;

  /**
   * Supports multiple system messages.
   */
  readonly supportsMultipleSystemMessages: boolean;

  /**
   * Supports temperature parameter.
   */
  readonly supportsTemperature?: boolean;

  /**
   * Supports topP parameter.
   */
  readonly supportsTopP?: boolean;

  /**
   * Supports topK parameter.
   */
  readonly supportsTopK?: boolean;

  /**
   * Supports seed parameter.
   */
  readonly supportsSeed?: boolean;

  /**
   * Supports frequency penalty.
   */
  readonly supportsFrequencyPenalty?: boolean;

  /**
   * Supports presence penalty.
   */
  readonly supportsPresencePenalty?: boolean;

  /**
   * Maximum number of stop sequences.
   */
  readonly maxStopSequences?: number;
}

// ============================================================================
// Metadata
// ============================================================================

/**
 * Warning severity levels.
 */
export type WarningSeverity = 'info' | 'warning' | 'error';

/**
 * Warning categories for semantic drift and compatibility issues.
 */
export type WarningCategory =
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
  /**
   * Message content was rewritten before it left the process - e.g. PII
   * redaction by the security or validation middleware. The request the
   * backend receives is not the request the caller supplied.
   */
  | 'content-redacted'
  /**
   * A response was served straight from the backend because the caching
   * middleware could not tell which caller the request belonged to, and
   * caching it would have risked handing it to a different caller. Set
   * {@link IRMetadata.principal} (or the middleware's `scopeKey`) to make
   * the request cacheable, or opt the deployment into a shared cache.
   */
  | 'cache-bypassed'
  /**
   * The request was accepted but did not run when it was made -- a
   * store-and-forward transport held it and executed it later. The reply is
   * correct and *late*, which is a different claim from any translation
   * warning: nothing about the request changed, only when it was served.
   *
   * Put the wait in {@link IRWarning.details} (e.g. `{ queuedMs: 812000 }`)
   * when the producer knows it. A caller that has already shown the user a
   * spinner, or has moved on, needs the elapsed time and not just the fact.
   */
  | 'request-queued'
  /**
   * The turn was served over a link that materially degraded it -- a stream
   * that reconnected mid-response, a re-send after a transport failure, or a
   * hop whose latency was an order of magnitude above the same request served
   * locally.
   *
   * This is deliberately *not* `'capability-unsupported'`. That member says
   * the backend could not do what was asked; this one says the backend did
   * exactly what was asked and the delivery was poor. Reaching for
   * `'capability-unsupported'` to report a slow or lossy link -- or a fallback
   * forced by device pressure rather than by a missing capability -- is how a
   * category stops carrying information.
   */
  | 'transport-degraded'
  /**
   * A response arrived where the receiver had reason to expect
   * {@link IRMetadata.provenance} and there was none.
   *
   * `provenance` is optional, so a bare `undefined` means two very different
   * things: the chain genuinely recorded nothing, or something recorded it and
   * it did not survive the trip -- dropped by a transport, a re-serialization,
   * or a hop that rebuilt `metadata` without spreading the old one. In one
   * process the second case does not happen. Across a wire it is the
   * difference between "we do not know where this ran" and "something ate the
   * answer" (#131).
   *
   * A transport-aware adapter that knows the far side stamps provenance
   * attaches this warning when it receives a response without it, which turns
   * a silent loss into a detectable one. It is the receiving hop's claim about
   * what it expected, so it is never inferred by a walker and never attached
   * by an adapter that had no such expectation: absent provenance with no
   * `provenance-lost` warning still means "not recorded".
   *
   * A consumer that renders a trust label should treat a turn carrying this
   * warning as unknown-and-suspect rather than unknown-and-ordinary.
   */
  | 'provenance-lost';

/**
 * Semantic drift warning.
 *
 * Documents transformations and compatibility issues that occur
 * when converting between provider formats.
 *
 * @example
 * ```typescript
 * const warning: IRWarning = {
 *   category: 'parameter-normalized',
 *   severity: 'info',
 *   message: 'Temperature normalized from 0-2 range to 0-1 range',
 *   field: 'temperature',
 *   originalValue: 1.5,
 *   transformedValue: 0.75,
 *   source: 'openai-backend'
 * };
 * ```
 */
export interface IRWarning {
  /**
   * Warning category.
   */
  readonly category: WarningCategory;

  /**
   * Severity level.
   */
  readonly severity: WarningSeverity;

  /**
   * Human-readable warning message.
   */
  readonly message: string;

  /**
   * Field or parameter that caused the warning.
   */
  readonly field?: string;

  /**
   * Original value before transformation.
   */
  readonly originalValue?: unknown;

  /**
   * Transformed value after normalization.
   */
  readonly transformedValue?: unknown;

  /**
   * Source adapter that generated the warning.
   */
  readonly source?: string;

  /**
   * Additional context or details.
   */
  readonly details?: Record<string, unknown>;
}

/**
 * Provenance tracking for request/response chain.
 *
 * The flat fields describe a single hop: the adapters *this* process ran. When the
 * backend is itself a proxy onto another aimatey instance, what the far side did goes in
 * {@link IRProvenance.upstream} rather than overwriting them.
 */
export interface IRProvenance {
  /**
   * Frontend adapter name.
   */
  readonly frontend?: string;

  /**
   * Backend adapter name.
   */
  readonly backend?: string;

  /**
   * The model that actually generated the response, as the provider reported it.
   *
   * Set by the backend adapter from the provider's own response payload -- OpenAI's
   * `model`, Anthropic's `model`, Gemini's `modelVersion` -- and **never** from the
   * request. `IRParameters.model` is what was asked for; this is what answered. The two
   * exist in order to differ: a provider may resolve an alias to a dated snapshot
   * (`gpt-4` -> `gpt-4-0613`), and aimatey's own `Router` may substitute a model outright
   * (the `model-substituted` warning category). Before this field, a consumer was told a
   * substitution had happened but could not learn *what* answered without parsing `raw`
   * per provider (#113).
   *
   * `undefined` means **not reported**, and must stay distinguishable from a reported
   * value. Four shipped providers genuinely do not echo the served model -- Cohere,
   * Bedrock (an inference profile deliberately does not disclose it), HuggingFace and
   * Replicate -- so an adapter that cannot report one leaves this unset rather than
   * defaulting to the requested model. A defaulted value would assert a model that never
   * ran in exactly the substitution case this field exists to record.
   *
   * It lives on provenance, next to {@link IRProvenance.backend}, because it is a
   * **per-hop** fact. In `phone -> desktop -> llama-cpp` the model that answered belongs to
   * the last hop; the tunnel served nothing at all, and leaving its `servedModel`
   * undefined is the honest statement of that. A single flat field on the response could
   * record only one of the two, reintroducing the ambiguity #110 removed from `backend`
   * one field over. Use {@link resolveServedModel} to walk a chain.
   *
   * Adapters assign this as a **plain key** (`servedModel: response.model`) rather than with
   * the conditional-spread idiom used elsewhere in their metadata blocks
   * (`...(x ? { k: x } : {})`). That is deliberate: excess-property checking does not see
   * through a spread of a conditional expression, so a misspelled key written that way
   * compiles silently -- which is exactly how the non-existent `provenance.backendModel`
   * read survived until #112. A plain key makes a typo `error TS2561` at every write site.
   * A provider that reports nothing therefore yields `servedModel: undefined`, which
   * `JSON.stringify` drops and {@link resolveServedModel} treats as not-reported.
   *
   * @example
   * ```typescript
   * // Single hop -- the near hop is the serving hop.
   * { frontend: 'openai', backend: 'openai', servedModel: 'gpt-4-0613' }
   *
   * // Proxied -- the tunnel forwarded, llama-cpp served.
   * {
   *   backend: 'tunnel',                        // no servedModel: it did not serve
   *   upstream: { backend: 'llama-cpp', servedModel: 'qwen2.5-7b-instruct' }
   * }
   * ```
   */
  readonly servedModel?: string;

  /**
   * Middleware chain (in order of execution).
   */
  readonly middleware?: readonly string[];

  /**
   * Router name (if applicable).
   */
  readonly router?: string;

  /**
   * Provenance reported by the next hop, when `backend` is itself a proxy.
   *
   * Set this only when `backend` did not serve the request itself but forwarded it to
   * another aimatey instance across a process or device boundary -- a tunnel, a gateway,
   * a self-hosted relay, or a test double wrapping a real `Router`. `upstream` then holds
   * what the far side reported: its own frontend, the backend *it* chose, and any router
   * or middleware it ran. The far side may itself have been proxying, so the chain nests
   * to whatever depth the request actually travelled.
   *
   * The sibling fields always describe the **nearest** hop, so a reader that ignores
   * `upstream` keeps reading the adapter this process actually talked to -- which is what
   * a circuit breaker, a usage counter, or a log line means by "the backend". A reader
   * that wants the far end walks `upstream` to the last link.
   *
   * Nesting rather than flattening is deliberate. `backend: 'tunnel'` and
   * `backend: 'llama-cpp'` are different claims about `phone -> desktop -> llama-cpp`, and
   * only the first is true of the phone. A flattened chain makes them indistinguishable,
   * and provenance is a privacy surface: a UI that tells someone whether a reply left
   * their device cannot be built on a field that cannot separate "your own desktop" from
   * "a third-party API" (#110).
   *
   * Use {@link withUpstreamProvenance} to attach one; it keeps the proxy's own hop intact.
   *
   * @example
   * ```typescript
   * // On the phone, for `phone -> desktop -> llama-cpp`:
   * const provenance: IRProvenance = {
   *   frontend: 'openai',
   *   backend: 'tunnel',          // what this device talked to
   *   upstream: {
   *     frontend: 'openai',
   *     backend: 'llama-cpp',     // what the desktop chose
   *     router: 'desktop-router'
   *   }
   * };
   * ```
   */
  readonly upstream?: IRProvenance;
}

/**
 * Request/response metadata.
 *
 * Tracks provenance, timing, warnings, and custom metadata throughout the adapter chain.
 *
 * @example
 * ```typescript
 * const metadata: IRMetadata = {
 *   requestId: 'req_abc123',
 *   timestamp: Date.now(),
 *   provenance: {
 *     frontend: 'anthropic',
 *     backend: 'openai',
 *     middleware: ['logging', 'caching']
 *   },
 *   warnings: [
 *     {
 *       category: 'parameter-normalized',
 *       severity: 'info',
 *       message: 'Temperature scaled from 0-2 to 0-1 range',
 *       field: 'temperature'
 *     }
 *   ],
 *   custom: {
 *     userId: 'user_123',
 *     sessionId: 'session_456'
 *   }
 * };
 * ```
 */
export interface IRMetadata {
  /**
   * Unique request identifier.
   * Generated by the client (frontend adapter or Bridge).
   * Stable across retries and fallbacks for correlation.
   */
  readonly requestId: string;

  /**
   * Provider's response identifier.
   * Set by backend adapter from the provider's actual response ID.
   * Examples: OpenAI's "chatcmpl-xxx", Anthropic's "msg_xxx".
   * Useful for correlating with provider logs and billing.
   */
  readonly providerResponseId?: string;

  /**
   * Request timestamp (milliseconds since epoch).
   */
  readonly timestamp: number;

  /**
   * Adapter chain provenance.
   */
  readonly provenance?: IRProvenance;

  /**
   * Semantic drift warnings collected during processing.
   * Documents any transformations or compatibility issues.
   */
  readonly warnings?: readonly IRWarning[];

  /**
   * Identity of the caller this request is made on behalf of.
   *
   * An opaque, deployment-defined string: a tenant ID, a user ID, an API-key
   * fingerprint, a session ID, or a composite such as `'tenant-7:user-42'`.
   * It is compared verbatim, never parsed, and is never sent to a provider --
   * it exists so that middleware which shares state *between* requests can
   * tell two callers apart.
   *
   * Set it whenever one process serves more than one user or tenant. The
   * caching middleware refuses to cache a request that has no principal
   * rather than risk serving one caller's completion to another (#44); a
   * genuinely single-tenant deployment opts out of that with the
   * middleware's own `unidentified: 'share'`.
   *
   * This is deliberately a first-class field rather than a convention inside
   * {@link IRMetadata.custom}: `custom` is an unstructured bag whose keys
   * mean whatever the application decided they mean, so no middleware can
   * safely read identity out of it. Security-relevant scoping needs a field
   * with one defined meaning.
   */
  readonly principal?: string;

  /**
   * Custom metadata fields.
   * Can be used by middleware or application code.
   */
  readonly custom?: Record<string, unknown>;
}

// ============================================================================
// Chat Request
// ============================================================================

/**
 * Universal chat completion request.
 *
 * This is the normalized format that all frontend adapters convert to
 * and all backend adapters consume.
 *
 * @example
 * ```typescript
 * const request: IRChatRequest = {
 *   messages: [
 *     { role: 'system', content: 'You are helpful.' },
 *     { role: 'user', content: 'Hello!' }
 *   ],
 *   parameters: {
 *     model: 'gpt-4',
 *     temperature: 0.7,
 *     maxTokens: 1000
 *   },
 *   metadata: {
 *     requestId: 'req_abc123',
 *     timestamp: Date.now(),
 *     provenance: {
 *       frontend: 'openai'
 *     }
 *   },
 *   stream: false
 * };
 * ```
 */
export interface IRChatRequest {
  /**
   * Conversation messages.
   * Must contain at least one message.
   */
  readonly messages: readonly IRMessage[];

  /**
   * Tool/function definitions.
   * Optional, for function calling.
   */
  readonly tools?: readonly IRTool[];

  /**
   * Tool choice strategy.
   * - 'auto': Model decides whether to call tools
   * - 'required': Model must call a tool
   * - 'none': Model cannot call tools
   * - { name: string }: Force specific tool
   */
  readonly toolChoice?: 'auto' | 'required' | 'none' | { readonly name: string };

  /**
   * Structured/schema-constrained output request.
   * Optional, for JSON-schema-constrained responses.
   */
  readonly responseFormat?: IRResponseFormat;

  /**
   * Request parameters.
   */
  readonly parameters?: IRParameters;

  /**
   * Request metadata.
   */
  readonly metadata: IRMetadata;

  /**
   * Whether to stream the response.
   * @default false
   */
  readonly stream?: boolean;

  /**
   * Preferred streaming mode (hint to backend).
   *
   * - `delta`: Request incremental chunks only (most efficient)
   * - `accumulated`: Request full accumulated text in each chunk
   *
   * This is a preference hint - backends may choose to:
   * - Provide only delta (always safe, universal)
   * - Provide both delta and accumulated (maximum flexibility)
   * - Provide only accumulated (if that's native format)
   *
   * Frontends and wrappers can convert between modes as needed.
   *
   * @default 'delta'
   */
  readonly streamMode?: StreamMode;
}

// ============================================================================
// Chat Response
// ============================================================================

/**
 * Finish reason for generation.
 */
export type FinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'error'
  | 'cancelled';

/**
 * Token usage statistics.
 */
export interface IRUsage {
  /**
   * Tokens in the prompt.
   */
  readonly promptTokens: number;

  /**
   * Tokens in the completion.
   */
  readonly completionTokens: number;

  /**
   * Total tokens (prompt + completion).
   */
  readonly totalTokens: number;

  /**
   * Provider-specific usage details.
   */
  readonly details?: Record<string, unknown>;
}

/**
 * Universal chat completion response.
 *
 * Normalized format that all backend adapters convert to
 * and all frontend adapters consume.
 *
 * @example
 * ```typescript
 * const response: IRChatResponse = {
 *   message: {
 *     role: 'assistant',
 *     content: 'Hello! How can I help you today?'
 *   },
 *   finishReason: 'stop',
 *   usage: {
 *     promptTokens: 15,
 *     completionTokens: 10,
 *     totalTokens: 25
 *   },
 *   metadata: {
 *     requestId: 'req_abc123',
 *     timestamp: Date.now(),
 *     provenance: {
 *       frontend: 'openai',
 *       backend: 'openai'
 *     }
 *   }
 * };
 * ```
 */
export interface IRChatResponse {
  /**
   * Generated message from the assistant.
   */
  readonly message: IRMessage;

  /**
   * Why generation finished.
   */
  readonly finishReason: FinishReason;

  /**
   * Token usage statistics.
   */
  readonly usage?: IRUsage;

  /**
   * Response metadata.
   * Includes original request metadata plus backend provenance.
   */
  readonly metadata: IRMetadata;

  /**
   * Provider-specific response data.
   */
  readonly raw?: Record<string, unknown>;
}

// ============================================================================
// Streaming
// ============================================================================

/**
 * Stream chunk types.
 */
export type StreamChunkType = 'start' | 'content' | 'tool_use' | 'metadata' | 'done' | 'error';

/**
 * Base stream chunk interface.
 */
export interface BaseStreamChunk {
  readonly type: StreamChunkType;

  /**
   * Position of this chunk within its stream.
   *
   * **The invariant, which every backend adapter must satisfy:** the first
   * chunk of a stream carries `0`, and each subsequent chunk carries exactly
   * one more than the chunk before it. The counter is per-stream and spans
   * **all** chunk types -- a `metadata` chunk between two `content` chunks
   * consumes a number, and so does the terminal `done` or `error` chunk. No
   * number is reused, and none is skipped.
   *
   * Contiguity is the whole point. In-process an async generator cannot drop
   * or reorder its own yields, so `sequence` is decoration and any invariant
   * would do. The moment a stream crosses a wire -- a tunnel, a gateway, a
   * relay, or any of the proxying shapes {@link IRProvenance.upstream}
   * anticipates -- it is the only loss-detection primitive the IR has, and it
   * can only detect loss if a gap is illegal. A consumer that observes a gap,
   * a repeat, or a decrease has received a stream that is not the stream that
   * was sent, and should fail the turn rather than render it: a fluent but
   * truncated answer reads to a user as a real answer, which is the worst
   * available failure mode for a chat UI (#120).
   *
   * `validateChunkSequence()` and `validateStream()` in
   * `@johnhenry/aimatey-utils` check exactly this rule, so a consumer does not
   * have to invent it -- and two consumers cannot invent different ones.
   *
   * The terminal `error` chunk is the easiest place to break the rule and the
   * worst place to break it, because it is emitted from a `catch` that often
   * cannot see the counter. An adapter that reports its failure at `sequence:
   * 0` after streaming forty chunks turns a clean in-band error into an
   * apparent replay, and a strict consumer rejects the error rather than the
   * request that caused it. Hoist the counter above the `try`.
   */
  readonly sequence: number;
}

/**
 * Start of stream chunk.
 */
export interface StreamStartChunk extends BaseStreamChunk {
  readonly type: 'start';
  readonly metadata: IRMetadata;
}

/**
 * Content chunk with flexible streaming support.
 *
 * Supports both delta (incremental) and accumulated (full text) streaming modes:
 *
 * **Delta Mode (default):**
 * - `delta` contains only the new text generated in this chunk
 * - Consumers must accumulate deltas to get full text
 * - Most efficient for network and memory
 *
 * **Accumulated Mode (optional):**
 * - `accumulated` contains all text generated so far
 * - Each chunk has the complete text up to that point
 * - Useful for UIs that want to replace text (Chrome AI style)
 *
 * **Backward Compatibility:**
 * - `delta` is ALWAYS present (universal standard)
 * - `accumulated` is optional (provided when backend configured for it)
 *
 * @example
 * ```typescript
 * // Delta-only chunk (standard)
 * { type: 'content', delta: ' world', sequence: 2 }
 *
 * // With both formats (configured backend)
 * { type: 'content', delta: ' world', accumulated: 'Hello world', sequence: 2 }
 * ```
 */
export interface StreamContentChunk extends BaseStreamChunk {
  readonly type: 'content';

  /**
   * Incremental text delta (new content only).
   * ALWAYS present for maximum compatibility.
   * Contains only the text generated in this chunk.
   */
  readonly delta: string;

  /**
   * Accumulated text (full content so far).
   * Optional - provided when backend is configured for accumulated mode.
   * Contains all text generated from the start up to and including this chunk.
   */
  readonly accumulated?: string;

  readonly role?: 'assistant';
}

/**
 * Tool use chunk.
 *
 * Emitted while a backend streams a tool/function call. Backends emit one
 * chunk per provider delta:
 *
 * - `id` and `name` are ALWAYS present on every chunk. Providers that only
 *   send them on the first delta (e.g. OpenAI's index-based `tool_calls`
 *   deltas) must resolve them from accumulation state before yielding.
 * - `inputDelta` is the raw partial-JSON fragment of the tool arguments for
 *   this chunk. It is an empty string (or absent) on the initial
 *   "announce" chunk that introduces a new tool call.
 * - `index` is the zero-based position of the tool call within the message
 *   (OpenAI `tool_calls[].index`, Anthropic content-block index order).
 *   Frontend adapters use it to re-emit provider-faithful deltas; when
 *   absent, consumers may assign indices in order of first appearance.
 *
 * Consumers that want assembled tool calls rather than deltas should read
 * the final `done` chunk: its `message.content` contains one complete
 * `ToolUseContent` block (with parsed `input`) per streamed tool call, and
 * its `finishReason` is `'tool_calls'`.
 *
 * @example
 * ```typescript
 * // Announce chunk (new tool call started)
 * { type: 'tool_use', sequence: 3, id: 'call_abc', name: 'get_weather', inputDelta: '', index: 0 }
 *
 * // Argument fragments (raw partial JSON)
 * { type: 'tool_use', sequence: 4, id: 'call_abc', name: 'get_weather', inputDelta: '{"loc', index: 0 }
 * { type: 'tool_use', sequence: 5, id: 'call_abc', name: 'get_weather', inputDelta: 'ation":"SF"}', index: 0 }
 * ```
 */
export interface StreamToolUseChunk extends BaseStreamChunk {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly inputDelta?: string;

  /**
   * Zero-based position of this tool call within the assistant message.
   * Optional for backward compatibility; assigned in order of first
   * appearance when absent.
   */
  readonly index?: number;
}

/**
 * Metadata chunk (usage, etc.).
 */
export interface StreamMetadataChunk extends BaseStreamChunk {
  readonly type: 'metadata';
  readonly usage?: Partial<IRUsage>;
  readonly metadata?: Partial<IRMetadata>;
}

/**
 * Done chunk (end of stream).
 */
export interface StreamDoneChunk extends BaseStreamChunk {
  readonly type: 'done';
  readonly finishReason: FinishReason;
  readonly usage?: IRUsage;
  readonly message?: IRMessage;
}

/**
 * Error chunk.
 */
export interface StreamErrorChunk extends BaseStreamChunk {
  readonly type: 'error';
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
  };
}

/**
 * Union of all stream chunk types.
 *
 * Uses discriminated union for type-safe chunk handling.
 */
export type IRStreamChunk =
  | StreamStartChunk
  | StreamContentChunk
  | StreamToolUseChunk
  | StreamMetadataChunk
  | StreamDoneChunk
  | StreamErrorChunk;

/**
 * Async generator for streaming responses.
 *
 * Yields IR stream chunks as they arrive from the backend.
 *
 * @example
 * ```typescript
 * async function processStream(stream: IRChatStream) {
 *   for await (const chunk of stream) {
 *     switch (chunk.type) {
 *       case 'start':
 *         console.log('Stream started:', chunk.metadata.requestId);
 *         break;
 *       case 'content':
 *         process.stdout.write(chunk.delta);
 *         break;
 *       case 'done':
 *         console.log('\nStream finished:', chunk.finishReason);
 *         break;
 *       case 'error':
 *         console.error('Stream error:', chunk.error.message);
 *         break;
 *     }
 *   }
 * }
 * ```
 */
export type IRChatStream = AsyncGenerator<IRStreamChunk, void, undefined>;
