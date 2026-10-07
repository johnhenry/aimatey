/**
 * Stream Contract
 *
 * Enforcement for the `IRChatStream` contract documented on the types in
 * `@johnhenry/aimatey-types`:
 *
 * - **Termination** (#126): a stream ends with exactly one `done` or `error`
 *   chunk. {@link withTerminationGuard} makes that true of every stream it wraps.
 * - **Authoritative text** (#119): the `delta`s are the text; `accumulated`
 *   equals their running sum; `done.message` equals their total.
 * - **Resumption** (#125): a `resumedFrom` marker continues the numbering.
 *
 * {@link validateStreamContract} checks a recorded stream; {@link monitorStreamContract}
 * checks a live one without altering it.
 *
 * @module
 */

import type {
  IRChatStream,
  IRMessage,
  IRStreamChunk,
  StreamContractViolation,
  StreamErrorChunk,
} from '@johnhenry/aimatey-types';

// ============================================================================
// Text of a message
// ============================================================================

/**
 * The text of a message: the string itself, or its `text` blocks concatenated
 * in order. Tool calls, images and the like carry no text and are skipped.
 */
export function getMessageText(message: IRMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }
  let text = '';
  for (const block of message.content) {
    if (block.type === 'text') {
      text += block.text;
    }
  }
  return text;
}

// ============================================================================
// Contract monitor (stateful, per stream)
// ============================================================================

/**
 * Incremental checker for one stream. Feed it every chunk with `observe()` and
 * call `end()` when the stream's iterator completes.
 */
export interface StreamContractMonitor {
  /** Check one chunk; returns the violations *it* introduced. */
  observe(chunk: IRStreamChunk): StreamContractViolation[];
  /** Check the stream as a whole once it has ended. */
  end(): StreamContractViolation[];
}

/**
 * Create a monitor for one stream.
 *
 * Text consistency is only checked from a stream's first content chunk and only
 * when `accumulated` / `done.message` are actually present, so a delta-only
 * stream without a `message` costs one string append per chunk.
 */
export function createStreamContractMonitor(): StreamContractMonitor {
  let terminal = false;
  let lastSequence: number | undefined;
  let text = '';

  return {
    observe(chunk) {
      const violations: StreamContractViolation[] = [];
      const sequence = chunk.sequence;

      if (terminal) {
        violations.push({
          code: 'chunk-after-terminal',
          message: `A '${chunk.type}' chunk (sequence ${sequence}) followed the stream's terminal chunk`,
          sequence,
        });
        return violations;
      }

      if (chunk.resumedFrom !== undefined && sequence !== chunk.resumedFrom.sequence + 1) {
        violations.push({
          code: 'resumed-sequence-mismatch',
          message: `Chunk at sequence ${sequence} is marked resumed from ${chunk.resumedFrom.sequence}; a resumed stream continues the numbering, so it must carry sequence ${chunk.resumedFrom.sequence + 1}`,
          sequence,
        });
      }

      if (chunk.type === 'content') {
        text += chunk.delta;
        if (chunk.accumulated !== undefined && chunk.accumulated !== text) {
          violations.push({
            code: 'accumulated-mismatch',
            message: `'accumulated' at sequence ${sequence} (${chunk.accumulated.length} chars) is not the sum of the deltas so far (${text.length} chars)`,
            sequence,
          });
        }
      } else if (chunk.type === 'done') {
        terminal = true;
        if (chunk.message !== undefined) {
          const messageText = getMessageText(chunk.message);
          if (messageText !== text) {
            violations.push({
              code: 'done-message-mismatch',
              message: `'done.message' text (${messageText.length} chars) is not the sum of the deltas (${text.length} chars); the message is authoritative, so the delta-built text is damaged`,
              sequence,
            });
          }
        }
      } else if (chunk.type === 'error') {
        terminal = true;
      }

      lastSequence = sequence;
      return violations;
    },

    end() {
      if (terminal) {
        return [];
      }
      return [
        {
          code: 'missing-terminal',
          message:
            lastSequence === undefined
              ? 'The stream ended without producing any chunk, so without a done or error chunk'
              : `The stream ended after sequence ${lastSequence} without a done or error chunk`,
          ...(lastSequence !== undefined ? { sequence: lastSequence } : {}),
        },
      ];
    },
  };
}

// ============================================================================
// Recorded streams
// ============================================================================

/**
 * Result of {@link validateStreamContract}.
 */
export interface StreamContractResult {
  readonly valid: boolean;
  readonly violations: readonly StreamContractViolation[];
}

/**
 * Check a recorded stream against the termination, text-consistency and
 * resumption rules. Sequence numbering is {@link validateChunkSequence}'s job
 * and is deliberately not repeated here.
 */
