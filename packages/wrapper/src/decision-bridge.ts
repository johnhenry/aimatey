/**
 * Shared plumbing for the decision SDK wrappers (`typesafe-sdk.ts`,
 * `ai-sdk-decide.ts`): run a request in a *specific* frontend's shape
 * through a Bridge, whatever frontend that Bridge was built with.
 *
 * @module
 * @internal
 */

import type {
  FrontendAdapter,
  IRDecisionRequest,
  IRDecisionResponse,
  DecisionOptions,
} from '@johnhenry/aimatey-types';
import { AdapterError, ErrorCode } from '@johnhenry/aimatey-errors';

/**
 * The slice of `Bridge` the decision wrappers use. Structural, so any
 * `Bridge` fits without this package depending on `@johnhenry/aimatey-core`.
 */
export interface DecisionBridge {
  readonly frontend: FrontendAdapter<never, unknown>;
  decide(
    state: unknown,
    questions: IRDecisionRequest['questions'],
    options?: DecisionOptions
  ): Promise<IRDecisionResponse>;
  decideFrom(
    request: never,
    options?: { signal?: AbortSignal; metadata?: Record<string, unknown>; principal?: string }
  ): Promise<unknown>;
}

/** Decision-hook frontend (the part of `FrontendAdapter` the wrappers need). */
export type DecisionFrontend<TRequest, TResponse> = Required<
  Pick<FrontendAdapter<TRequest, TResponse>, 'metadata' | 'decisionToIR' | 'decisionFromIR'>
>;

export function assertDecisionBridge(
  bridge: unknown,
  wrapper: string
): asserts bridge is DecisionBridge {
  const b = bridge as Partial<DecisionBridge> | null;
  if (!b || typeof b.decide !== 'function' || typeof b.decideFrom !== 'function') {
    throw new AdapterError({
      code: ErrorCode.UNSUPPORTED_FEATURE,
      message: `${wrapper} requires a Bridge (an object with decide() and decideFrom())`,
      isRetryable: false,
    });
  }
}

/**
 * Run `request` (in `adapter`'s shape) through `bridge` and return the
 * response in the same shape.
 *
 * When the bridge's own frontend *is* that adapter (matched by
 * `metadata.name`), this is `bridge.decideFrom()`. Otherwise the request
 * is converted with `adapter`, run with `bridge.decide()`, and converted
 * back, so the wrapper works on a Bridge built with any frontend.
 */
export async function runDecision<TRequest, TResponse>(
  bridge: DecisionBridge,
  adapter: DecisionFrontend<TRequest, TResponse>,
  request: TRequest,
  signal?: AbortSignal
): Promise<TResponse> {
  if (bridge.frontend.metadata.name === adapter.metadata.name) {
    return (await bridge.decideFrom(request as never, { signal })) as TResponse;
  }

  const ir = await adapter.decisionToIR(request);
  if (ir.images?.length) {
    throw new AdapterError({
      code: ErrorCode.UNSUPPORTED_FEATURE,
      message:
        `This Bridge's frontend is '${bridge.frontend.metadata.name}', not '${adapter.metadata.name}', ` +
        `and Bridge.decide() cannot carry images; build the Bridge with '${adapter.metadata.name}' to send them`,
      isRetryable: false,
    });
  }
  const response = await bridge.decide(ir.state, ir.questions, {
    model: ir.parameters?.model,
    custom: ir.parameters?.custom,
    signal,
  });
  return adapter.decisionFromIR(response, ir);
}
