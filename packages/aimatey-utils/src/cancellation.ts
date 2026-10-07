/**
 * Forwardable cancellation helpers (#121).
 *
 * `AbortSignal` cannot cross a transport. These helpers connect it to
 * `BackendAdapter.cancel()` on the near side and, on the far side, map an
 * incoming cancel back onto the `AbortController` of the request being run.
 * Both are keyed on `IRMetadata.requestId`.
 *
 * @module
 */

import type { BackendAdapter } from '@johnhenry/aimatey-types';

/**
 * Deliver one best-effort `cancel()` to the adapter. Never throws and never
 * rejects: the signal, not this call, settles the caller's promise or stream.
 */
function sendCancel(adapter: Pick<BackendAdapter, 'cancel'>, requestId: string, reason: unknown) {
  try {
    // `Promise.resolve` also absorbs a synchronous return, so one path covers both.
    Promise.resolve(adapter.cancel?.(requestId, reason)).catch(() => undefined);
  } catch {
    // Best effort by contract.
  }
}

/**
 * Arm `signal` so that aborting it calls `adapter.cancel(requestId, reason)`
 * once. If the signal is already aborted the cancel is sent immediately.
 *
 * @returns A disposer that detaches the listener; call it when the request
 *   settles so a later abort cancels nothing.
 */
function arm(
  adapter: Pick<BackendAdapter, 'cancel'>,
  requestId: string,
  signal: AbortSignal | undefined
): () => void {
  if (!signal || typeof adapter.cancel !== 'function') {
    return () => undefined;
  }
  if (signal.aborted) {
    sendCancel(adapter, requestId, signal.reason);
    return () => undefined;
  }
  const onAbort = (): void => sendCancel(adapter, requestId, signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/**
 * Run `run` and, if `signal` aborts while it is pending, call
 * `adapter.cancel(requestId)` once. A no-op wrapper for an adapter without
 * `cancel()` or a call without a signal.
 *
 * `Bridge` uses this around its backend call; a proxy registered behind a
 * `Router` (which hands its backends only the signal) can use it around its
 * own transport call.
 */
export async function withCancellation<T>(
  adapter: Pick<BackendAdapter, 'cancel'>,
  requestId: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>
): Promise<T> {
  const disarm = arm(adapter, requestId, signal);
  try {
    return await run();
  } finally {
    disarm();
  }
}

/**
 * Streaming counterpart of {@link withCancellation}: the listener is armed
 * when the stream starts being consumed and detached when it ends, throws, or
 * is abandoned by the consumer.
 */
export async function* withStreamCancellation<T>(
  adapter: Pick<BackendAdapter, 'cancel'>,
  requestId: string,
  signal: AbortSignal | undefined,
  stream: AsyncGenerator<T, void, undefined>
): AsyncGenerator<T, void, undefined> {
  const disarm = arm(adapter, requestId, signal);
  try {
    yield* stream;
  } finally {
    disarm();
  }
}

/** A request registered with a {@link CancellationRegistry}. */
export interface RegisteredRequest {
  /** Pass this to the in-process `execute` / `executeStream` call. */
  readonly signal: AbortSignal;
  /** Remove the registration; call it when the request settles. */
  release(): void;
}

/** Options for {@link createCancellationRegistry}. */
export interface CancellationRegistryOptions {
  /**
   * How long, in milliseconds, to remember a cancel for a request id that had
   * not been registered yet, so a cancel that overtakes its request on the
   * wire is still honoured (once). `0` (the default) remembers nothing:
   * `requestId` is reused across retries, so a remembered cancel can abort a
   * legitimate later attempt, and the window is a deliberate opt-in.
   * @default 0
   */
  readonly tombstoneMs?: number;
}

/**
 * Far-side bookkeeping for cancellation: maps a `requestId` named by an
 * incoming cancel message onto the `AbortController`s of the requests this
 * process is running for it.
 */
export interface CancellationRegistry {
  /** Start tracking a request. Several registrations may share one id (retries). */
  register(requestId: string): RegisteredRequest;
  /**
   * Abort every in-flight request registered under `requestId`.
   * @returns `false` when nothing was in flight -- the request already
   *   finished, never arrived, or was already cancelled. That is a no-op, not
   *   an error.
   */
  cancel(requestId: string, reason?: unknown): boolean;
  /** Number of requests currently tracked. */
  readonly size: number;
}

/**
 * Create a {@link CancellationRegistry}.
 *
 * @example
 * ```typescript
 * const registry = createCancellationRegistry();
 * // on POST /chat
 * const { signal, release } = registry.register(ir.metadata.requestId);
 * try { return await bridge.executeIR(ir, { signal }); } finally { release(); }
 * // on POST /cancel { requestId }
 * registry.cancel(requestId);
 * ```
 */
export function createCancellationRegistry(
  options: CancellationRegistryOptions = {}
): CancellationRegistry {
  const tombstoneMs = options.tombstoneMs ?? 0;
  const inFlight = new Map<string, Set<AbortController>>();
  const tombstones = new Map<string, { reason: unknown; expires: number }>();

  return {
    register(requestId) {
      const controller = new AbortController();

      const tombstone = tombstones.get(requestId);
      if (tombstone) {
        tombstones.delete(requestId);
        if (tombstone.expires > Date.now()) {
          controller.abort(tombstone.reason);
        }
      }

      let set = inFlight.get(requestId);
      if (!set) {
        set = new Set();
        inFlight.set(requestId, set);
      }
      set.add(controller);

      return {
        signal: controller.signal,
        release() {
          const current = inFlight.get(requestId);
          current?.delete(controller);
          if (current?.size === 0) {
            inFlight.delete(requestId);
          }
        },
      };
    },

    cancel(requestId, reason) {
      const set = inFlight.get(requestId);
      if (!set || set.size === 0) {
        if (tombstoneMs > 0) {
          const now = Date.now();
          for (const [id, entry] of tombstones) {
            if (entry.expires <= now) {
              tombstones.delete(id);
            }
          }
          tombstones.set(requestId, { reason, expires: now + tombstoneMs });
        }
        return false;
      }
      for (const controller of set) {
        controller.abort(reason);
      }
      return true;
    },

    get size() {
      let n = 0;
      for (const set of inFlight.values()) {
        n += set.size;
      }
      return n;
    },
  };
}
