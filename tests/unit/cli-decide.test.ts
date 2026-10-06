/**
 * `ai-matey decide` (packages/cli/src/decide.ts): the --question grammar,
 * argument parsing, table / JSON output, batch mode and exit codes, against
 * the mock decision backend (no network).
 */

import { describe, it, expect } from 'vitest';
import { createMockDecisionBackend } from '@johnhenry/aimatey-testing';
import { ProviderError } from '@johnhenry/aimatey-errors';
import { ErrorCode } from '@johnhenry/aimatey-types';
import type { IRDecisionAnswer, IRDecisionRequest, IRDecisionResponse } from '@johnhenry/aimatey-types';
import {
  DecideUsageError,
  decideCommand,
  formatDecisionTable,
  parseDecideArgs,
  parseQuestionSpec,
  type DecideDeps,
} from '../../packages/cli/src/decide.js';

// ============================================================================
// --question grammar
// ============================================================================

describe('parseQuestionSpec', () => {
  it('parses a choice question with option=description pairs', () => {
    expect(parseQuestionSpec('team:choice:"Who owns this?":billing=invoices and refunds,tech=bugs')).toEqual({
      name: 'team',
      question: {
        type: 'choice',
        instructions: 'Who owns this?',
        criteria: { billing: 'invoices and refunds', tech: 'bugs' },
      },
    });
  });

  it('parses a score question with a level list', () => {
    expect(parseQuestionSpec('urgency:score:"How urgent?":low,mid,high')).toEqual({
      name: 'urgency',
      question: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'mid', 'high'] },
    });
  });

  it('parses a noul question with and without true/false labels', () => {
    expect(parseQuestionSpec('spam:noul:"Is this spam?"').question).toEqual({
      type: 'noul',
      instructions: 'Is this spam?',
    });
    expect(parseQuestionSpec('spam:noul:"Is this spam?":true=unsolicited,false=wanted').question).toEqual({
      type: 'noul',
      instructions: 'Is this spam?',
      criteria: { true: 'unsolicited', false: 'wanted' },
    });
  });

  it("accepts 'boolean' as an alias of noul", () => {
    expect(parseQuestionSpec('ok:boolean:"Fine?"').question.type).toBe('noul');
  });

  it('accepts unquoted instructions that contain no colon or comma-sensitive text', () => {
    expect(parseQuestionSpec('spam:noul:Is this spam?').question).toEqual({
      type: 'noul',
      instructions: 'Is this spam?',
    });
    expect(parseQuestionSpec('urgency:score:How urgent:low,high').question).toMatchObject({
      instructions: 'How urgent',
      criteria: ['low', 'high'],
    });
  });

  it('allows colons, commas and escaped quotes inside quoted instructions', () => {
    const { question } = parseQuestionSpec(
      String.raw`q:noul:"Re: \"refund\", yes, or no?"`
    );
    expect(question.instructions).toBe('Re: "refund", yes, or no?');
  });

  it('allows quoted option descriptions containing commas and colons', () => {
    const { question } = parseQuestionSpec(
      'team:choice:"Who?":billing="money, refunds: all of it",tech=bugs'
    );
    expect(question).toMatchObject({
      criteria: { billing: 'money, refunds: all of it', tech: 'bugs' },
    });
  });

  it('allows a bare choice option name, using it as its own description', () => {
    expect(parseQuestionSpec('c:choice:"Pick":a,b').question).toMatchObject({
      criteria: { a: 'a', b: 'b' },
    });
  });

  it('allows an unquoted description to contain a colon (the options are the rest of the spec)', () => {
    expect(parseQuestionSpec('c:choice:"Pick":a=x: y,b=z').question).toMatchObject({
      criteria: { a: 'x: y', b: 'z' },
    });
  });

  it('trims whitespace around names, types and levels', () => {
    expect(parseQuestionSpec(' u : score : "How?" : low , high ')).toEqual({
      name: 'u',
      question: { type: 'score', instructions: 'How?', criteria: ['low', 'high'] },
    });
  });

  it.each([
    ['', /empty/],
    ['onlyname', /name:type:"instructions"/],
    ['q:noul', /name:type:"instructions"/],
    [':noul:"x"', /name/],
    ['bad name:noul:"x"', /name/],
    ['q:rank:"x"', /type 'rank'/],
    ['q:noul:""', /instructions/],
    ['q:noul:"unterminated', /unterminated/i],
    ['q:choice:"Pick"', /at least 2 options/],
    ['q:choice:"Pick":only=one', /at least 2 options/],
    ['q:choice:"Pick":a=1,a=2', /duplicate option 'a'/],
    ['q:choice:"Pick":a=,b=2', /description/],
    ['q:score:"How"', /at least 2 levels/],
    ['q:score:"How":one', /at least 2 levels/],
    ['q:score:"How":a,,b', /empty level/],
    ['q:noul:"x":yes=1,no=2', /true=.*false=/],
    ['q:noul:"x":true=only', /true=.*false=/],
  ])('rejects %j', (spec, message) => {
    expect(() => parseQuestionSpec(spec)).toThrow(DecideUsageError);
    expect(() => parseQuestionSpec(spec)).toThrow(message);
  });
});

