/**
 * Fixed task set for the tool-protocol benchmark (#241).
 *
 * Every task builds a FRESH set of deterministic fake tools (so repeats
 * cannot leak state) and a pure checker that decides correctness from the
 * model's final answer and the tool-call log. No LLM judge.
 *
 * @module
 */

import type { ToolDefinition } from '@johnhenry/aimatey-types';

/** One recorded tool invocation. */
export interface ToolCallRecord {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly error?: string;
}

export interface BuildOptions {
  readonly outputSchema?: boolean;
}

export interface TaskInstance {
  readonly tools: Record<string, ToolDefinition>;
  /** Every call the fake tools received (including ones that errored). */
  readonly calls: ToolCallRecord[];
}

export interface BenchTask {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  /** Heavy tasks get fewer repeats by default (big prompts, slow on CPU). */
  readonly heavy: boolean;
  /** The expected answer, for reports. */
  readonly expected: string;
  /** `outputSchema: false` strips every tool's outputSchema (benchmark ablation); default true. */
  build(options?: BuildOptions): TaskInstance;
  check(answer: string, calls: readonly ToolCallRecord[]): boolean;
}

/** True when `n` appears in `text` as a whole number (thousands separators and `$` ignored). */
export function containsNumber(text: string, n: number | string): boolean {
  const cleaned = text.replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  const re = new RegExp(`(?<![\\d.])${String(n).replace(/\./g, '\\.')}(?![\\d]|\\.\\d)`);
  return re.test(cleaned);
}

function instrument(
  calls: ToolCallRecord[],
  name: string,
  def: Omit<ToolDefinition, 'execute'>,
  run: (input: Record<string, unknown>) => unknown
): ToolDefinition {
  return {
    ...def,
    execute: (input: Record<string, unknown>) => {
      try {
        const out = run(input);
        calls.push({ name, input });
        return out;
      } catch (e) {
        calls.push({ name, input, error: (e as Error).message });
        throw e;
      }
    },
  } as ToolDefinition;
}

const obj = (properties: Record<string, unknown>) => ({
  type: 'object' as const,
  properties,
  required: Object.keys(properties),
});
const nullable = (type: string) => ({ type: [type, 'null'] });

const str = (description: string) => ({ type: 'string' as const, description });

// ---- 1. single call -------------------------------------------------------

const TEMPS: Record<string, number> = { Boston: 58, Denver: 41, Phoenix: 97 };

const singleCall: BenchTask = {
  id: 't1-single',
  name: 'single call',
  prompt: 'What is the current temperature in Boston, in Fahrenheit? Use the tool, then reply with the number.',
  heavy: false,
  expected: '58',
  build() {
    const calls: ToolCallRecord[] = [];
    return {
      calls,
      tools: {
        get_temperature: instrument(
          calls,
          'get_temperature',
          {
            description: 'Current temperature in Fahrenheit for a city',
            outputSchema: obj({ city: { type: 'string' }, fahrenheit: nullable('number') }),
            parameters: { type: 'object', properties: { city: str('City name') }, required: ['city'] },
          },
          ({ city }) => ({ city, fahrenheit: TEMPS[city as string] ?? null })
        ),
      },
    };
  },
  check: (answer) => containsNumber(answer, 58),
};

// ---- 2. sequential chain --------------------------------------------------

const ORDERS: Record<string, { orders: string[] }> = { 'u-417': { orders: ['o-9003', 'o-9007', 'o-9011'] } };
const TOTALS: Record<string, number> = { 'o-9003': 120, 'o-9007': 75, 'o-9011': 284 };

const chain: BenchTask = {
  id: 't2-chain',
  name: '3-call chain',
  prompt:
    "What is the total of the most recent order placed by the user 'alice'? " +
    'Look up the user, then their orders (listed oldest first), then the total of the latest one. Reply with the number.',
  heavy: false,
  expected: '284',
  build() {
    const calls: ToolCallRecord[] = [];
    return {
      calls,
      tools: {
        find_user: instrument(
          calls,
          'find_user',
          {
            description: 'Find a user by username; returns their userId',
            outputSchema: obj({ userId: nullable('string') }),
            parameters: { type: 'object', properties: { username: str('Username') }, required: ['username'] },
          },
          ({ username }) => (username === 'alice' ? { userId: 'u-417' } : { userId: null })
        ),
        list_orders: instrument(
          calls,
          'list_orders',
          {
            description: 'List order ids for a userId, oldest first',
            outputSchema: obj({ orders: { type: 'array', items: { type: 'string' } } }),
            parameters: { type: 'object', properties: { userId: str('A userId from find_user') }, required: ['userId'] },
          },
          ({ userId }) => ORDERS[userId as string] ?? { orders: [] }
        ),
        get_order_total: instrument(
          calls,
          'get_order_total',
          {
            description: 'Total in dollars for an order id',
            outputSchema: obj({ orderId: { type: 'string' }, total: nullable('number') }),
            parameters: { type: 'object', properties: { orderId: str('An order id from list_orders') }, required: ['orderId'] },
          },
          ({ orderId }) => ({ orderId, total: TOTALS[orderId as string] ?? null })
        ),
      },
    };
  },
  check: (answer, calls) =>
    containsNumber(answer, 284) &&
    calls.some((c) => c.name === 'get_order_total' && c.input.orderId === 'o-9011' && !c.error),
};

// ---- 3. fan-out -----------------------------------------------------------

