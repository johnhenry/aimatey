/**
 * MCP result shapes: task handles, input_required, non-object
 * structuredContent, missing content, isError, and preserved tool metadata.
 * Fakes only; the isError test drives the real createRunTools loop.
 */

import { describe, it, expect, vi } from 'vitest';
import { createRunTools } from '@johnhenry/aimatey-core';
import {
  McpInputRequiredError,
  McpTaskUnresolvedError,
  extractMcpResultText,
  mcpToolToIRTool,
  mcpToolsToDefinitions,
} from '@johnhenry/aimatey-mcp';
import type {
  McpCallToolResult,
  McpClientLike,
  McpTaskHandleLike,
  McpToolSchema,
} from '@johnhenry/aimatey-mcp';
import type { IRChatRequest, IRChatResponse } from '@johnhenry/aimatey-types';

const TOOL: McpToolSchema = {
  name: 'work',
  description: 'Does work',
  inputSchema: { type: 'object' },
};
const CTX = { toolCallId: 'c1', messages: [] };

function clientWith(
  callTool: McpClientLike['callTool'],
  extra: Partial<McpClientLike> = {}
): McpClientLike {
  return { listTools: () => [TOOL], callTool, ...extra };
}

async function run(client: McpClientLike, opts: Parameters<typeof mcpToolsToDefinitions>[1] = {}) {
  const defs = await mcpToolsToDefinitions(client, opts);
  return defs.work!.execute({}, CTX);
}

const TASK: McpCallToolResult = { resultType: 'task', taskId: 't-1', status: 'working' };

describe('task-shaped results', () => {
  it('awaits the handle from callToolTask when preferTasks is set, forwarding signal', async () => {
    const callTool = vi.fn();
    const handle: McpTaskHandleLike = {
      taskId: 't-1',
      result: async () => ({ content: [{ type: 'text', text: 'finished' }] }),
    };
    const callToolTask = vi.fn(async () => handle);
    const controller = new AbortController();

    const out = await run(clientWith(callTool, { callToolTask }), {
      preferTasks: true,
      server: 's',
      signal: controller.signal,
    });

    expect(out).toBe('finished');
    expect(callTool).not.toHaveBeenCalled();
    expect(callToolTask).toHaveBeenCalledWith('work', {}, { server: 's', signal: controller.signal });
  });

  it('cancels the task and rejects when the signal aborts while waiting', async () => {
    const cancel = vi.fn(async () => undefined);
    const handle: McpTaskHandleLike = { result: () => new Promise(() => undefined), cancel };
    const controller = new AbortController();

    const pending = run(
      clientWith(vi.fn(), { callToolTask: async () => handle }),
      { preferTasks: true, signal: controller.signal }
    );
    controller.abort(new Error('stop'));

    await expect(pending).rejects.toThrow('stop');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('fails with McpTaskUnresolvedError when callTool returns a task handle and tasks are not preferred', async () => {
    const callToolTask = vi.fn();
    const client = clientWith(async () => TASK, { callToolTask });

    const error = await run(client).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpTaskUnresolvedError);
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as McpTaskUnresolvedError).taskId).toBe('t-1');
    expect((error as Error).message).toContain('"work"');
    // must not start a second execution of the tool
    expect(callToolTask).not.toHaveBeenCalled();
  });

  it('fails with McpTaskUnresolvedError when the client cannot resolve tasks at all', async () => {
    await expect(run(clientWith(async () => TASK), { preferTasks: true })).rejects.toBeInstanceOf(
      McpTaskUnresolvedError
    );
  });

  it('extractMcpResultText throws instead of a TypeError on a bare task handle', () => {
    expect(() => extractMcpResultText({ taskId: 't', status: 'working' })).toThrow(McpTaskUnresolvedError);
  });
});

