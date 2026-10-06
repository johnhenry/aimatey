/**
 * useDecision / useDecisionBatch Hooks
 *
 * React hooks for typed-decision models (Jev, Laya, and similar): ask typed
 * questions about a state and get typed, calibrated answers back from a
 * `Bridge`, with loading, cancellation and stale-response handling.
 *
 * @module
 */

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type {
  DecisionOptions,
  IRDecisionAnswer,
  IRDecisionQuestion,
  IRDecisionResponse,
} from '@johnhenry/aimatey-types';
import { createLatestRunner, type LatestRunner } from './latest-runner.js';

/** Questions to ask, keyed by name (the same shape `Bridge.decide()` takes). */
export type DecisionQuestions = Record<string, IRDecisionQuestion>;

/** Per-call options for `decide()`; `signal` is managed by the hook. */
export type DecideCallOptions = Omit<DecisionOptions, 'signal'>;

/**
 * What the hooks need from a `Bridge`. A real `Bridge` satisfies it; typing
 * it structurally keeps this package free of a dependency on `aimatey-core`.
 */
export interface DecisionHookBridge {
  decide(
    state: unknown,
    questions: DecisionQuestions,
    options?: DecisionOptions
  ): Promise<IRDecisionResponse>;
  decideBatch(
    states: readonly unknown[],
    questions: DecisionQuestions,
    options: DecisionOptions & {
      concurrency?: number;
      onProgress?: (done: number, total: number) => void;
      onError: 'collect';
    }
  ): Promise<readonly PromiseSettledResult<IRDecisionResponse>[]>;
}

const DecisionBridgeContext = createContext<DecisionHookBridge | undefined>(undefined);

/**
 * Provide a bridge to every `useDecision` / `useDecisionBatch` below, so
 * components do not each need a `bridge` option.
 *
 * @example
 * ```tsx
 * <DecisionBridgeProvider bridge={bridge}>
 *   <App />
 * </DecisionBridgeProvider>
 * ```
 */
export function DecisionBridgeProvider(props: {
  bridge: DecisionHookBridge;
  children?: ReactNode;
}): ReactNode {
  return createElement(DecisionBridgeContext.Provider, { value: props.bridge }, props.children);
}

function useBridge(explicit: DecisionHookBridge | undefined): DecisionHookBridge {
  const fromContext = useContext(DecisionBridgeContext);
  const bridge = explicit ?? fromContext;
  return (
    bridge ??
    ({
      decide: () => Promise.reject(noBridgeError()),
      decideBatch: () => Promise.reject(noBridgeError()),
    } satisfies DecisionHookBridge)
  );
}

function noBridgeError(): Error {
  return new Error(
    'useDecision: no bridge. Pass `{ bridge }` or render inside <DecisionBridgeProvider bridge={...}>.'
  );
}

function useRunner<T>(): LatestRunner<T> {
  const ref = useRef<LatestRunner<T> | undefined>(undefined);
  ref.current ??= createLatestRunner<T>();
  const runner = ref.current;

  // Cancel whatever is in flight when the component goes away.
  useEffect(
    () => () => {
      runner.abort();
    },
    [runner]
  );
  return runner;
}

/** A stable key for `questions`, so a fresh object literal per render is not a change. */
function useQuestionsKey(questions: DecisionQuestions): string {
  return useMemo(() => JSON.stringify(questions), [questions]);
}

// ============================================================================
// useDecision
// ============================================================================

/** Options for {@link useDecision}. */
export interface UseDecisionOptions {
  /** Bridge to decide with. Falls back to the nearest {@link DecisionBridgeProvider}. */
  bridge?: DecisionHookBridge;

  /** Decision model id (falls back to the backend's default). */
  model?: string;

  /**
   * Run on mount with `initialState`, and again whenever the content of
   * `questions` changes (compared by value, so an inline object literal
   * does not re-trigger it). Needs `initialState`.
   */
  auto?: boolean;