export function validateStreamContract(chunks: readonly IRStreamChunk[]): StreamContractResult {
  const monitor = createStreamContractMonitor();
  const violations: StreamContractViolation[] = [];
  for (const chunk of chunks) {
    violations.push(...monitor.observe(chunk));
  }
  violations.push(...monitor.end());
  return { valid: violations.length === 0, violations };
}

// ============================================================================
// Live streams
// ============================================================================

function report(
  onViolation: ((violation: StreamContractViolation) => void) | undefined,
  violations: readonly StreamContractViolation[]
): void {
  if (!onViolation) {
    return;
  }
  for (const violation of violations) {
    try {
      onViolation(violation);
    } catch {
      // A diagnostic hook must not be able to fail a stream.
    }
  }
}

/**
 * Pass a stream through untouched while reporting every contract violation to
 * `onViolation`. Never throws, drops or reorders a chunk; this is the dev/test
 * mode check, not an enforcer (see {@link withTerminationGuard} for that).
 */
export async function* monitorStreamContract(
  stream: IRChatStream,
  onViolation: (violation: StreamContractViolation) => void
): IRChatStream {
  const monitor = createStreamContractMonitor();
  for await (const chunk of stream) {
    report(onViolation, monitor.observe(chunk));
    yield chunk;
  }
  // `missing-terminal` is reported by withTerminationGuard when both run.
}

/**
 * Options for {@link withTerminationGuard}.
 */
export interface TerminationGuardOptions {
  /**
   * The request's abort signal. A stream that ends without a terminal chunk
   * *after* the signal aborted was cancelled, not truncated, and is left alone.
   */
  signal?: AbortSignal;

  /** Told when the guard synthesizes a terminal chunk. */
  onViolation?: (violation: StreamContractViolation) => void;

  /** Backend name, recorded in the synthesized error's `details`. */
  backend?: string;
}

/**
 * Guarantee that a stream ends with exactly one terminal chunk (#126).
 *
 * - **Silent end.** If the iterator completes without a `done` or `error`
 *   chunk, an `error` chunk is appended: `code: 'stream-truncated'`, numbered as
 *   the next sequence so the stream stays contiguous, with the last sequence
 *   seen in `details`. The consumer is told the truth rather than shown a
 *   fluent but cut-off answer as if it were complete.
 * - **After the terminal chunk.** Anything the source yields past `done` or
 *   `error` is dropped (and reported), so no second terminal chunk can follow.
 *   The source is still drained to its end, not closed early: a generator may
 *   have work to do once its last chunk is out.
 * - **Cancellation.** If `options.signal` has aborted, a silent end is left
 *   alone. A source that *throws* is never intercepted: the exception reaches
 *   the caller exactly as before.
 *
 * A stream that already honours the contract passes through chunk-for-chunk.
 */
export async function* withTerminationGuard(
  stream: IRChatStream,
  options: TerminationGuardOptions = {}
): IRChatStream {
  let lastSequence = -1;
  let chunkCount = 0;
  let terminated = false;

  for await (const chunk of stream) {
    if (terminated) {
      // Exactly one terminal chunk, and nothing after it. The source is still
      // drained rather than closed: a generator (a middleware's, say) may have
      // work to do once its last chunk is out, and abandoning it would skip it.
      report(options.onViolation, [
        {
          code: 'chunk-after-terminal',
          message: `A '${chunk.type}' chunk (sequence ${chunk.sequence}) followed the stream's terminal chunk and was dropped`,
          sequence: chunk.sequence,
        },
      ]);
      continue;
    }
    lastSequence = chunk.sequence;
    chunkCount++;
    yield chunk;
    if (chunk.type === 'done' || chunk.type === 'error') {
      terminated = true;
    }
  }

  if (terminated) {
    return;
  }

  if (options.signal?.aborted) {
    return;
  }

  const violation: StreamContractViolation = {
    code: 'missing-terminal',
    message:
      chunkCount === 0
        ? 'The stream ended without producing any chunk, so without a done or error chunk'
        : `The stream ended after sequence ${lastSequence} without a done or error chunk`,
    ...(chunkCount > 0 ? { sequence: lastSequence } : {}),
  };
  report(options.onViolation, [violation]);

  const truncated: StreamErrorChunk = {
    type: 'error',
    sequence: lastSequence + 1,
    error: {
      code: 'stream-truncated',
      message: `${violation.message}. A stream must end with a done or error chunk; the answer received so far is incomplete.`,
      details: {
        lastSequence: chunkCount > 0 ? lastSequence : null,
        chunks: chunkCount,
        ...(options.backend !== undefined ? { backend: options.backend } : {}),
      },
    },
  };
  yield truncated;
}
