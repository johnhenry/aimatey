/**
 * `code` tool protocol (#240). Layer 1 uses a fake in-memory CodeExecutor
 * (loop wiring only); layer 2 runs real andbox wasm.
 */

import { describe, it, expect } from 'vitest';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import type { BackendAdapter, IRChatRequest, IRChatResponse } from '@johnhenry/aimatey-types';
import {
  codeProtocol,
  registerCodeProtocol,
  generateToolsInterface,
  buildCodePrompt,
  buildLegacyCodePrompt,
  type CodeExecutor,
  type CodeRunOptions,
} from '@johnhenry/aimatey-tool-protocols';

function backend(replies: string[]): BackendAdapter & { requests: IRChatRequest[] } {
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
        tools: false,
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

const bridgeOf = (b: BackendAdapter) => new Bridge(new OpenAIFrontendAdapter(), b);
const fence = (code: string) => '```js\n' + code + '\n```';

const tools = {
  add: {
    description: 'Add two numbers',
    parameters: {
      type: 'object' as const,
      properties: {
        a: { type: 'number', description: 'first' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
    },
    execute: ({ a, b }: Record<string, unknown>) => (a as number) + (b as number),
  },
  boom: {
    description: 'Always fails',
    parameters: { type: 'object' as const, properties: {} },
    execute: () => {
      throw new Error('kaboom');
    },
  },
};

type Fn = (...a: unknown[]) => unknown;
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...a: string[]
) => Fn;

/** Fake executor: evaluates the snippet in-process (test only). */
function fakeExecutor(seen: CodeRunOptions[] = []): CodeExecutor {
  return {
    async run(code, opts) {
      seen.push(opts);
      const logs: string[] = [];
      const toolsObj: Record<string, (i: unknown) => Promise<unknown>> = {};
      for (const n of opts.toolNames) toolsObj[n] = (i) => opts.callTool(n, i);
      let final: { answer: unknown } | undefined;
      try {
        const fn = new AsyncFunction('tools', 'console', 'final', code);
        const result = await fn(
          toolsObj,
          { log: (...a: unknown[]) => logs.push(a.map(String).join(' ')) },
          (answer: unknown) => {
            final = { answer };
          }
        );
        return { logs, result, ...(final && { final }) };
      } catch (e) {
        const err = e as Error;
        return { logs, error: { name: err.name, message: err.message } };
      }
    },
  };
}

describe('code protocol (fake executor)', () => {
  it('prepare drops native tools and adds a system prompt with the tools interface', async () => {
    const b = backend(['No code needed.']);
    const result = await bridgeOf(b).runTools({
      prompt: 'hi',
      tools,
      protocol: codeProtocol({ executor: fakeExecutor() }),
    });
    expect(result.text).toBe('No code needed.');
    expect(result.steps[0].protocol).toBe('code');
    const req = b.requests[0];
    expect(req.tools).toBeUndefined();
    const sys = req.messages.find((m) => m.role === 'system');
    const text = JSON.stringify(sys?.content);
    expect(text).toContain('declare const tools');
    expect(text).toContain('add(');
    expect(text).toContain('Add two numbers');
    expect(text).toContain('await tools.name');
    expect(text).toMatch(/fetch/);
  });

  it('merges into an existing system message', async () => {
    const b = backend(['ok']);
    await bridgeOf(b).runTools({
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'hi' },
      ],
      tools,
      protocol: codeProtocol({ executor: fakeExecutor() }),
    });
    const systems = b.requests[0].messages.filter((m) => m.role === 'system');
    expect(systems).toHaveLength(1);
    expect(JSON.stringify(systems[0].content)).toContain('Be terse.');
    expect(JSON.stringify(systems[0].content)).toContain('declare const tools');
  });

  it('runs the snippet, records calls and feeds logs + value back', async () => {
    const b = backend([
      fence('const r = await tools.add({a:2,b:3}); console.log("sum", r); return r * 2;'),
      'The answer is 10',
    ]);
    const result = await bridgeOf(b).runTools({
      prompt: 'sum',
      tools,
      protocol: codeProtocol({ executor: fakeExecutor() }),
    });
    expect(result.text).toBe('The answer is 10');
    expect(result.steps[0].toolCalls).toEqual([
      { id: 'code-1-1', name: 'add', input: { a: 2, b: 3 } },
    ]);
    expect(result.steps[0].toolResults[0]).toMatchObject({ toolCallId: 'code-1-1', result: 5 });
    const feedback = JSON.stringify(b.requests[1].messages.at(-1));
    expect(feedback).toContain('sum 5');
    expect(feedback).toContain('10');
  });

  it('accepts untagged and javascript-tagged fences', async () => {
    for (const open of ['```', '```javascript', '```ts']) {
      const b = backend([open + '\nreturn 7\n```', 'done']);
      const r = await bridgeOf(b).runTools({
        prompt: 'p',
        tools,
        protocol: codeProtocol({ executor: fakeExecutor() }),
      });
      expect(r.steps).toHaveLength(2);
      expect(JSON.stringify(b.requests[1].messages.at(-1))).toContain('7');
    }
  });

  it('a reply with no code block is the final answer', async () => {
    const r = await bridgeOf(backend(['just text'])).runTools({
      prompt: 'p',
      tools,
      protocol: codeProtocol({ executor: fakeExecutor() }),
    });
    expect(r.text).toBe('just text');
    expect(r.steps).toHaveLength(1);
  });

  it('final(answer) ends the loop with that text', async () => {
    const b = backend([fence('final("42 it is")'), 'unused']);
    const r = await bridgeOf(b).runTools({
      prompt: 'p',
      tools,
      protocol: codeProtocol({ executor: fakeExecutor() }),
    });
    expect(r.text).toBe('42 it is');
    expect(b.requests).toHaveLength(1);
  });

  it('gate sees every call; a denial is catchable and counts toward maxDenials', async () => {
    const seen: string[] = [];
    const b = backend([
      fence(
        'try { await tools.add({a:1,b:1}); } catch (e) { console.log("caught:", e.message); }\n' +
          'await tools.add({a:2,b:2});'
      ),
      'never',
    ]);
    const r = await bridgeOf(b).runTools({
      prompt: 'p',
      tools,
      protocol: codeProtocol({ executor: fakeExecutor() }),
      gate: (call) => {
        seen.push(JSON.stringify(call.input));
        return { action: 'deny', reason: 'policy says no' };
      },
      maxDenials: 2,
    });
    expect(seen).toEqual(['{"a":1,"b":1}', '{"a":2,"b":2}']);
    expect(r.status).toBe('max-denials');
    expect(r.denials).toHaveLength(2);
    expect(r.steps[0].toolResults.every((x) => x.isError)).toBe(true);
    // snippet-level feedback (second denial is uncaught -> error message)
    expect(r.messages.length).toBeGreaterThan(2);
  });

  it('caught denial text reaches the snippet; validation errors too', async () => {
    const b = backend([
      fence(
        'try { await tools.add({a:"x"}); } catch (e) { console.log("V:", e.message); }\n' +
          'try { await tools.boom({}); } catch (e) { console.log("B:", e.message); }'
      ),
      'done',
    ]);
    await bridgeOf(b).runTools({
      prompt: 'p',
      tools,
      protocol: codeProtocol({ executor: fakeExecutor() }),
    });
    const fb = JSON.stringify(b.requests[1].messages.at(-1));
    expect(fb).toContain('V: Invalid arguments');
    expect(fb).toContain('B: kaboom');
  });

  it('snippet errors become a readable user message and consume the iteration', async () => {
    const b = backend([fence('throw new TypeError("bad thing")'), 'sorry']);
    const r = await bridgeOf(b).runTools({
      prompt: 'p',
      tools,
      protocol: codeProtocol({ executor: fakeExecutor() }),
    });
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0].toolCalls).toEqual([]);
    const fb = JSON.stringify(b.requests[1].messages.at(-1));
    expect(fb).toContain('TypeError');
    expect(fb).toContain('bad thing');
  });

  it('error feedback counts against maxIterations', async () => {
    await expect(
      bridgeOf(backend([fence('throw new Error("x")')])).runTools({
        prompt: 'p',
        tools,
        protocol: codeProtocol({ executor: fakeExecutor() }),
        maxIterations: 2,
      })
    ).rejects.toThrow(/exceeded 2 iterations/);
  });

  it('maps limits and tool names to the executor', async () => {
    const seen: CodeRunOptions[] = [];
    await bridgeOf(backend([fence('return 1'), 'ok'])).runTools({
      prompt: 'p',
      tools,
      protocol: codeProtocol({
        executor: fakeExecutor(seen),
        limits: { fuel: 5, memoryBytes: 1024, stackBytes: 2048, deadlineMs: 99, maxToolCalls: 3 },
      }),
    });
    expect(seen[0].limits).toEqual({
      fuel: 5,
      memoryBytes: 1024,
      stackBytes: 2048,
      deadlineMs: 99,
      maxToolCalls: 3,
    });
    expect(seen[0].toolNames).toEqual(['add', 'boom']);
  });

  it('truncates long output with a visible marker', async () => {
    const b = backend([fence('console.log("x".repeat(500))'), 'ok']);
    await bridgeOf(b).runTools({
      prompt: 'p',
      tools,
      protocol: codeProtocol({ executor: fakeExecutor(), maxLogChars: 100 }),
    });
    const fb = JSON.stringify(b.requests[1].messages.at(-1));
    expect(fb).toMatch(/\[truncated \d+ chars\]/);
    expect(fb.length).toBeLessThan(400);
  });

  it('registerCodeProtocol makes protocol: "code" resolvable', async () => {
    registerCodeProtocol(fakeExecutor());
    const r = await bridgeOf(backend(['hi'])).runTools({ prompt: 'p', tools, protocol: 'code' });
    expect(r.text).toBe('hi');
  });
});