  /** State for the `auto` run; also the state re-used when `questions` change. */
  initialState?: unknown;

  /** Called with each set of answers that lands (never for a superseded or aborted call). */
  onAnswers?: (answers: Record<string, IRDecisionAnswer>, response: IRDecisionResponse) => void;

  /** Called when a call fails (never for an abort or a superseded call). */
  onError?: (error: Error) => void;
}

/** What {@link useDecision} returns. */
export interface UseDecisionReturn {
  /** Answers of the latest completed call, keyed by question name. */
  answers: Record<string, IRDecisionAnswer> | undefined;

  /** The full response (model, usage, warnings) behind `answers`. */
  response: IRDecisionResponse | undefined;

  /**
   * Ask the questions about `state`. Aborts any call still in flight and
   * discards its result. Resolves to the response, or `undefined` when the
   * call failed (see `error`) or was superseded / aborted.
   */
  decide: (state: unknown, options?: DecideCallOptions) => Promise<IRDecisionResponse | undefined>;

  isLoading: boolean;

  /** Error of the latest call, cleared when the next one starts. */
  error: Error | undefined;

  /** Cancel the in-flight call. Keeps the current answers. */
  abort: () => void;

  /** Cancel and clear answers, response and error. */
  reset: () => void;
}

/**
 * useDecision - ask typed questions about a state.
 *
 * The decision-model counterpart of a chat hook: no streaming, no message
 * list; a call returns typed answers (a `noul` is a calibrated probability)
 * in one shot.
 *
 * - `decide(state)` cancels the call in flight (via `AbortSignal`) and
 *   ignores its response if it still arrives, so the latest call always wins.
 * - Changing the identity of `questions` never refetches by itself; only
 *   `auto: true` re-runs, and only when the questions' content changes.
 * - Unmounting aborts the in-flight call.
 *
 * @example
 * ```tsx
 * import { useDecision } from '@johnhenry/aimatey-react-hooks';
 *
 * const questions = {
 *   urgent: { type: 'noul', instructions: 'Is this urgent?' },
 * } as const;
 *
 * function Triage({ bridge, ticket }) {
 *   const { answers, decide, isLoading } = useDecision(questions, { bridge });
 *   return (
 *     <>
 *       <button disabled={isLoading} onClick={() => decide(ticket)}>Triage</button>
 *       {answers?.urgent && <p>P(urgent) = {answers.urgent.value.toFixed(2)}</p>}
 *     </>
 *   );
 * }
 * ```
 */
export function useDecision(
  questions: DecisionQuestions,
  options: UseDecisionOptions = {}
): UseDecisionReturn {
  const runner = useRunner<IRDecisionResponse>();
  const snapshot = useSyncExternalStore(runner.subscribe, runner.getSnapshot, runner.getSnapshot);
  const bridge = useBridge(options.bridge);

  // Latest values, read at call time so `decide` can stay referentially stable.
  const latest = useRef({ questions, options, bridge });
  latest.current = { questions, options, bridge };
  const lastState = useRef<{ value: unknown } | undefined>(
    'initialState' in options ? { value: options.initialState } : undefined
  );

  const decide = useCallback(
    (state: unknown, callOptions?: DecideCallOptions) => {
      lastState.current = { value: state };
      return runner.run(
        (signal) => {
          const { questions: q, options: o, bridge: b } = latest.current;
          return b.decide(state, q, { model: o.model, ...callOptions, signal });
        },
        {
          onSuccess: (response) => latest.current.options.onAnswers?.(response.answers, response),
          onError: (error) => latest.current.options.onError?.(error),
        }
      );
    },
    [runner]
  );

  const questionsKey = useQuestionsKey(questions);
  const auto = options.auto === true;
  useEffect(() => {
    if (auto && lastState.current) {
      void decide(lastState.current.value);
    }
  }, [auto, questionsKey, decide]);

  return {
    answers: snapshot.data?.answers,
    response: snapshot.data,
    decide,
    isLoading: snapshot.isLoading,
    error: snapshot.error,
    abort: runner.abort,
    reset: runner.reset,
  };
}

