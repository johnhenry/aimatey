/**
 * MCP <-> IR Translation
 *
 * Pure functions converting between MCP's tool/result shapes and aimatey's
 * IR types. No client, no I/O - just the mapping.
 *
 * @module
 */

import type { IRTool, JSONSchema } from '@johnhenry/aimatey-types';
import { McpInputRequiredError, McpTaskUnresolvedError } from './errors.js';
import type { McpCallToolResult, McpContentBlock, McpToolSchema } from './types.js';

/**
 * Convert an MCP tool schema to an IR tool definition.
 *
 * `IRTool.description` is required; MCP's is optional, so a missing
 * description becomes an empty string rather than `undefined`.
 */
export function mcpToolToIRTool(tool: McpToolSchema): IRTool {
  // MCP-only metadata rides in the IR tool's `metadata` slot under `mcp`.
  const mcp: Record<string, unknown> = {};
  if (tool.title !== undefined) {
    mcp.title = tool.title;
  }
  if (tool.annotations !== undefined) {
    mcp.annotations = tool.annotations;
  }
  if (tool.outputSchema !== undefined) {
    mcp.outputSchema = tool.outputSchema;
  }

  return {
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.inputSchema as unknown as JSONSchema,
    ...(Object.keys(mcp).length > 0 && { metadata: { mcp } }),
  };
}

/** True when a `tools/call` result is a task handle rather than a final result. */
export function isMcpTaskResult(result: McpCallToolResult): boolean {
  return (
    typeof result.taskId === 'string' &&
    (result.resultType === 'task' ||
      (typeof result.status === 'string' && result.content === undefined))
  );
}

/** True when a `tools/call` result asks for in-band input (elicitation). */
export function isMcpInputRequiredResult(result: McpCallToolResult): boolean {
  return result.resultType === 'input_required';
}

/**
 * Throw a typed error if `result` is not a final tool result (a task handle
 * or an `input_required` round). Returns normally otherwise.
 */
export function assertFinalMcpResult(result: McpCallToolResult, toolName?: string): void {
  if (isMcpInputRequiredResult(result)) {
    throw new McpInputRequiredError(result, toolName);
  }
  if (isMcpTaskResult(result)) {
    throw new McpTaskUnresolvedError(result, toolName);
  }
}

/**
 * Extract a best-effort text representation of an MCP tool call result, for
 * feeding back to the model as a tool result.
 *
 * Joins `text` fields from content blocks; if none are present, falls back
 * to JSON-stringifying `structuredContent` (or the raw content array).
 *
 * @throws {McpInputRequiredError} for `input_required` results.
 * @throws {McpTaskUnresolvedError} for task handles that were not resolved.
 */
export function extractMcpResultText(result: McpCallToolResult): string {
  assertFinalMcpResult(result);

  const content = result.content ?? [];
  const text = content
    .filter((block): block is McpContentBlockWithText => typeof block.text === 'string')
    .map((block) => block.text)
    .join('');

  if (text.length > 0) {
    return text;
  }

  // JSON.stringify(undefined) is undefined, so fall back to an empty array.
  return JSON.stringify(result.structuredContent ?? result.content ?? []);
}

interface McpContentBlockWithText extends McpContentBlock {
  readonly text: string;
}
