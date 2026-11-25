/**
 * Aggregation and markdown report for benchmark results.
 *
 * @module
 */

import type { RunRecord } from './runner.js';
import { PROTOCOLS } from './runner.js';

export interface Cell {
  readonly task: string;
  readonly protocol: string;
  /** Ablation arm id, when the runs carry one. */
  readonly arm?: string;
  readonly model: string;
  readonly runs: number;
  readonly successes: number;
  readonly successRate: number;
  readonly meanSteps: number;
  readonly meanModelCalls: number;
  readonly meanToolCalls: number;
  readonly meanTokens: number;
  readonly meanWallMs: number;
  /** Mean executor time per run (code only), else null. */
  readonly meanCodeMs: number | null;
  /** Any run in the cell used estimated tokens. */
  readonly tokensEstimated: boolean;
  readonly timeouts: number;
}

const mean = (xs: number[]): number => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);

export function aggregate(runs: readonly RunRecord[]): Cell[] {
  const groups = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const key = `${r.model}\u0000${r.task}\u0000${r.protocol}\u0000${r.arm ?? ''}`;
    const g = groups.get(key);
    if (g) {
      g.push(r);
    } else {
      groups.set(key, [r]);
    }
  }
  const cells: Cell[] = [];
  for (const g of groups.values()) {
    const first = g[0];
    const code = g.filter((r) => r.codeMs !== undefined);
    cells.push({
      task: first.task,
      protocol: first.protocol,
      ...(first.arm && { arm: first.arm }),
      model: first.model,
      runs: g.length,
      successes: g.filter((r) => r.success).length,
      successRate: g.filter((r) => r.success).length / g.length,
      meanSteps: mean(g.map((r) => r.steps)),
      meanModelCalls: mean(g.map((r) => r.modelCalls)),
      meanToolCalls: mean(g.map((r) => r.toolCalls)),
      meanTokens: mean(g.map((r) => r.promptTokens + r.completionTokens)),
      meanWallMs: mean(g.map((r) => r.wallMs)),
      meanCodeMs: code.length ? mean(code.map((r) => r.codeMs ?? 0)) : null,
      tokensEstimated: g.some((r) => r.tokensEstimated),
      timeouts: g.filter((r) => r.timedOut).length,
    });
  }
  const order = (p: string): number => PROTOCOLS.indexOf(p as (typeof PROTOCOLS)[number]);
  return cells.sort(
    (a, b) => a.model.localeCompare(b.model) || a.task.localeCompare(b.task) || order(a.protocol) - order(b.protocol) || (a.arm ?? '').localeCompare(b.arm ?? '')
  );
}

const f1 = (x: number): string => (Number.isNaN(x) ? 'n/a' : x.toFixed(1));
const pct = (x: number): string => `${Math.round(x * 100)}%`;
const secs = (ms: number): string => (Number.isNaN(ms) ? 'n/a' : (ms / 1000).toFixed(1));

function row(c: Cell, label: string): string {
  const tokens = Number.isNaN(c.meanTokens) ? 'n/a' : `${Math.round(c.meanTokens)}${c.tokensEstimated ? '*' : ''}`;
  const code = c.meanCodeMs === null ? '-' : secs(c.meanCodeMs);
  return `| ${label} | ${c.arm ? `${c.protocol} (arm ${c.arm})` : c.protocol} | ${c.runs} | ${pct(c.successRate)} (${c.successes}/${c.runs}) | ${f1(c.meanSteps)} | ${f1(c.meanModelCalls)} | ${f1(c.meanToolCalls)} | ${tokens} | ${secs(c.meanWallMs)} | ${code} | ${c.timeouts} |`;
}

const HEADER =
  '| task | protocol | runs | success | steps | model calls | tool calls | tokens | wall s | code exec s | timeouts |\n' +
  '|---|---|---|---|---|---|---|---|---|---|---|';

/** Overall per-protocol cells (all tasks pooled) for one model. */
export function pooled(runs: readonly RunRecord[], model: string): Cell[] {
  const pooledRuns = runs.filter((r) => r.model === model).map((r) => ({ ...r, task: 'ALL TASKS' }));
  return aggregate(pooledRuns);
}

export function toMarkdown(runs: readonly RunRecord[], taskNames: Record<string, string> = {}): string {
  const models = [...new Set(runs.map((r) => r.model))];
  const cells = aggregate(runs);
  const out: string[] = [];
  for (const model of models) {
    out.push(`### ${model}`, '', HEADER);
    for (const c of cells.filter((x) => x.model === model)) {
      out.push(row(c, taskNames[c.task] ?? c.task));
    }
    for (const c of pooled(runs, model)) {
      out.push(row(c, '**all tasks**'));
    }
    out.push('');
  }
  if (cells.some((c) => c.tokensEstimated)) {
    out.push('`*` token counts include an estimate (characters / 4) because the backend did not report usage for every call.', '');
  }
  out.push(
    'Means are over all runs in the cell, failures included. "steps" is loop iterations, "model calls" is backend requests, ' +
      '"code exec s" is mean time inside the sandbox executor per run (tool time included).'
  );
  return out.join('\n');
}
