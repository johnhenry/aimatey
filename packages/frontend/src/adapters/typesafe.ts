/**
 * TypeSafe (Jev) Frontend Adapter
 *
 * Translates `@typesafe-ai/sdk`-shaped `systemOne()` calls into the
 * Universal Decision IR.
 *
 * This implements `FrontendAdapter` through its *decision* hooks
 * (`decisionToIR`/`decisionFromIR`) and deliberately not the chat ones --
 * `toIR`/`fromIR`/`fromIRStream` are optional on `FrontendAdapter` for
 * exactly this reason (a decision request is not a chat request in a
 * costume, the same reasoning `BackendAdapter.decide?` used to stay a
 * *sibling* of `execute?`). `Bridge.decideFrom()` drives these hooks;
 * `Bridge.chat()` with this frontend throws `UNSUPPORTED_FEATURE`.
 *
 * Genuinely light: `@typesafe-ai/sdk`'s own `systemOne({ state, questions
 * })` call shape *is* Jev's wire format (see
 * `packages/backend/src/providers/typesafe.ts`), and the IR was modeled on
 * that same shape — so this translation is close to the identity
 * function. Its value isn't in the mapping; it's letting someone who
 * already writes `@typesafe-ai/sdk`-shaped code point at aimatey (and,
 * once a second decision backend exists, swap providers) without
 * rewriting call sites.
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
// @typesafe-ai/sdk-shaped types
// ============================================================================

/**
 * Shape of `@typesafe-ai/sdk`'s `TypeSafeClient#systemOne()` request.
 * Identical to {@link IRDecisionQuestion}/{@link IRDecisionRequest} minus
 * `metadata` — the SDK has no concept of aimatey's provenance/warnings.
 */
export interface TypeSafeSDKRequest {
  readonly state: unknown;
  readonly questions: Record<string, IRDecisionQuestion>;
  readonly model?: string;
  /** Images to consider alongside `state` (base64), for models that take them. */
  readonly images?: IRDecisionRequest['images'];
}

/**
 * Shape of `@typesafe-ai/sdk`'s `systemOne()` response.
 *
 * `probabilities`/`confidence` are optional here because the IR's are --
 * an answer that came from a backend that never reported them (an LLM
 * emulation, say) is passed on without them rather than with a sentinel.
 */
export interface TypeSafeSDKResponse {
  readonly answers: Record<
    string,
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
    | { readonly noul: number }
  >;
  readonly model: string;
}

export class TypeSafeFrontendAdapter
  implements FrontendAdapter<TypeSafeSDKRequest, TypeSafeSDKResponse>
{
  readonly metadata: AdapterMetadata = {
    name: 'typesafe-frontend',
    version: '1.0.0',
    provider: 'TypeSafe',
    capabilities: {
      // Chat-shaped fields don't apply -- see the backend adapter's
      // identical comment on why these are still required fields.
      streaming: false,
      multiModal: false,
      tools: false,
      systemMessageStrategy: 'not-supported',
      supportsMultipleSystemMessages: false,
      decisions: true,
    },
  };

  /**
   * Convert an `@typesafe-ai/sdk`-shaped `systemOne()` call into a
   * Universal Decision IR request.
   */
  decisionToIR(request: TypeSafeSDKRequest): Promise<IRDecisionRequest> {
    return Promise.resolve({
      state: request.state,
      questions: request.questions,
      ...(request.images && { images: request.images }),
      parameters: request.model ? { model: request.model } : undefined,
      metadata: {
        requestId: 'typesafe-' + Date.now(),
        timestamp: Date.now(),
        provenance: { frontend: this.metadata.name },
      },
    });
  }

  /**
   * Convert a Universal Decision IR response back into
   * `@typesafe-ai/sdk`'s `systemOne()` response shape.
   */
  decisionFromIR(response: IRDecisionResponse): Promise<TypeSafeSDKResponse> {
    const answers: TypeSafeSDKResponse['answers'] = {};
    for (const [name, answer] of Object.entries(response.answers)) {
      answers[name] = toSDKAnswer(answer);
    }
    return Promise.resolve({ answers, model: response.model });
  }
}

function toSDKAnswer(answer: IRDecisionAnswer): TypeSafeSDKResponse['answers'][string] {
  switch (answer.type) {
    case 'choice':
      return {
        choice: answer.value,
        ...(answer.probabilities !== undefined && { probabilities: answer.probabilities }),
        ...(answer.confidence !== undefined && { confidence: answer.confidence }),
      };
    case 'score':
      return {
        score: answer.value,
        ...(answer.probabilities !== undefined && { probabilities: answer.probabilities }),
        ...(answer.confidence !== undefined && { confidence: answer.confidence }),
      };
    case 'noul':
      return { noul: answer.value };
  }
}
