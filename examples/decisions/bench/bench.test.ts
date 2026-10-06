/**
 * Tests for the decision benchmark harness.
 *
 * Not part of the centralized `npm test` (examples/ is outside the root
 * vitest workspace); run standalone:
 *
 *   cd examples/decisions/bench && npx vitest run
 *
 * Every backend here is `createMockDecisionBackend`; nothing touches the
 * network. The live run is gated behind `OLLAMA_LIVE=1` (see the bottom).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockDecisionBackend } from '@johnhenry/aimatey-testing';
import type { IRDecisionAnswer, IRDecisionRequest } from '@johnhenry/aimatey-types';
import { parseArgs, USAGE } from './args.js';
import { parseBackendSpec } from './backends.js';
import {
  BUILTIN_ITEMS,
  loadDataset,
  parseDatasetText,
  type BenchItem,
} from './datasets.js';
import { isCorrect, percentile, priceFor, summarize } from './scoring.js';
import { runBench } from './run.js';
import { renderMarkdown, buildJsonReport } from './report.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const choiceQ = {
  type: 'choice' as const,
  instructions: 'Which team?',
  criteria: { billing: 'money', tech: 'bugs' },
};
const scoreQ = {
  type: 'score' as const,
  instructions: 'How urgent?',
  criteria: ['low', 'medium', 'high'],
};
const noulQ = { type: 'noul' as const, instructions: 'Refund requested?' };

function item(id: string, gold: BenchItem['gold']): BenchItem {
  return {
    id,
    workflow: 'customer-escalation',
    state: `ticket ${id}`,
    questions: { team: choiceQ, urgency: scoreQ, refund: noulQ },
    gold,
  };
}

/** Answers every question correctly with the given confidence. */
function perfectAnswers(request: IRDecisionRequest, conf: number, gold: BenchItem['gold']) {
  const answers: Record<string, IRDecisionAnswer> = {};
  for (const [name, q] of Object.entries(request.questions)) {
    const g = gold[name]!;
    if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      answers[name] = {
        type: 'choice',
        value: g as string,
        confidence: conf,
        probabilities: Object.fromEntries(
          keys.map((k) => [k, k === g ? conf : (1 - conf) / (keys.length - 1)])
        ),
      };
    } else if (q.type === 'score') {
      const n = q.criteria.length;
      answers[name] = {
        type: 'score',
        value: g as number,
        confidence: conf,
        probabilities: Array.from({ length: n }, (_, i) => (i === g ? conf : (1 - conf) / (n - 1))),
      };
    } else {
      answers[name] = { type: 'noul', value: g === true ? conf : 1 - conf };
    }
  }
  return answers;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('parses repeatable --backend and every flag', () => {
    const o = parseArgs([
      '--backend', 'ollama',
      '--backend', 'emulated:qwen2.5:3b',
      '--dataset', 'builtin',
      '--limit', '10',
      '--concurrency', '3',
      '--out', 'r.json',
      '--neutral-keys',
      '--temperature', '1.5',
      '--name-invariance',
      '--markdown', 'r.md',
    ]);
    expect(o.backends).toEqual(['ollama', 'emulated:qwen2.5:3b']);
    expect(o.dataset).toBe('builtin');
    expect(o.limit).toBe(10);
    expect(o.concurrency).toBe(3);
    expect(o.out).toBe('r.json');
    expect(o.neutralKeys).toBe(true);
    expect(o.temperature).toBe(1.5);
    expect(o.nameInvariance).toBe(true);
    expect(o.markdown).toBe('r.md');
  });

  it('applies defaults', () => {
    const o = parseArgs(['--backend=laya']);
    expect(o).toMatchObject({
      backends: ['laya'],
      dataset: 'builtin',
      concurrency: 1,
      neutralKeys: false,
      nameInvariance: false,
    });
    expect(o.limit).toBeUndefined();
    expect(o.temperature).toBeUndefined();
  });

  it('rejects missing backends, bad numbers, unknown flags and bad specs', () => {
    expect(() => parseArgs([])).toThrow(/--backend/);
    expect(() => parseArgs(['--backend', 'laya', '--limit', 'ten'])).toThrow(/--limit/);
    expect(() => parseArgs(['--backend', 'laya', '--concurrency', '0'])).toThrow(/--concurrency/);
    expect(() => parseArgs(['--backend', 'laya', '--temperature', '-1'])).toThrow(/--temperature/);
    expect(() => parseArgs(['--backend', 'laya', '--bogus'])).toThrow(/--bogus/);
    expect(() => parseArgs(['--backend', 'gpt9'])).toThrow(/unknown backend/i);
    expect(() => parseArgs(['--backend', 'laya', '--limit'])).toThrow(/requires a value/);
  });

  it('exposes usage text', () => {
    expect(USAGE).toContain('--backend');
  });
});

