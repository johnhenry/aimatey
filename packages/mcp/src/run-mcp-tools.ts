/**
 * MCP Tool-Execution Convenience Wrapper
 *
 * `runMcpTools(runTools, options)` composes `mcpToolsToDefinitions` with an
 * already-existing `runTools` function (e.g. `bridge.runTools`) from the
 * *outside* - this package never imports `aimatey-core`, matching
 * `createRunTools`'s own `RunToolsBridge` structural-typing idiom.
 *
 * @module
 */

import type { RunToolsOptions, RunToolsResult } from '@johnhenry/aimatey-types';
import { mcpToolsToDefinitions } from './tool-definitions.js';
import type { McpClientLike, McpToolSchema } from './types.js';

export interface RunMcpToolsOptions extends Omit<RunToolsOptions, 'tools'> {
  /** The injected MCP client to list/call tools against. */
  readonly client: McpClientLike;

  /** Which server to list/call tools against (for multi-server clients). */
  readonly server?: string;

  /** Only include tools for which this returns true. */
  readonly toolFilter?: (tool: McpToolSchema) => boolean;

  /** Await task-shaped results via `client.callToolTask`; see `McpToolsToDefinitionsOptions`. */
  readonly preferTasks?: boolean;
}

/**
 * Run an MCP-backed agentic tool-call loop.
 *
 * @param runTools - A bound `runTools` function, e.g. `bridge.runTools`
 *   (every `Bridge` instance exposes this already).
 * @param options - MCP client plus the usual `RunToolsOptions` (`prompt`/
 *   `messages`, `maxIterations`, etc.) minus `tools`, which is built from
 *   the MCP client automatically.
 *
 * @example
 * ```typescript
 * const result = await runMcpTools(bridge.runTools, {
 *   client: mcpClient,
 *   prompt: 'What files changed in the last commit?',
 * });
 * ```
 */
export async function runMcpTools(
  runTools: (options: RunToolsOptions) => Promise<RunToolsResult>,
  options: RunMcpToolsOptions
): Promise<RunToolsResult> {
  const { client, server, toolFilter, preferTasks, signal, ...runToolsOptions } = options;
  const tools = await mcpToolsToDefinitions(client, { server, signal, toolFilter, preferTasks });
  return runTools({ ...runToolsOptions, signal, tools });
}