// ============================================================================
// Argument parsing
// ============================================================================

describe('parseDecideArgs', () => {
  it('collects repeatable flags and both value syntaxes', () => {
    const args = parseDecideArgs([
      '--backend',
      'ollama',
      '--model=tev1:0.8b',
      '--state',
      'hello',
      '--question',
      'a:noul:"A?"',
      '--question=b:noul:"B?"',
      '--questions',
      '@qs.json',
      '--image',
      'one.png',
      '--image',
      'two.jpg',
      '--json',
      '--concurrency',
      '2',
    ]);
    expect(args).toMatchObject({
      backend: 'ollama',
      model: 'tev1:0.8b',
      state: 'hello',
      questions: ['a:noul:"A?"', 'b:noul:"B?"'],
      questionsFile: 'qs.json',
      images: ['one.png', 'two.jpg'],
      json: true,
      concurrency: 2,
    });
  });

  it('supports --batch @file and rejects a missing @', () => {
    expect(parseDecideArgs(['--batch', '@in.jsonl']).batch).toBe('in.jsonl');
    expect(() => parseDecideArgs(['--batch', 'in.jsonl'])).toThrow(/@file/);
    expect(() => parseDecideArgs(['--questions', 'qs.json'])).toThrow(/@file/);
  });

  it('reports -h/--help', () => {
    expect(parseDecideArgs(['-h']).help).toBe(true);
    expect(parseDecideArgs(['--help']).help).toBe(true);
  });

  it.each([
    [['--nope'], /Unknown option/],
    [['--model'], /requires a value/],
    [['--concurrency', 'x'], /positive integer/],
    [['stray'], /Unexpected argument/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseDecideArgs(argv)).toThrow(DecideUsageError);
    expect(() => parseDecideArgs(argv)).toThrow(message);
  });
});

// ============================================================================
// Table
// ============================================================================

const request: IRDecisionRequest = {
  state: 'x',
  questions: {
    team: { type: 'choice', instructions: 'Team?', criteria: { billing: 'b', tech: 't' } },
    urgency: { type: 'score', instructions: 'Urgent?', criteria: ['low', 'mid', 'high'] },
    spam: { type: 'noul', instructions: 'Spam?' },
  },
  metadata: { requestId: 'r', timestamp: 0 },
};

const answers: Record<string, IRDecisionAnswer> = {
  team: { type: 'choice', value: 'billing', probabilities: { billing: 0.8, tech: 0.2 }, confidence: 0.8 },
  urgency: { type: 'score', value: 2, probabilities: [0.1, 0.2, 0.7], confidence: 0.7 },
  spam: { type: 'noul', value: 0.05 },
};