const POPS: Record<string, number> = { Oslo: 709, Lima: 9751, Kyiv: 2884, Hanoi: 8054, Quito: 1763, Perth: 2125 };
const POP_TOTAL = Object.values(POPS).reduce((a, b) => a + b, 0);

const fanOut: BenchTask = {
  id: 't3-fanout',
  name: 'fan-out x6',
  prompt:
    'Look up the population (in thousands) of each of these six cities with the tool: ' +
    'Oslo, Lima, Kyiv, Hanoi, Quito, Perth. Then reply with their combined population in thousands.',
  heavy: false,
  expected: String(POP_TOTAL),
  build() {
    const calls: ToolCallRecord[] = [];
    return {
      calls,
      tools: {
        get_population: instrument(
          calls,
          'get_population',
          {
            description: 'Population of a city in thousands',
            outputSchema: obj({ city: { type: 'string' }, thousands: nullable('number') }),
            parameters: { type: 'object', properties: { city: str('City name') }, required: ['city'] },
          },
          ({ city }) => ({ city, thousands: POPS[city as string] ?? null })
        ),
      },
    };
  },
  check: (answer, calls) =>
    containsNumber(answer, POP_TOTAL) &&
    Object.keys(POPS).every((c) => calls.some((k) => k.name === 'get_population' && k.input.city === c)),
};

// ---- 4. filter / aggregate a large result ---------------------------------

const CATEGORIES = ['food', 'travel', 'rent', 'fun', 'tools'];
/** 200 deterministic rows: a tiny LCG, no Math.random. */
export function makeTransactions(): { id: number; category: string; amount: number }[] {
  let s = 12345;
  const next = (): number => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s;
  };
  return Array.from({ length: 200 }, (_, i) => ({
    id: i + 1,
    category: CATEGORIES[next() % CATEGORIES.length],
    amount: (next() % 90) + 10,
  }));
}
const TX = makeTransactions();
const TRAVEL = TX.filter((r) => r.category === 'travel');
const TRAVEL_COUNT = TRAVEL.length;
const TRAVEL_SUM = TRAVEL.reduce((a, r) => a + r.amount, 0);

const aggregate: BenchTask = {
  id: 't4-aggregate',
  name: 'large result aggregate',
  prompt:
    "Call list_transactions, then tell me how many transactions have category 'travel' and the sum of their amounts. " +
    "Reply in the form 'count=<n> sum=<n>'.",
  heavy: true,
  expected: `count=${TRAVEL_COUNT} sum=${TRAVEL_SUM}`,
  build() {
    const calls: ToolCallRecord[] = [];
    return {
      calls,
      tools: {
        list_transactions: instrument(
          calls,
          'list_transactions',
          {
            description: 'List all 200 transactions as rows {id, category, amount}',
            outputSchema: {
              type: 'array',
              items: obj({ id: { type: 'number' }, category: { type: 'string' }, amount: { type: 'number' } }),
            },
            parameters: { type: 'object', properties: {} },
          },
          () => TX
        ),
      },
    };
  },
  check: (answer) => containsNumber(answer, TRAVEL_COUNT) && containsNumber(answer, TRAVEL_SUM),
};

// ---- 5. error recovery ----------------------------------------------------

const ACCOUNTS: Record<string, number> = { 'ACC-1042': 731 };

const errorRecovery: BenchTask = {
  id: 't5-recovery',
  name: 'error recovery',
  prompt: 'What is the balance of account 1042? Use the tool, then reply with the number.',
  heavy: true,
  expected: '731',
  build() {
    const calls: ToolCallRecord[] = [];
    return {
      calls,
      tools: {
        get_balance: instrument(
          calls,
          'get_balance',
          {
            description: 'Balance in dollars for an account id',
            outputSchema: obj({ accountId: { type: 'string' }, balance: { type: 'number' } }),
            parameters: { type: 'object', properties: { accountId: str('Account id') }, required: ['accountId'] },
          },
          ({ accountId }) => {
            if (typeof accountId !== 'string' || !/^ACC-\d{4}$/.test(accountId)) {
              throw new Error(`Invalid account id '${String(accountId)}': expected the form ACC-NNNN, e.g. ACC-1042`);
            }
            if (!(accountId in ACCOUNTS)) {
              throw new Error(`No such account ${accountId}`);
            }
            return { accountId, balance: ACCOUNTS[accountId] };
          }
        ),
      },
    };
  },
  check: (answer, calls) =>
    containsNumber(answer, 731) &&
    calls.some((c) => c.name === 'get_balance' && c.input.accountId === 'ACC-1042' && !c.error),
};

/** Same tools with `outputSchema` removed (the original, untyped-result bench). */
function stripSchemas(instance: TaskInstance): TaskInstance {
  const tools = Object.fromEntries(
    Object.entries(instance.tools).map(([name, def]) => {
      const { outputSchema: _dropped, ...rest } = def;
      return [name, rest as ToolDefinition];
    })
  );
  return { calls: instance.calls, tools };
}

const withBuildOptions = (task: BenchTask): BenchTask => ({
  ...task,
  build: (options) => {
    const instance = task.build();
    return options?.outputSchema === false ? stripSchemas(instance) : instance;
  },
});

export const TASKS: readonly BenchTask[] = [singleCall, chain, fanOut, aggregate, errorRecovery].map(withBuildOptions);
export const EXPECTED_TRAVEL = { count: TRAVEL_COUNT, sum: TRAVEL_SUM };
export const EXPECTED_POP_TOTAL = POP_TOTAL;
