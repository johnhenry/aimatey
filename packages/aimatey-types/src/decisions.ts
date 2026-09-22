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

import type { IRMetadata } from './ir.js';

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
 * `probabilities` is the full distribution over `criteria`
 * (`choice`: per-option; `score`: per-level); `confidence` is the
 * probability mass on the winning answer specifically. Both are omitted
 * for `noul`, where the probability itself *is* the answer — there is no
 * separate "confidence in the yes/no" to report.
 */
export type IRDecisionAnswer =
  | {
      readonly type: 'choice';
      /** The selected option name (a key of the question's `criteria`). */
      readonly value: string;
      readonly probabilities: Record<string, number>;
      readonly confidence: number;
    }
  | {
      readonly type: 'score';
      /** Index (may be fractional) into the question's ordered `criteria`. */
      readonly value: number;
      readonly probabilities: readonly number[];
      readonly confidence: number;
    }
  | {
      readonly type: 'noul';
      /** Calibrated probability that the answer is "yes", in `[0, 1]`. */
      readonly value: number;
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
  readonly details?: Record<string, unknown>;
}

/**
 * Universal typed-decision response.
 */
export interface IRDecisionResponse {
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
