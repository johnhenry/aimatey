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
  /** JSON Schema of `structuredContent`, when the server declares one. */
  readonly outputSchema?: Record<string, unknown>;
  /** Human-readable display name (MCP `Tool.title`). */
  readonly title?: string;
  /** Behavioral hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, ...). */
  readonly annotations?: Readonly<Record<string, unknown>>;
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
  /**
   * Content blocks. Optional: a result may carry only `structuredContent`,
   * and task-shaped / `input_required` results have none.
   */
  readonly content?: readonly McpContentBlock[];
  /** Any JSON value (SEP-2106): object, array, string, number, boolean or null. */
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
  /** Discriminator used by newer protocol revisions: `"task"`, `"input_required"`, `"complete"`. */
  readonly resultType?: string;
  /** Task handle fields (tasks extension): present when the server answered with a task. */
  readonly taskId?: string;
  readonly status?: string;
  /** `input_required` fields: what the server wants elicited, and state to echo back. */
  readonly inputRequests?: unknown;
  readonly requestState?: unknown;
  readonly [key: string]: unknown;
}

/**
 * A live handle on a task-augmented tool call. Structurally compatible with
 * `mcp-query`'s `TaskHandle` (`MCPClient.callToolTask(...)` resolves to one).
 */
export interface McpTaskHandleLike {
  readonly taskId?: string;
  /** Resolves with the final tool result when the task completes; rejects on failure/cancel. */
  result(): Promise<McpCallToolResult>;
  /** Ask the server to cancel the task. Called when the abort signal fires. */
  cancel?(): Promise<void>;
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

  /**
   * Optional: start a task-augmented tool call and return a handle that can
   * be awaited for the final result (`mcp-query`'s `callToolTask`). Used only
   * when `preferTasks` is set on `mcpToolsToDefinitions` / `runMcpTools`;
   * without it, or without this method, a task-shaped `callTool` result
   * fails with `McpTaskUnresolvedError`. Not used as a fallback after
   * `callTool`, because that would run the tool a second time.
   *
   * Note: `mcp-query` rejects this on connections whose server does not
   * advertise the tasks extension, which is why it is opt-in.
   */
  callToolTask?(
    name: string,
    args: Record<string, unknown>,
    opts?: { readonly server?: string; readonly signal?: AbortSignal }
  ): Promise<McpTaskHandleLike>;
}
