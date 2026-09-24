/**
 * Laya Frontend Adapter
 *
 * Translates Laya-native `Router.predict()`/`Agent.system_one()`-shaped
 * calls into the Universal Decision IR. Same reasoning as
 * `TypeSafeFrontendAdapter` for why this isn't an implementation of
 * `FrontendAdapter` (that interface is chat-hardwired) -- see that file's
 * module comment, not repeated here.
 *
 * Types below are verified against Laya's actual source
 * (github.com/NandhaKishorM/laya `laya/agent.py`'s `system_one()` and
 * `laya/router.py`'s `predict()`), not its README's marketing examples --
 * the two disagree in real, structural ways from TypeSafe's Jev, which
 * this adapter's sibling (`typesafe.ts`) already covers:
 *
 * - Laya's answers carry their own `type` field; Jev's don't (Jev's
 *   backend adapter has to re-derive it from the *question*).
 * - Laya's `score` answer keys `probabilities` by **stringified index**
 *   (`{"0": 0.1, "1": 0.6, ...}`), not an array like Jev's. Its `score`
 *   value itself is a probability-weighted expected value over those
 *   indices, not necessarily an integer -- confirmed live against
 *   `@receptron/laya` (`LayaBackendAdapter`'s real backend), not just
 *   read from source.
 * - **Correction, also from a live check**: this comment previously
 *   claimed Laya's `noul` answer always includes a real `confidence`
 *   (`max(p, 1-p)`), based on reading `NandhaKishorM/laya`'s Python
 *   source, not running it. A live `@receptron/laya` response's `noul`
 *   answer carries no `confidence` field at all -- same gap as Jev's.
 *   `IRDecisionAnswer`'s `noul.confidence` stayed optional for exactly
 *   this reason; both `toLayaAnswer` below and `native-laya`'s
 *   `toIRAnswer` derive `max(p, 1-p)` when the wire response omits one,
 *   rather than one of the two providers reliably reporting it.
 * - Every Laya answer carries an RL-agent action-selection sub-object
 *   with no IR equivalent (looks tied to the package's `RLAgent` class
 *   alias). This adapter's original source reading named it
 *   `action: { act_probability }`; a live `@receptron/laya` response
 *   names it `rl_agent: { act_probability }` instead -- likely a
 *   difference between the original Python reference this frontend
 *   adapter's types model and the TS/ONNX port `native-laya` actually
 *   talks to, not a correction of one over the other. Either way, it's
 *   dropped on the way into the IR; there is nothing to reconstruct it
 *   from on the way back out.
 *
 * ---
 *
 * ## `LayaBackendAdapter`
 *
 * Unlike Jev, Laya has no hosted API of its own -- but it doesn't need
 * one: `@receptron/laya` (github.com/receptron/laya, MIT) is a real,
 * verified TypeScript/ONNX Runtime port of Laya's inference, run
 * in-process via `onnxruntime-node`. No Python, no separately-hosted
 * wrapper service. See `@johnhenry/aimatey-native-laya`, which implements
 * `decide()` against it directly -- `native-laya`'s module comment maps
 * the same three answer-shape differences `toLayaAnswer` below already
 * handles on the way out, in reverse, on the way in.
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
// Laya-native types (verified against laya/agent.py and laya/router.py)
// ============================================================================

/** The three checkpoints `Router` knows about, plus their common aliases. */
export type LayaModel =
  | 'english'
  | 'multilingual'
  | 'typed-decisions'
  | 'en'
  | 'laya'
  | 'default'
  | 'multi'
  | 'ml'
  | 'typed'
  | 'typed_decisions'
  | 'decisions';

/**
 * Shape of a `Router.predict(state, questions, model=, task=, lang=)` call.
 * `task`/`lang` are routing hints specific to Laya (force a
 * typed-decisions workflow match, or skip script detection) with no Jev
 * equivalent -- passed through via `IRDecisionParameters.custom`.
 */
export interface LayaRequest {
  readonly state: unknown;
  readonly questions: Record<string, IRDecisionQuestion>;
  readonly model?: LayaModel;
  readonly task?: string;
  readonly lang?: string;
}

/** A single answer, exactly as `Agent.system_one()` builds it. */
export type LayaAnswer =
  | {
      readonly type: 'choice';
      readonly choice: string;
      readonly probabilities: Record<string, number>;
      readonly confidence: number;
      readonly action?: { readonly act_probability: number };
    }
  | {
      readonly type: 'score';
      readonly score: number;
      /** Level index (stringified) -> human-readable label, from the question's own `criteria`. */
      readonly legend: Record<string, string>;
      /** Keyed by stringified level index -- NOT an array, unlike Jev's `score` answers. */
      readonly probabilities: Record<string, number>;
      readonly confidence: number;
      readonly action?: { readonly act_probability: number };
    }
  | {
      readonly type: 'noul';
      readonly noul: number;
      readonly confidence: number;
      readonly action?: { readonly act_probability: number };
    };

