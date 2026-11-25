import { describe, it, expect } from 'vitest';
import { mcpToolsToDefinitions } from '@johnhenry/aimatey-mcp';
import { generateToolsInterface } from '@johnhenry/aimatey-tool-protocols';

const client = {
  listTools: () =>
    Promise.resolve([
      {
        name: 'get_user',
        description: 'Fetch a user',
        inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
        outputSchema: {
          type: 'object',
          properties: { name: { type: 'string' }, age: { type: 'number' } },
          required: ['name'],
        },
      },
      { name: 'ping', inputSchema: { type: 'object', properties: {} } },
    ]),
  callTool: (name: string) =>
    Promise.resolve(
      name === 'get_user'
        ? {
            content: [{ type: 'text', text: '{"name":"Ada","age":36}' }],
            structuredContent: { name: 'Ada', age: 36 },
          }
        : { content: [{ type: 'text', text: 'pong' }] }
    ),
};

describe('MCP outputSchema', () => {
  it('carries outputSchema onto the tool definition', async () => {
    const defs = await mcpToolsToDefinitions(client);
    expect(defs.get_user.outputSchema).toMatchObject({ type: 'object' });
    expect(defs.ping.outputSchema).toBeUndefined();
  });

  it('returns structuredContent when the tool declares an outputSchema', async () => {
    const defs = await mcpToolsToDefinitions(client);
    const ctx = { toolCallId: 'x', messages: [] };
    expect(await defs.get_user.execute({ id: 1 }, ctx)).toEqual({ name: 'Ada', age: 36 });
    expect(await defs.ping.execute({}, ctx)).toBe('pong');
  });
});

describe('typed tools API with outputs', () => {
  it('types results from outputSchema and falls back to unknown', async () => {
    const defs = await mcpToolsToDefinitions(client);
    const out = generateToolsInterface(defs);
    expect(out).toMatch(
      /get_user\(input: \{[^)]*\}\): Promise<\{[^}]*name: string;[^}]*age\?: number;?[^}]*\}>;/s
    );
    expect(out).toMatch(/ping\(input\?: \{\}\): Promise<unknown>;/);
  });
});
