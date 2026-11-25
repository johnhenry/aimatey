/**
 * Tool-protocol benchmark CLI (#241): every task x protocol x model against
 * a local Ollama model, results written incrementally.
 *
 *   npx tsx examples/tools/bench/run.ts --model qwen2.5:3b --repeats 2 \
 *     --out examples/tools/bench/results/qwen2.5-3b.json
 *   npx tsx examples/tools/bench/run.ts --report examples/tools/bench/results/qwen2.5-3b.json
 *
 * `--resume` skips runs already present in --out, so an interrupted run can continue.
 * Needs the optional peers for `code` (@johnhenry/andbox and its pinned engine).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { OllamaBackendAdapter } from '@johnhenry/aimatey-backend/ollama';
import { codeProtocol, andboxExecutor, textProtocol, buildLegacyCodePrompt } from '@johnhenry/aimatey-tool-protocols';
import { parseArgs, type BenchArgs } from './args.js';
import { toMarkdown } from './aggregate.js';
import { instrumentBackend, instrumentExecutor, runOne, type Arm, type RunnerDeps, type RunRecord } from './runner.js';
import { TASKS } from './tasks.js';

export interface ResultsFile {
  meta: {
    startedAt: string;
    updatedAt: string;
    hardware: string;
    models: string[];
    repeats: number;
    heavyRepeats: number;
    timeoutMs: number;
    maxIterations: number;
    temperature: number;
    complete: boolean;
  };
  runs: RunRecord[];
}

const taskNames = Object.fromEntries(TASKS.map((t) => [t.id, t.name]));

function save(file: string, data: ResultsFile): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

function makeDeps(args: BenchArgs): RunnerDeps {
  const base = new OllamaBackendAdapter({ baseURL: args.baseURL ?? 'http://localhost:11434' });
  return {
    runTools(protocol, options, probe, arm) {
      const bridge = new Bridge(new OpenAIFrontendAdapter(), instrumentBackend(base, probe));
      const withProtocol =
        protocol === 'native'
          ? options
          : {
              ...options,
              protocol:
                protocol === 'text'
                  ? textProtocol()
                  : codeProtocol({
                      executor: instrumentExecutor(andboxExecutor(), probe),
                      ...(arm?.prompt === 'legacy' && { systemPrompt: buildLegacyCodePrompt }),
                    }),
            };
      return bridge.runTools(withProtocol);
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.report) {
    const data = JSON.parse(readFileSync(args.report, 'utf8')) as ResultsFile;
    const md = toMarkdown(data.runs, taskNames);
    if (args.markdown) {
      writeFileSync(args.markdown, md + '\n');
    } else {
      console.log(md);
    }
    return;
  }

  const tasks = TASKS.filter((t) => !args.tasks || args.tasks.some((id) => t.id === id || t.id.startsWith(`${id}-`)));
  const now = new Date().toISOString();
  const data: ResultsFile =
    args.resume && existsSync(args.out)
      ? (JSON.parse(readFileSync(args.out, 'utf8')) as ResultsFile)
      : {
          meta: {
            startedAt: now,
            updatedAt: now,
            hardware: args.hardware ?? 'CPU only, no GPU',
            models: [],
            repeats: args.repeats,
            heavyRepeats: args.heavyRepeats,
            timeoutMs: args.timeoutMs,
            maxIterations: args.maxIterations,
            temperature: args.temperature,
            complete: false,
          },
          runs: [],
        };
  data.meta.complete = false;
  data.meta.models = [...new Set([...data.meta.models, ...args.models])];
  const done = new Set(data.runs.map((r) => `${r.model}|${r.task}|${r.protocol}|${r.arm ?? ''}|${r.repeat}`));
  const deps = makeDeps(args);

  const armList: (Arm | undefined)[] = args.arms ?? [undefined];
  const plan: { model: string; task: (typeof TASKS)[number]; protocol: BenchArgs['protocols'][number]; repeat: number; arm?: Arm }[] = [];
  for (const model of args.models) {
    // Arms outermost so a partial run still holds whole arms, in the order given.
    for (const arm of armList) {
      for (const task of tasks) {
        const repeats = task.heavy ? args.heavyRepeats : args.repeats;
        for (let repeat = 1; repeat <= repeats; repeat++) {
          for (const protocol of args.protocols) {
            if (!done.has(`${model}|${task.id}|${protocol}|${arm?.id ?? ''}|${repeat}`)) {
              plan.push({ model, task, protocol, repeat, ...(arm && { arm }) });
            }
          }
        }
      }
    }
  }
  console.log(`${plan.length} runs to do (${data.runs.length} already recorded) -> ${args.out}`);

  let n = 0;
  for (const p of plan) {
    n += 1;
    const rec = await runOne(p.task, p.protocol, p.model, p.repeat, deps, {
      timeoutMs: args.timeoutMs,
      maxIterations: args.maxIterations,
      temperature: args.temperature,
      ...(p.arm && { arm: p.arm }),
    });
    data.runs.push(rec);
    data.meta.updatedAt = new Date().toISOString();
    save(args.out, data);
    console.log(
      `[${n}/${plan.length}] ${p.model} ${p.task.id} ${p.protocol}${p.arm ? `/${p.arm.id}` : ''} #${p.repeat}: ` +
        `${rec.success ? 'ok' : 'FAIL'} calls=${rec.modelCalls} tools=${rec.toolCalls} ${(rec.wallMs / 1000).toFixed(1)}s` +
        (rec.error ? ` (${rec.error.slice(0, 80)})` : '')
    );
  }
  data.meta.complete = true;
  save(args.out, data);
  console.log('\n' + toMarkdown(data.runs, taskNames));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
