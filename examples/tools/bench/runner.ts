/**
 * Runner: executes one task x protocol x model run and records metrics.
 * The `runTools` call is injected, so the pure parts are testable with a
 * scripted fake and no model.
 *
 * @module
 */

import type { BackendAdapter, IRChatRequest, IRChatResponse, RunToolsOptions, RunToolsResult } from '@johnhenry/aimatey-types';
import type { BenchTask } from './tasks.js';

export const PROTOCOLS = ['native', 'text', 'code'] as const;
export type ProtocolName = (typeof PROTOCOLS)[number];

/** Counters filled in while a run executes (by the instrumented backend / executor). */
export interface Probe {
  modelCalls: number;
  /** Model calls whose response carried usage numbers. */
  usageCalls: number;
  promptTokens: number;
  completionTokens: number;
  /** Rough character counts, for the estimate when usage is missing. */
  promptChars: number;
  completionChars: number;
  codeSnippets: number;
  codeMs: number;
  codeErrors: number;
}

export const newProbe = (): Probe => ({
  modelCalls: 0,
  usageCalls: 0,
  promptTokens: 0,
  completionTokens: 0,
  promptChars: 0,
  completionChars: 0,
  codeSnippets: 0,
  codeMs: 0,
  codeErrors: 0,
});

export interface RunRecord {
  readonly task: string;
  readonly protocol: ProtocolName;
  readonly model: string;
  readonly repeat: number;
  readonly success: boolean;
  /** Loop iterations (`RunToolsResult.steps.length`); the partial count when the run failed. */
  readonly steps: number;
  /** Backend `execute` calls actually made. */
  readonly modelCalls: number;
  /** Calls the fake tools received. */
  readonly toolCalls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** True when token counts are a chars/4 estimate rather than reported usage. */
  readonly tokensEstimated: boolean;
  readonly wallMs: number;
  /** `code` only: sandbox snippets run, and total time inside the executor (tool time included). */
  readonly codeSnippets?: number;
  readonly codeMs?: number;
  readonly codeErrors?: number;
  readonly timedOut: boolean;
  readonly error?: string;
  /** The model's final answer (truncated), for auditing the checker. */
  readonly answer?: string;
}

export interface RunnerDeps {
  /** Run the loop with the given protocol; the implementation wires `probe` into its backend/executor. */
  runTools(protocol: ProtocolName, options: RunToolsOptions, probe: Probe): Promise<RunToolsResult>;
}

export interface RunOptions {
  readonly timeoutMs: number;
  readonly maxIterations: number;
  readonly temperature?: number;
}

const ANSWER_LIMIT = 400;

export async function runOne(
  task: BenchTask,
  protocol: ProtocolName,
  model: string,
  repeat: number,
  deps: RunnerDeps,
  opts: RunOptions
): Promise<RunRecord> {
  const instance = task.build();
  const probe = newProbe();
  const controller = new AbortController();
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let result: RunToolsResult | undefined;
  let error: string | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(`timed out after ${opts.timeoutMs} ms`));
    }, opts.timeoutMs);
  });
  try {
    result = await Promise.race([
      deps.runTools(
        protocol,
        {
          prompt: task.prompt,
          tools: instance.tools,
          model,
          maxIterations: opts.maxIterations,
          signal: controller.signal,
          ...(opts.temperature !== undefined && { parameters: { temperature: opts.temperature } }),
        },
        probe
      ),
      timeout,
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }
  const wallMs = Date.now() - started;

  const answer = result?.text ?? '';
  let success = false;
  if (result && result.status === 'completed') {
    try {
      success = task.check(answer, instance.calls);
    } catch (e) {
      error = `checker threw: ${(e as Error).message}`;
    }
  } else if (result) {
    error = `status ${result.status}`;
  }

  const estimated = probe.modelCalls > 0 && probe.usageCalls < probe.modelCalls;
  const promptTokens = estimated ? Math.round(probe.promptChars / 4) : probe.promptTokens;
  const completionTokens = estimated ? Math.round(probe.completionChars / 4) : probe.completionTokens;

  return {
    task: task.id,
    protocol,
    model,
    repeat,
    success,
    steps: result?.steps.length ?? probe.modelCalls,
    modelCalls: probe.modelCalls,
    toolCalls: instance.calls.length,
    promptTokens,
    completionTokens,
    tokensEstimated: estimated,
    wallMs,
    ...(protocol === 'code' && {
      codeSnippets: probe.codeSnippets,
      codeMs: probe.codeMs,
      codeErrors: probe.codeErrors,
    }),
    timedOut,
    ...(error !== undefined && { error }),
    ...(answer && { answer: answer.slice(0, ANSWER_LIMIT) }),
  };
}

const charsOf = (value: unknown): number => {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
};

/**
 * Wrap a backend so every `execute` call updates `probe` (call count, usage,
 * character counts). Other members pass through unchanged.
 */
export function instrumentBackend(backend: BackendAdapter, probe: Probe): BackendAdapter {
  return new Proxy(backend, {
    get(target, prop, receiver) {
      if (prop === 'execute') {
        return async (request: IRChatRequest, ...rest: unknown[]): Promise<IRChatResponse> => {
          probe.modelCalls += 1;
          probe.promptChars += charsOf(request.messages) + charsOf(request.tools);
          const response = await (target.execute as (...a: unknown[]) => Promise<IRChatResponse>)(request, ...rest);
          probe.completionChars += charsOf(response.message.content);
          const usage = response.usage;
          if (usage && (usage.promptTokens > 0 || usage.completionTokens > 0)) {
            probe.usageCalls += 1;
            probe.promptTokens += usage.promptTokens;
            probe.completionTokens += usage.completionTokens ?? 0;
          }
          return response;
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * Wrap a code executor to count snippets, executor time and snippet errors.
 * Fuel consumed is not reported by the executor interface, so it is not recorded.
 */
export function instrumentExecutor<E extends { run(code: string, options: any): Promise<{ error?: unknown }> }>(
  executor: E,
  probe: Probe
): E {
  return {
    ...executor,
    async run(code: string, options: unknown) {
      const t0 = Date.now();
      probe.codeSnippets += 1;
      try {
        const out = await executor.run(code, options);
        if (out.error) {
          probe.codeErrors += 1;
        }
        return out;
      } finally {
        probe.codeMs += Date.now() - t0;
      }
    },
  };
}