const response: IRDecisionResponse = {
  answers,
  model: 'tev1:0.8b',
  usage: { inputTokens: 12, outputTokens: 1 },
  metadata: { requestId: 'r', timestamp: 0 },
};

describe('formatDecisionTable', () => {
  it('renders value, probability bar and confidence per question', () => {
    expect(formatDecisionTable(response, request)).toMatchInlineSnapshot(`
      "QUESTION  VALUE     PROBABILITY     CONFIDENCE
      team      billing   ████████░░ 80%  0.80
      urgency   high (2)  ███████░░░ 70%  0.70
      spam      false     ░░░░░░░░░░ 5%   -
      model tev1:0.8b · 12 in · 1 out tokens"
    `)
  });

  it('shows the true side of a noul and a dash when no probability is reported', () => {
    const table = formatDecisionTable(
      {
        ...response,
        usage: undefined,
        answers: {
          team: { type: 'choice', value: 'tech' },
          urgency: { type: 'score', value: 0 },
          spam: { type: 'noul', value: 0.93, confidence: 0.93 },
        },
      },
      request
    );
    expect(table).toContain('tech');
    expect(table).toMatch(/spam\s+true\s+█████████░ 93%\s+0\.93/);
    expect(table).toMatch(/team\s+tech\s+-\s+-/);
    expect(table).toMatch(/urgency\s+low \(0\)\s+-\s+-/);
    expect(table.split('\n').at(-1)).toBe('model tev1:0.8b');
  });

  it('lists warnings and an escalation note', () => {
    const table = formatDecisionTable(
      {
        ...response,
        metadata: {
          ...response.metadata,
          warnings: [{ category: 'capability-emulated', severity: 'info', message: 'emulated by a chat model' }],
          custom: {
            escalation: {
              triggeredBy: [{ question: 'team', reason: 'confidence_below' }],
              primaryModel: 'small',
            },
          },
        },
      },
      request
    );
    expect(table).toContain('warning: emulated by a chat model');
    expect(table).toContain('escalated from small (team: confidence_below)');
  });
});

// ============================================================================
// Command
// ============================================================================

function harness(files: Record<string, string | Buffer> = {}, stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  const deps: Partial<DecideDeps> = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    readFile: async (path) => {
      const file = files[path];
      if (file === undefined) throw new Error(`ENOENT: ${path}`);
      return Buffer.from(file);
    },
    readStdin: async () => stdin,
  };
  return { deps, out, err, stdout: () => out.join(''), stderr: () => err.join('') };
}

const Q = ['--question', 'spam:noul:"Is this spam?"', '--question', 'urgency:score:"How urgent?":low,mid,high'];
const cannedAnswers = {
  spam: { type: 'noul', value: 0.9 } as const,
  urgency: { type: 'score', value: 1, probabilities: [0.2, 0.6, 0.2], confidence: 0.6 } as const,
};

