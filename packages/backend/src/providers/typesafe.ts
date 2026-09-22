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

import type {
  BackendAdapter,
  ApiKeyBackendAdapterConfig,
  AdapterMetadata,
  IRDecisionRequest,
  IRDecisionResponse,
  IRDecisionQuestion,
  IRDecisionAnswer,
} from '@johnhenry/aimatey-types';
import {
  NetworkError,
  ProviderError,
  ErrorCode,
  createErrorFromHttpResponse,
} from '@johnhenry/aimatey-errors';
import { registerModels } from '@johnhenry/aimatey-utils';

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
      readonly probabilities: Record<string, number>;
      readonly confidence: number;
    }
  | {
      readonly score: number;
      readonly probabilities: readonly number[];
      readonly confidence: number;
    }
  | { readonly noul: number };

export interface TypeSafeResponse {
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

    registerModels([
      {
        id: 'jev-1.13.0',
        provider: 'typesafe',
        family: 'jev',
        kind: 'decision',
        aliases: ['jev-latest'],
        // Output tokens are free -- see IRDecisionUsage's own doc comment
        // for why decision usage isn't shoehorned into chat's IRUsage.
        pricing: { inputPer1M: 0.042, outputPer1M: 0 },
        contextWindow: 64_000,
      },
    ]);
  }

  /**
   * Convert IR decision request to TypeSafe's wire format.
   *
   * Not part of `BackendAdapter` (that interface's `fromIR`/`toIR` are
   * chat-typed and optional) — a plain method the adapter uses internally
   * and exposes for the same debugging/testing reasons `fromIR` exists on
   * chat backends.
   */
  public decisionFromIR(request: IRDecisionRequest): TypeSafeRequest {
    return {
      state: request.state,
      questions: request.questions,
      model: request.parameters?.model,
    };
  }

  /**
   * Convert TypeSafe's response to IR, mapping each answer to the
   * discriminated {@link IRDecisionAnswer} shape by the question's own
   * `type` (the wire response doesn't repeat it, unlike the request).
   */
  public decisionToIR(
    response: TypeSafeResponse,
    originalRequest: IRDecisionRequest
  ): IRDecisionResponse {
    const answers: Record<string, IRDecisionAnswer> = {};

    for (const [name, question] of Object.entries(originalRequest.questions)) {
      const raw = response.answers[name];
      if (!raw) {
        continue; // Provider omitted an answer -- surfaced by validation upstream, not here.
      }
      answers[name] = toIRAnswer(question, raw, name, this.metadata.name);
    }

    return {
      answers,
      model: response.model,
      usage: response.usage
        ? {
            inputTokens: response.usage.input_tokens ?? 0,
            details: response.usage.cost !== undefined ? { cost: response.usage.cost } : undefined,
          }
        : undefined,
      metadata: {
        ...originalRequest.metadata,
        provenance: {
          ...originalRequest.metadata.provenance,
          backend: this.metadata.name,
        },
      },
      raw: response as unknown as Record<string, unknown>,
    };
  }

  /**
   * Answer a typed-decision request via Jev's `/systemone` endpoint.
   */
  async decide(request: IRDecisionRequest, signal?: AbortSignal): Promise<IRDecisionResponse> {
    try {
      const typesafeRequest = this.decisionFromIR(request);

      const response = await fetch(`${this.baseURL}/systemone`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(typesafeRequest),
        signal,
      });

      if (!response.ok) {
        throw createErrorFromHttpResponse(
          response.status,
          response.statusText,
          await response.text(),
          { backend: this.metadata.name }
        );
      }

      const data = (await response.json()) as TypeSafeResponse;
      return this.decisionToIR(data, request);
    } catch (error) {
      if (error instanceof NetworkError || error instanceof ProviderError) {
        throw error;
      }

      throw new ProviderError({
        code: ErrorCode.PROVIDER_ERROR,
        message: `TypeSafe request failed: ${error instanceof Error ? error.message : String(error)}`,
        isRetryable: true,
        provenance: { backend: this.metadata.name },
        cause: error instanceof Error ? error : undefined,
      });
    }
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

// ============================================================================
// Response Mapping
// ============================================================================

function toIRAnswer(
  question: IRDecisionQuestion,
  raw: TypeSafeAnswer,
  name: string,
  backendName: string
): IRDecisionAnswer {
  if (question.type === 'choice' && 'choice' in raw) {
    return {
      type: 'choice',
      value: raw.choice,
      probabilities: raw.probabilities,
      confidence: raw.confidence,
    };
  }
  if (question.type === 'score' && 'score' in raw) {
    return {
      type: 'score',
      value: raw.score,
      probabilities: raw.probabilities,
      confidence: raw.confidence,
    };
  }
  if (question.type === 'noul' && 'noul' in raw) {
    return { type: 'noul', value: raw.noul };
  }

  throw new ProviderError({
    code: ErrorCode.PROVIDER_ERROR,
    message: `TypeSafe answered question '${name}' (type '${question.type}') with a response shape that doesn't match: ${JSON.stringify(raw)}`,
    isRetryable: false,
    provenance: { backend: backendName },
  });
}
