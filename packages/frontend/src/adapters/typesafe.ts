/**
 * TypeSafe (Jev) Frontend Adapter
 *
 * Translates `@typesafe-ai/sdk`-shaped `systemOne()` calls into the
 * Universal Decision IR.
 *
 * This is deliberately **not** an implementation of `FrontendAdapter` from
 * `@johnhenry/aimatey-types` — that interface's `toIR`/`fromIR`/
 * `fromIRStream` are hard-typed to `IRChatRequest`/`IRChatResponse`/
 * `IRChatStream`, and a decision request is not a chat request wearing a
 * costume. Rather than widen a chat-shaped interface to accommodate one
 * new capability (the same reasoning `BackendAdapter.decide?` used to stay
 * a *sibling* of `execute?`, not a variant of it), this is a small,
 * standalone class with the same translation-adapter shape and spirit.
 * If a second non-chat frontend shows up later, generalizing
 * `FrontendAdapter` becomes worth it; one doesn't justify it yet.
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
}

/**
 * Shape of `@typesafe-ai/sdk`'s `systemOne()` response.
 */
export interface TypeSafeSDKResponse {
  readonly answers: Record<
    string,
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
    | { readonly noul: number }
  >;
  readonly model: string;
}

export class TypeSafeFrontendAdapter {
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
  toIR(request: TypeSafeSDKRequest): Promise<IRDecisionRequest> {
    return Promise.resolve({
      state: request.state,
      questions: request.questions,
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
  fromIR(response: IRDecisionResponse): Promise<TypeSafeSDKResponse> {
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
        probabilities: answer.probabilities,
        confidence: answer.confidence,
      };
    case 'score':
      return {
        score: answer.value,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
      };
    case 'noul':
      return { noul: answer.value };
  }
}
