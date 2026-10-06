/**
 * Decision Types
 *
 * IR types for "System One" typed-decision models (TypeSafe's Jev,
 * ConvAI's Laya, and similar): given a state (text, JSON, an email, a
 * ticket) and a set of typed questions, the model returns typed answers
 * with calibrated probabilities in a single forward pass — no generated
 * text, nothing to parse, nothing to hallucinate.
 *
 * This is not a variant of chat completion. It mirrors the chat IR's
 * shape (a universal request/response pair sharing {@link IRMetadata},
 * executed by backend adapters that opt in via an optional method) the
 * same way `embeddings.ts` does, but the request/response bodies here are
 * unrelated to `IRChatRequest`/`IRChatResponse` — there is no message
 * list, no streaming, no finish reason.
 *
 * @module
 */

import type { IRMetadata, ImageContent } from './ir.js';

// ============================================================================
// Questions
// ============================================================================

/**
 * A single typed question asked of a decision request's `state`.
 *
 * Three primitives, matching the vocabulary both Jev and Laya use natively
 * (kept as-is rather than renamed, so a backend adapter's translation is a
 * near-identity mapping rather than another naming layer to get wrong):
 *
 * - `choice`: pick one option from a labeled set (up to ~255 options).
 * - `score`: place the state on an ordered spectrum of 2-10 labeled levels.
 * - `noul`: a yes/no question answered as a calibrated probability, not a
 *   boolean — the model's confidence *is* the answer, not a side channel
 *   on it.
 *
 * Discriminated on `type`, matching every other discriminated union in the
 * IR ({@link MessageContent}, {@link IRStreamChunk}).
 */
export type IRDecisionQuestion =
  | {
      readonly type: 'choice';
      readonly instructions: string;
      /** Option name -> human-readable description of when it applies. */
      readonly criteria: Record<string, string>;
    }
  | {
      readonly type: 'score';
      readonly instructions: string;
      /** Ordered levels, low to high (e.g. `['calm', 'frustrated', 'furious']`). */
      readonly criteria: readonly string[];
    }
  | {
      readonly type: 'noul';
      readonly instructions: string;
      /**
       * Labels for each side of the yes/no question (OpenRouter, Vercel
       * and Ollama accept them). Pinning what `true` and `false` *mean*
       * here, rather than only in `instructions`, is the mitigation for
       * option-name bias that the literature recommends.
       */
      readonly criteria?: {
        readonly true: string;
        readonly false: string;
      };
    };

// ============================================================================
// Request
// ============================================================================

/**
 * Normalized parameters for a decision request.
 */
export interface IRDecisionParameters {
  /** Model identifier (falls back to the backend's default). */
  readonly model?: string;

  /** Provider-specific passthrough parameters. */
  readonly custom?: Record<string, unknown>;
}

/**
 * Universal typed-decision request.
 *
 * @example
 * ```typescript
 * const request: IRDecisionRequest = {
 *   state: { subject: 'Duplicate charge', body: 'Please refund me today.' },
 *   questions: {
 *     department: {
 *       type: 'choice',
 *       instructions: 'Which team should handle this?',
 *       criteria: { billing: 'invoices, refunds', technical: 'bugs, outages' },
 *     },
 *     refundRequested: { type: 'noul', instructions: 'Does the user request a refund?' },
 *   },
 *   metadata: { requestId: 'req_abc123', timestamp: Date.now() },
 * };
 * ```
 */
export interface IRDecisionRequest {
  /**
   * The state being evaluated. Text, a structured object, or an array —
   * both Jev and Laya accept arbitrary JSON here, so the IR does not
   * constrain it further than "serializable".
   */
  readonly state: unknown;

  /** Named questions to ask of `state`. Answered positionally by name. */
  readonly questions: Record<string, IRDecisionQuestion>;

  /**
   * Images to consider alongside `state`. Base64 sources are what providers
   * accept in practice; check `capabilities.decisionImages` and
   * `decisionLimits.maxImages` first -- a backend that cannot take images
   * warns (`capability-unsupported`) and drops them.
   */
  readonly images?: readonly ImageContent[];

  readonly parameters?: IRDecisionParameters;

  /** Request metadata (requestId, provenance, warnings). */
  readonly metadata: IRMetadata;
}

// ============================================================================
// Response
// ============================================================================