describe('decideCommand', () => {
  it('asks the questions and prints the table, exit 0', async () => {
    const backend = createMockDecisionBackend({ answers: cannedAnswers });
    const h = harness();
    const code = await decideCommand(['--state', 'WIN A PRIZE', ...Q, '--model', 'm1'], {
      ...h.deps,
      backend,
    });
    expect(code).toBe(0);
    expect(h.stdout()).toMatch(/spam\s+true\s+█████████░ 90%/);
    expect(h.stdout()).toMatch(/urgency\s+mid \(1\)/);
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]!.state).toBe('WIN A PRIZE');
    expect(backend.calls[0]!.parameters?.model).toBe('m1');
    expect(backend.calls[0]!.questions.urgency).toEqual({
      type: 'score',
      instructions: 'How urgent?',
      criteria: ['low', 'mid', 'high'],
    });
  });

  it('--json prints the raw IR response and nothing else on stdout', async () => {
    const backend = createMockDecisionBackend({ answers: cannedAnswers });
    const h = harness();
    const code = await decideCommand(['--state', 's', ...Q, '--json'], { ...h.deps, backend });
    expect(code).toBe(0);
    const parsed = JSON.parse(h.stdout());
    expect(parsed.answers.spam).toEqual({ type: 'noul', value: 0.9 });
    expect(parsed.model).toBe('mock-decision-model');
  });

  it('--json output is stable for a fixed backend response', async () => {
    const backend = createMockDecisionBackend({
      handler: () => ({
        answers: { spam: { type: 'noul', value: 0.9 }, urgency: cannedAnswers.urgency },
        model: 'fixed-model',
        usage: { inputTokens: 3 },
        metadata: { requestId: 'req-1', timestamp: 1 },
      }),
    });
    const h = harness();
    await decideCommand(['--state', 's', ...Q, '--json'], { ...h.deps, backend });
    expect(h.stdout()).toMatchInlineSnapshot(`
      "{
        "answers": {
          "spam": {
            "type": "noul",
            "value": 0.9
          },
          "urgency": {
            "type": "score",
            "value": 1,
            "probabilities": [
              0.2,
              0.6,
              0.2
            ],
            "confidence": 0.6
          }
        },
        "model": "fixed-model",
        "usage": {
          "inputTokens": 3
        },
        "metadata": {
          "requestId": "req-1",
          "timestamp": 1,
          "provenance": {
            "backend": "mock-decision"
          }
        }
      }
      "
    `);
  });

  it.each([
    ['plain text', 'hello world', 'hello world'],
    ['@file text', '@note.txt', 'from a file\n'],
    ['@file .json is parsed', '@data.json', { amount: 5 }],
    ['json: prefix', 'json:{"a":[1,2]}', { a: [1, 2] }],
    ['- reads stdin', '-', 'piped in'],
  ])('--state %s', async (_label, flag, expected) => {
    const backend = createMockDecisionBackend({ answers: cannedAnswers });
    const h = harness({ 'note.txt': 'from a file\n', 'data.json': '{"amount":5}' }, 'piped in');
    const code = await decideCommand(['--state', flag, ...Q], { ...h.deps, backend });
    expect(code).toBe(0);
    expect(backend.calls[0]!.state).toEqual(expected);
  });

  it('merges --questions @file.json with --question flags', async () => {
    const backend = createMockDecisionBackend({ answers: cannedAnswers });
    const h = harness({
      'qs.json': JSON.stringify({ spam: { type: 'noul', instructions: 'Is this spam?' } }),
    });
    const code = await decideCommand(
      ['--state', 's', '--questions', '@qs.json', '--question', 'urgency:score:"U?":low,high'],
      { ...h.deps, backend }
    );
    expect(code).toBe(0);
    expect(Object.keys(backend.calls[0]!.questions)).toEqual(['spam', 'urgency']);
  });

  it('attaches --image files as base64 with a media type from the extension', async () => {
    const backend = createMockDecisionBackend({ answers: cannedAnswers });
    const h = harness({ 'a.png': Buffer.from([1, 2, 3]), 'b.jpg': Buffer.from([4]) });
    await decideCommand(['--state', 's', ...Q, '--image', 'a.png', '--image', 'b.jpg'], {
      ...h.deps,
      backend,
    });
    expect(backend.calls[0]!.images).toEqual([
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AQID' } },
      { type: 'image', source: { type: 'base64', mediaType: 'image/jpeg', data: 'BA==' } },
    ]);
  });

  describe('exit codes', () => {
    it('2 on a ValidationError (the request or the response is invalid)', async () => {
      // Answers that do not match the asked question types fail response validation.
      const backend = createMockDecisionBackend({
        answers: { spam: { type: 'noul', value: 7 }, urgency: cannedAnswers.urgency },
      });
      const h = harness();
      const code = await decideCommand(['--state', 's', ...Q], { ...h.deps, backend });
      expect(code).toBe(2);
      expect(h.stderr()).toMatch(/spam/);
      expect(h.stdout()).toBe('');
    });

    it('1 on a backend failure', async () => {
      const backend = createMockDecisionBackend({
        error: new ProviderError({ code: ErrorCode.PROVIDER_ERROR, message: 'upstream down' }),
      });
      const h = harness();
      const code = await decideCommand(['--state', 's', ...Q], { ...h.deps, backend });
      expect(code).toBe(1);
      expect(h.stderr()).toMatch(/upstream down/);
    });

    it('1 on a usage error, with the message on stderr', async () => {
      const h = harness();
      expect(await decideCommand(['--state', 's'], h.deps)).toBe(1);
      expect(h.stderr()).toMatch(/at least one --question/);
      expect(await decideCommand([...Q], h.deps)).toBe(1);
      expect(h.stderr()).toMatch(/--state/);
      expect(await decideCommand(['--bogus'], h.deps)).toBe(1);
    });

    it('1 when no --backend is given and none is injected', async () => {
      const h = harness();
      expect(await decideCommand(['--state', 's', ...Q], h.deps)).toBe(1);
      expect(h.stderr()).toMatch(/--backend/);
    });

    it('0 and usage on --help', async () => {
      const h = harness();
      expect(await decideCommand(['--help'], h.deps)).toBe(0);
      expect(h.stdout()).toMatch(/--question/);
    });
  });

  describe('--batch', () => {
    const jsonl = ['"first ticket"', '', '{"state":{"id":2}}', 'plain text line', '[1,2]'].join('\n');

    it('answers every line, in order, with a progress line on stderr', async () => {
      const backend = createMockDecisionBackend({ answers: cannedAnswers });
      const h = harness({ 'in.jsonl': jsonl });
      const code = await decideCommand(['--batch', '@in.jsonl', ...Q, '--concurrency', '1'], {
        ...h.deps,
        backend,
      });
      expect(code).toBe(0);
      expect(backend.calls.map((c) => c.state)).toEqual([
        'first ticket',
        { id: 2 },
        'plain text line',
        [1, 2],
      ]);
      expect(h.stderr()).toContain('4/4');
      expect(h.stdout()).toContain('[1] first ticket');
      expect(h.stdout()).toContain('[3] plain text line');
    });

    it('--json prints one JSON response per line', async () => {
      const backend = createMockDecisionBackend({ answers: cannedAnswers });
      const h = harness({ 'in.jsonl': '"a"\n"b"' });
      const code = await decideCommand(['--batch', '@in.jsonl', ...Q, '--json'], { ...h.deps, backend });
      expect(code).toBe(0);
      const lines = h.stdout().trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1]!).answers.spam.value).toBe(0.9);
    });

    it('collects failures: exit 2 if any was a ValidationError, results still printed', async () => {
      let n = 0;
      const backend = createMockDecisionBackend({
        handler: (req) => {
          n++;
          return {
            answers: { spam: { type: 'noul', value: n === 2 ? 7 : 0.5 }, urgency: cannedAnswers.urgency },
            model: 'm',
            metadata: req.metadata,
          };
        },
      });
      const h = harness({ 'in.jsonl': '"a"\n"b"\n"c"' });
      const code = await decideCommand(['--batch', '@in.jsonl', ...Q, '--concurrency', '1'], {
        ...h.deps,
        backend,
      });
      expect(code).toBe(2);
      expect(h.stdout()).toContain('[1]');
      expect(h.stdout()).toMatch(/\[2\] .*\n.*error/s);
      expect(h.stdout()).toContain('[3]');
    });

    it('rejects --batch together with --state, and an empty batch file', async () => {
      const backend = createMockDecisionBackend({ answers: cannedAnswers });
      const h = harness({ 'in.jsonl': '\n\n' });
      expect(await decideCommand(['--batch', '@in.jsonl', '--state', 's', ...Q], { ...h.deps, backend })).toBe(1);
      expect(h.stderr()).toMatch(/not both/);
      expect(await decideCommand(['--batch', '@in.jsonl', ...Q], { ...h.deps, backend })).toBe(1);
      expect(h.stderr()).toMatch(/no states/);
    });
  });
});
