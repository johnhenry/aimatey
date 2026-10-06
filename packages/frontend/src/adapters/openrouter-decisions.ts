/**
 * OpenRouter Decisions Frontend Adapter
 *
 * Translates OpenRouter's `/api/alpha/decisions` request/response shapes into
 * the Universal Decision IR. Like `TypeSafeFrontendAdapter`, it implements
 * `FrontendAdapter` through its decision hooks only; drive it with
 * `Bridge.decideFrom()`.
 *
 * It is System One plus an envelope (mirrors the `openrouter` entry of
 * `SYSTEMONE_DIALECTS` in `packages/backend/src/decisions/systemone-client.ts`;
 * the frontend must not depend on the backend package, so the mapping is
 * copied here -- keep the two in step):
 *
 * - Request: `provider` (routing preferences), `trace`, `session_id` and
 *   `user` ride alongside `state`/`questions`; here they travel in
 *   `parameters.custom` (`provider`, `trace`, `sessionId`, `user`), which is
 *   exactly where the backend client reads them.
 * - Questions use the canonical `noul`/`choice`/`score` types; `noul` takes
 *   `criteria { true, false }`.
 * - Response: `id`, `provider` and `usage.cost` envelope fields, and
 *   `probabilities`/`confidence` optional on every answer.
 * - As in Laya's shape, `score` probabilities are an object keyed by
 *   stringified level index, with a `legend` (index -> label) from the
 *   question's own `criteria`.
 *
 * @module
 */

import type {
  AdapterMetadata,
  FrontendAdapter,
  IRDecisionRequest,
  IRDecisionResponse,
  IRDecisionQuestion,
  IRDecisionAnswer,
} from '@johnhenry/aimatey-types';

// ============================================================================
// OpenRouter-shaped types
// ============================================================================

/** Shape of a `POST /api/alpha/decisions` body. */
export interface OpenRouterDecisionsRequest {
  readonly model: string;
  readonly state: unknown;
  readonly questions: Record<string, IRDecisionQuestion>;
  /** Provider routing preferences (`order`, `allow_fallbacks`, ...), opaque here. */
  readonly provider?: Record<string, unknown>;
  readonly trace?: Record<string, unknown>;
  readonly session_id?: string;
  readonly user?: string;
}

/** A single answer, as the decisions endpoint returns it. */
export type OpenRouterDecisionAnswer =
  | {
      readonly type: 'choice';
      readonly choice: string;
      readonly confidence?: number;
      readonly probabilities?: Record<string, number>;
    }
  | {
      readonly type: 'score';
      readonly score: number;
      readonly confidence?: number;
      /** Keyed by stringified level index. */
      readonly probabilities?: Record<string, number>;
      /** Level index (stringified) -> label, from the question's `criteria`. */
      readonly legend?: Record<string, string>;
    }
  | {
      readonly type: 'noul';
      readonly noul: number;
      readonly confidence?: number;
    };

/** Shape of a `POST /api/alpha/decisions` response. */
export interface OpenRouterDecisionsResponse {
  readonly id?: string;
  readonly model: string;
  readonly provider?: string;
  readonly answers: Record<string, OpenRouterDecisionAnswer>;
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cost?: number;
  };
}

// ============================================================================
// Adapter
// ============================================================================

export class OpenRouterDecisionsFrontendAdapter implements FrontendAdapter<
  OpenRouterDecisionsRequest,
  OpenRouterDecisionsResponse
> {
  readonly metadata: AdapterMetadata = {
    name: 'openrouter-decisions-frontend',
    version: '1.0.0',
    provider: 'OpenRouter',
    capabilities: {
      streaming: false,
      multiModal: false,
      tools: false,
      systemMessageStrategy: 'not-supported',
      supportsMultipleSystemMessages: false,
      decisions: true,
    },
  };

  /** Convert an `/api/alpha/decisions` body into a Universal Decision IR request. */
  decisionToIR(request: OpenRouterDecisionsRequest): Promise<IRDecisionRequest> {
    const custom: Record<string, unknown> = {
      ...(request.provider !== undefined && { provider: request.provider }),
      ...(request.trace !== undefined && { trace: request.trace }),
      ...(request.session_id !== undefined && { sessionId: request.session_id }),
      ...(request.user !== undefined && { user: request.user }),
    };

    return Promise.resolve({
      state: request.state,
      questions: request.questions,
      parameters: {
        model: request.model,
        ...(Object.keys(custom).length > 0 && { custom }),
      },
      metadata: {
        requestId: 'openrouter-decisions-' + Date.now(),
        timestamp: Date.now(),
        provenance: { frontend: this.metadata.name },
      },
    });
  }

  /**
   * Convert a Universal Decision IR response into an `/api/alpha/decisions`
   * response. `originalRequest` supplies the `score` questions' `criteria`
   * for `legend`; without it the legend falls back to numeric-string labels
   * (the same honest degradation `LayaFrontendAdapter` makes).
   */
  decisionFromIR(
    response: IRDecisionResponse,
    originalRequest?: IRDecisionRequest
  ): Promise<OpenRouterDecisionsResponse> {
    const answers: Record<string, OpenRouterDecisionAnswer> = {};
    for (const [name, answer] of Object.entries(response.answers)) {
      answers[name] = toOpenRouterAnswer(answer, originalRequest?.questions[name]);
    }

    return Promise.resolve({
      ...(response.id !== undefined && { id: response.id }),
      model: response.model,
      ...(response.provider !== undefined && { provider: response.provider }),
      answers,
      usage: {
        input_tokens: response.usage?.inputTokens ?? 0,
        output_tokens: response.usage?.outputTokens ?? 0,
        ...(response.usage?.cost !== undefined && { cost: response.usage.cost }),
      },
    });
  }
}

function toOpenRouterAnswer(
  answer: IRDecisionAnswer,
  question?: IRDecisionQuestion
): OpenRouterDecisionAnswer {
  switch (answer.type) {
    case 'choice':
      return {
        type: 'choice',
        choice: answer.value,
        ...(answer.confidence !== undefined && { confidence: answer.confidence }),
        ...(answer.probabilities !== undefined && { probabilities: answer.probabilities }),
      };
    case 'score': {
      const criteria = question?.type === 'score' ? question.criteria : undefined;
      const levels = criteria?.length ?? answer.probabilities?.length ?? 0;
      const legend: Record<string, string> = {};
      for (let i = 0; i < levels; i++) {
        legend[String(i)] = criteria?.[i] ?? String(i);
      }
      let probabilities: Record<string, number> | undefined;
      if (answer.probabilities) {
        probabilities = {};
        answer.probabilities.forEach((p, i) => {
          probabilities![String(i)] = p;
        });
      }
      return {
        type: 'score',
        score: answer.value,
        ...(levels > 0 && { legend }),
        ...(probabilities && { probabilities }),
        ...(answer.confidence !== undefined && { confidence: answer.confidence }),
      };
    }
    case 'noul':
      return {
        type: 'noul',
        noul: answer.value,
        ...(answer.confidence !== undefined && { confidence: answer.confidence }),
      };
  }
}
