/**
 * Command-line parsing for the benchmark.
 *
 * @module
 */

import { parseBackendSpec } from './backends.js';

export interface BenchOptions {
  /** Backend specs, in the order given. */
  readonly backends: string[];
  /** `builtin` or a path to a JSON/JSONL dataset. */
  readonly dataset: string;
  readonly limit?: number;
  readonly concurrency: number;
  /** Where to write the JSON report. */
  readonly out?: string;
  /** Where to write the markdown report. */
  readonly markdown?: string;
  readonly neutralKeys: boolean;
  /** One temperature applied to every answer's probabilities. */
  readonly temperature?: number;
  /** Also measure the name-invariance flip rate (extra forward passes per item). */
  readonly nameInvariance: boolean;
  /** Model passed as `parameters.model` on every request. */
  readonly model?: string;
  /** Free-text hardware note for the report header. */
  readonly hardware?: string;
  readonly help: boolean;
}

export const USAGE = `Usage: tsx bench.ts --backend <spec> [--backend <spec> ...] [options]

Backends:
  ollama[:<model>]       local Ollama /v1/systemone (default model tev1:0.8b)
  typesafe               TypeSafe Jev        (TYPESAFE_API_KEY)
  openrouter[:<model>]   OpenRouter Decisions (OPENROUTER_API_KEY)
  cloudflare[:<model>]   Workers AI Clef      (CLOUDFLARE_API_KEY, CLOUDFLARE_ACCOUNT_ID)
  systemone:<url>        any System One server (SYSTEMONE_API_KEY optional)
  emulated:<chatModel>   an Ollama chat model answering through structured output
  laya                   on-device Laya (needs @receptron/laya)

Options:
  --dataset <path|builtin>  dataset to run (default: builtin)
  --limit <N>               only the first N items
  --concurrency <N>         requests in flight per backend (default 1)
  --out <file.json>         write the JSON report
  --markdown <file.md>      write the markdown report
  --neutral-keys            rewrite choice keys to opt_1..n before asking
  --temperature <T>         scale every answer's probabilities by temperature T
  --name-invariance         also measure the option-name flip rate
  --model <id>              parameters.model on every request
  --hardware <text>         hardware note for the report header
  --help                    show this text
`;

function positiveNumber(flag: string, value: string, integer: boolean): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    throw new Error(`${flag} must be a positive ${integer ? 'integer' : 'number'}, got '${value}'`);
  }
  return n;
}

/** Parse `process.argv.slice(2)`. Throws an `Error` with a usable message on bad input. */
export function parseArgs(argv: readonly string[]): BenchOptions {
  const backends: string[] = [];
  let dataset = 'builtin';
  let limit: number | undefined;
  let concurrency = 1;
  let out: string | undefined;
  let markdown: string | undefined;
  let neutralKeys = false;
  let temperature: number | undefined;
  let nameInvariance = false;
  let model: string | undefined;
  let hardware: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]!;
    let inline: string | undefined;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const value = (): string => {
      if (inline !== undefined) {
        return inline;
      }
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      return next;
    };

    switch (arg) {
      case '--backend':
        backends.push(value());
        break;
      case '--dataset':
        dataset = value();
        break;
      case '--limit':
        limit = positiveNumber('--limit', value(), true);
        break;
      case '--concurrency':
        concurrency = positiveNumber('--concurrency', value(), true);
        break;
      case '--out':
        out = value();
        break;
      case '--markdown':
        markdown = value();
        break;
      case '--neutral-keys':
        neutralKeys = true;
        break;
      case '--temperature':
        temperature = positiveNumber('--temperature', value(), false);
        break;
      case '--name-invariance':
        nameInvariance = true;
        break;
      case '--model':
        model = value();
        break;
      case '--hardware':
        hardware = value();
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        throw new Error(`unknown option ${arg}`);
    }
  }

  if (!help && backends.length === 0) {
    throw new Error('at least one --backend is required');
  }
  for (const spec of backends) {
    parseBackendSpec(spec);
  }

  return {
    backends,
    dataset,
    ...(limit !== undefined && { limit }),
    concurrency,
    ...(out !== undefined && { out }),
    ...(markdown !== undefined && { markdown }),
    neutralKeys,
    ...(temperature !== undefined && { temperature }),
    nameInvariance,
    ...(model !== undefined && { model }),
    ...(hardware !== undefined && { hardware }),
    help,
  };
}