describe('input_required results', () => {
  const INPUT: McpCallToolResult = {
    resultType: 'input_required',
    inputRequests: { q: { message: 'Which env?' } },
    requestState: 'opaque',
  };

  it('throws McpInputRequiredError naming the missing elicitation handler', async () => {
    const error = await run(clientWith(async () => INPUT)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpInputRequiredError);
    expect(error).not.toBeInstanceOf(TypeError);
    const typed = error as McpInputRequiredError;
    expect(typed.message).toContain('elicitation handler');
    expect(typed.message).toContain('"work"');
    expect(typed.requestState).toBe('opaque');
    expect(typed.inputRequests).toEqual(INPUT.inputRequests);
  });

  it('extractMcpResultText throws the typed error too', () => {
    expect(() => extractMcpResultText(INPUT)).toThrow(McpInputRequiredError);
  });
});

describe('structuredContent and content', () => {
  it('accepts array structuredContent without content', () => {
    expect(extractMcpResultText({ structuredContent: [1, 2, 3] })).toBe('[1,2,3]');
  });

  it('accepts string structuredContent without content', () => {
    expect(extractMcpResultText({ structuredContent: 'plain' })).toBe('"plain"');
  });

  it('tolerates a result with neither content nor structuredContent', () => {
    expect(extractMcpResultText({})).toBe('[]');
  });

  it('returns non-object structuredContent as the typed value when outputSchema is declared', async () => {
    const tool: McpToolSchema = { ...TOOL, outputSchema: { type: 'array' } };
    const client: McpClientLike = {
      listTools: () => [tool],
      callTool: async () => ({ structuredContent: ['a', 'b'] }),
    };
    const defs = await mcpToolsToDefinitions(client);
    expect(await defs.work!.execute({}, CTX)).toEqual(['a', 'b']);
  });
});

describe('isError results reach the tool loop as tool errors', () => {
  it('createRunTools marks the thrown error as an isError tool result', async () => {
    let call = 0;
    const execute = vi.fn(async (request: IRChatRequest): Promise<IRChatResponse> => {
      call++;
      const message =
        call === 1
          ? {
              role: 'assistant' as const,
              content: [{ type: 'tool_use' as const, id: 't1', name: 'work', input: {} }],
            }
          : { role: 'assistant' as const, content: 'ok' };
      return {
        message,
        finishReason: call === 1 ? 'tool_calls' : 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        metadata: request.metadata,
      } as IRChatResponse;
    });
    const runTools = createRunTools({
      executeIR: execute,
      frontend: { metadata: { name: 'test' } },
    });
    const tools = await mcpToolsToDefinitions(
      clientWith(async () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }))
    );

    const result = await runTools({ prompt: 'go', tools });

    expect(result.steps[0]!.toolResults).toEqual([
      { toolCallId: 't1', result: 'boom', isError: true },
    ]);
  });
});

describe('tool metadata', () => {
  const RICH: McpToolSchema = {
    name: 'delete_all',
    description: 'Deletes',
    inputSchema: { type: 'object' },
    title: 'Delete everything',
    annotations: { destructiveHint: true, readOnlyHint: false },
    outputSchema: { type: 'object' },
  };

  it('keeps title, annotations and outputSchema under IRTool.metadata.mcp', () => {
    expect(mcpToolToIRTool(RICH).metadata).toEqual({
      mcp: {
        title: 'Delete everything',
        annotations: { destructiveHint: true, readOnlyHint: false },
        outputSchema: { type: 'object' },
      },
    });
  });

  it('omits metadata when the tool has none', () => {
    expect(mcpToolToIRTool(TOOL)).not.toHaveProperty('metadata');
  });

  it('carries metadata onto the ToolDefinition and lets toolFilter gate on annotations', async () => {
    const client: McpClientLike = {
      listTools: () => [RICH, { ...TOOL, annotations: { readOnlyHint: true } }],
      callTool: async () => ({ content: [] }),
    };
    const defs = await mcpToolsToDefinitions(client, {
      toolFilter: (tool) => tool.annotations?.destructiveHint !== true,
    });
    expect(Object.keys(defs)).toEqual(['work']);

    const all = await mcpToolsToDefinitions(client);
    expect(all.delete_all?.metadata).toMatchObject({ mcp: { title: 'Delete everything' } });
  });
});
