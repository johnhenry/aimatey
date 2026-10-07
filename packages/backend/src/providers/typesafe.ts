/**
 * TypeSafe (Jev) Backend Adapter
 *
 * Adapts the Universal Decision IR to TypeSafe's Jev API — a "System One"
 * typed-decision model, not a chat model. This adapter implements only
 * `metadata` and `decide()`; it deliberately does not implement
 * `fromIR`/`toIR`/`execute`/`executeStream` (all optional on
 * `BackendAdapter` precisely so a decision-only backend isn't forced to
 * fake a chat capability it doesn't have — see `decide?` on
 * `BackendAdapter` in `@johnhenry/aimatey-types`).
 *
 * @see https://typesafe.ai
 * @module
 */

import { localityForBaseURL, servedByForBaseURL } from '@johnhenry/aimatey-utils';
import type {
  BackendAdapter,
  ApiKeyBackendAdapterConfig,
  AdapterMetadata,
  IRDecisionRequest,
  IRDecisionResponse,
  IRDecisionQuestion,
} from '@johnhenry/aimatey-types';
import {
  buildImageDroppedWarning,
  buildSystemOneRequest,
  decideViaSystemOne,
  parseSystemOneResponse,
} from '../decisions/systemone-client.js';

// ============================================================================
// TypeSafe (Jev) API Types
// ============================================================================

/**
 * A question as TypeSafe's wire format expects it. Structurally identical
 * to {@link IRDecisionQuestion} — Jev's own vocabulary (`choice`/`score`/
 * `noul`) is what the IR type was modeled on, so this mapping is a
 * near-identity, not a translation.
 */
export type TypeSafeQuestion = IRDecisionQuestion;

export interface TypeSafeRequest {
  readonly state: unknown;
  readonly questions: Record<string, TypeSafeQuestion>;
  readonly model?: string;
}

export type TypeSafeAnswer =
  | {
      readonly choice: string;
      readonly probabilities?: Record<string, number>;
      readonly confidence?: number;
    }
  | {
      readonly score: number;
      readonly probabilities?: readonly number[];
      readonly confidence?: number;
    }
  | { readonly noul: number };

export interface TypeSafeResponse {
  readonly id?: string;
  readonly answers: Record<string, TypeSafeAnswer>;
  readonly model: string;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cost?: number;
  };
}

// ============================================================================
// TypeSafe (Jev) Backend Adapter
// ============================================================================

/**
 * Backend adapter for TypeSafe's Jev typed-decision API.
 *
 * Features:
 * - Typed decisions (`choice`/`score`/`noul`) over arbitrary state, not chat
 * - 70-500ms latency; no streaming (a decision is one shot, not a token stream)
 * - Pricing is input-token-only (`jev-1.13.0`: $0.042/1M input, output free)
 */
export class TypeSafeBackendAdapter implements BackendAdapter<TypeSafeRequest, TypeSafeResponse> {
  readonly metadata: AdapterMetadata;
  private readonly config: ApiKeyBackendAdapterConfig;
  private readonly baseURL: string;

  constructor(config: ApiKeyBackendAdapterConfig) {
    this.config = config;
    this.baseURL = config.baseURL || 'https://api.typesafe.ai/v1';
    this.metadata = {
      name: 'typesafe-backend',
      version: '1.0.0',
      provider: 'TypeSafe',
      capabilities: {
        decisions: true,
        decisionModels: ['jev-1.13.0', 'jev-latest'],
        decisionTypes: ['choice', 'score', 'noul'],
        decisionImages: false,
        decisionLimits: {
          maxChoiceOptions: 255,
          maxScoreLevels: 10,
          maxStateTokens: 32_000,
          maxImages: 0,
        },
        // Chat-shaped fields don't apply to a decision-only backend --
        // `streaming`/`multiModal`/`tools` are all correctly `false`, and
        // `systemMessageStrategy` is 'not-supported' rather than omitted,
        // matching the family's other required-field conventions.
        streaming: false,
        multiModal: false,
        tools: false,
        systemMessageStrategy: 'not-supported',
        supportsMultipleSystemMessages: false,
      },
      config: {
        baseURL: this.baseURL,
      },
    };
  }

  /**
   * Convert IR decision request to TypeSafe's wire format.
   *
   * Not part of `BackendAdapter` (that interface's `fromIR`/`toIR` are
   * chat-typed and optional) -- a plain method the adapter uses internally
   * and exposes for the same debugging/testing reasons `fromIR` exists on
   * chat backends. Delegates to the shared System One client.
   */
  public decisionFromIR(request: IRDecisionRequest): TypeSafeRequest {
    return buildSystemOneRequest(request, { dialect: 'systemone' }) as unknown as TypeSafeRequest;
  }

  /**
   * Convert TypeSafe's response to IR via the shared System One client.
   * Throws if a question is unanswered or answered with the wrong shape.
   */
  public decisionToIR(
    response: TypeSafeResponse,
    originalRequest: IRDecisionRequest
  ): IRDecisionResponse {
    return parseSystemOneResponse(response, originalRequest, {
      dialect: 'systemone',
      backendName: this.metadata.name,
      provider: 'typesafe',
      warnings: buildImageDroppedWarning(originalRequest, this.metadata.name, 'Jev'),
      locality: localityForBaseURL(this.baseURL),
      servedBy: servedByForBaseURL(this.baseURL),
    });
  }

  /**
   * Answer a typed-decision request via Jev's `/systemone` endpoint.
   */
  decide(request: IRDecisionRequest, signal?: AbortSignal): Promise<IRDecisionResponse> {
    return decideViaSystemOne(request, {
      url: `${this.baseURL}/systemone`,
      dialect: 'systemone',
      headers: this.getHeaders(),
      signal,
      backendName: this.metadata.name,
      provider: 'typesafe',
      // Jev takes no images: dropped here, with a warning on the response.
      warnings: buildImageDroppedWarning(request, this.metadata.name, 'Jev'),
      locality: localityForBaseURL(this.baseURL),
      servedBy: servedByForBaseURL(this.baseURL),
    });
  }

  /**
   * Estimate cost from Jev's flat, input-token-only pricing.
   *
   * Cannot estimate input tokens ahead of the call the way chat backends
   * estimate prompt tokens (`estimateTokens()` in `../shared.ts` counts
   * message text; a decision `state` may be an arbitrary JSON object with
   * no comparable token-counting heuristic in this package), so this
   * returns `null` until the request has actually been made -- the real
   * `usage.cost` Jev reports is on the response, not estimable in advance.
   */
  estimateDecisionCost(_request: IRDecisionRequest): Promise<number | null> {
    return Promise.resolve(null);
  }

  /**
   * Get HTTP headers. TypeSafe uses `Authorization: Bearer <key>`, same as
   * every other bearer-token backend in this package.
   */
  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
      ...this.config.headers,
    };
  }

  /**
   * Health check: a real `decide()` call with a trivial question is the
   * only meaningful check TypeSafe's API offers -- there is no separate
   * key-verification endpoint the way Cohere's `/check-api-key` is.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseURL}/systemone`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          state: 'health check',
          questions: { ok: { type: 'noul', instructions: 'Is this a health check?' } },
        } satisfies TypeSafeRequest),
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
