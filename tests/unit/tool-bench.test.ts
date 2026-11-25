/**
 * Tool-protocol benchmark (#241): the pure parts. Task checkers, fake tools,
 * the runner (scripted fake backend, no model), aggregation and the table.
 */

import { describe, it, expect } from 'vitest';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import type { BackendAdapter, IRChatRequest, IRChatResponse, RunToolsResult } from '@johnhenry/aimatey-types';
import {
  TASKS,
  containsNumber,
  makeTransactions,
  EXPECTED_TRAVEL,
  EXPECTED_POP_TOTAL,
} from '../../examples/tools/bench/tasks';
import { ARMS, runOne, instrumentBackend, instrumentExecutor, newProbe, type RunRecord, type RunnerDeps } from '../../examples/tools/bench/runner';
import { aggregate, toMarkdown } from '../../examples/tools/bench/aggregate';
import { parseArgs } from '../../examples/tools/bench/args';

const task = (id: string) => TASKS.find((t) => t.id === id)!;

describe('containsNumber', () => {
  it('matches whole numbers only', () => {
    expect(containsNumber('It is 58 degrees', 58)).toBe(true);
    expect(containsNumber('It is 158 degrees', 58)).toBe(false);
    expect(containsNumber('It is 58.5 degrees', 58)).toBe(false);
    expect(containsNumber('about 585', 58)).toBe(false);
  });
  it('ignores thousands separators', () => {
    expect(containsNumber('total: 25,286 thousand', 25286)).toBe(true);
    expect(containsNumber('1,746.', 1746)).toBe(true);
  });
});

describe('task data', () => {
  it('has the five tasks, heavy ones last', () => {
    expect(TASKS.map((t) => t.id)).toEqual(['t1-single', 't2-chain', 't3-fanout', 't4-aggregate', 't5-recovery']);
    expect(TASKS.filter((t) => t.heavy).map((t) => t.id)).toEqual(['t4-aggregate', 't5-recovery']);
  });
  it('transactions are deterministic and 200 rows', () => {
    const a = makeTransactions();
    expect(a).toHaveLength(200);
    expect(makeTransactions()).toEqual(a);
    const travel = a.filter((r) => r.category === 'travel');
    expect(travel.length).toBe(EXPECTED_TRAVEL.count);
    expect(travel.reduce((s, r) => s + r.amount, 0)).toBe(EXPECTED_TRAVEL.sum);
  });
  it('every tool declares an outputSchema that its real results satisfy (by default)', async () => {
    const samples: Record<string, [string, Record<string, unknown>][]> = {
      't1-single': [['get_temperature', { city: 'Boston' }]],
      't2-chain': [
        ['find_user', { username: 'alice' }],
        ['list_orders', { userId: 'u-417' }],
        ['get_order_total', { orderId: 'o-9011' }],
      ],
      't3-fanout': [['get_population', { city: 'Oslo' }]],
      't4-aggregate': [['list_transactions', {}]],
      't5-recovery': [['get_balance', { accountId: 'ACC-1042' }]],
    };
    const matches = (v: unknown, s: any): boolean => {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
      if (!types.includes(t) && !(t === 'number' && types.includes('integer'))) return false;
      if (t === 'array') return (v as unknown[]).every((x) => matches(x, s.items));
      if (t === 'object') {
        const o = v as Record<string, unknown>;
        return Object.keys(o).every((k) => k in s.properties && matches(o[k], s.properties[k])) &&
          (s.required ?? []).every((k: string) => k in o);
      }
      return true;
    };
    for (const t of TASKS) {
      const inst = t.build();
      for (const [name, input] of samples[t.id]) {
        const def = inst.tools[name];
        expect(def.outputSchema, `${t.id}/${name}`).toBeDefined();
        const out = await def.execute(input, {} as never);
        expect(matches(out, def.outputSchema), `${t.id}/${name}`).toBe(true);
      }
    }
  });
  it('build({ outputSchema: false }) strips them (ablation) without changing results', async () => {
    const a = task('t1-single').build({ outputSchema: false });
    const b = task('t1-single').build();
    expect(a.tools.get_temperature.outputSchema).toBeUndefined();
    expect(await a.tools.get_temperature.execute({ city: 'Boston' }, {} as never)).toEqual(
      await b.tools.get_temperature.execute({ city: 'Boston' }, {} as never)
    );
  });
  it('build() gives fresh call logs each time', async () => {
    const a = task('t1-single').build();
    const b = task('t1-single').build();
    await a.tools.get_temperature.execute({ city: 'Boston' }, {} as never);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
  });
});

