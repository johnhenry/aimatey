/**
 * text and auto tool protocols (#239): tool calling for models with no native
 * tool support, via a fenced JSON action block.
 */

import { describe, it, expect } from 'vitest';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { runMcpTools } from '@johnhenry/aimatey-mcp';
import type { McpClientLike } from '@johnhenry/aimatey-mcp';
import {
  textProtocol,
  autoProtocol,
  registerTextProtocols,
} from '@johnhenry/aimatey-tool-protocols';
import type { BackendAdapter, IRChatRequest, IRChatResponse } from '@johnhenry/aimatey-types';

function backend(replies: string[], tools = false): BackendAdapter & { requests: IRChatRequest[] } {
  let call = 0;
  const requests: IRChatRequest[] = [];
  return {
    metadata: {
      name: 'fake',
      version: '1.0.0',
      provider: 'Mock',
      capabilities: {
        streaming: false,
        multiModal: false,
        tools,
        systemMessageStrategy: 'in-messages',
        supportsMultipleSystemMessages: false,
      },
    },
    requests,
    fromIR: (r) => r,
    toIR: () => {
      throw new Error('unused');
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- mock interface
    execute: async (request: IRChatRequest): Promise<IRChatResponse> => {
      requests.push(request);
      const text = replies[Math.min(call++, replies.length - 1)];
      return {
        message: { role: 'assistant', content: text },
        finishReason: 'stop',
        metadata: request.metadata,
      } as IRChatResponse;
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- mock generator interface
    executeStream: async function* () {
      throw new Error('unused');
    },
  };
}

const tools = {
  add: {
    description: 'Add numbers',
    parameters: {
      type: 'object' as const,
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
    execute: ({ a, b }: Record<string, unknown>) => (a as number) + (b as number),
  },
  echo: {
    description: 'Echo text',
    parameters: {
      type: 'object' as const,
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    execute: ({ text }: Record<string, unknown>) => text,
  },
};

const bridgeOf = (b: BackendAdapter) => new Bridge(new OpenAIFrontendAdapter(), b);
const fence = (json: string) => '```json\n' + json + '\n```';
const allText = (r: IRChatRequest) => JSON.stringify(r.messages);

describe('textProtocol', () => {
  it('runs a single call then a final answer, with no native tools sent', async () => {
    const b = backend([fence('{"tool":"add","args":{"a":2,"b":3}}'), 'The sum is 5.']);
    const result = await bridgeOf(b).runTools({ prompt: 'sum', tools, protocol: textProtocol() });
    expect(result.text).toBe('The sum is 5.');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].toolCalls).toEqual([
      { id: 'text-1-0', name: 'add', input: { a: 2, b: 3 } },
    ]);
    expect(result.steps[0].toolResults[0].result).toBe(5);
    expect(result.steps.every((s) => s.protocol === 'text')).toBe(true);
    expect(b.requests[0].tools).toBeUndefined();
    const second = b.requests[1].messages;
    const last = second[second.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain('Tool result for add (text-1-0): 5');
  });

  it('describes every tool with its schema in a system message', async () => {
    const b = backend(['hello']);
    await bridgeOf(b).runTools({ prompt: 'hi', tools, protocol: textProtocol() });
    const sys = b.requests[0].messages[0];
    expect(sys.role).toBe('system');
    const text = sys.content as string;
    expect(text).toContain('add');
    expect(text).toContain('Add numbers');
    expect(text).toContain('"required"');
    expect(text).toContain('echo');
    expect(text).toContain('"tool"');
  });

  it('merges into an existing leading system message', async () => {
    const b = backend(['hello']);
    await bridgeOf(b).runTools({
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'hi' },
      ],
      tools,
      protocol: textProtocol(),
    });
    const msgs = b.requests[0].messages;
    expect(msgs.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(msgs[0].content as string).toContain('You are terse.');
    expect(msgs[0].content as string).toContain('Add numbers');
  });

  it('asks for an array when parallelToolCalls and runs several calls', async () => {
    const b = backend([
      fence('[{"tool":"add","args":{"a":1,"b":1}},{"tool":"echo","args":{"text":"x"}}]'),
      'done',
    ]);
    const result = await bridgeOf(b).runTools({
      prompt: 'p',
      tools,
      protocol: textProtocol(),
      parallelToolCalls: true,
    });
    expect(result.steps[0].toolCalls.map((c) => c.id)).toEqual(['text-1-0', 'text-1-1']);
    expect(result.steps[0].toolResults.map((r) => r.result)).toEqual([2, 'x']);
    expect(b.requests[0].messages[0].content as string).toMatch(/array/i);
  });

  it('tolerates prose before and after the block', async () => {
    const b = backend([
      'Sure, let me add those.\n' +
        fence('{"tool":"add","args":{"a":4,"b":5}}') +
        '\nThat should do it.',
      '9',
    ]);
    const result = await bridgeOf(b).runTools({ prompt: 'p', tools, protocol: textProtocol() });
    expect(result.steps[0].toolResults[0].result).toBe(9);
    expect(result.text).toBe('9');
  });

  it('tolerates a missing fence and trailing commas', async () => {
    const b = backend(['I will call: {"tool": "add", "args": {"a": 1, "b": 2,},}', 'three']);
    const result = await bridgeOf(b).runTools({ prompt: 'p', tools, protocol: textProtocol() });
    expect(result.steps[0].toolResults[0].result).toBe(3);
  });

  it('treats a tool name without args as empty args', async () => {
    const b = backend([fence('{"tool":"echo"}'), 'ok']);
    const result = await bridgeOf(b).runTools({ prompt: 'p', tools, protocol: textProtocol() });
    // echo requires text: schema validation fails, passed on as an error result
    expect(result.steps[0].toolResults[0].isError).toBe(true);
  });

  it('treats a reply with no action block as the final answer', async () => {
    const b = backend(['Just a plain answer with {braces} in it.']);
    const result = await bridgeOf(b).runTools({ prompt: 'p', tools, protocol: textProtocol() });
    expect(result.text).toBe('Just a plain answer with {braces} in it.');
    expect(result.steps).toHaveLength(1);
    expect(result.status).toBe('completed');
  });

  it('treats a fenced JSON answer that is not an action as final', async () => {
    const b = backend([fence('{"city":"Paris","temp":12}')]);
    const result = await bridgeOf(b).runTools({ prompt: 'p', tools, protocol: textProtocol() });
    expect(result.steps).toHaveLength(1);
    expect(result.text).toContain('Paris');
  });

  it('feeds malformed JSON back as an error and recovers next iteration', async () => {
    const b = backend([
      fence('{"tool":"add","args":{"a":1,"b":'),
      fence('{"tool":"add","args":{"a":1,"b":2}}'),
      'It is 3.',
    ]);
    const result = await bridgeOf(b).runTools({ prompt: 'p', tools, protocol: textProtocol() });
    expect(result.text).toBe('It is 3.');
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0].toolCalls).toEqual([]);
    expect(result.steps[0].toolResults).toEqual([]);
    const retry = b.requests[1].messages;
    const last = retry[retry.length - 1];
    expect(last.role).toBe('user');
    expect(last.content as string).toMatch(/not valid JSON/i);
    expect(result.steps[1].toolResults[0].result).toBe(3);
  });

  it('feeds back an action block missing the tool key', async () => {
    const b = backend([fence('{"args":{"a":1,"b":2}}'), 'gave up']);
    const result = await bridgeOf(b).runTools({ prompt: 'p', tools, protocol: textProtocol() });
    expect(result.steps[0].toolCalls).toEqual([]);
    expect(result.text).toBe('gave up');
    expect(allText(b.requests[1])).toContain('\\"tool\\" key');
    expect(allText(b.requests[1])).toMatch(/missing/i);
  });

  it('consumes iterations on malformed replies (maxIterations)', async () => {
    const b = backend([fence('{"tool": ')]);
    await expect(
      bridgeOf(b).runTools({ prompt: 'p', tools, protocol: textProtocol(), maxIterations: 2 })
    ).rejects.toThrow(/exceeded 2 iterations/);
    expect(b.requests).toHaveLength(2);
  });

  it('passes unknown tool names back as error results', async () => {
    const b = backend([fence('{"tool":"nope","args":{}}'), 'sorry']);
    const result = await bridgeOf(b).runTools({ prompt: 'p', tools, protocol: textProtocol() });
    expect(result.steps[0].toolResults[0].isError).toBe(true);
    const second = b.requests[1].messages;
    expect(second[second.length - 1].content as string).toContain('Tool error for nope');
  });

  it('passes schema-invalid args back as error results', async () => {
    const b = backend([fence('{"tool":"add","args":{"a":"x"}}'), 'sorry']);
    const result = await bridgeOf(b).runTools({ prompt: 'p', tools, protocol: textProtocol() });
    expect(result.steps[0].toolResults[0].isError).toBe(true);
    expect(result.text).toBe('sorry');
  });

  it('routes calls through the gate and stops at maxDenials', async () => {
    const b = backend([
      fence('{"tool":"add","args":{"a":1,"b":2}}'),
      fence('{"tool":"add","args":{"a":3,"b":4}}'),
      'never',
    ]);
    const seen: string[] = [];
    const result = await bridgeOf(b).runTools({
      prompt: 'p',
      tools,
      protocol: textProtocol(),
      gate: (call) => {
        seen.push(call.name);
        return { action: 'deny', reason: 'no' };
      },
      maxDenials: 1,
    });
    expect(seen).toEqual(['add']);
    expect(result.status).toBe('max-denials');
  });
});