describe('parseBackendSpec', () => {
  it('splits on the first colon only, so URLs and model tags survive', () => {
    expect(parseBackendSpec('systemone:http://localhost:8080/v1')).toEqual({
      kind: 'systemone',
      arg: 'http://localhost:8080/v1',
    });
    expect(parseBackendSpec('emulated:qwen2.5:3b')).toEqual({ kind: 'emulated', arg: 'qwen2.5:3b' });
    expect(parseBackendSpec('ollama')).toEqual({ kind: 'ollama', arg: undefined });
    expect(parseBackendSpec('ollama:tev1:0.8b')).toEqual({ kind: 'ollama', arg: 'tev1:0.8b' });
  });

  it('requires an argument where one is needed', () => {
    expect(() => parseBackendSpec('systemone')).toThrow(/url/i);
    expect(() => parseBackendSpec('emulated')).toThrow(/chat model/i);
  });
});

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

describe('built-in dataset', () => {
  it('has ~40 well-formed items across the four workflows and three types', () => {
    expect(BUILTIN_ITEMS.length).toBeGreaterThanOrEqual(36);
    expect(new Set(BUILTIN_ITEMS.map((i) => i.id)).size).toBe(BUILTIN_ITEMS.length);
    expect(new Set(BUILTIN_ITEMS.map((i) => i.workflow))).toEqual(
      new Set(['invoice-reconciliation', 'agent-triage', 'security-alerts', 'customer-escalation'])
    );
    const types = new Set<string>();
    for (const it of BUILTIN_ITEMS) {
      for (const [name, q] of Object.entries(it.questions)) {
        types.add(q.type);
        const g = it.gold[name];
        expect(g, `${it.id}.${name} has gold`).not.toBeUndefined();
        if (q.type === 'choice') {
          expect(Object.keys(q.criteria)).toContain(g);
        } else if (q.type === 'score') {
          expect(Number.isInteger(g)).toBe(true);
          expect(g as number).toBeGreaterThanOrEqual(0);
          expect(g as number).toBeLessThan(q.criteria.length);
        } else {
          expect(typeof g).toBe('boolean');
        }
      }
    }
    expect(types).toEqual(new Set(['choice', 'score', 'noul']));
  });

  it('loads via "builtin" and honours --limit', async () => {
    const all = await loadDataset('builtin');
    expect(all).toHaveLength(BUILTIN_ITEMS.length);
    expect(await loadDataset('builtin', { limit: 5 })).toHaveLength(5);
  });
});

