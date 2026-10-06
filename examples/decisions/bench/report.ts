/**
 * Report formatting: a markdown table (for pasting into a PR or docs) and
 * a JSON document (for diffing runs) from the same results.
 *
 * @module
 */

import type { BackendResult } from './run.js';
import { percentile, summarize, type Summary } from './scoring.js';

export interface ReportMeta {
  readonly dataset: string;
  readonly itemCount: number;
  /** Free-text hardware note, e.g. `4-core CPU, no GPU`. */
  readonly hardware?: string;
  /** ISO date shown in the header. */
  readonly date?: string;
  /** Flags the run used (`--neutral-keys`, `--temperature 1.5`, ...). */
  readonly flags?: readonly string[];
}

const pct = (x: number | null): string => (x === null || Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const fixed = (x: number, digits: number): string => (Number.isNaN(x) ? 'n/a' : x.toFixed(digits));
const ms = (x: number): string => (Number.isNaN(x) ? 'n/a' : `${Math.round(x)}`);
const usd = (x: number | null): string => {
  if (x === null) {
    return 'n/a';
  }
  if (x === 0) {
    return '$0';
  }
  return x < 0.01 ? `$${x.toPrecision(2)}` : `$${x.toFixed(4)}`;
};
const jsonNumber = (x: number): number | null => (Number.isFinite(x) ? x : null);

function latencies(result: BackendResult): number[] {
  return result.items.filter((i) => i.error === undefined).map((i) => i.latencyMs);
}

function calibrationCell(summary: Summary, pick: 'brier' | 'ece'): string {
  return summary.calibration.n === 0 ? 'n/a' : fixed(summary.calibration[pick], 3);
}

/** Render the markdown report: one row per backend, then accuracy by workflow. */
export function renderMarkdown(results: readonly BackendResult[], meta: ReportMeta): string {
  const lines: string[] = [];
  lines.push(`# Decision benchmark${meta.date ? `: ${meta.date}` : ''}`, '');
  lines.push(`- Dataset: \`${meta.dataset}\` (${meta.itemCount} items)`);
  if (meta.hardware) {
    lines.push(`- Hardware: ${meta.hardware}`);
  }
  if (meta.flags && meta.flags.length > 0) {
    lines.push(`- Flags: ${meta.flags.map((f) => `\`${f}\``).join(' ')}`);
  }
  lines.push(
    '- Latency is wall-clock per `decide()` call on this hardware, over successful calls only; it is not comparable to a vendor figure measured elsewhere.',
    ''
  );

  lines.push(
    '| backend | model | choice | score | noul | overall | Brier | ECE | p50 ms | p95 ms | cost (USD) | name flip | errors |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|'
  );
  for (const r of results) {
    const s = summarize(r.rows);
    const lat = latencies(r);
    const flip = r.nameInvariance ? pct(r.nameInvariance.flipRate) : '-';
    lines.push(
      `| ${[
        r.label,
        r.model,
        pct(s.byType.choice.accuracy),
        pct(s.byType.score.accuracy),
        pct(s.byType.noul.accuracy),
        pct(s.overall.accuracy),
        calibrationCell(s, 'brier'),
        calibrationCell(s, 'ece'),
        ms(percentile(lat, 50)),
        ms(percentile(lat, 95)),
        usd(r.totalCost),
        flip,
        `${r.errors}/${r.items.length}`,
      ].join(' | ')} |`
    );
  }
  lines.push('');

  const workflows = [...new Set(results.flatMap((r) => r.items.map((i) => i.workflow)))];
  if (workflows.length > 1) {
    lines.push('Accuracy by workflow (all answers):', '');
    lines.push(`| backend | ${workflows.join(' | ')} |`, `|---|${workflows.map(() => '---').join('|')}|`);
    for (const r of results) {
      const cells = workflows.map((w) => {
        const answers = r.items.filter((i) => i.workflow === w).flatMap((i) => i.answers);
        return answers.length === 0
          ? 'n/a'
          : pct(answers.filter((a) => a.correct).length / answers.length);
      });
      lines.push(`| ${r.label} | ${cells.join(' | ')} |`);
    }
    lines.push('');
  }

  const calibrated = results.filter((r) => summarize(r.rows).calibration.skipped > 0);
  if (calibrated.length > 0) {
    lines.push(
      'Brier and ECE cover only answers that report a confidence or probabilities; ' +
        calibrated
          .map((r) => `${r.label} skipped ${summarize(r.rows).calibration.skipped}`)
          .join(', ') +
        '.',
      ''
    );
  }
  return lines.join('\n');
}

/** Build the JSON report (NaN becomes `null` so it round-trips). */
export function buildJsonReport(results: readonly BackendResult[], meta: ReportMeta) {
  return {
    dataset: meta.dataset,
    itemCount: meta.itemCount,
    ...(meta.hardware && { hardware: meta.hardware }),
    ...(meta.date && { date: meta.date }),
    flags: meta.flags ?? [],
    backends: results.map((r) => {
      const summary = summarize(r.rows);
      const lat = latencies(r);
      return {
        label: r.label,
        model: r.model,
        summary,
        latency: {
          p50: jsonNumber(percentile(lat, 50)),
          p95: jsonNumber(percentile(lat, 95)),
          mean: lat.length === 0 ? null : lat.reduce((a, b) => a + b, 0) / lat.length,
        },
        cost: { total: r.totalCost },
        errors: r.errors,
        wallMs: Math.round(r.wallMs),
        nameInvariance: r.nameInvariance
          ? {
              ...r.nameInvariance,
              flipRate: jsonNumber(r.nameInvariance.flipRate),
            }
          : null,
        items: r.items,
      };
    }),
  };
}