// ============================================================================
// useDecisionBatch
// ============================================================================

/** Options for {@link useDecisionBatch}. */
export interface UseDecisionBatchOptions {
  /** Bridge to decide with. Falls back to the nearest {@link DecisionBridgeProvider}. */
  bridge?: DecisionHookBridge;

  /** Decision model id. */
  model?: string;

  /** Most states in flight at once (defaults to the backend's limit, else 4). */
  concurrency?: number;

  /** Called when the batch finishes, with one settled result per state. */
  onResults?: (results: readonly PromiseSettledResult<IRDecisionResponse>[]) => void;

  /** Called when the batch as a whole fails (e.g. the backend cannot decide). */
  onError?: (error: Error) => void;
}

/** What {@link useDecisionBatch} returns. */
export interface UseDecisionBatchReturn {
  /** One settled result per state, in input order, from the latest completed batch. */
  results: readonly PromiseSettledResult<IRDecisionResponse>[] | undefined;

  /**
   * Decide every state. Supersedes a batch in flight. A failing state is a
   * `rejected` entry in `results`, not a failure of the batch. Resolves to
   * the results, or `undefined` if the batch failed outright or was
   * superseded / aborted.
   */
  run: (
    states: readonly unknown[],
    options?: DecideCallOptions
  ) => Promise<readonly PromiseSettledResult<IRDecisionResponse>[] | undefined>;

  /** States finished so far out of the batch's total (items that failed count as finished). */
  progress: { done: number; total: number };

  isLoading: boolean;

  /** Batch-level error (not per-state failures; those are in `results`). */
  error: Error | undefined;

  /** Cancel the batch in flight; its results are dropped. */
  abort: () => void;

  /** Cancel and clear results, progress and error. */
  reset: () => void;
}

/**
 * useDecisionBatch - ask the same questions about many states, with progress.
 *
 * Wraps `Bridge.decideBatch()` (bounded concurrency, `onProgress`) in the
 * same latest-wins state machine as {@link useDecision}.
 *
 * @example
 * ```tsx
 * const { run, progress, results, isLoading } = useDecisionBatch(questions, { bridge });
 * // <button onClick={() => run(tickets)}>Triage all</button>
 * // <progress value={progress.done} max={progress.total} />
 * ```
 */
export function useDecisionBatch(
  questions: DecisionQuestions,
  options: UseDecisionBatchOptions = {}
): UseDecisionBatchReturn {
  const runner = useRunner<readonly PromiseSettledResult<IRDecisionResponse>[]>();
  const snapshot = useSyncExternalStore(runner.subscribe, runner.getSnapshot, runner.getSnapshot);
  const bridge = useBridge(options.bridge);

  const latest = useRef({ questions, options, bridge });
  latest.current = { questions, options, bridge };

  const run = useCallback(
    (states: readonly unknown[], callOptions?: DecideCallOptions) =>
      runner.run(
        (signal, setProgress) => {
          const { questions: q, options: o, bridge: b } = latest.current;
          setProgress(0, states.length);
          return b.decideBatch(states, q, {
            model: o.model,
            concurrency: o.concurrency,
            ...callOptions,
            signal,
            onProgress: setProgress,
            onError: 'collect',
          });
        },
        {
          onSuccess: (results) => latest.current.options.onResults?.(results),
          onError: (error) => latest.current.options.onError?.(error),
        }
      ),
    [runner]
  );

  return {
    results: snapshot.data,
    run,
    progress: { done: snapshot.progress.done, total: snapshot.progress.total },
    isLoading: snapshot.isLoading,
    error: snapshot.error,
    abort: runner.abort,
    reset: runner.reset,
  };
}
