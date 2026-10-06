/**
 * Latest-wins async runner
 *
 * The state machine behind `useDecision` / `useDecisionBatch`: at most one
 * call counts at a time. Starting a call aborts the one in flight and
 * discards its result, so a slow, superseded response can never overwrite a
 * newer one. Framework-free (the hooks bind it with `useSyncExternalStore`)
 * so its behaviour is testable without a DOM.
 *
 * @module
 * @internal
 */

/** What a runner exposes to React. A new object whenever anything changes. */
export interface RunnerState<T> {
  readonly data: T | undefined;
  readonly isLoading: boolean;
  readonly error: Error | undefined;
  /** Batch progress; `{ done: 0, total: 0 }` outside a batch. */
  readonly progress: { readonly done: number; readonly total: number };
}

/** Per-run callbacks, called only if the run is still the live one. */
export interface RunHandlers<T> {
  onSuccess?: (data: T) => void;
  onError?: (error: Error) => void;
}

export interface LatestRunner<T> {
  /** Start a call, superseding any in flight. Resolves to the data, or `undefined` if it failed or was superseded/aborted. */
  run: (
    task: (signal: AbortSignal, setProgress: (done: number, total: number) => void) => Promise<T>,
    handlers?: RunHandlers<T>
  ) => Promise<T | undefined>;
  /** Cancel the in-flight call and drop its result. Keeps current data. */
  abort: () => void;
  /** Abort and return to the idle state. */
  reset: () => void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => RunnerState<T>;
}

const IDLE_PROGRESS = { done: 0, total: 0 } as const;

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function createLatestRunner<T>(): LatestRunner<T> {
  let state: RunnerState<T> = {
    data: undefined,
    isLoading: false,
    error: undefined,
    progress: IDLE_PROGRESS,
  };
  let runId = 0;
  let controller: AbortController | undefined;
  const listeners = new Set<() => void>();

  const update = (patch: Partial<RunnerState<T>>): void => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const cancel = (): void => {
    controller?.abort();
    controller = undefined;
    runId++;
  };

  return {
    async run(task, handlers) {
      cancel();
      const id = runId;
      const own = new AbortController();
      controller = own;
      update({ isLoading: true, error: undefined, progress: IDLE_PROGRESS });

      const live = (): boolean => id === runId;

      try {
        const data = await task(own.signal, (done, total) => {
          if (live()) {
            update({ progress: { done, total } });
          }
        });
        if (!live()) {
          return undefined;
        }
        controller = undefined;
        update({ data, isLoading: false });
        handlers?.onSuccess?.(data);
        return data;
      } catch (caught) {
        if (!live() || isAbort(caught)) {
          return undefined;
        }
        controller = undefined;
        const error = caught instanceof Error ? caught : new Error(String(caught));
        update({ isLoading: false, error });
        handlers?.onError?.(error);
        return undefined;
      }
    },

    abort() {
      const wasLoading = state.isLoading;
      cancel();
      if (wasLoading) {
        update({ isLoading: false });
      }
    },

    reset() {
      cancel();
      update({ data: undefined, isLoading: false, error: undefined, progress: IDLE_PROGRESS });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot: () => state,
  };
}
