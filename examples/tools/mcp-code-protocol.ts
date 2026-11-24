/**
 * MCP tools through the `code` protocol: one JavaScript snippet chains
 * several tool calls, and the gate sees every call.
 *
 * Needs: @johnhenry/andbox + the pinned QuickJS engine packages, and a model
 * (here a local Ollama model). A fake MCP client stands in for a real server.
 */
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { OllamaBackendAdapter } from '@johnhenry/aimatey-backend/ollama';
import { runMcpTools, type McpClientLike } from '@johnhenry/aimatey-mcp';
import { codeProtocol, andboxExecutor } from '@johnhenry/aimatey-tool-protocols';

const mcpClient: McpClientLike = {
  listTools: () =>
    Promise.resolve([
      {
        name: 'open_issues',
        description: 'Number of open issues in a repo',
        inputSchema: {
          type: 'object',
          properties: { repo: { type: 'string' } },
          required: ['repo'],
        },
        outputSchema: {
          type: 'object',
          properties: { repo: { type: 'string' }, open: { type: 'number' } },
          required: ['repo', 'open'],
        },
      },
    ]),
  callTool: (_name, input) => {
    const repo = String((input as { repo: string }).repo);
    const open = repo.length * 3;
    return Promise.resolve({
      content: [{ type: 'text', text: JSON.stringify({ repo, open }) }],
      structuredContent: { repo, open },
    });
  },
};

const bridge = new Bridge(
  new OpenAIFrontendAdapter(),
  new OllamaBackendAdapter({ baseURL: 'http://localhost:11434' })
);

const result = await runMcpTools(bridge.runTools, {
  client: mcpClient,
  model: 'qwen2.5:3b',
  prompt: 'Which of these repos has the most open issues: aimatey, andbox, hive?',
  protocol: codeProtocol({ executor: andboxExecutor() }),
  gate: (call) => {
    console.log('gate saw', call.name, call.input);
    return { action: 'allow' };
  },
});

console.log(result.text);
console.log(result.steps.map((s) => `${s.protocol}: ${s.toolCalls.length} calls`));
