/**
 * AI SDK `decide()` Wrapper
 *
 * Mimics the Vercel AI SDK's experimental `decide()` on top of any `Bridge`
 * with a decision-capable backend. Uses `VercelDecideFrontendAdapter` for the
 * format conversions.
 *
 * @module
 */

import { VercelDecideFrontendAdapter } from '@johnhenry/aimatey-frontend';
import type { VercelDecideRequest, VercelDecideResponse } from '@johnhenry/aimatey-frontend';
import { assertDecisionBridge, runDecision, type DecisionBridge } from './decision-bridge.js';

export type {
  VercelDecideRequest,
  VercelDecideResponse,
  VercelDecideQuestion,
  VercelDecideAnswer,
} from '@johnhenry/aimatey-frontend';

/** Options for {@link createDecide}. */
export interface DecideOptions {
  /** Model used when a call names none. */
  readonly defaultModel?: string;
}

/** What `decide()` takes: {@link VercelDecideRequest} plus an abort signal. */
export type DecideParams = VercelDecideRequest & { readonly abortSignal?: AbortSignal };

/** Signature of the AI SDK's `decide()`. */
export type DecideFunction = (params: DecideParams) => Promise<VercelDecideResponse>;

/**
 * Wrap a Bridge as a function with the AI SDK `decide()` signature.
 *
 * @example
 * ```typescript
 * const decide = createDecide(new Bridge(new VercelDecideFrontendAdapter(), backend));
 * const { answers } = await decide({
 *   model: 'tev1:0.8b',
 *   state: 'Please refund me.',
 *   questions: { refund: { type: 'boolean', instructions: 'Wants a refund?' } },
 * });
 * answers.refund; // { type: 'boolean', probability: 0.97 }
 * ```
 */
export function createDecide(bridge: DecisionBridge, opts: DecideOptions = {}): DecideFunction {
  assertDecisionBridge(bridge, 'createDecide');
  const adapter = new VercelDecideFrontendAdapter();

  return ({ abortSignal, ...request }) =>
    runDecision(
      bridge,
      adapter,
      request.model === undefined && opts.defaultModel !== undefined
        ? { ...request, model: opts.defaultModel }
        : request,
      abortSignal
    );
}

/**
 * A minimal analogue of `gateway.decisionModel(id)`: a model id bound to a
 * `decide()` function.
 *
 * Shape-compatible only -- this is NOT an `ai` provider/model object and
 * will not be accepted where the SDK expects one.
 */
export interface DecisionModel {
  readonly modelId: string;
  readonly provider: string;
  decide(params: Omit<DecideParams, 'model'>): Promise<VercelDecideResponse>;
}

/** Bind `modelId` to a Bridge; see {@link DecisionModel}. */
export function createDecisionModel(bridge: DecisionBridge, modelId: string): DecisionModel {
  const decide = createDecide(bridge, { defaultModel: modelId });
  return {
    modelId,
    provider: 'aimatey',
    decide: (params) => decide({ ...params, model: modelId }),
  };
}