describe('checkers', () => {
  it('t1 single call', () => {
    expect(task('t1-single').check('Boston is 58F', [])).toBe(true);
    expect(task('t1-single').check('Boston is 41F', [])).toBe(false);
  });
  it('t2 chain needs the right answer AND the real chain', async () => {
    const inst = task('t2-chain').build();
    expect(task('t2-chain').check('284', inst.calls)).toBe(false); // guessed, no call
    const uid = (await inst.tools.find_user.execute({ username: 'alice' }, {} as never)) as { userId: string };
    const ord = (await inst.tools.list_orders.execute({ userId: uid.userId }, {} as never)) as { orders: string[] };
    await inst.tools.get_order_total.execute({ orderId: ord.orders[ord.orders.length - 1] }, {} as never);
    expect(task('t2-chain').check('The total is $284', inst.calls)).toBe(true);
    expect(task('t2-chain').check('The total is $120', inst.calls)).toBe(false);
  });
  it('t3 fan-out needs the sum and all six lookups', async () => {
    const inst = task('t3-fanout').build();
    const t = task('t3-fanout');
    expect(t.check(String(EXPECTED_POP_TOTAL), inst.calls)).toBe(false);
    for (const city of ['Oslo', 'Lima', 'Kyiv', 'Hanoi', 'Quito', 'Perth']) {
      await inst.tools.get_population.execute({ city }, {} as never);
    }
    expect(t.check(`${EXPECTED_POP_TOTAL.toLocaleString('en-US')} thousand`, inst.calls)).toBe(true);
    expect(t.check('25000', inst.calls)).toBe(false);
  });
  it('t4 needs both count and sum', () => {
    const t = task('t4-aggregate');
    expect(t.check(`count=${EXPECTED_TRAVEL.count} sum=${EXPECTED_TRAVEL.sum}`, [])).toBe(true);
    expect(t.check(`count=${EXPECTED_TRAVEL.count}`, [])).toBe(false);
    expect(t.check(`sum=${EXPECTED_TRAVEL.sum}`, [])).toBe(false);
  });
  it('t5 recovery: the bad id errors with a hint, the retry works', async () => {
    const inst = task('t5-recovery').build();
    const t = task('t5-recovery');
    expect(() => inst.tools.get_balance.execute({ accountId: '1042' }, {} as never)).toThrow(/ACC-NNNN/);
    expect(t.check('731', inst.calls)).toBe(false); // never made a valid call
    await inst.tools.get_balance.execute({ accountId: 'ACC-1042' }, {} as never);
    expect(inst.calls.map((c) => !!c.error)).toEqual([true, false]);
    expect(t.check('Balance: $731', inst.calls)).toBe(true);
  });
});

