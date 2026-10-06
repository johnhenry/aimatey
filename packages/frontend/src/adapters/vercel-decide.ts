/**
 * Vercel AI SDK `decide()` Frontend Adapter
 *
 * Translates the request/response shapes of the AI SDK's experimental
 * `decide()` (the decision-model counterpart of `generateText`, served by
 * the Vercel AI Gateway's `/v1/evaluate`) into the Universal Decision IR.
 *
 * Like `TypeSafeFrontendAdapter`, this implements `FrontendAdapter` through
 * its decision hooks only (`decisionToIR`/`decisionFromIR`); drive it with
 * `Bridge.decideFrom()`.
 *
 * Differences from the IR, mirrored from the `vercel-evaluate` entry of
 * `SYSTEMONE_DIALECTS` in `packages/backend/src/decisions/systemone-client.ts`
 * (the frontend must not depend on the backend package, so the small table is
 * copied here -- keep the two in step):
 *
 * - The yes/no question type is `boolean` (IR: `noul`), and its answer is
 *   `{ type: 'boolean', probability }` (IR: `value`).
 * - Usage is camelCase (`inputTokens`/`outputTokens`) and the answered model
 *   is `response.modelId`.
 * - Gateway routing details come back under `providerMetadata.gateway`.
 *
 * Lossy on the way out: a `boolean` answer carries no `confidence` or
 * `reasoning` on this shape, so those IR fields are dropped.
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
// AI SDK `decide()`-shaped types
// ============================================================================

/** A single question, as `decide({ questions })` takes it. */
export type VercelDecideQuestion =
  | {
      readonly type: 'boolean';
      readonly instructions: string;
      /** What `true` and `false` mean here (pins the sides against option-name bias). */
      readonly criteria?: { readonly true: string; readonly false: string };
    }
  | {
      readonly type: 'choice';
      readonly instructions: string;
      readonly criteria: Record<string, string>;
    }
  | {
      readonly type: 'score';
      readonly instructions: string;
      readonly criteria: readonly string[];
    };

/** Shape of an AI SDK `decide()` call's options (the serializable part). */
export interface VercelDecideRequest {
  readonly model?: string;
  readonly state: unknown;
  readonly questions: Record<string, VercelDecideQuestion>;
  /** Provider-keyed options, passed through to the backend as `parameters.custom.providerOptions`. */
  readonly providerOptions?: Record<string, Record<string, unknown>>;
}

/** A single answer, as `decide()` returns it. */
export type VercelDecideAnswer =
  | { readonly type: 'boolean'; readonly probability: number }
  | {
      readonly type: 'choice';
      readonly choice: string;
      readonly probabilities?: Record<string, number>;
      readonly confidence?: number;
    }
  | {
      readonly type: 'score';
      readonly score: number;
      /** Keyed by level label (the question's `criteria`), or by index when the question is unknown. */
      readonly probabilities?: Record<string, number>;
      readonly confidence?: number;
    };

/** Shape of an AI SDK `decide()` result. */
export interface VercelDecideResponse {
  readonly answers: Record<string, VercelDecideAnswer>;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly response: { readonly modelId: string };
  readonly providerMetadata?: { readonly gateway?: Record<string, unknown> };
}

// ============================================================================
// Adapter
// ============================================================================

export class VercelDecideFrontendAdapter implements FrontendAdapter<
  VercelDecideRequest,
  VercelDecideResponse
> {
  readonly metadata: AdapterMetadata = {
    name: 'vercel-decide-frontend',
    version: '1.0.0',
    provider: 'Vercel AI SDK',
    capabilities: {
      streaming: false,
      multiModal: false,
      tools: false,
      systemMessageStrategy: 'not-supported',
      supportsMultipleSystemMessages: false,
      decisions: true,
    },
  };

  /** Convert an AI SDK `decide()` call into a Universal Decision IR request. */
  decisionToIR(request: VercelDecideRequest): Promise<IRDecisionRequest> {
    const questions: Record<string, IRDecisionQuestion> = {};
    for (const [name, question] of Object.entries(request.questions)) {
      questions[name] = toIRQuestion(question);
    }

    return Promise.resolve({
      state: request.state,
      questions,
      parameters: {
        ...(request.model !== undefined && { model: request.model }),
        ...(request.providerOptions !== undefined && {
          custom: { providerOptions: request.providerOptions },
        }),
      },
      metadata: {
        requestId: 'vercel-decide-' + Date.now(),
        timestamp: Date.now(),
        provenance: { frontend: this.metadata.name },
      },
    });
  }

  /**
   * Convert a Universal Decision IR response into an AI SDK `decide()` result.
   *
   * `originalRequest` is optional; with it, `score` probabilities are keyed by
   * level label, without it by level index.
   */
  decisionFromIR(
    response: IRDecisionResponse,
    originalRequest?: IRDecisionRequest
  ): Promise<VercelDecideResponse> {
    const answers: Record<string, VercelDecideAnswer> = {};
    for (const [name, answer] of Object.entries(response.answers)) {
      answers[name] = toVercelAnswer(answer, originalRequest?.questions[name]);
    }

    const gateway = gatewayMetadata(response);
    return Promise.resolve({
      answers,
      usage: {
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
      },
      response: { modelId: response.model },
      ...(gateway && { providerMetadata: { gateway } }),
    });
  }
}

function toIRQuestion(question: VercelDecideQuestion): IRDecisionQuestion {
  if (question.type === 'boolean') {
    return {
      type: 'noul',
      instructions: question.instructions,
      ...(question.criteria && { criteria: question.criteria }),
    };
  }
  return question;
}

function toVercelAnswer(
  answer: IRDecisionAnswer,
  question?: IRDecisionQuestion
): VercelDecideAnswer {
  switch (answer.type) {
    case 'noul':
      return { type: 'boolean', probability: answer.value };
    case 'choice':
      return {
        type: 'choice',
        choice: answer.value,
        ...(answer.probabilities !== undefined && { probabilities: answer.probabilities }),
        ...(answer.confidence !== undefined && { confidence: answer.confidence }),
      };
    case 'score': {
      const levels = question?.type === 'score' ? question.criteria : undefined;
      let probabilities: Record<string, number> | undefined;
      if (answer.probabilities) {
        probabilities = {};
        answer.probabilities.forEach((p, i) => {
          probabilities![levels?.[i] ?? String(i)] = p;
        });
      }
      return {
        type: 'score',
        score: answer.value,
        ...(probabilities && { probabilities }),
        ...(answer.confidence !== undefined && { confidence: answer.confidence }),
      };
    }
  }
}

/** `raw.providerMetadata.gateway` when the backend relayed one, plus the serving provider if known. */
function gatewayMetadata(response: IRDecisionResponse): Record<string, unknown> | undefined {
  const rawMeta = response.raw?.providerMetadata;
  const rawGateway =
    typeof rawMeta === 'object' && rawMeta !== null
      ? (rawMeta as Record<string, unknown>).gateway
      : undefined;
  const base =
    typeof rawGateway === 'object' && rawGateway !== null && !Array.isArray(rawGateway)
      ? (rawGateway as Record<string, unknown>)
      : undefined;

  if (response.provider === undefined) {
    return base;
  }
  return { provider: response.provider, ...base };
}
