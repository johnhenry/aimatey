/**
 * TypeSafe SDK Wrapper
 *
 * Mimics the `@typesafe-ai/sdk` client's `systemOne()` call on top of any
 * `Bridge` with a decision-capable backend, so code written against that
 * SDK can run against Jev, Ollama, Laya, an LLM emulation, or anything else
 * aimatey can reach.
 *
 * Uses `TypeSafeFrontendAdapter` for the format conversions.
 *
 * @module
 */

import { TypeSafeFrontendAdapter } from '@johnhenry/aimatey-frontend';
import type { TypeSafeSDKRequest, TypeSafeSDKResponse } from '@johnhenry/aimatey-frontend';
import { assertDecisionBridge, runDecision, type DecisionBridge } from './decision-bridge.js';

export type { TypeSafeSDKRequest, TypeSafeSDKResponse } from '@johnhenry/aimatey-frontend';

/** Options for {@link createTypeSafeClient}. */
export interface TypeSafeClientOptions {
  /** Model used when a request names none. */
  readonly defaultModel?: string;
}

/** Per-call options. */
export interface TypeSafeCallOptions {
  readonly signal?: AbortSignal;
}

/** An object shaped like `@typesafe-ai/sdk`'s client. */
export interface TypeSafeClient {
  systemOne(
    request: TypeSafeSDKRequest,
    options?: TypeSafeCallOptions
  ): Promise<TypeSafeSDKResponse>;
  /** Alias of {@link TypeSafeClient.systemOne}. */
  decide(request: TypeSafeSDKRequest, options?: TypeSafeCallOptions): Promise<TypeSafeSDKResponse>;
}

/**
 * Wrap a Bridge so it looks like `@typesafe-ai/sdk`'s client.
 *
 * With a Bridge built on `TypeSafeFrontendAdapter` this is
 * `bridge.decideFrom()`; with any other frontend the request is converted
 * internally and run through `bridge.decide()`.
 *
 * Errors are the Bridge's own (`AdapterError` `UNSUPPORTED_FEATURE` for a
 * backend without decisions, backend/provider errors unchanged).
 *
 * @example
 * ```typescript
 * const client = createTypeSafeClient(new Bridge(new TypeSafeFrontendAdapter(), backend));
 * const { answers } = await client.systemOne({
 *   state: 'Please refund me.',
 *   questions: { refund: { type: 'noul', instructions: 'Wants a refund?' } },
 * });
 * ```
 */
export function createTypeSafeClient(
  bridge: DecisionBridge,
  opts: TypeSafeClientOptions = {}
): TypeSafeClient {
  assertDecisionBridge(bridge, 'createTypeSafeClient');
  const adapter = new TypeSafeFrontendAdapter();

  const systemOne = (request: TypeSafeSDKRequest, options: TypeSafeCallOptions = {}) =>
    runDecision(
      bridge,
      adapter,
      request.model === undefined && opts.defaultModel !== undefined
        ? { ...request, model: opts.defaultModel }
        : request,
      options.signal
    );

  return { systemOne, decide: systemOne };
}
