/**
 * Decision dataset capture
 *
 * Records every decision a `Bridge` makes (state, questions, answers with
 * probabilities, model, usage) as JSONL, and lets you attach the ground
 * truth later with `recordOutcome()`. The resulting file is the dataset
 * shape that fine-tuning loops consume -- Cloudflare's RL platform (AI
 * Gateway captures a dataset of requests, then rollouts, sandbox scoring and
 * a trainer) and Laya's RLCD both start from "requests plus what turned out
 * to be right". aimatey does no training; this is the capture half.
 *
 * Storage is append-only: a decision is one line, an outcome is a separate
 * `{ requestId, outcome }` line, and `records()` / `loadDecisionDataset()`
 * join them on read. Nothing is ever rewritten.
 *
 * @module
 */

import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  DecisionMiddleware,
  IRDecisionAnswer,
  IRDecisionQuestion,
  IRDecisionUsage,
  IRWarning,
} from '@johnhenry/aimatey-types';

/** Ground truth for a decision: the right answer per question name. */
export type DecisionOutcome = Record<string, string | number | boolean>;

/** A decision as written to the sink (one JSON object per line). */
export interface DecisionLogLine {
  readonly requestId: string;
  readonly timestamp: number;
  readonly backend?: string;
  readonly model: string;
  /** Omitted when `includeState` is false; passed through `redact` otherwise. */
  readonly state?: unknown;
  readonly questions: Record<string, IRDecisionQuestion>;
  readonly answers: Record<string, IRDecisionAnswer>;
  readonly usage?: IRDecisionUsage;
  readonly warnings?: readonly IRWarning[];
}

/** An outcome as written to the sink, joined to its decision by `requestId`. */
export interface OutcomeLogLine {
  readonly requestId: string;
  readonly outcome: DecisionOutcome;
  readonly meta?: Record<string, unknown>;
  readonly recordedAt?: number;
}

/** A line in a decision dataset file: either a decision or an outcome. */
export type DecisionCaptureLine = DecisionLogLine | OutcomeLogLine;

/** A decision joined with its outcome(s), as `records()` returns it. */
export interface DecisionRecord extends DecisionLogLine {
  readonly outcome?: DecisionOutcome;
  readonly meta?: Record<string, unknown>;
}

/**
 * Where capture lines go. `write` is called once per line, in order;
 * `read` is only needed for `records()`.
 */
export interface DecisionCaptureSink {
  write(line: DecisionCaptureLine): void | Promise<void>;
  read?(): readonly DecisionCaptureLine[] | Promise<readonly DecisionCaptureLine[]>;
}

/** An in-memory sink; `lines` is the raw append-only log. */
export interface MemoryDecisionSink extends DecisionCaptureSink {
  readonly lines: DecisionCaptureLine[];
}

/** Create an in-memory sink (tests, short-lived processes). */
export function createMemoryDecisionSink(): MemoryDecisionSink {
  const lines: DecisionCaptureLine[] = [];
  return {
    lines,
    write: (line) => {
      lines.push(line);
    },
    read: () => lines,
  };
}

/**
 * A JSONL file sink: appends one JSON object per line, creating the file
 * and its directory on first write.
 */
export function createFileDecisionSink(path: string): DecisionCaptureSink {
  let ready: Promise<unknown> | undefined;
  return {
    write: async (line) => {
      ready ??= mkdir(dirname(path), { recursive: true });
      await ready;
      await appendFile(path, `${JSON.stringify(line)}\n`, 'utf8');
    },
    read: async () => {
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return [];
        }
        throw error;
      }
      return parseDecisionLines(text, path);
    },
  };
}

/** Configuration for {@link createDecisionCapture}. */
export interface DecisionCaptureConfig {
  /** A sink, or a path to a JSONL file (see {@link createFileDecisionSink}). */
  readonly sink: DecisionCaptureSink | string;

  /** Record the request state. Turn off when states are too sensitive to keep. @default true */
  readonly includeState?: boolean;

  /** Transform the state before it is written (scrub PII, truncate). */
  readonly redact?: (state: unknown) => unknown;

  /**
   * Called when the sink fails. Capture never fails the decision it is
   * observing. @default console.error
   */
  readonly onError?: (error: unknown) => void;
}

/** The handle returned by {@link createDecisionCapture}. */
export interface DecisionCapture {
  /** Register with `bridge.useDecision(capture.middleware)`. */
  readonly middleware: DecisionMiddleware;

  /**
   * Record the ground truth for an earlier decision, e.g. once a human
   * labels it or the real-world result is known. Calling again for the
   * same `requestId` merges into the earlier outcome.
   */
  recordOutcome(
    requestId: string,
    outcome: DecisionOutcome,
    meta?: Record<string, unknown>
  ): Promise<void>;

  /** Wait for every pending write to land. */
  flush(): Promise<void>;

  /** All decisions so far with their outcomes joined on (needs a readable sink). */
  records(): Promise<DecisionRecord[]>;
}