describe('autoProtocol', () => {
  it('uses native tool calling when the backend supports tools', async () => {
    const b = backend(['plain answer'], true);
    await bridgeOf(b).runTools({ prompt: 'p', tools, protocol: autoProtocol() });
    expect(b.requests[0].tools?.map((t) => t.name)).toEqual(['add', 'echo']);
    expect(allText(b.requests[0])).not.toContain('Add numbers');
  });

  it('falls back to text when the backend has no native tools', async () => {
    const b = backend([fence('{"tool":"add","args":{"a":1,"b":1}}'), 'two'], false);
    const result = await bridgeOf(b).runTools({ prompt: 'p', tools, protocol: autoProtocol() });
    expect(b.requests[0].tools).toBeUndefined();
    expect(result.steps[0].toolResults[0].result).toBe(2);
    expect(result.text).toBe('two');
  });

  it("resolves protocol: 'auto' and 'text' after registerTextProtocols()", async () => {
    registerTextProtocols();
    const b = backend([fence('{"tool":"add","args":{"a":2,"b":2}}'), 'four']);
    const result = await bridgeOf(b).runTools({ prompt: 'p', tools, protocol: 'auto' });
    expect(result.text).toBe('four');
    const b2 = backend(['hi']);
    await bridgeOf(b2).runTools({ prompt: 'p', tools, protocol: 'text' });
    expect(b2.requests[0].tools).toBeUndefined();
  });
});

describe('runMcpTools with the text protocol', () => {
  it('works end to end on a backend with no native tools', async () => {
    const client: McpClientLike = {
      listTools: () => [
        {
          name: 'get_weather',
          description: 'Get current weather',
          inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
      callTool: () => Promise.resolve({ content: [{ type: 'text', text: 'Sunny' }] }),
    };
    const b = backend([fence('{"tool":"get_weather","args":{"city":"Paris"}}'), 'It is sunny.']);
    const bridge = bridgeOf(b);
    const result = await runMcpTools((o) => bridge.runTools(o), {
      client,
      prompt: 'weather in Paris?',
      protocol: textProtocol(),
    });
    expect(result.text).toBe('It is sunny.');
    expect(b.requests[0].tools).toBeUndefined();
    expect(JSON.stringify(b.requests[1].messages)).toContain('Sunny');
  });
});
