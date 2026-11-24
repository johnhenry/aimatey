/**
 * runTools protocol seam (#238): the loop delegates request shaping and reply
 * reading to a ToolProtocol while keeping validation, the gate, limits and
 * step reporting. 'native' is the default and must not change behavior.
 */

import { describe, it, expect } from 'vitest';
import { Bridge, registerToolProtocol, clearToolProtocols } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import type {
  BackendAdapter,
  IRChatRequest,
  IRChatResponse,
  ToolProtocol,
} from '@johnhenry/aimatey-types';

function backend(replies: string[], tools = true): BackendAdapter & { requests: IRChatRequest[] } {
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
};

/** Replies "CALL <name> <json>" → a tool call; anything else → final answer. */
const lineProtocol: ToolProtocol = {
  name: 'line',
  prepare: (request) => ({ ...request, tools: undefined }),
  async interpret(response, ctx) {
    const text = response.message.content as string;
    const m = /^CALL (\w+) (.*)$/.exec(text);
    if (!m) return { kind: 'final' };
    const call = { id: `c${ctx.iteration}`, name: m[1], input: JSON.parse(m[2]) };
    const result = await ctx.invoke(call);
    return {
      kind: 'continue',
      calls: [call],
      results: [result],
      messages: [
        response.message,
        { role: 'user', content: `RESULT ${JSON.stringify(result.result)}` },
      ],
    };
  },
};

const bridgeOf = (b: BackendAdapter) => new Bridge(new OpenAIFrontendAdapter(), b);

describe('runTools protocol seam', () => {
  it('runs a custom protocol: prepare shapes the request, interpret drives calls', async () => {
    const b = backend(['CALL add {"a":2,"b":3}', 'the answer is 5']);
    const result = await bridgeOf(b).runTools({ prompt: 'sum', tools, protocol: lineProtocol });
    expect(result.text).toBe('the answer is 5');
    expect(result.status).toBe('completed');
    expect(b.requests[0].tools).toBeUndefined();
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].toolCalls).toEqual([{ id: 'c1', name: 'add', input: { a: 2, b: 3 } }]);
    expect(result.steps[0].toolResults[0].result).toBe(5);
    expect(result.steps.every((s) => s.protocol === 'line')).toBe(true);
    expect(JSON.stringify(b.requests[1].messages)).toContain('RESULT 5');
  });

  it('routes protocol calls through validation and the gate', async () => {
    const b = backend(['CALL add {"a":"x"}', 'CALL add {"a":1,"b":2}', 'done']);
    const seen: string[] = [];
    const result = await bridgeOf(b).runTools({
      prompt: 'p',
      tools,
      protocol: lineProtocol,
      gate: (call) => {
        seen.push(call.name);
        return { action: 'deny', reason: 'no' };
      },
      maxDenials: 1,
    });
    // first call fails validation (never reaches the gate); second is denied
    expect(seen).toEqual(['add']);
    expect(result.status).toBe('max-denials');
    expect(result.denials).toHaveLength(1);
  });

  it('honors maxIterations for protocol loops', async () => {
    const b = backend(['CALL add {"a":1,"b":1}']);
    await expect(
      bridgeOf(b).runTools({ prompt: 'p', tools, protocol: lineProtocol, maxIterations: 3 })
    ).rejects.toThrow(/exceeded 3 iterations/);
  });

  it('exposes backend native-tool support to the protocol', async () => {
    let supports: boolean | undefined = true;
    const probe: ToolProtocol = {
      name: 'probe',
      prepare: (r, ctx) => {
        supports = ctx.supportsNativeTools;
        return r;
      },
      interpret: () => Promise.resolve({ kind: 'final' }),
    };
    await bridgeOf(backend(['hi'], false)).runTools({ prompt: 'p', tools, protocol: probe });
    expect(supports).toBe(false);
  });

  it("'native' is the default and names itself in steps", async () => {
    const b = backend(['plain answer']);
    const result = await bridgeOf(b).runTools({ prompt: 'p', tools });
    expect(result.steps[0].protocol).toBe('native');
    expect(b.requests[0].tools).toHaveLength(1);
  });

  it('resolves registered protocol names and rejects unknown ones with an install hint', async () => {
    clearToolProtocols();
    await expect(
      bridgeOf(backend(['x'])).runTools({ prompt: 'p', tools, protocol: 'text' })
    ).rejects.toThrow(/aimatey-tool-protocols/);
    registerToolProtocol(lineProtocol);
    const result = await bridgeOf(backend(['hello'])).runTools({
      prompt: 'p',
      tools,
      protocol: 'line',
    });
    expect(result.text).toBe('hello');
    clearToolProtocols();
  });
});
