/**
 * Decision mocks
 *
 * A decision-only mock backend for testing code that calls
 * `Bridge.decide()` / `backend.decide()` without a real model.
 *
 * @module
 */

import type {
  AdapterMetadata,
  BackendAdapter,
  IRDecisionAnswer,
  IRDecisionRequest,
  IRDecisionResponse,
} from '@johnhenry/aimatey-types';

/**
 * Configuration for {@link createMockDecisionBackend}.
 */
export interface MockDecisionBackendConfig {
  /**
   * Canned answers, keyed by question name. A request asking a question
   * with no entry here (and no `handler`) rejects, naming the question.
   */
  readonly answers?: Record<string, IRDecisionAnswer>;

  /**
   * Build the whole response yourself. Takes precedence over `answers`.
   */
  readonly handler?: (
    request: IRDecisionRequest
  ) => IRDecisionResponse | Promise<IRDecisionResponse>;

  /**
   * Delay before responding, in milliseconds.
   * @default 0
   */
  readonly latencyMs?: number;

  /**
   * Reject with this error instead of answering. The call is still logged.
   */
  readonly error?: Error;

  /**
   * Adapter name, reported in `metadata.name` and response provenance.
   * @default 'mock-decision'
   */
  readonly name?: string;

  /**
   * Model name reported on `answers`-built responses.
   * @default 'mock-decision-model'
   */
  readonly model?: string;
}

/**
 * A mock decision backend plus the log of requests it received.
 */
export type MockDecisionBackend = BackendAdapter & {
  /** Every request passed to `decide()`, in order. */
  readonly calls: IRDecisionRequest[];
  decide(request: IRDecisionRequest, signal?: AbortSignal): Promise<IRDecisionResponse>;
};

/**
 * Create a decision-only mock backend: no chat methods, `decisions: true`.
 *
 * @example
 * ```typescript
 * const backend = createMockDecisionBackend({
 *   answers: { urgent: { type: 'noul', value: 0.9 } },
 * });
 * const bridge = new Bridge(frontend, backend);
 * await bridge.decide('server is down', {
 *   urgent: { type: 'noul', instructions: 'Is this urgent?' },
 * });
 * backend.calls; // [the IRDecisionRequest the bridge built]
 * ```
 */
export function createMockDecisionBackend(
  config: MockDecisionBackendConfig = {}
): MockDecisionBackend {
  const name = config.name ?? 'mock-decision';
  const calls: IRDecisionRequest[] = [];

  const metadata: AdapterMetadata = {
    name,
    version: '1.0.0',
    provider: 'mock',
    capabilities: {
      streaming: false,
      multiModal: false,
      tools: false,
      decisions: true,
      systemMessageStrategy: 'not-supported',
      supportsMultipleSystemMessages: false,
    },
  };

  return {
    metadata,
    calls,
    async decide(request, signal) {
      calls.push(request);
      signal?.throwIfAborted();

      if (config.latencyMs && config.latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, config.latencyMs));
        signal?.throwIfAborted();
      }

      if (config.error) {
        throw config.error;
      }

      if (config.handler) {
        return config.handler(request);
      }

      const answers: Record<string, IRDecisionAnswer> = {};
      for (const question of Object.keys(request.questions)) {
        const answer = config.answers?.[question];
        if (!answer) {
          throw new Error(`createMockDecisionBackend: no mock answer configured for question '${question}'`);
        }
        answers[question] = answer;
      }

      return {
        answers,
        model: config.model ?? 'mock-decision-model',
        metadata: {
          ...request.metadata,
          provenance: { ...request.metadata.provenance, backend: name },
        },
      };
    },
  };
}
