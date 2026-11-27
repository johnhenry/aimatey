/**
 * MCP Tools -> ToolDefinition
 *
 * Converts an injected MCP client's tools into the `ToolDefinition` shape
 * consumed by `aimatey-core`'s `Bridge.runTools()` / `createRunTools()`
 * agentic loop - so MCP tool-calling reuses that loop's validation,
 * iteration, and parallel-execution logic rather than reimplementing it.
 *
 * @module
 */

import type { JSONSchema, ToolDefinition } from '@johnhenry/aimatey-types';
import { assertFinalMcpResult, extractMcpResultText, mcpToolToIRTool } from './convert.js';
import type { McpCallToolResult, McpClientLike, McpToolSchema } from './types.js';

export interface McpToolsToDefinitionsOptions {
  /** Which server to list/call tools against (for multi-server clients). */
  readonly server?: string;

  /** Abort signal forwarded to `listTools`/`callTool`. */
  readonly signal?: AbortSignal;

  /**
   * Only include tools for which this returns true. Receives the full MCP
   * tool schema, including `title` and `annotations` (e.g. `destructiveHint`).
   */
  readonly toolFilter?: (tool: McpToolSchema) => boolean;

  /**
   * Run calls through `client.callToolTask(...).result()` when the client
   * provides it, so task-shaped answers are awaited to a final result.
   * Default `false`: some clients reject `callToolTask` on servers that do
   * not advertise the tasks extension. Ignored when the client has no
   * `callToolTask`.
   */
  readonly preferTasks?: boolean;
}

/** Await a task handle's result, cancelling the task if `signal` aborts first. */
async function awaitTask(
  handle: { result(): Promise<McpCallToolResult>; cancel?(): Promise<void> },
  signal?: AbortSignal
): Promise<McpCallToolResult> {
  if (!signal) {
    return handle.result();
  }
  const aborted = (): Error =>
    signal.reason instanceof Error ? signal.reason : new Error('Aborted');
  if (signal.aborted) {
    await handle.cancel?.().catch(() => undefined);
    throw aborted();
  }
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => {
      void handle.cancel?.().catch(() => undefined);
      reject(aborted());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([handle.result(), abortPromise]);
  } finally {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * List an MCP client's tools and convert them into a `Record<string,
 * ToolDefinition>` ready to pass as `RunToolsOptions.tools`.
 *
 * Each `execute` calls `client.callTool(...)`. Per `runTools`'s documented
 * contract ("thrown errors become `isError: true` tool results rather than
 * aborting the loop"), an MCP result with `isError: true` is converted into
 * a thrown `Error` - no special sentinel return value is needed (verified
 * against `createRunTools`, which turns any throw into an `isError: true`
 * tool result).
 *
 * Non-final results never reach the model as text: `input_required` throws
 * `McpInputRequiredError`, an unresolved task handle throws
 * `McpTaskUnresolvedError`.
 */
export async function mcpToolsToDefinitions(
  client: McpClientLike,
  options: McpToolsToDefinitionsOptions = {}
): Promise<Record<string, ToolDefinition>> {
  const { server, signal, toolFilter, preferTasks } = options;

  const tools = await client.listTools(server);
  const filtered = toolFilter ? tools.filter(toolFilter) : tools;

  const definitions: Record<string, ToolDefinition> = {};

  for (const tool of filtered) {
    const irTool = mcpToolToIRTool(tool);
    definitions[tool.name] = {
      description: irTool.description,
      parameters: irTool.parameters,
      ...(irTool.metadata && { metadata: irTool.metadata }),
      ...(tool.outputSchema && { outputSchema: tool.outputSchema as unknown as JSONSchema }),
      execute: async (input) => {
        const callOpts = { server, signal };
        const result =
          preferTasks && client.callToolTask
            ? await awaitTask(await client.callToolTask(tool.name, input, callOpts), signal)
            : await client.callTool(tool.name, input, callOpts);
        // Task handles and input_required rounds are not final results:
        // fail with a typed error (a thrown error is a tool error to the loop).
        assertFinalMcpResult(result, tool.name);
        if (result.isError) {
          throw new Error(extractMcpResultText(result));
        }
        // A declared outputSchema describes structuredContent: return it as
        // the typed value instead of flattening it to text.
        if (tool.outputSchema && result.structuredContent !== undefined) {
          return result.structuredContent;
        }
        return extractMcpResultText(result);
      },
    };
  }

  return definitions;
}
