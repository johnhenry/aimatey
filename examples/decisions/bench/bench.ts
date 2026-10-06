/**
 * Decision benchmark CLI.
 *
 *   npx tsx examples/decisions/bench/bench.ts \
 *     --backend ollama:tev1:0.8b --backend emulated:qwen2.5:3b \
 *     --dataset builtin --limit 10 --out results.json
 *
 * See `readme.md` for how to read the numbers and `fetch-datasets.md` for
 * the public datasets.
 *
 * @module
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, USAGE, type BenchOptions } from './args.js';
import { createBackend, labelFor, parseBackendSpec } from './backends.js';
import { loadDataset } from './datasets.js';
import { buildJsonReport, renderMarkdown, type ReportMeta } from './report.js';
import { runBench, type BackendResult } from './run.js';

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

/** Run the benchmark described by `options`; returns the results and the rendered markdown. */
export async function main(options: BenchOptions): Promise<{ results: BackendResult[]; markdown: string }> {
  const items = await loadDataset(options.dataset, { limit: options.limit });
  console.error(`dataset ${options.dataset}: ${items.length} items`);

  const flags = [
    ...(options.neutralKeys ? ['--neutral-keys'] : []),
    ...(options.temperature !== undefined ? [`--temperature ${options.temperature}`] : []),
    ...(options.nameInvariance ? ['--name-invariance'] : []),
    ...(options.model ? [`--model ${options.model}`] : []),
  ];

  const results: BackendResult[] = [];
  for (const raw of options.backends) {
    const spec = parseBackendSpec(raw);
    const label = labelFor(spec);
    console.error(`\n== ${label}`);
    const backend = await createBackend(spec);
    results.push(
      await runBench({
        backend,
        label,
        items,
        concurrency: options.concurrency,
        neutralKeys: options.neutralKeys,
        temperature: options.temperature,
        nameInvariance: options.nameInvariance,
        model: options.model,
        onItem: (r, done, total) =>
          console.error(
            `  [${done}/${total}] ${r.id} ${r.error ? `ERROR ${r.error}` : `${Math.round(r.latencyMs)} ms`}`
          ),
      })
    );
  }

  const meta: ReportMeta = {
    dataset: options.dataset,
    itemCount: items.length,
    hardware: options.hardware,
    date: new Date().toISOString().slice(0, 10),
    flags,
  };
  const markdown = renderMarkdown(results, meta);
  if (options.out) {
    await write(options.out, `${JSON.stringify(buildJsonReport(results, meta), null, 2)}\n`);
  }
  if (options.markdown) {
    await write(options.markdown, `${markdown}\n`);
  }
  return { results, markdown };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(USAGE);
    } else {
      const { markdown } = await main(options);
      console.log(`\n${markdown}`);
    }
  } catch (error) {
    console.error(`bench: ${error instanceof Error ? error.message : String(error)}\n`);
    console.error(USAGE);
    process.exitCode = 1;
  }
}
