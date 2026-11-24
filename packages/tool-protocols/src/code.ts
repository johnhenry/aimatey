/**
 * The `code` tool protocol: the model writes JavaScript against a generated
 * `tools.*` API; a {@link CodeExecutor} runs it and every tool call inside
 * goes back through the loop's `invoke` (validation, gate, execute).
 *
 * @module
 */

import { registerToolProtocol } from '@johnhenry/aimatey-core';
import type {
  IRChatRequest,
  IRChatResponse,
  IRMessage,
  ToolProtocol,
  ToolProtocolCall,
  ToolProtocolContext,
  ToolProtocolOutcome,
  ToolProtocolResult,
} from '@johnhenry/aimatey-types';
import { buildCodePrompt } from './code-api.js';

export { generateToolsInterface, schemaToTs, buildCodePrompt } from './code-api.js';
export { andboxExecutor, type AndboxExecutorOptions } from './andbox-executor.js';

/** Resource limits for one snippet. Executors apply what they support. */
export interface CodeLimits {
  /** Deterministic instruction budget. */
  fuel?: number;
  /** Guest heap cap in bytes. */
  memoryBytes?: number;
  /** Guest call-stack cap in bytes. */
  stackBytes?: number;
  /** Wall-clock deadline for the snippet, including tool time. */
  deadlineMs?: number;
  /** Maximum tool calls one snippet may make. */
  maxToolCalls?: number;
}

/** What an executor gets for one snippet. */
export interface CodeRunOptions {
  /** Run a tool through the host. Rejects (throws in the guest) when the call fails or is denied. */
  callTool(name: string, input: unknown): Promise<unknown>;
  /** Names of the tools to expose as `tools.<name>`. */
  toolNames: string[];
  limits?: CodeLimits;
  signal?: AbortSignal;
}

/** Outcome of running one snippet. */
export interface CodeRunResult {
  /** Lines the snippet printed with `console.*`. */
  logs: string[];
  /** The value the snippet returned (JSON-safe), if any. */
  result?: unknown;
  /** Set when the snippet called `final(answer)`. */
  final?: { answer: unknown };
  error?: { name: string; message: string; code?: string };
}

/**
 * Runs model-written JavaScript. The interface has no sandbox dependency;
 * `andboxExecutor()` is the bundled implementation. Implementations must
 * expose `tools.<name>(input)`, `console.*` and `final(answer)` to the code.
 */
export interface CodeExecutor {
  run(code: string, options: CodeRunOptions): Promise<CodeRunResult>;
}

export interface CodeProtocolOptions {
  executor: CodeExecutor;
  /** Truncate the feedback message to this many characters. @default 4000 */
  maxLogChars?: number;
  limits?: CodeLimits;
}

const DEFAULT_MAX_LOG_CHARS = 4000;

/** First js/javascript/ts fenced block (or an untagged one); tolerates a missing closing fence. */
export function extractCodeBlock(text: string): string | undefined {
  const re = /```[ \t]*([A-Za-z]*)[^\n]*\n([\s\S]*?)(?:```|$)/g;
  for (const m of text.matchAll(re)) {
    const lang = (m[1] ?? '').toLowerCase();
    if (['', 'js', 'javascript', 'ts', 'typescript', 'mjs'].includes(lang)) {
      return m[2];
    }
  }
  return undefined;
}

function messageText(response: IRChatResponse): string {
  const content = response.message.content;
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function show(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}

/**
 * Create the `code` protocol. The model writes JavaScript instead of
 * emitting tool calls; tools are not sent in `request.tools`.
 */
export function codeProtocol(options: CodeProtocolOptions): ToolProtocol {
  const { executor, limits } = options;
  const maxLogChars = options.maxLogChars ?? DEFAULT_MAX_LOG_CHARS;

  return {
    name: 'code',

    prepare(request: IRChatRequest, context: ToolProtocolContext): IRChatRequest {
      const prompt = buildCodePrompt(context.tools);
      const messages: IRMessage[] = [...request.messages];
      const first = messages[0];
      if (first?.role === 'system' && typeof first.content === 'string') {
        messages[0] = { ...first, content: `${first.content}\n\n${prompt}` };
      } else {
        messages.unshift({ role: 'system', content: prompt });
      }
      return { ...request, messages, tools: undefined };
    },

    async interpret(
      response: IRChatResponse,
      context: ToolProtocolContext
    ): Promise<ToolProtocolOutcome> {
      const code = extractCodeBlock(messageText(response));
      if (code === undefined) {
        return { kind: 'final' };
      }

      const calls: ToolProtocolCall[] = [];
      const results: ToolProtocolResult[] = [];
      const callTool = async (name: string, input: unknown): Promise<unknown> => {
        const call: ToolProtocolCall = {
          id: `code-${context.iteration}-${calls.length + 1}`,
          name,
          input:
            typeof input === 'object' && input !== null && !Array.isArray(input)
              ? (input as Record<string, unknown>)
              : input === undefined || input === null
                ? {}
                : { value: input },
        };
        calls.push(call);
        const result = await context.invoke(call);
        results.push(result);
        if (result.isError) {
          throw new Error(show(result.result));
        }
        return result.result;
      };

      let run: CodeRunResult;
      try {
        run = await executor.run(code, {
          callTool,
          toolNames: Object.keys(context.tools),
          ...(limits && { limits }),
          ...(context.signal && { signal: context.signal }),
        });
      } catch (error) {
        context.signal?.throwIfAborted();
        run = {
          logs: [],
          error: {
            name: error instanceof Error ? error.name : 'Error',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }

      if (run.final) {
        return { kind: 'final', text: show(run.final.answer) };
      }

      const parts: string[] = [];
      if (run.logs.length > 0) {
        parts.push(`Output:\n${run.logs.join('\n')}`);
      }
      if (run.error) {
        parts.push(
          `Error (${run.error.name}${run.error.code ? `, ${run.error.code}` : ''}): ${run.error.message}`
        );
      } else if (run.result !== undefined) {
        parts.push(`Returned: ${show(run.result)}`);
      }
      if (parts.length === 0) {
        parts.push('The code ran and produced no output and no return value.');
      }

      return {
        kind: 'continue',
        calls,
        results,
        messages: [
          response.message,
          { role: 'user', content: truncate(parts.join('\n\n'), maxLogChars) },
        ],
      };
    },
  };
}

/** Register the `code` protocol so `runTools({ protocol: 'code' })` resolves it. */
export function registerCodeProtocol(
  executor: CodeExecutor,
  options: Omit<CodeProtocolOptions, 'executor'> = {}
): ToolProtocol {
  const protocol = codeProtocol({ ...options, executor });
  registerToolProtocol(protocol);
  return protocol;
}
