/**
 * {@link CodeExecutor} backed by `@johnhenry/andbox` in `mode: 'wasm'`
 * (QuickJS-ng compiled to WebAssembly). andbox is an OPTIONAL peer
 * dependency, loaded lazily.
 *
 * @module
 */

import type { CodeExecutor, CodeLimits, CodeRunOptions, CodeRunResult } from './code.js';

/** Minimal shape of andbox that this adapter uses. */
interface AndboxLike {
  createSandbox(options: Record<string, unknown>): Promise<{
    evaluate(code: string, opts?: Record<string, unknown>): Promise<unknown>;
    dispose(): void | Promise<void>;
  }>;
}

export interface AndboxExecutorOptions {
  /** Defaults applied under per-run limits. */
  limits?: CodeLimits;
  /** Extra `createSandbox` options (e.g. `engineURL`/`wasmURL` in browsers). */
  sandboxOptions?: Record<string, unknown>;
  /** Supply the andbox module yourself instead of `import('@johnhenry/andbox')`. */
  andbox?: AndboxLike;
}

export const DEFAULT_CODE_LIMITS: Required<Omit<CodeLimits, 'stackBytes'>> & CodeLimits = {
  fuel: 20_000,
  memoryBytes: 32 * 1024 * 1024,
  deadlineMs: 10_000,
  maxToolCalls: 50,
};

async function loadAndbox(): Promise<AndboxLike> {
  try {
    return (await import('@johnhenry/andbox')) as unknown as AndboxLike;
  } catch (error) {
    throw new Error(
      'andboxExecutor needs the optional peer @johnhenry/andbox (>=0.0.8) and its wasm engine: ' +
        'npm install @johnhenry/andbox && npm install --save-exact quickjs-emscripten-core@0.32.0 ' +
        `@jitl/quickjs-ng-wasmfile-release-sync@0.32.0 (${error instanceof Error ? error.message : String(error)})`,
      { cause: error }
    );
  }
}

/** JSON-safe copy of any tool result: bigint, Date, Map/Set, cycles and functions never throw. */
export function toJsonSafe(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  const seen = new WeakSet<object>();
  try {
    const text = JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v === 'bigint') {
        return v.toString();
      }
      if (typeof v === 'function') {
        return '[Function]';
      }
      if (typeof v === 'symbol') {
        return v.toString();
      }
      if (v instanceof Map) {
        return Object.fromEntries(v);
      }
      if (v instanceof Set) {
        return [...v];
      }
      if (v instanceof Error) {
        return { name: v.name, message: v.message };
      }
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) {
          return '[Circular]';
        }
        seen.add(v);
      }
      return v;
    });
    return text === undefined ? null : (JSON.parse(text) as unknown);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

// Written as one line so the user's code keeps its own line numbers.
function prelude(toolNames: string[]): string {
  return (
    `const tools = Object.fromEntries(${JSON.stringify(toolNames)}.map((n) => [n, (input) => host.call('tool', n, input === undefined ? {} : input)]));` +
    `const final = (answer) => host.call('final', answer);`
  );
}

/**
 * Executor using andbox wasm mode. A fresh sandbox (and so a fresh QuickJS
 * runtime) is created per snippet and disposed afterwards.
 */
export function andboxExecutor(options: AndboxExecutorOptions = {}): CodeExecutor {
  return {
    async run(code: string, run: CodeRunOptions): Promise<CodeRunResult> {
      const andbox = options.andbox ?? (await loadAndbox());
      const limits = { ...DEFAULT_CODE_LIMITS, ...options.limits, ...run.limits };
      const logs: string[] = [];
      let final: { answer: unknown } | undefined;
      const toolNames = new Set(run.toolNames);

      const sandbox = await andbox.createSandbox({
        mode: 'wasm',
        ...options.sandboxOptions,
        capabilities: {
          tool: async (name: unknown, input: unknown) => {
            if (typeof name !== 'string' || !toolNames.has(name)) {
              throw new Error(`Unknown tool: ${String(name)}`);
            }
            return toJsonSafe(await run.callTool(name, input));
          },
          final: (answer: unknown) => {
            final = { answer };
            return null;
          },
        },
        policy: { capabilities: { tool: { maxCalls: limits.maxToolCalls } } },
        fuel: limits.fuel,
        memoryBytes: limits.memoryBytes,
        deadlineMs: limits.deadlineMs,
        ...(limits.stackBytes !== undefined && { stackBytes: limits.stackBytes }),
        onConsole: (level: string, ...args: unknown[]) => {
          const line = args
            .map((a) => (typeof a === 'string' ? a : JSON.stringify(toJsonSafe(a))))
            .join(' ');
          logs.push(level === 'log' || level === 'info' ? line : `[${level}] ${line}`);
        },
      });

      try {
        const result = await sandbox.evaluate(`${prelude(run.toolNames)}\n${code}`, {
          ...(run.signal && { signal: run.signal }),
          timeoutMs: limits.deadlineMs + 1000,
        });
        return { logs, ...(result !== undefined && { result }), ...(final && { final }) };
      } catch (error) {
        const e = error as { name?: string; message?: string; code?: string };
        return {
          logs,
          ...(final && { final }),
          error: {
            name: e?.name ?? 'Error',
            message: e?.message ?? String(error),
            ...(e?.code && { code: e.code }),
          },
        };
      } finally {
        await sandbox.dispose();
      }
    },
  };
}