function fakeResult(text: string, steps = 2, status: RunToolsResult['status'] = 'completed'): RunToolsResult {
  return {
    text,
    steps: Array.from({ length: steps }, (_, i) => ({ iteration: i + 1 })) as unknown as RunToolsResult['steps'],
    status,
    messages: [],
    denials: [],
    finishReason: 'stop',
    response: {} as RunToolsResult['response'],
    totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}
const opts = { timeoutMs: 1000, maxIterations: 5 };

describe('runOne with a scripted fake runTools', () => {
  it('records success, steps, tool calls and reported tokens', async () => {
    const deps: RunnerDeps = {
      async runTools(_p, options, probe) {
        await options.tools.get_temperature.execute({ city: 'Boston' }, {} as never);
        probe.modelCalls = 2;
        probe.usageCalls = 2;
        probe.promptTokens = 300;
        probe.completionTokens = 40;
        return fakeResult('58', 2);
      },
    };
    const rec = await runOne(task('t1-single'), 'native', 'm', 1, deps, opts);
    expect(rec).toMatchObject({
      success: true, steps: 2, modelCalls: 2, toolCalls: 1,
      promptTokens: 300, completionTokens: 40, tokensEstimated: false, timedOut: false,
    });
    expect(rec.codeSnippets).toBeUndefined();
  });

  it('marks a wrong answer as a failure without an error', async () => {
    const deps: RunnerDeps = { runTools: () => Promise.resolve(fakeResult('99')) };
    const rec = await runOne(task('t1-single'), 'text', 'm', 1, deps, opts);
    expect(rec.success).toBe(false);
    expect(rec.error).toBeUndefined();
    expect(rec.answer).toBe('99');
  });

  it('records a thrown error and keeps going', async () => {
    const deps: RunnerDeps = { runTools: () => Promise.reject(new Error('boom')) };
    const rec = await runOne(task('t1-single'), 'native', 'm', 1, deps, opts);
    expect(rec).toMatchObject({ success: false, error: 'boom', timedOut: false });
  });

  it('times out a hung run and aborts its signal', async () => {
    let aborted = false;
    const deps: RunnerDeps = {
      runTools: (_p, o) =>
        new Promise<RunToolsResult>(() => {
          o.signal?.addEventListener('abort', () => (aborted = true));
        }),
    };
    const rec = await runOne(task('t1-single'), 'native', 'm', 1, deps, { ...opts, timeoutMs: 30 });
    expect(rec.timedOut).toBe(true);
    expect(rec.success).toBe(false);
    expect(rec.error).toMatch(/timed out/);
    expect(aborted).toBe(true);
  });

  it('treats a non-completed status as failure even with a right-looking answer', async () => {
    const deps: RunnerDeps = { runTools: () => Promise.resolve(fakeResult('58', 1, 'max-denials')) };
    const rec = await runOne(task('t1-single'), 'native', 'm', 1, deps, opts);
    expect(rec.success).toBe(false);
    expect(rec.error).toMatch(/max-denials/);
  });

  it('estimates tokens (chars/4) and says so when usage is missing', async () => {
    const deps: RunnerDeps = {
      runTools(_p, _o, probe) {
        probe.modelCalls = 1;
        probe.promptChars = 400;
        probe.completionChars = 80;
        return Promise.resolve(fakeResult('58', 1));
      },
    };
    const rec = await runOne(task('t1-single'), 'native', 'm', 1, deps, opts);
    expect(rec).toMatchObject({ promptTokens: 100, completionTokens: 20, tokensEstimated: true });
  });

  it('records code snippet stats only for the code protocol', async () => {
    const deps: RunnerDeps = {
      runTools(_p, _o, probe) {
        probe.codeSnippets = 2;
        probe.codeMs = 250;
        probe.codeErrors = 1;
        return Promise.resolve(fakeResult('58'));
      },
    };
    const rec = await runOne(task('t1-single'), 'code', 'm', 1, deps, opts);
    expect(rec).toMatchObject({ codeSnippets: 2, codeMs: 250, codeErrors: 1 });
  });
});

describe('arms', () => {
  it('defines the four ablation arms', () => {
    expect(ARMS.map((a) => [a.id, a.outputSchema, a.prompt])).toEqual([
      ['A', false, 'legacy'],
      ['B', true, 'legacy'],
      ['C', false, 'v2'],
      ['D', true, 'v2'],
    ]);
  });
  it('runOne builds tools per arm and records the arm', async () => {
    let schema: unknown = 'unset';
    const deps: RunnerDeps = {
      runTools(_p, o) {
        schema = o.tools.get_temperature.outputSchema;
        return Promise.resolve(fakeResult('58'));
      },
    };
    const rec = await runOne(task('t1-single'), 'code', 'm', 1, deps, { ...opts, arm: ARMS[0] });
    expect(schema).toBeUndefined();
    expect(rec.arm).toBe('A');
    await runOne(task('t1-single'), 'code', 'm', 1, deps, { ...opts, arm: ARMS[3] });
    expect(schema).toBeDefined();
  });
  it('parseArgs reads --arms and aggregate separates arms', () => {
    expect(parseArgs(['--arms', 'D,A']).arms?.map((a) => a.id)).toEqual(['D', 'A']);
    expect(() => parseArgs(['--arms', 'Z'])).toThrow(/unknown arm/);
    const mk = (arm: string, success: boolean): RunRecord => ({
      task: 't1-single', protocol: 'code', model: 'm', repeat: 1, success, steps: 1, modelCalls: 1, toolCalls: 1,
      promptTokens: 1, completionTokens: 1, tokensEstimated: false, wallMs: 1, timedOut: false, arm,
    });
    const cells = aggregate([mk('A', false), mk('D', true)]);
    expect(cells.map((c) => [c.arm, c.successes])).toEqual([['A', 0], ['D', 1]]);
    expect(toMarkdown([mk('A', false), mk('D', true)])).toMatch(/code \(arm D\)/);
  });
});

describe('instrumentation', () => {
  const metadata = {
    name: 'fake', version: '1', provider: 'Mock',
    capabilities: { streaming: false, multiModal: false, tools: false, systemMessageStrategy: 'in-messages', supportsMultipleSystemMessages: false },
  };
  function fake(usage: boolean): BackendAdapter {
    return {
      metadata,
      fromIR: (r: unknown) => r,
      toIR: () => { throw new Error('unused'); },
      execute: (request: IRChatRequest): Promise<IRChatResponse> =>
        Promise.resolve({
          message: { role: 'assistant', content: '58' },
          finishReason: 'stop',
          metadata: request.metadata,
          ...(usage && { usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 } }),
        } as IRChatResponse),
      // eslint-disable-next-line require-yield
      executeStream: async function* () { throw new Error('unused'); },
    } as unknown as BackendAdapter;
  }

  it('counts model calls and usage through a real Bridge', async () => {
    const probe = newProbe();
    const bridge = new Bridge(new OpenAIFrontendAdapter(), instrumentBackend(fake(true), probe));
    const t = task('t1-single').build();
    const r = await bridge.runTools({ prompt: 'hi', tools: t.tools });
    expect(r.text).toBe('58');
    expect(probe).toMatchObject({ modelCalls: 1, usageCalls: 1, promptTokens: 10, completionTokens: 3 });
    expect(probe.promptChars).toBeGreaterThan(0);
  });

  it('leaves usageCalls at 0 when the backend reports none', async () => {
    const probe = newProbe();
    const bridge = new Bridge(new OpenAIFrontendAdapter(), instrumentBackend(fake(false), probe));
    await bridge.runTools({ prompt: 'hi', tools: task('t1-single').build().tools });
    expect(probe.modelCalls).toBe(1);
    expect(probe.usageCalls).toBe(0);
  });

  it('instrumentExecutor counts snippets, errors and time', async () => {
    const probe = newProbe();
    const inner = {
      run: async (code: string) => (code === 'bad' ? { error: { name: 'E' } } : { logs: [] }),
    };
    const ex = instrumentExecutor(inner, probe);
    await ex.run('ok', {});
    await ex.run('bad', {});
    expect(probe).toMatchObject({ codeSnippets: 2, codeErrors: 1 });
    expect(probe.codeMs).toBeGreaterThanOrEqual(0);
  });
});

