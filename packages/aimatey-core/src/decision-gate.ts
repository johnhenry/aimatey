/**
 * Decision-model gate and tool
 *
 * Two ways to put a System One decision model (Jev, Laya, an emulated
 * tev1) next to an agentic tool loop:
 *
 * - {@link createDecisionGate}: a `runTools({ gate })` function that asks the
 *   model "is this tool call safe and consistent with the user's request?"
 *   and maps the calibrated probability to allow / review / deny. One cheap
 *   forward pass instead of an LLM round trip per tool call (the pattern
 *   eve.dev calls auto-approving tool calls).
 * - {@link createDecisionTool}: a `ToolDefinition` that lets a chat agent
 *   consult a decision model mid-loop.
 *
 * @module
 */

import type {
  BackendAdapter,
  GateDecision,
  IRDecisionAnswer,
  IRDecisionQuestion,
  IRDecisionRequest,
  IRDecisionResponse,
  IRMessage,
  ToolCallGate,
  ToolCallGateCall,
  ToolDefinition,
} from '@johnhenry/aimatey-types';
import { AdapterError, ErrorCode } from '@johnhenry/aimatey-errors';
import { supportsDecisions } from '@johnhenry/aimatey-utils';

/** Probability thresholds mapping a gate question's P(true) to a verdict. */
export interface DecisionGatePolicy {
  /** P(true) at or above this allows the call. @default 0.8 */
  readonly allowAbove?: number;
  /** P(true) at or below this denies the call; between the two is `review`. @default 0.3 */
  readonly denyBelow?: number;
}

/** Configuration for {@link createDecisionGate}. */
export interface DecisionGateConfig {
  /** Decision model to ask (falls back to the backend's default). */
  readonly model?: string;

  /**
   * Replace the default question. Every `noul` question here is read as
   * "true means the call is fine"; the gate uses the lowest P(true) across
   * them. Other question types are asked but do not affect the verdict.
   * Must contain at least one `noul`.
   */
  readonly questions?: Record<string, IRDecisionQuestion>;

  /** Thresholds; see {@link DecisionGatePolicy}. */
  readonly policy?: DecisionGatePolicy;

  /** Replace the default state (`{ toolName, input, lastUserMessage }`). */
  readonly stateBuilder?: (call: ToolCallGateCall) => unknown;
}

/** The question {@link createDecisionGate} asks unless `questions` overrides it. */
export const DEFAULT_GATE_QUESTIONS: Readonly<Record<string, IRDecisionQuestion>> = {
  safe: {
    type: 'noul',
    instructions:
      "Is this tool call safe and consistent with the user's request? " +
      'Answer false if it is destructive, exfiltrates data, or is not what the user asked for.',
    criteria: {
      true: 'safe and consistent with the request',
      false: 'unsafe or not what the user asked for',
    },
  },
};

function lastUserMessage(history: readonly IRMessage[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    if (message.role !== 'user') {
      continue;
    }
    if (typeof message.content === 'string') {
      return message.content;
    }
    const text = message.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('');
    if (text) {
      return text;
    }
  }
  return undefined;
}

function requireDecisionBackend(
  backend: BackendAdapter
): BackendAdapter & Required<Pick<BackendAdapter, 'decide'>> {
  if (!supportsDecisions(backend)) {
    throw new AdapterError({
      code: ErrorCode.UNSUPPORTED_FEATURE,
      message: `Backend '${backend.metadata?.name}' does not support typed decisions`,
      isRetryable: false,
      provenance: { backend: backend.metadata?.name },
    });
  }
  return backend;
}

function buildRequest(
  questions: Record<string, IRDecisionQuestion>,
  state: unknown,
  model: string | undefined,
  source: string
): IRDecisionRequest {
  return {
    state,
    questions,
    parameters: { model },
    metadata: {
      requestId: crypto.randomUUID(),
      timestamp: Date.now(),
      provenance: { frontend: source },
    },
  };
}

/**
 * Build a `runTools({ gate })` function backed by a decision model.
 *
 * Asks the backend whether the proposed tool call is safe and consistent
 * with the user's request (state: tool name, input, last user message) and
 * maps P(true): `>= allowAbove` (0.8) allows, `<= denyBelow` (0.3) denies,
 * anything between is `review`. The verdict carries the decision response
 * as `response` and the probability in `reason`, so
 * `RunToolsResult.denials` is an audit trail.
 *
 * The backend is called directly (not through a `Bridge`), so decision
 * middleware does not run; if the backend throws, so does the gate, and
 * `runTools` fails closed by denying the call.
 *
 * @throws AdapterError UNSUPPORTED_FEATURE when the backend lacks decide()
 * @throws RangeError when `policy` is incoherent or `questions` has no `noul`
 *
 * @example
 * ```typescript
 * const result = await bridge.runTools({
 *   prompt: 'Clean up my temp folder',
 *   tools,
 *   gate: createDecisionGate(new OllamaBackendAdapter({ model: 'tev1:0.8b' })),
 *   onReview: (event) => askHuman(event),
 * });
 * ```
 */
