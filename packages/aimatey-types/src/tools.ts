/**
 * Tool Execution Types
 *
 * Types for the agentic tool-execution loop (`bridge.runTools()`) and
 * tool-calling helpers.
 *
 * @module
 */

import type {
  FinishReason,
  IRChatRequest,
  IRChatResponse,
  IRMessage,
  IRParameters,
  IRTool,
  IRUsage,
} from './ir.js';
import type { IRDecisionResponse } from './decisions.js';

/**
 * Context passed to a tool's execute function.
 */
export interface ToolExecutionContext {
  /** The provider-assigned id of this tool call. */
  readonly toolCallId: string;

  /** Conversation messages up to (and including) the assistant's tool call. */
  readonly messages: readonly IRMessage[];

  /** Abort signal from the runTools invocation. */
  readonly signal?: AbortSignal;
}

/**
 * A tool the model may call, with its executable implementation.
 *
 * Passed to `runTools` as a record keyed by tool name (which prevents
 * duplicate names); converted to the IR `tools` array internally.
 */
export interface ToolDefinition extends Omit<IRTool, 'name'> {
  /**
   * Execute the tool. The return value is JSON-stringified (unless already
   * a string) and fed back to the model as a tool result. Thrown errors
   * become `isError: true` tool results rather than aborting the loop.
   */
  readonly execute: (input: Record<string, unknown>, context: ToolExecutionContext) => unknown; // sync or Promise; the loop awaits either
}

/**
 * A tool call about to be executed, as seen by a {@link ToolCallGate}.
 */
export interface ToolCallGateCall {
  /** Tool name. */
  readonly name: string;

  /** Arguments the model supplied (already schema-validated when `validateArguments` is on). */
  readonly input: Record<string, unknown>;

  /** 1-based loop iteration the call was made in. */
  readonly iteration: number;

  /** The provider-assigned id of this tool call. */
  readonly toolCallId: string;

  /** Conversation so far, ending with the assistant message that made the call. */
  readonly history: readonly IRMessage[];
}

/**
 * A gate's verdict on one tool call.
 *
 * - `allow`: run the tool.
 * - `deny`: do not run it; `"Tool call denied: <reason>"` goes back to the
 *   model as an error tool result so the loop can continue.
 * - `review`: not clear enough to decide. By default behaves like `deny`
 *   with a distinct message; `onReview` can turn it into a human-in-the-loop
 *   approval.
 *
 * `response` carries the decision-model response that produced the verdict
 * (set by `createDecisionGate`), for auditing.
 */
export type GateDecision =
  | { readonly action: 'allow'; readonly response?: IRDecisionResponse }
  | { readonly action: 'deny'; readonly reason?: string; readonly response?: IRDecisionResponse }
  | { readonly action: 'review'; readonly reason?: string; readonly response?: IRDecisionResponse };

/**
 * Decides whether a tool call may run. Fail-closed: a gate that throws
 * denies the call.
 */
export type ToolCallGate = (call: ToolCallGateCall) => Promise<GateDecision> | GateDecision;

/**
 * Passed to `onReview` when a gate answers `review`.
 */
export interface ToolReviewEvent extends ToolCallGateCall {
  readonly reason?: string;
  /** The gate's full verdict, including any audit `response`. */
  readonly decision: Extract<GateDecision, { action: 'review' }>;
}

/**
 * A tool call the gate stopped (denied, or sent to review and not approved).
 */
export interface RunToolsDenial {
  readonly iteration: number;
  readonly toolCallId: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly action: 'deny' | 'review';
  readonly reason?: string;
  /** Decision-model response behind the verdict, when the gate attached one. */
  readonly response?: IRDecisionResponse;
}

/** How a tool loop ended: with a final answer, or cut short by `maxDenials`. */
export type RunToolsStatus = 'completed' | 'max-denials';

/**
 * Options for `bridge.runTools()`.
 */
export interface RunToolsOptions {
  /** Conversation messages (alternative to `prompt`). */
  readonly messages?: readonly IRMessage[];

  /** Convenience: a single user prompt. */
  readonly prompt?: string;

  /** Tools keyed by name. */
  readonly tools: Readonly<Record<string, ToolDefinition>>;

  /** Model id. */
  readonly model?: string;

  /** Tool-choice constraint for the FIRST iteration. */
  readonly toolChoice?: IRChatRequest['toolChoice'];

  /** Maximum model round-trips before aborting. @default 10 */
  readonly maxIterations?: number;

  /** Run multiple tool calls from one response concurrently. @default true */
  readonly parallelToolCalls?: boolean;

  /**
   * Validate arguments against each tool's JSON schema before executing;
   * invalid arguments are fed back to the model as error tool results.
   * @default true
   */
  readonly validateArguments?: boolean;

  /**
   * Decide whether each tool call may run (see {@link ToolCallGate}).
   * Consulted after the tool is found and its arguments validate, so unknown
   * tools and invalid arguments never reach it. With no gate, every call runs.
   */
  readonly gate?: ToolCallGate;

  /**
   * Called when the gate answers `review`. May return a verdict to settle it
   * (`allow` runs the tool, anything else denies); returning nothing leaves
   * the default: the call is not run and the model is told it needs review.
   */
  readonly onReview?: (
    event: ToolReviewEvent
  ) => GateDecision | void | Promise<GateDecision | void>;

  /**
   * End the loop after this many gated calls were stopped (denied, or
   * reviewed and not approved), with `status: 'max-denials'` on the result
   * instead of an error. Unlimited when omitted.
   */
  readonly maxDenials?: number;

  /** Called after each iteration completes. */
  readonly onStepFinish?: (step: RunToolsStep) => void | Promise<void>;

  /** Abort signal. */
  readonly signal?: AbortSignal;

  /** Additional request parameters (temperature, maxTokens, ...). */
  readonly parameters?: IRParameters;
}

/**
 * One iteration of the tool loop.
 */
export interface RunToolsStep {
  /** 1-based iteration number. */
  readonly iteration: number;

  /** The model response for this iteration. */
  readonly response: IRChatResponse;

  /** Tool calls the model requested (empty on the final iteration). */
  readonly toolCalls: readonly { id: string; name: string; input: Record<string, unknown> }[];

  /** Results fed back to the model. */
  readonly toolResults: readonly { toolCallId: string; result: unknown; isError?: boolean }[];
}

/**
 * Result of a completed tool loop.
 */
export interface RunToolsResult {
  /** Final assistant text. */
  readonly text: string;

  /** Final model response. */
  readonly response: IRChatResponse;

  /** Full conversation including tool calls and results. */
  readonly messages: readonly IRMessage[];

  /** Every iteration's step record. */
  readonly steps: readonly RunToolsStep[];

  /** Finish reason of the final response. */
  readonly finishReason: FinishReason;

  /** Summed usage across iterations (when providers report it). */
  readonly totalUsage: IRUsage;

  /** `'completed'` with a final answer, or `'max-denials'` when `maxDenials` cut the loop short (`text` is then empty). */
  readonly status: RunToolsStatus;

  /** Every call the gate stopped, in order. Empty when no gate is set. */
  readonly denials: readonly RunToolsDenial[];
}