function rec(over: Partial<RunRecord>): RunRecord {
  return {
    task: 't1-single', protocol: 'native', model: 'm', repeat: 1, success: true, steps: 2, modelCalls: 2,
    toolCalls: 1, promptTokens: 100, completionTokens: 20, tokensEstimated: false, wallMs: 10_000, timedOut: false,
    ...over,
  };
}

describe('aggregate and table', () => {
  const runs = [
    rec({}),
    rec({ repeat: 2, success: false, steps: 4, modelCalls: 4, wallMs: 20_000, promptTokens: 300, timedOut: true }),
    rec({ protocol: 'code', codeMs: 400, codeSnippets: 1, tokensEstimated: true }),
    rec({ task: 't2-chain', protocol: 'text' }),
  ];

  it('computes per-cell means over all runs, failures included', () => {
    const cells = aggregate(runs);
    const native = cells.find((c) => c.task === 't1-single' && c.protocol === 'native')!;
    expect(native).toMatchObject({ runs: 2, successes: 1, successRate: 0.5, meanSteps: 3, meanModelCalls: 3, timeouts: 1 });
    expect(native.meanTokens).toBe((120 + 320) / 2);
    expect(native.meanWallMs).toBe(15_000);
    expect(native.meanCodeMs).toBeNull();
    const code = cells.find((c) => c.protocol === 'code')!;
    expect(code.meanCodeMs).toBe(400);
    expect(code.tokensEstimated).toBe(true);
  });

  it('orders cells native, text, code within a task', () => {
    const order = aggregate([rec({ protocol: 'code' }), rec({ protocol: 'text' }), rec({ protocol: 'native' })]).map((c) => c.protocol);
    expect(order).toEqual(['native', 'text', 'code']);
  });

  it('renders a markdown table per model with a pooled row and the estimate footnote', () => {
    const md = toMarkdown(runs, { 't1-single': 'single call' });
    expect(md).toContain('### m');
    expect(md).toContain('| task | protocol | runs | success |');
    expect(md).toContain('| single call | native | 2 | 50% (1/2) | 3.0 | 3.0 | 1.0 | 220 | 15.0 | - | 1 |');
    expect(md).toContain('**all tasks**');
    expect(md).toContain('t2-chain'); // falls back to the id with no display name
    expect(md).toMatch(/\*` token counts include an estimate|`\*` token counts/);
    expect(md).toMatch(/\| 120\* \|/); // code cell flagged
  });

  it('handles an empty results list', () => {
    expect(aggregate([])).toEqual([]);
    expect(() => toMarkdown([])).not.toThrow();
  });
});

describe('parseArgs', () => {
  it('defaults', () => {
    const a = parseArgs([]);
    expect(a).toMatchObject({ models: ['qwen2.5:3b'], repeats: 2, protocols: ['native', 'text', 'code'] });
  });
  it('parses flags', () => {
    const a = parseArgs(['--model', 'a', '--model', 'b', '--repeats', '3', '--timeout-s', '10', '--protocols', 'native,code', '--tasks', 't1,t2', '--resume']);
    expect(a).toMatchObject({ models: ['a', 'b'], repeats: 3, timeoutMs: 10_000, protocols: ['native', 'code'], tasks: ['t1', 't2'], resume: true });
  });
  it('rejects unknown flags and protocols', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown flag/);
    expect(() => parseArgs(['--protocols', 'xml'])).toThrow(/unknown protocol/);
    expect(() => parseArgs(['--repeats'])).toThrow(/needs a value/);
  });
});