export function createDecisionGate(
  backend: BackendAdapter,
  config: DecisionGateConfig = {}
): ToolCallGate {
  const decider = requireDecisionBackend(backend);
  const questions = config.questions ?? DEFAULT_GATE_QUESTIONS;
  const allowAbove = config.policy?.allowAbove ?? 0.8;
  const denyBelow = config.policy?.denyBelow ?? 0.3;

  const noulNames = Object.entries(questions)
    .filter(([, question]) => question.type === 'noul')
    .map(([name]) => name);
  if (noulNames.length === 0) {
    throw new RangeError('createDecisionGate: `questions` needs at least one noul question');
  }
  if (!(denyBelow < allowAbove)) {
    throw new RangeError(
      `createDecisionGate: policy.allowAbove (${allowAbove}) must be greater than policy.denyBelow (${denyBelow})`
    );
  }

  const buildState =
    config.stateBuilder ??
    ((call: ToolCallGateCall) => ({
      toolName: call.name,
      input: call.input,
      lastUserMessage: lastUserMessage(call.history),
    }));

  return async (call): Promise<GateDecision> => {
    const response = await decider.decide(
      buildRequest(questions, buildState(call), config.model, 'decision-gate')
    );

    let probability = 1;
    for (const name of noulNames) {
      const answer = response.answers[name];
      if (answer?.type !== 'noul') {
        throw new AdapterError({
          code: ErrorCode.PROVIDER_ERROR,
          message: `Decision gate: backend returned no noul answer for question '${name}'`,
          isRetryable: false,
          provenance: { backend: backend.metadata.name },
        });
      }
      probability = Math.min(probability, answer.value);
    }

    const label = `decision model P(safe)=${probability.toFixed(2)}`;
    if (probability >= allowAbove) {
      return { action: 'allow', response };
    }
    if (probability <= denyBelow) {
      return { action: 'deny', reason: label, response };
    }
    return { action: 'review', reason: label, response };
  };
}

/** Options for {@link createDecisionTool}. */
export interface DecisionToolOptions {
  /** Tool name (the key to register it under in `runTools({ tools })`). @default 'consult_decision_model' */
  readonly name?: string;
  /** Tool description shown to the model. Defaults to one listing the questions. */
  readonly description?: string;
  /** Decision model to ask. */
  readonly model?: string;
}

/** A {@link ToolDefinition} that knows the name to register it under. */
export type DecisionTool = ToolDefinition & { readonly name: string };

function describeQuestions(questions: Record<string, IRDecisionQuestion>): string {
  return Object.entries(questions)
    .map(([name, question]) => `${name} (${question.type}): ${question.instructions}`)
    .join('; ');
}

function summarizeAnswer(answer: IRDecisionAnswer): Record<string, unknown> {
  return {
    type: answer.type,
    value: answer.value,
    ...('probabilities' in answer &&
      answer.probabilities && { probabilities: answer.probabilities }),
    ...(answer.confidence !== undefined && { confidence: answer.confidence }),
    ...(answer.reasoning !== undefined && { reasoning: answer.reasoning }),
  };
}

/**
 * Expose a decision model to a chat agent as a tool.
 *
 * The agent calls it with `{ state }` and gets back
 * `{ answers, model }`, where each answer has its value and, when the
 * provider reports them, probabilities and confidence -- so the agent can
 * weigh a 0.55 differently from a 0.99. Register under `tool.name`:
 *
 * @example
 * ```typescript
 * const triage = createDecisionTool(backend, {
 *   urgent: { type: 'noul', instructions: 'Is this urgent?' },
 * });
 * await bridge.runTools({ prompt, tools: { [triage.name]: triage } });
 * ```
 */
export function createDecisionTool(
  backend: BackendAdapter,
  questions: Record<string, IRDecisionQuestion>,
  options: DecisionToolOptions = {}
): DecisionTool {
  const decider = requireDecisionBackend(backend);

  return {
    name: options.name ?? 'consult_decision_model',
    description:
      options.description ??
      `Ask a fast decision model typed questions about some text or data and get calibrated answers. Questions: ${describeQuestions(questions)}.`,
    parameters: {
      type: 'object',
      properties: {
        state: {
          description: 'The text or JSON the questions are asked about.',
        },
      },
      required: ['state'],
    },
    execute: async (input, context) => {
      const response: IRDecisionResponse = await decider.decide(
        buildRequest(questions, input.state, options.model, 'decision-tool'),
        context.signal
      );
      return {
        answers: Object.fromEntries(
          Object.entries(response.answers).map(([name, answer]) => [name, summarizeAnswer(answer)])
        ),
        model: response.model,
      };
    },
  };
}
