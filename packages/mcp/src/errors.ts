/**
 * Typed errors for MCP result shapes this package cannot turn into a final
 * tool result by itself.
 *
 * @module
 */

import type { McpCallToolResult } from './types.js';

/**
 * The server answered `tools/call` with `resultType: "input_required"`
 * (in-band elicitation) and the injected client did not drive that round.
 *
 * The client, not this package, owns elicitation: register an elicitation
 * handler on it (for `mcp-query`, the host handlers/broker) so it answers
 * `inputRequests` and re-sends the call with `requestState`.
 */
export class McpInputRequiredError extends Error {
  readonly code = 'MCP_INPUT_REQUIRED';
  readonly toolName?: string;
  readonly inputRequests: unknown;
  readonly requestState: unknown;

  constructor(result: McpCallToolResult, toolName?: string) {
    super(
      `MCP tool${toolName ? ` "${toolName}"` : ''} returned an input_required result, but the injected ` +
        `MCP client has no elicitation handler to answer it. Configure an elicitation handler on the ` +
        `client so it can resolve inputRequests and retry with requestState.`
    );
    this.name = 'McpInputRequiredError';
    this.toolName = toolName;
    this.inputRequests = result.inputRequests;
    this.requestState = result.requestState;
  }
}

/**
 * The server answered `tools/call` with a task handle (`taskId`, `status`, no
 * `content`) and nothing resolved it to a final result.
 */
export class McpTaskUnresolvedError extends Error {
  readonly code = 'MCP_TASK_UNRESOLVED';
  readonly toolName?: string;
  readonly taskId: string;
  readonly status?: string;

  constructor(result: McpCallToolResult, toolName?: string) {
    super(
      `MCP tool${toolName ? ` "${toolName}"` : ''} returned a task handle (taskId ${String(result.taskId)}) ` +
        `instead of a final result, and it could not be resolved. Use a client that resolves tasks ` +
        `before returning, or one that implements callToolTask and pass preferTasks: true.`
    );
    this.name = 'McpTaskUnresolvedError';
    this.toolName = toolName;
    this.taskId = String(result.taskId);
    this.status = typeof result.status === 'string' ? result.status : undefined;
  }
}
