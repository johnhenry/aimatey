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
import { extractMcpResultText, mcpToolToIRTool } from './convert.js';
import type { McpClientLike, McpToolSchema } from './types.js';

export interface McpToolsToDefinitionsOptions {
  /** Which server to list/call tools against (for multi-server clients). */
  readonly server?: string;

  /** Abort signal forwarded to `listTools`/`callTool`. */
  readonly signal?: AbortSignal;

  /** Only include tools for which this returns true. */
  readonly toolFilter?: (tool: McpToolSchema) => boolean;
}

/**
 * List an MCP client's tools and convert them into a `Record<string,
 * ToolDefinition>` ready to pass as `RunToolsOptions.tools`.
 *
 * Each `execute` calls `client.callTool(...)`. Per `runTools`'s documented
 * contract ("thrown errors become `isError: true` tool results rather than
 * aborting the loop"), an MCP result with `isError: true` is converted into
 * a thrown `Error` - no special sentinel return value is needed.
 */
export async function mcpToolsToDefinitions(
  client: McpClientLike,
  options: McpToolsToDefinitionsOptions = {}
): Promise<Record<string, ToolDefinition>> {
  const { server, signal, toolFilter } = options;

  const tools = await client.listTools(server);
  const filtered = toolFilter ? tools.filter(toolFilter) : tools;

  const definitions: Record<string, ToolDefinition> = {};

  for (const tool of filtered) {
    const irTool = mcpToolToIRTool(tool);
    definitions[tool.name] = {
      description: irTool.description,
      parameters: irTool.parameters,
      ...(tool.outputSchema && { outputSchema: tool.outputSchema as unknown as JSONSchema }),
      execute: async (input) => {
        const result = await client.callTool(tool.name, input, { server, signal });
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