/**
 * Capture decisions (and later their outcomes) as a JSONL dataset.
 *
 * @example
 * ```typescript
 * const capture = createDecisionCapture({
 *   sink: 'data/triage.jsonl',
 *   redact: (state) => scrubEmails(state),
 * });
 * bridge.useDecision(capture.middleware);
 *
 * const response = await bridge.decide(ticket, questions);
 * // ...later, when the real answer is known:
 * await capture.recordOutcome(response.metadata.requestId, { team: 'billing' });
 *
 * const runs = toCalibrationRuns(await capture.records());
 * ```
 */
export function createDecisionCapture(config: DecisionCaptureConfig): DecisionCapture {
  const sink = typeof config.sink === 'string' ? createFileDecisionSink(config.sink) : config.sink;
  const includeState = config.includeState ?? true;
  const onError = config.onError ?? ((error: unknown) => console.error('decision capture:', error));

  // Writes are chained so lines land in call order and flush() has one thing to await.
  let pending: Promise<void> = Promise.resolve();
  const enqueue = (line: DecisionCaptureLine): Promise<void> => {
    pending = pending.then(async () => {
      try {
        await sink.write(line);
      } catch (error) {
        onError(error);
      }
    });
    return pending;
  };

  const middleware: DecisionMiddleware = async (request, next) => {
    const response = await next(request);

    // Capture is observation: building the line must not be able to fail the call.
    try {
      const warnings = response.metadata.warnings;
      const backend = response.metadata.provenance?.backend ?? request.metadata.provenance?.backend;
      const line: DecisionLogLine = {
        requestId: request.metadata.requestId,
        timestamp: request.metadata.timestamp,
        ...(backend !== undefined && { backend }),
        model: response.model,
        ...(includeState && {
          state: config.redact ? config.redact(request.state) : request.state,
        }),
        questions: request.questions,
        answers: response.answers,
        ...(response.usage && { usage: response.usage }),
        ...(warnings && warnings.length > 0 && { warnings }),
      };
      void enqueue(line);
    } catch (error) {
      onError(error);
    }

    return response;
  };

  return {
    middleware,
    recordOutcome: (requestId, outcome, meta) =>
      enqueue({
        requestId,
        outcome,
        ...(meta && { meta }),
        recordedAt: Date.now(),
      }),
    flush: () => pending,
    async records() {
      await pending;
      if (!sink.read) {
        throw new Error('createDecisionCapture: this sink has no read(); cannot join records');
      }
      return joinDecisionLines(await sink.read());
    },
  };
}

function isOutcomeLine(line: DecisionCaptureLine): line is OutcomeLogLine {
  return !('answers' in line) && 'outcome' in line;
}

/** Join decision lines with the outcome lines that reference them. */
export function joinDecisionLines(lines: readonly DecisionCaptureLine[]): DecisionRecord[] {
  const byId = new Map<string, DecisionRecord>();
  const order: string[] = [];

  for (const line of lines) {
    if (isOutcomeLine(line)) {
      const record = byId.get(line.requestId);
      if (!record) {
        continue; // outcome for a decision this log never saw
      }
      byId.set(line.requestId, {
        ...record,
        outcome: { ...record.outcome, ...line.outcome },
        ...((record.meta || line.meta) && { meta: { ...record.meta, ...line.meta } }),
      });
    } else {
      if (!byId.has(line.requestId)) {
        order.push(line.requestId);
      }
      byId.set(line.requestId, { ...line });
    }
  }

  return order.map((id) => byId.get(id)!);
}

function parseDecisionLines(text: string, source: string): DecisionCaptureLine[] {
  const lines: DecisionCaptureLine[] = [];
  text.split('\n').forEach((raw, index) => {
    if (!raw.trim()) {
      return;
    }
    try {
      lines.push(JSON.parse(raw) as DecisionCaptureLine);
    } catch {
      throw new Error(`${source}: malformed JSON on line ${index + 1}`);
    }
  });
  return lines;
}

/**
 * Load a captured JSONL file and join outcomes onto their decisions.
 *
 * @throws Error naming the line of the first malformed JSON line
 */
export async function loadDecisionDataset(path: string): Promise<DecisionRecord[]> {
  return joinDecisionLines(parseDecisionLines(await readFile(path, 'utf8'), path));
}

/**
 * One scored answer: what the model said and what was true. Shaped as
 * `{ answer, truth }` for the `calibrationReport` helper planned for this
 * package; defined here until that lands.
 */
export interface CalibrationRun {
  readonly answer: IRDecisionAnswer;
  readonly truth: string | number | boolean;
}

/**
 * Turn captured records into calibration inputs: for each question name,
 * every `{ answer, truth }` pair where an outcome was recorded.
 * Decisions without an outcome for a question are skipped.
 */
export function toCalibrationRuns(
  records: readonly DecisionRecord[]
): Record<string, CalibrationRun[]> {
  const runs: Record<string, CalibrationRun[]> = {};
  for (const record of records) {
    if (!record.outcome) {
      continue;
    }
    for (const [question, truth] of Object.entries(record.outcome)) {
      const answer = record.answers[question];
      if (!answer) {
        continue;
      }
      (runs[question] ??= []).push({ answer, truth });
    }
  }
  return runs;
}
