/**
 * MCP Structural Types
 *
 * Minimal structural interfaces describing the subset of an MCP client's
 * surface this package needs - list tools, call a tool. Deliberately not
 * imported from `@modelcontextprotocol/sdk` or any specific client library:
 * this package has no hard (or peer) dependency on any MCP SDK. Any client
 * satisfying `McpClientLike` - the official SDK wrapped by hand, `mcp-query`
 * (`@johnhenry/mcp-query`; previously published as `@johnhenry/mcpq`, now
 * deprecated in favor of this name), or a test fake - works without aimatey
 * ever needing to know it exists.
 *
 * @module
 */

/**
 * A tool as reported by an MCP server (raw MCP spec shape: `name`,
 * `description?`, `inputSchema` as JSON Schema).
 */
export interface McpToolSchema {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: {
    readonly type?: string;
    readonly properties?: Record<string, unknown>;
    readonly required?: readonly string[];
    readonly [key: string]: unknown;
  };
}

/**
 * A single content block from an MCP tool call result (text, image, etc.).
 * Only `text` is inspected here; other block types pass through untouched.
 */
export interface McpContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly [key: string]: unknown;
}

/**
 * The result of an MCP `tools/call` (raw MCP spec `CallToolResult` shape).
 */
export interface McpCallToolResult {
  readonly content: readonly McpContentBlock[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

/**
 * The subset of an MCP client's surface this package depends on.
 *
 * `mcp-query`'s `MCPClient` instances satisfy this structurally: its
 * `listTools(server)` is synchronous (assignable to `Promise<T[]> | T[]`)
 * and `callTool(name, args, opts?)` is a plain one-shot promise whose
 * default instantiation is the raw `CallToolResult` passthrough.
 */
export interface McpClientLike {
  /**
   * List tools available from a server. May be sync or async - callers
   * should `await` the result either way.
   */
  listTools(server?: string): Promise<McpToolSchema[]> | McpToolSchema[];

  /**
   * Call a tool by name with arguments, returning the raw MCP result.
   */
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { readonly server?: string; readonly signal?: AbortSignal }
  ): Promise<McpCallToolResult>;
}
