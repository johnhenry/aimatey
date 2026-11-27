/**
 * aimatey-mcp
 *
 * MCP (Model Context Protocol) tool-calling for Aimatey. Translates MCP
 * tools into the `ToolDefinition` shape consumed by `aimatey-core`'s
 * `Bridge.runTools()` agentic loop, via an injectable MCP client - no hard
 * (or peer) dependency on any MCP SDK.
 *
 * @module
 */

export type {
  McpClientLike,
  McpToolSchema,
  McpContentBlock,
  McpCallToolResult,
  McpTaskHandleLike,
} from './types.js';

export { McpInputRequiredError, McpTaskUnresolvedError } from './errors.js';

export {
  mcpToolToIRTool,
  extractMcpResultText,
  isMcpTaskResult,
  isMcpInputRequiredResult,
} from './convert.js';

export { mcpToolsToDefinitions, type McpToolsToDefinitionsOptions } from './tool-definitions.js';

export { runMcpTools, type RunMcpToolsOptions } from './run-mcp-tools.js';