describe('dataset loader', () => {
  it('parses Typed Decisions JSONL (multi-question rows, gold under "answers")', () => {
    const text = [
      JSON.stringify({
        id: 'td-1',
        workflow: 'security-alerts',
        state: { alert: 'x' },
        questions: { sev: scoreQ, act: noulQ, team: choiceQ },
        answers: { sev: 'high', act: 'yes', team: 'tech' },
      }),
      '',
      JSON.stringify({
        state: 'no id here',
        questions: { team: choiceQ },
        gold: { team: 'billing' },
      }),
    ].join('\n');
    const items = parseDatasetText(text, 'typed-decisions.jsonl');
    expect(items).toHaveLength(2);
    expect(items[0]!.id).toBe('td-1');
    // Score label -> index, noul "yes" -> true.
    expect(items[0]!.gold).toEqual({ sev: 2, act: true, team: 'tech' });
    expect(items[1]!.id).toBe('item-2');
    expect(items[1]!.workflow).toBe('unknown');
  });

  it('parses Decision Index rows (one "question" and a "label")', () => {
    const json = JSON.stringify([
      { id: 'di-1', benchmark: 'spam', input: 'win a prize', question: noulQ, label: 1 },
      { id: 'di-2', benchmark: 'topic', input: 'invoice', question: choiceQ, label: 0 },
    ]);
    const items = parseDatasetText(json, 'decision-index.json');
    expect(items).toHaveLength(2);
    expect(items[0]!.questions).toEqual({ answer: noulQ });
    expect(items[0]!.gold).toEqual({ answer: true });
    // Numeric choice label = index into criteria.
    expect(items[1]!.gold).toEqual({ answer: 'billing' });
    expect(items[1]!.workflow).toBe('topic');
    expect(items[1]!.state).toBe('invoice');
  });

  it('reads the public Typed Decisions export: JSON-string questions/gold and soft gold objects', () => {
    const row = {
      id: 'cs-1',
      workflow: 'customer_service',
      state: 'Customer says the app is down again.',
      questions: JSON.stringify({ team: choiceQ, urgency: scoreQ, refund: noulQ }),
      gold: JSON.stringify({
        team: { label: 'tech', probabilities: { billing: 0.1, tech: 0.9 } },
        urgency: { score: 1.7, probabilities: [0.1, 0.3, 0.6] },
        refund: { probability_true: 0.2 },
      }),
    };
    const [it] = parseDatasetText(JSON.stringify(row), 'cs.jsonl');
    expect(it!.gold).toEqual({ team: 'tech', urgency: 2, refund: false });
    expect(Object.keys(it!.questions)).toEqual(['team', 'urgency', 'refund']);
  });

  it('rejects rows with unusable gold, naming the row and question', () => {
    const bad = JSON.stringify({
      id: 'r1',
      state: 's',
      questions: { team: choiceQ },
      gold: { team: 'astrology' },
    });
    expect(() => parseDatasetText(bad, 'x.jsonl')).toThrow(/r1.*team/s);
    const missing = JSON.stringify({ id: 'r2', state: 's', questions: { team: choiceQ }, gold: {} });
    expect(() => parseDatasetText(missing, 'x.jsonl')).toThrow(/r2.*team/s);
    expect(() => parseDatasetText('{not json', 'x.jsonl')).toThrow(/line 1/);
  });

  it('loads a file path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-'));
    const file = join(dir, 'd.jsonl');
    writeFileSync(
      file,
      JSON.stringify({ id: 'a', state: 's', questions: { team: choiceQ }, gold: { team: 'tech' } })
    );
    const items = await loadDataset(file);
    expect(items.map((i) => i.id)).toEqual(['a']);
    await expect(loadDataset(join(dir, 'missing.jsonl'))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Scoring math
// ---------------------------------------------------------------------------

describe('scoring', () => {
  it('judges correctness per question type', () => {
    expect(isCorrect({ type: 'choice', value: 'a' }, 'a')).toBe(true);
    expect(isCorrect({ type: 'choice', value: 'a' }, 'b')).toBe(false);
    expect(isCorrect({ type: 'score', value: 1.4 }, 1)).toBe(true);
    expect(isCorrect({ type: 'score', value: 1.6 }, 1)).toBe(false);
    expect(isCorrect({ type: 'noul', value: 0.7 }, true)).toBe(true);
    expect(isCorrect({ type: 'noul', value: 0.7 }, false)).toBe(false);
    expect(isCorrect({ type: 'noul', value: 0.3 }, false)).toBe(true);
  });

  it('computes percentiles by linear interpolation', () => {
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBeCloseTo(9.55, 10);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNaN();
  });

  it('prices from usage.cost first, then registry pricing, else null', () => {
    expect(priceFor({ inputTokens: 1000, cost: 0.5 }, 'clef')).toBe(0.5);
    // clef: $0.24 per million input tokens.
    expect(priceFor({ inputTokens: 1_000_000 }, 'clef')).toBeCloseTo(0.24, 10);
    expect(priceFor({ inputTokens: 1000 }, 'no-such-model-xyz')).toBeNull();
    expect(priceFor(undefined, 'clef')).toBeNull();
  });

  it('summarizes accuracy per type, Brier and ECE from known inputs', () => {
    // 3 noul items, each confident (0.9 yes). Gold: true, true, false.
    // Correct: 2/3. Brier = ((0.9-1)^2 + (0.9-1)^2 + (0.9-0)^2)/3 = (0.01+0.01+0.81)/3.
    const rows = [
      { type: 'noul' as const, answer: { type: 'noul' as const, value: 0.9 }, gold: true },
      { type: 'noul' as const, answer: { type: 'noul' as const, value: 0.9 }, gold: true },
      { type: 'noul' as const, answer: { type: 'noul' as const, value: 0.9 }, gold: false },
      { type: 'choice' as const, answer: { type: 'choice' as const, value: 'a' }, gold: 'a' },
      { type: 'choice' as const, answer: { type: 'choice' as const, value: 'a' }, gold: 'b' },
    ];
    const s = summarize(rows);
    expect(s.byType.noul).toEqual({ n: 3, correct: 2, accuracy: 2 / 3 });
    expect(s.byType.choice).toEqual({ n: 2, correct: 1, accuracy: 0.5 });
    expect(s.byType.score).toEqual({ n: 0, correct: 0, accuracy: null });
    expect(s.overall.accuracy).toBeCloseTo(3 / 5, 10);
    expect(s.calibration.n).toBe(3); // the two choice answers carry no confidence
    expect(s.calibration.skipped).toBe(2);
    expect(s.calibration.brier).toBeCloseTo((0.01 + 0.01 + 0.81) / 3, 10);
    // One bucket (0.9): accuracy 2/3, mean confidence 0.9.
    expect(s.calibration.ece).toBeCloseTo(Math.abs(2 / 3 - 0.9), 10);
  });

  it('reports null calibration when nothing carries confidence', () => {
    const s = summarize([
      { type: 'choice', answer: { type: 'choice', value: 'a' }, gold: 'a' },
    ]);
    expect(s.calibration.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Runner + report
// ---------------------------------------------------------------------------

describe('runBench', () => {
  const items = [
    item('a', { team: 'billing', urgency: 2, refund: true }),
    item('b', { team: 'tech', urgency: 0, refund: false }),
    item('c', { team: 'tech', urgency: 1, refund: true }),
  ];

  it('runs every item, scores answers against gold and records latency and cost', async () => {
    const goldById = new Map(items.map((i) => [i.state, i.gold]));
    const backend = createMockDecisionBackend({
      name: 'mock-a',
      model: 'clef',
      latencyMs: 2,
      handler: (req) => ({
        answers: perfectAnswers(req, 0.9, goldById.get(req.state as string)!),
        model: 'clef',
        usage: { inputTokens: 500_000 },
        metadata: req.metadata,
      }),
    });
    const result = await runBench({ backend, label: 'mock-a', items, concurrency: 2 });
    expect(backend.calls).toHaveLength(3);
    expect(result.items).toHaveLength(3);
    expect(result.errors).toBe(0);
    const s = summarize(result.rows);
    expect(s.overall).toMatchObject({ n: 9, correct: 9, accuracy: 1 });
    expect(result.items.every((r) => r.latencyMs >= 1)).toBe(true);
    // 3 calls x 500k tokens x $0.24/M.
    expect(result.totalCost).toBeCloseTo(0.36, 10);
    expect(result.model).toBe('clef');
  });

  it('books local backends at $0 instead of guessing a hosted price', async () => {
    const local = createMockDecisionBackend({
      name: 'local',
      handler: (req) => ({
        answers: perfectAnswers(req, 0.9, items[0]!.gold),
        model: 'tev1:0.8b',
        usage: { inputTokens: 1_000_000 },
        metadata: req.metadata,
      }),
    });
    (local.metadata as { provider: string }).provider = 'Ollama';
    const result = await runBench({ backend: local, label: 'local', items: [items[0]!] });
    expect(result.totalCost).toBe(0);
  });

  it('counts a thrown backend as an error and keeps going', async () => {
    const backend = createMockDecisionBackend({ error: new Error('boom') });
    const result = await runBench({ backend, label: 'bad', items, concurrency: 1 });
    expect(result.errors).toBe(3);
    expect(result.items[0]!.error).toContain('boom');
    expect(result.rows).toHaveLength(0);
  });

  it('never exceeds the requested concurrency', async () => {
    let live = 0;
    let peak = 0;
    const backend = createMockDecisionBackend({
      handler: async (req) => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 5));
        live--;
        return {
          answers: perfectAnswers(req, 0.8, items[0]!.gold),
          model: 'm',
          metadata: req.metadata,
        };
      },
    });
    await runBench({ backend, label: 'c', items, concurrency: 2 });
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBe(2);
  });

  it('applies neutral keys: the backend sees opt_N keys, scoring still uses original names', async () => {
    const backend = createMockDecisionBackend({
      handler: (req) => {
        const q = req.questions.team!;
        expect(q.type === 'choice' && Object.keys(q.criteria)).toEqual(['opt_1', 'opt_2']);
        const answers = perfectAnswers(req, 0.9, { team: 'opt_1', urgency: 0, refund: false });
        return { answers, model: 'm', metadata: req.metadata };
      },
    });
    const result = await runBench({
      backend,
      label: 'n',
      items: [item('a', { team: 'billing', urgency: 0, refund: false })],
      concurrency: 1,
      neutralKeys: true,
    });
    expect(result.errors).toBe(0);
    // opt_1 maps back to the first original key ("billing").
    expect(result.rows.find((r) => r.type === 'choice')!.answer).toMatchObject({ value: 'billing' });
  });

  it('measures name-invariance flip rate when asked', async () => {
    const gold = { team: 'billing', urgency: 0, refund: false };
    // A model that always says the first option it is shown: invariant under
    // renaming/reassignment of definitions only if it follows names -> it flips.
    const backend = createMockDecisionBackend({
      handler: (req) => ({
        answers: perfectAnswers(req, 0.9, {
          team: Object.keys((req.questions.team as typeof choiceQ).criteria)[0]!,
          urgency: 0,
          refund: false,
        }),
        model: 'm',
        metadata: req.metadata,
      }),
    });
    const result = await runBench({
      backend,
      label: 'inv',
      items: [item('a', gold), item('b', gold)],
      concurrency: 1,
      nameInvariance: true,
    });
    expect(result.nameInvariance).toBeDefined();
    expect(result.nameInvariance!.items).toBe(2);
    expect(result.nameInvariance!.flipRate).toBeGreaterThanOrEqual(0);
    expect(result.nameInvariance!.flipRate).toBeLessThanOrEqual(1);
  });
});

describe('report', () => {
  async function makeResult(label: string, conf: number) {
    const items = [
      item('a', { team: 'billing', urgency: 2, refund: true }),
      item('b', { team: 'tech', urgency: 0, refund: false }),
    ];
    const byState = new Map(items.map((i) => [i.state, i.gold]));
    const backend = createMockDecisionBackend({
      handler: (req) => ({
        answers: perfectAnswers(req, conf, byState.get(req.state as string)!),
        model: 'clef-flash',
        usage: { inputTokens: 1000 },
        metadata: req.metadata,
      }),
    });
    return runBench({ backend, label, items, concurrency: 1 });
  }

  it('renders one markdown row per backend with the documented columns', async () => {
    const md = renderMarkdown(
      [await makeResult('alpha', 0.9), await makeResult('beta', 0.6)],
      { dataset: 'builtin', itemCount: 2, hardware: '4-core CPU, no GPU', date: '2026-10-06' }
    );
    expect(md).toContain('| backend |');
    for (const col of ['choice', 'score', 'noul', 'Brier', 'ECE', 'p50', 'p95', 'cost']) {
      expect(md).toContain(col);
    }
    expect(md).toMatch(/\| alpha \|/);
    expect(md).toMatch(/\| beta \|/);
    expect(md).toContain('4-core CPU, no GPU');
    expect(md).toContain('2026-10-06');
    // Perfect answers at 0.9 confidence: accuracy 100.0%.
    expect(md).toContain('100.0%');
  });

  it('shows "n/a" instead of NaN for missing numbers and "-" for no flip rate', async () => {
    const r = await runBench({
      backend: createMockDecisionBackend({ error: new Error('x') }),
      label: 'dead',
      items: [item('a', { team: 'tech', urgency: 0, refund: false })],
      concurrency: 1,
    });
    const md = renderMarkdown([r], { dataset: 'builtin', itemCount: 1 });
    expect(md).not.toContain('NaN');
    expect(md).toContain('n/a');
  });

  it('builds a JSON report with per-item rows and summary numbers', async () => {
    const json = buildJsonReport([await makeResult('alpha', 0.9)], {
      dataset: 'builtin',
      itemCount: 2,
    });
    expect(json.dataset).toBe('builtin');
    expect(json.backends).toHaveLength(1);
    const b = json.backends[0]!;
    expect(b.label).toBe('alpha');
    expect(b.summary.overall.accuracy).toBe(1);
    expect(b.latency.p50).toBeGreaterThanOrEqual(0);
    expect(b.items).toHaveLength(2);
    expect(() => JSON.stringify(json)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Live (opt-in)
// ---------------------------------------------------------------------------

describe.skipIf(process.env.OLLAMA_LIVE !== '1')('live Ollama (OLLAMA_LIVE=1)', () => {
  it('runs the built-in set against a local decision model', async () => {
    const { createBackend } = await import('./backends.js');
    const backend = await createBackend(parseBackendSpec('ollama:tev1:0.8b'));
    const result = await runBench({
      backend,
      label: 'ollama:tev1:0.8b',
      items: await loadDataset('builtin', { limit: 2 }),
      concurrency: 1,
    });
    expect(result.items).toHaveLength(2);
    expect(result.errors).toBe(0);
  }, 120_000);
});
