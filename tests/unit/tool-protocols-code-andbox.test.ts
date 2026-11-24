/**
 * `code` protocol against real andbox wasm mode (#240, layer 2). Skipped with
 * a clear message when the optional engine is not installed.
 */

import { describe, it, expect } from 'vitest';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import type { BackendAdapter, IRChatRequest, IRChatResponse } from '@johnhenry/aimatey-types';
import { codeProtocol, andboxExecutor } from '@johnhenry/aimatey-tool-protocols';

async function engineAvailable(): Promise<boolean> {
  try {
    const { createSandbox } = await import('@johnhenry/andbox');
    const s = await createSandbox({ mode: 'wasm' });
    s.dispose();
    return true;
  } catch (e) {
    console.warn(`[skip] andbox wasm engine unavailable: ${(e as Error).message}`);
    return false;
  }
}
const available = await engineAvailable();
const d = describe.skipIf(!available);

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

const calls: string[] = [];
const tools = {
  add: {
    description: 'Add',
    parameters: {
      type: 'object' as const,
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
    execute: ({ a, b }: Record<string, unknown>) => {
      calls.push('add');
      return (a as number) + (b as number);
    },
  },
  weird: {
    description: 'Returns non-JSON-safe values',
    parameters: { type: 'object' as const, properties: {} },
    execute: () => {
      const circ: Record<string, unknown> = { n: 1n, d: new Date(0), m: new Map([[1, 2]]) };
      circ.self = circ;
      return circ;
    },
  },
};

const run = (replies: string[], extra: Record<string, unknown> = {}, limits = {}) => {
  const b = backend(replies);
  return bridgeOf(b)
    .runTools({
      prompt: 'p',
      tools,
      protocol: codeProtocol({ executor: andboxExecutor(), limits }),
      ...extra,
    })
    .then((r) => ({ r, b }));
};
const lastFeedback = (b: { requests: IRChatRequest[] }) =>
  JSON.stringify(b.requests[1].messages.at(-1));

d('code protocol (andbox wasm)', () => {
  it('multi-call chain with a loop and Promise.all', async () => {
    const { r, b } = await run([
      fence(
        `let t = 0;
for (let i = 1; i <= 3; i++) t = await tools.add({a: t, b: i});
const [x, y] = await Promise.all([tools.add({a:1,b:1}), tools.add({a:10,b:10})]);
console.log("t", t);
return {t, x, y};`
      ),
      'fin',
    ]);
    expect(r.text).toBe('fin');
    expect(r.steps[0].toolCalls).toHaveLength(5);
    expect(r.steps[0].toolCalls.map((c) => c.id)).toEqual([
      'code-1-1',
      'code-1-2',
      'code-1-3',
      'code-1-4',
      'code-1-5',
    ]);
    const fb = lastFeedback(b);
    expect(fb).toContain('t 6');
    expect(fb).toContain('Returned: {\\"t\\":6,\\"x\\":2,\\"y\\":20}');
  });

  it('a denied call is caught by the snippet', async () => {
    const { r, b } = await run(
      [
        fence('try { await tools.add({a:1,b:2}) } catch (e) { console.log("caught", e.message) }'),
        'ok',
      ],
      { gate: () => ({ action: 'deny', reason: 'nope' }) }
    );
    expect(r.denials).toHaveLength(1);
    expect(lastFeedback(b)).toContain('caught');
    expect(lastFeedback(b)).toContain('nope');
  });

  it('final(answer) ends the loop', async () => {
    const { r, b } = await run([fence('final("done: " + (await tools.add({a:1,b:1})))'), 'x']);
    expect(r.text).toBe('done: 2');
    expect(b.requests).toHaveLength(1);
  });

  it('an infinite loop is stopped and the loop continues with an error', async () => {
    const { r, b } = await run([fence('while (true) {}'), 'recovered'], {}, { deadlineMs: 1500 });
    expect(r.text).toBe('recovered');
    expect(lastFeedback(b)).toMatch(/Fuel|Timeout|deadline|ERR_ANDBOX/i);
  }, 20_000);

  it('fuel limit stops a busy loop deterministically', async () => {
    const { r, b } = await run(
      [fence('let i = 0; while (true) { i++ }'), 'recovered'],
      {},
      { fuel: 5 }
    );
    expect(r.text).toBe('recovered');
    expect(lastFeedback(b)).toMatch(/Fuel/i);
  }, 20_000);

  it('an allocation bomb hits the memory limit', async () => {
    const { r, b } = await run(
      [fence('const a = []; while (true) a.push("x".repeat(1e6));'), 'recovered'],
      {},
      { memoryBytes: 8 * 1024 * 1024, deadlineMs: 10_000 }
    );
    expect(r.text).toBe('recovered');
    expect(lastFeedback(b)).toMatch(/Memory|ERR_ANDBOX_MEMORY/i);
  }, 30_000);

  it('the guest cannot reach fetch, process or timers', async () => {
    const { b } = await run([
      fence(
        'console.log(typeof fetch, typeof process, typeof setTimeout, typeof require, typeof XMLHttpRequest, typeof WebSocket)'
      ),
      'ok',
    ]);
    expect(lastFeedback(b)).toContain(
      'undefined undefined undefined undefined undefined undefined'
    );
  });

  it('non-JSON-safe tool results are handled', async () => {
    const { b } = await run([
      fence('const w = await tools.weird({}); console.log(typeof w); return Object.keys(w)'),
      'ok',
    ]);
    const fb = lastFeedback(b);
    expect(fb).not.toMatch(/Error/);
    expect(fb).toContain('object');
  });

  it('reports syntax errors readably', async () => {
    const { r, b } = await run([fence('const = ;'), 'ok']);
    expect(r.text).toBe('ok');
    expect(lastFeedback(b)).toMatch(/SyntaxError|error/i);
  });

  it('caps tool calls per snippet', async () => {
    const { b } = await run(
      [
        fence(
          'let n = 0; try { for (;;) { await tools.add({a:1,b:1}); n++ } } catch (e) { console.log("stopped", n, e.message) }'
        ),
        'ok',
      ],
      {},
      { maxToolCalls: 3 }
    );
    expect(lastFeedback(b)).toContain('stopped 3');
  });
});