/**
 * Shape of `Router.predict()`'s return value: `Agent.system_one()`'s
 * payload plus a `routing` key recording which checkpoint answered and
 * why. `routing` is omitted here when reconstructing from the IR -- it
 * records a real routing decision this adapter never made.
 */
export interface LayaResponse {
  readonly model: string;
  readonly answers: Record<string, LayaAnswer>;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
  readonly routing?: { readonly model: string; readonly reason: string };
}

// ============================================================================
// Laya Frontend Adapter
// ============================================================================

export class LayaFrontendAdapter {
  readonly metadata: AdapterMetadata = {
    name: 'laya-frontend',
    version: '1.0.0',
    provider: 'ConvAI (Laya)',
    capabilities: {
      streaming: false,
      multiModal: false,
      tools: false,
      systemMessageStrategy: 'not-supported',
      supportsMultipleSystemMessages: false,
      decisions: true,
    },
  };

  /**
   * Convert a Laya-native `Router.predict()`-shaped call into a Universal
   * Decision IR request. `task`/`lang` (Laya-specific routing hints, no
   * Jev equivalent) travel in `parameters.custom` rather than as
   * first-class IR fields -- promoting a single provider's routing
   * vocabulary into the universal request shape is exactly the kind of
   * provider-specific leakage the IR's `custom` escape hatch exists for.
   */
  toIR(request: LayaRequest): Promise<IRDecisionRequest> {
    return Promise.resolve({
      state: request.state,
      questions: request.questions,
      parameters: {
        model: request.model,
        custom: {
          ...(request.task !== undefined && { task: request.task }),
          ...(request.lang !== undefined && { lang: request.lang }),
        },
      },
      metadata: {
        requestId: 'laya-' + Date.now(),
        timestamp: Date.now(),
        provenance: { frontend: this.metadata.name },
      },
    });
  }

  /**
   * Convert a Universal Decision IR response back into Laya's native
   * response shape.
   *
   * `originalRequest` is optional but matters: `score` answers need the
   * question's own `criteria` list to reconstruct `legend` (index ->
   * label), which the IR response alone doesn't carry. Without it,
   * `legend` falls back to numeric-string labels (`{"0": "0", "1": "1"}`)
   * rather than being fabricated or omitted outright -- a real, honest
   * degradation, not silently wrong data.
   */
  fromIR(response: IRDecisionResponse, originalRequest?: IRDecisionRequest): Promise<LayaResponse> {
    const answers: Record<string, LayaAnswer> = {};
    for (const [name, answer] of Object.entries(response.answers)) {
      const question = originalRequest?.questions[name];
      answers[name] = toLayaAnswer(answer, question);
    }

    return Promise.resolve({
      model: response.model,
      answers,
      usage: {
        input_tokens: response.usage?.inputTokens ?? 0,
        // Laya is non-autoregressive -- it never generates output tokens,
        // so this is always 0, not "unknown"/omitted the way a chat
        // backend's completionTokens might be.
        output_tokens: 0,
      },
    });
  }
}

function toLayaAnswer(answer: IRDecisionAnswer, question?: IRDecisionQuestion): LayaAnswer {
  switch (answer.type) {
    case 'choice':
      return {
        type: 'choice',
        choice: answer.value,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
      };
    case 'score': {
      const criteria = question?.type === 'score' ? question.criteria : undefined;
      const legend: Record<string, string> = {};
      const probabilities: Record<string, number> = {};
      answer.probabilities.forEach((p, i) => {
        legend[String(i)] = criteria?.[i] ?? String(i);
        probabilities[String(i)] = p;
      });
      return {
        type: 'score',
        score: answer.value,
        legend,
        probabilities,
        confidence: answer.confidence,
      };
    }
    case 'noul':
      return {
        type: 'noul',
        noul: answer.value,
        // Derive if the source backend didn't report one -- neither Jev
        // nor a live Laya response reliably does (see this file's module
        // comment). This is a real, defined quantity (distance from a
        // coin flip), not a guess, so computing it here is honest
        // reconstruction, not fabrication the way inventing `rl_agent`/
        // `routing` would be.
        confidence: answer.confidence ?? Math.max(answer.value, 1 - answer.value),
      };
  }
}