describe('generateToolsInterface', () => {
  it('renders JSON schema as TypeScript with JSDoc', () => {
    const out = generateToolsInterface({
      search: {
        description: 'Search things',
        parameters: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'query' },
            n: { type: 'integer' },
            kind: { enum: ['a', 'b'] },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['q'],
        },
        execute: () => null,
      },
    });
    expect(out).toContain('declare const tools: {');
    expect(out).toContain('/** Search things */');
    expect(out).toContain('q: string');
    expect(out).toContain('n?: number');
    expect(out).toContain("kind?: 'a' | 'b'");
    expect(out).toContain('tags?: string[]');
    expect(out).toContain('Promise<unknown>');
    expect(out).toContain('/** query */');
  });
});

describe('code prompt v2', () => {
  const defs = {
    add: {
      description: 'Add two numbers',
      parameters: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] },
      execute: () => 1,
    },
  } as never;

  it('has a worked two-step example and the log-first rule', () => {
    const p = buildCodePrompt(defs);
    expect(p).toMatch(/Example/);
    // the example shows the tool call + console.log, then a later plain-text reply
    expect(p).toMatch(/console\.log\(/);
    expect(p).toMatch(/NEXT reply|next reply/i);
    expect(p).toMatch(/never call final\(\)[^\n]*same snippet/i);
    expect(p).toMatch(/plain text and no code block/i);
    expect(p).toMatch(/optional/i);
    expect(p).toMatch(/do not guess/i);
    expect(p).toContain('declare const tools');
  });

  it('stays short for small models (rules + example under 2500 chars before the tools block)', () => {
    const p = buildCodePrompt(defs);
    expect(p.indexOf('Available tools:')).toBeLessThan(2500);
  });

  it('legacy prompt reproduces the original wording', () => {
    const p = buildLegacyCodePrompt(defs);
    expect(p).toContain('You act by writing JavaScript.');
    expect(p).toContain('To finish, call `final(answer)` inside the code');
    expect(p).not.toMatch(/Example/);
  });

  it('systemPrompt option overrides the default', async () => {
    const b = backend(['done']);
    await bridgeOf(b).runTools({
      prompt: 'hi',
      tools,
      protocol: codeProtocol({
        executor: fakeExecutor(),
        systemPrompt: (t) => `CUSTOM ${Object.keys(t).join(',')}`,
      }),
    });
    const sys = b.requests[0].messages.find((m) => m.role === 'system');
    expect(JSON.stringify(sys?.content)).toContain('CUSTOM add');
    expect(JSON.stringify(sys?.content)).not.toContain('declare const tools');
  });

  it('default prompt is v2', async () => {
    const b = backend(['done']);
    await bridgeOf(b).runTools({ prompt: 'hi', tools, protocol: codeProtocol({ executor: fakeExecutor() }) });
    const sys = b.requests[0].messages.find((m) => m.role === 'system');
    expect(JSON.stringify(sys?.content)).toMatch(/same snippet/);
  });
});
