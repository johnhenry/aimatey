/** CLI argument parsing for the tool-protocol benchmark. */

import { PROTOCOLS, type ProtocolName } from './runner.js';

export interface BenchArgs {
  models: string[];
  repeats: number;
  heavyRepeats: number;
  timeoutMs: number;
  maxIterations: number;
  temperature: number;
  tasks?: string[];
  protocols: ProtocolName[];
  out: string;
  resume: boolean;
  /** Only render markdown from an existing results file. */
  report?: string;
  markdown?: string;
  baseURL?: string;
  hardware?: string;
}

export function parseArgs(argv: readonly string[]): BenchArgs {
  const args: BenchArgs = {
    models: [],
    repeats: 2,
    heavyRepeats: 2,
    timeoutMs: 300_000,
    maxIterations: 8,
    temperature: 0.3,
    protocols: [...PROTOCOLS],
    out: 'examples/tools/bench/results/results.json',
    resume: false,
  };
  const need = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      throw new Error(`${flag} needs a value`);
    }
    return v;
  };
  const num = (v: string, flag: string): number => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`${flag} needs a non-negative number, got '${v}'`);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--model': args.models.push(need(i++, flag)); break;
      case '--repeats': args.repeats = num(need(i++, flag), flag); break;
      case '--heavy-repeats': args.heavyRepeats = num(need(i++, flag), flag); break;
      case '--timeout-s': args.timeoutMs = num(need(i++, flag), flag) * 1000; break;
      case '--max-iterations': args.maxIterations = num(need(i++, flag), flag); break;
      case '--temperature': args.temperature = num(need(i++, flag), flag); break;
      case '--tasks': args.tasks = need(i++, flag).split(','); break;
      case '--protocols': {
        const list = need(i++, flag).split(',');
        for (const p of list) {
          if (!PROTOCOLS.includes(p as ProtocolName)) {
            throw new Error(`unknown protocol '${p}' (expected ${PROTOCOLS.join(', ')})`);
          }
        }
        args.protocols = list as ProtocolName[];
        break;
      }
      case '--out': args.out = need(i++, flag); break;
      case '--resume': args.resume = true; break;
      case '--report': args.report = need(i++, flag); break;
      case '--markdown': args.markdown = need(i++, flag); break;
      case '--base-url': args.baseURL = need(i++, flag); break;
      case '--hardware': args.hardware = need(i++, flag); break;
      default:
        throw new Error(`unknown flag '${flag}'`);
    }
  }
  if (!args.report && args.models.length === 0) {
    args.models.push('qwen2.5:3b');
  }
  return args;
}