/**
 * A single typed answer, shaped by which question primitive produced it.
 *
 * `probabilities` is the full distribution over `criteria` (`choice`:
 * per-option; `score`: per-level); `confidence` is how concentrated that
 * distribution is, `1 - H(p) / ln(n)` with `H` the Shannon entropy (1 for a
 * one-hot distribution, 0 for a uniform one; `decisionConfidence()` and
 * `noulConfidence()` in `@johnhenry/aimatey-utils`). It is not the winning
 * option's probability and not accuracy. A provider that reports its own
 * `confidence` (Jev, Ollama, Laya) is passed through as reported.
 * **Both are optional** on `choice` and `score`: OpenRouter's schema marks
 * them optional, and an answer produced by an LLM through structured output has neither. Absence means "the
 * provider did not report it" -- there is no sentinel value such as
 * `confidence: 0`, so consumers must handle `undefined`.
 *
 * Both are omitted for `noul`, where the probability itself *is* the answer
 * -- but `confidence` alone is still a real, separate quantity there
 * (the concentration of `[p, 1-p]`, i.e. distance from a coin flip, not the
 * same number as `value`):
 * Jev's wire format doesn't report it, Laya's does, so it's optional rather
 * than absent -- a provider that has it should not have to throw it away to
 * fit this type.
 *
 * Every variant may carry `reasoning`, free text from providers that
 * explain themselves (LLM emulation, "thinking" decision models). Never
 * required.
 */
export type IRDecisionAnswer =
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
      /** Calibrated probability that the answer is "yes", in `[0, 1]`. */
      readonly value: number;
      /**
       * `max(value, 1 - value)` -- how far the answer sits from a coin
       * flip, as opposed to `value` itself (which side it landed on).
       * Optional: not every provider reports it (Jev doesn't; Laya does).
       */
      readonly confidence?: number;
      readonly reasoning?: string;
    };

/**
 * Token usage for a decision request. Output tokens are typically free
 * (Jev's pricing has no output-token cost), unlike chat's
 * {@link IRUsage} — kept as a separate shape rather than reusing `IRUsage`
 * so a zero/absent `completionTokens` is never mistaken for a real
 * chat-shaped measurement.
 */
export interface IRDecisionUsage {
  readonly inputTokens: number;
  /** Output tokens, when the provider reports them (often 0: decisions generate none). */
  readonly outputTokens?: number;
  /** Cost of the call in USD, when the provider reports it. */
  readonly cost?: number;
  readonly details?: Record<string, unknown>;
}

/**
 * Universal typed-decision response.
 */
export interface IRDecisionResponse {
  /** Provider's response identifier (e.g. OpenRouter's decision id), when it sends one. */
  readonly id?: string;

  /** Provider that actually served the request, when the API is a gateway (OpenRouter, Vercel). */
  readonly provider?: string;

  /** Answers, keyed by the same names as the request's `questions`. */
  readonly answers: Record<string, IRDecisionAnswer>;

  /** Model that actually answered, as the provider reported it. */
  readonly model: string;

  readonly usage?: IRDecisionUsage;

  /** Response metadata (provenance, warnings). */
  readonly metadata: IRMetadata;

  /** Provider-specific response data. */
  readonly raw?: Record<string, unknown>;
}

// ============================================================================
// Bridge Decision API
// ============================================================================

/**
 * Options for `Bridge.decide()`.
 */
export interface DecisionOptions {
  readonly model?: string;

  /** Abort signal. */
  readonly signal?: AbortSignal;

  /** Extra metadata merged into the request's custom metadata. */
  readonly metadata?: Record<string, unknown>;

  /**
   * Caller this request is made on behalf of; becomes
   * `metadata.principal` on the IR request. See {@link IRMetadata.principal}.
   */
  readonly principal?: string;

  /** Provider-specific passthrough parameters. */
  readonly custom?: Record<string, unknown>;
}

/**
 * Middleware for decision requests.
 *
 * A lightweight functional chain, separate from the chat middleware stack
 * (whose context types are chat-specific) — same reasoning as
 * {@link EmbedMiddleware}. Registered via `bridge.useDecision()`; runs
 * outermost-first.
 */
export type DecisionMiddleware = (
  request: IRDecisionRequest,
  next: (request: IRDecisionRequest) => Promise<IRDecisionResponse>
) => Promise<IRDecisionResponse>;
