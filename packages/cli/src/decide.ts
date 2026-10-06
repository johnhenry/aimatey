/**
 * `ai-matey decide`
 *
 * Ask typed questions (choice / score / noul) about a state from the command
 * line, through any decision-capable backend, and print the answers as a table
 * or as the raw IR response. `--batch @file.jsonl` answers the same questions
 * about many states with `Bridge.decideBatch`.
 *
 * Exit codes: 0 success, 1 usage or backend/runtime failure, 2 a
 * `ValidationError` (the request or a response failed validation).
 *
 * @module cli/decide
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { Bridge } from '@johnhenry/aimatey-core';
import { createGenericFrontend } from '@johnhenry/aimatey-frontend';
import { ValidationError } from '@johnhenry/aimatey-errors';
import type {
  BackendAdapter,
  IRDecisionQuestion,
  IRDecisionRequest,
  IRDecisionResponse,
  ImageContent,
} from '@johnhenry/aimatey-types';
import { loadBackend } from './utils/backend-loader.js';
import { wireToDecisionRequest, DecisionWireError } from './decisions.js';

// ============================================================================
// Errors
// ============================================================================

/** A problem with the command line (exit code 1, message printed without a stack). */
export class DecideUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecideUsageError';
  }
}

// ============================================================================
// --question grammar
// ============================================================================

/**
 * Split on top-level occurrences of `separator`, treating `"..."` (with `\"`
 * and `\\` escapes) as opaque. At most `limit` pieces: the last keeps the rest
 * of the string verbatim, separators and all.
 */
function splitTopLevel(text: string, separator: string, limit = Infinity): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuote && ch === '\\' && i + 1 < text.length) {
      current += ch + text[++i];
      continue;
    }
    if (ch === '"') {
      inQuote = !inQuote;
    }
    if (ch === separator && !inQuote && parts.length < limit - 1) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (inQuote) {
    throw new DecideUsageError(`Unterminated quote in ${JSON.stringify(text)}`);
  }
  parts.push(current);
  return parts;
}

/** Strip surrounding double quotes (resolving `\"` and `\\`), or return the trimmed text. */
function unquote(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return trimmed;
}

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * Parse one `--question` value.
 *
 * ```
 * name:type:"instructions"[:options]
 *
 * team:choice:"Who owns this?":billing=invoices and refunds,tech=bugs and outages
 * urgency:score:"How urgent is it?":low,medium,high
 * spam:noul:"Is this spam?"
 * spam:noul:"Is this spam?":true=unsolicited,false=wanted
 * ```
 *
 * - `name`: letters, digits, `_`, `.`, `-`; not starting with a digit.
 * - `type`: `choice`, `score`, `noul` (or its alias `boolean`).
 * - `instructions`: double-quoted (use `\"` for a quote); unquoted text works
 *   when it contains no `:`.
 * - options (everything after the third `:`):
 *   - choice: `option=description` pairs separated by commas (at least 2);
 *     a bare `option` describes itself; wrap a description in double quotes to
 *     include commas.
 *   - score: comma-separated level labels, lowest first (at least 2).
 *   - noul: optional `true=<label>,false=<label>` (both or neither).
 */
export function parseQuestionSpec(spec: string): { name: string; question: IRDecisionQuestion } {
  if (spec.trim() === '') {
    throw new DecideUsageError('--question is empty');
  }
  const parts = splitTopLevel(spec, ':', 4);
  if (parts.length < 3) {
    throw new DecideUsageError(
      `--question ${JSON.stringify(spec)} must look like name:type:"instructions"[:options]`
    );
  }
  const name = parts[0]!.trim();
  const typeText = parts[1]!.trim();
  const instructions = unquote(parts[2]!);
  const optionsText = parts[3];

  if (!NAME_PATTERN.test(name)) {
    throw new DecideUsageError(
      `Invalid question name ${JSON.stringify(name)} (use letters, digits, _ . -)`
    );
  }
  if (instructions === '') {
    throw new DecideUsageError(`Question '${name}' has empty instructions`);
  }
  const type = typeText === 'boolean' ? 'noul' : typeText;
  if (type !== 'choice' && type !== 'score' && type !== 'noul') {
    throw new DecideUsageError(
      `Question '${name}': unknown type '${typeText}' (expected choice, score or noul)`
    );
  }

  const items =
    optionsText === undefined || optionsText.trim() === ''
      ? []
      : splitTopLevel(optionsText, ',').map((item) => item.trim());

  if (type === 'choice') {
    const criteria: Record<string, string> = {};
    for (const item of items) {
      const eq = item.indexOf('=');
      const key = (eq === -1 ? item : item.slice(0, eq)).trim();
      const description = eq === -1 ? key : unquote(item.slice(eq + 1));
      if (key === '') {
        throw new DecideUsageError(`Question '${name}': empty option name`);
      }
      if (description === '') {
        throw new DecideUsageError(`Question '${name}': option '${key}' needs a description`);
      }
      if (key in criteria) {
        throw new DecideUsageError(`Question '${name}': duplicate option '${key}'`);
      }
      criteria[key] = description;
    }
    if (Object.keys(criteria).length < 2) {
      throw new DecideUsageError(
        `Question '${name}': a choice needs at least 2 options (option=description,option=description)`
      );
    }
    return { name, question: { type, instructions, criteria } };
  }

  if (type === 'score') {
    if (items.some((level) => level === '')) {
      throw new DecideUsageError(`Question '${name}': empty level label`);
    }
    if (items.length < 2) {
      throw new DecideUsageError(
        `Question '${name}': a score needs at least 2 levels (low,mid,high)`
      );
    }
    return { name, question: { type, instructions, criteria: items.map(unquote) } };
  }

  if (items.length === 0) {
    return { name, question: { type, instructions } };
  }
  const labels: Record<string, string> = {};
  for (const item of items) {
    const eq = item.indexOf('=');
    if (eq !== -1) {
      labels[item.slice(0, eq).trim()] = unquote(item.slice(eq + 1));
    }
  }
  if (
    items.length !== 2 ||
    typeof labels.true !== 'string' ||
    typeof labels.false !== 'string' ||
    labels.true === '' ||
    labels.false === ''
  ) {
    throw new DecideUsageError(
      `Question '${name}': noul options must be true=<label>,false=<label>`
    );
  }
  return {
    name,
    question: { type, instructions, criteria: { true: labels.true, false: labels.false } },
  };
}

// ============================================================================
// Arguments
// ============================================================================

export interface DecideArgs {
  backend?: string;
  model?: string;
  state?: string;
  questions: string[];
  questionsFile?: string;
  images: string[];
  json: boolean;
  batch?: string;
  concurrency?: number;
  timeout?: number;
  url?: string;
  dialect?: string;
  help: boolean;
}

const VALUE_FLAGS = new Set([
  'backend',
  'model',
  'state',
  'question',
  'questions',
  'image',
  'batch',
  'concurrency',
  'timeout',
  'url',
  'dialect',
]);

function stripAt(flag: string, value: string): string {
  if (!value.startsWith('@')) {
    throw new DecideUsageError(`--${flag} takes @file (got ${JSON.stringify(value)})`);
  }
  return value.slice(1);
}

function positiveInt(flag: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new DecideUsageError(
      `--${flag} must be a positive integer (got ${JSON.stringify(value)})`
    );
  }
  return n;
}

/** Parse `decide`'s argv (the part after the command name). */
export function parseDecideArgs(argv: readonly string[]): DecideArgs {
  const args: DecideArgs = { questions: [], images: [], json: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-h' || arg === '--help') {
      args.help = true;
      continue;
    }
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new DecideUsageError(`Unexpected argument ${JSON.stringify(arg)}`);
    }

    const eq = arg.indexOf('=');
    const flag = arg.slice(2, eq === -1 ? undefined : eq);
    if (!VALUE_FLAGS.has(flag)) {
      throw new DecideUsageError(`Unknown option --${flag}`);
    }
    let value: string | undefined = eq === -1 ? undefined : arg.slice(eq + 1);
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) {
        throw new DecideUsageError(`--${flag} requires a value`);
      }
    }

    switch (flag) {
      case 'backend':
        args.backend = value;
        break;
      case 'model':
        args.model = value;
        break;
      case 'state':
        args.state = value;
        break;
      case 'question':
        args.questions.push(value);
        break;
      case 'questions':
        args.questionsFile = stripAt(flag, value);
        break;
      case 'image':
        args.images.push(value);
        break;
      case 'batch':
        args.batch = stripAt(flag, value);
        break;
      case 'concurrency':
        args.concurrency = positiveInt(flag, value);
        break;
      case 'timeout':
        args.timeout = positiveInt(flag, value);
        break;
      case 'url':
        args.url = value;
        break;
      case 'dialect':
        args.dialect = value;
        break;
    }
  }
  return args;
}

// ============================================================================
// Output
// ============================================================================

const BAR_WIDTH = 10;

function bar(probability: number): string {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.floor(probability * BAR_WIDTH + 1e-9)));
  return `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)} ${Math.round(probability * 100)}%`;
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

interface EscalationRecord {
  triggeredBy: { question: string; reason: string }[];
  primaryModel: string;
}

/**
 * The default human output: one row per question with the answer, a
 * probability bar and the confidence, then the model, usage, any escalation
 * and any warnings. For a `noul`, the bar is P(true).
 */
export function formatDecisionTable(
  response: IRDecisionResponse,
  request: Pick<IRDecisionRequest, 'questions'>
): string {
  const rows: string[][] = [['QUESTION', 'VALUE', 'PROBABILITY', 'CONFIDENCE']];

  for (const [name, answer] of Object.entries(response.answers)) {
    const question = request.questions[name];
    let value: string;
    let probability: number | undefined;

    if (answer.type === 'choice') {
      value = answer.value;
      probability = answer.probabilities?.[answer.value];
    } else if (answer.type === 'score') {
      const index = Math.round(answer.value);
      const label = question?.type === 'score' ? question.criteria[index] : undefined;
      value =
        label === undefined
          ? formatNumber(answer.value)
          : `${label} (${formatNumber(answer.value)})`;
      probability = answer.probabilities?.[index];
    } else {
      value = answer.value >= 0.5 ? 'true' : 'false';
      probability = answer.value;
    }

    rows.push([
      name,
      value,
      probability === undefined ? '-' : bar(probability),
      answer.confidence === undefined ? '-' : answer.confidence.toFixed(2),
    ]);
  }

  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((row) => row[col]!.length)));
  const lines = rows.map((row) =>
    row
      .map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col]! + 2)))
      .join('')
      .trimEnd()
  );

  const usage = response.usage;
  const usageText = usage
    ? ` · ${usage.inputTokens} in${usage.outputTokens !== undefined ? ` · ${usage.outputTokens} out` : ''} tokens`
    : '';
  lines.push(`model ${response.model}${usageText}`);

  const escalation = response.metadata.custom?.escalation as EscalationRecord | undefined;
  if (escalation) {
    const why = escalation.triggeredBy.map((t) => `${t.question}: ${t.reason}`).join(', ');
    lines.push(`escalated from ${escalation.primaryModel} (${why})`);
  }
  for (const warning of response.metadata.warnings ?? []) {
    lines.push(`warning: ${warning.message}`);
  }
  return lines.join('\n');
}

// ============================================================================
// Inputs
// ============================================================================

/** The I/O the command touches, injectable for tests. */
export interface DecideDeps {
  /** Use this backend instead of building one from `--backend`. */
  backend?: BackendAdapter;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readFile: (path: string) => Promise<Buffer>;
  readStdin: () => Promise<string>;
  env: Record<string, string | undefined>;
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

const defaultDeps: DecideDeps = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readFile: (path) => readFile(path),
  readStdin: readStdinText,
  env: process.env,
};

function parseJSON(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new DecideUsageError(
      `${what} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** `--state`: literal text, `@file` (parsed as JSON for `.json`), `-` for stdin, or `json:<value>`. */
async function resolveState(spec: string, deps: DecideDeps): Promise<unknown> {
  if (spec === '-') {
    return deps.readStdin();
  }
  if (spec.startsWith('json:')) {
    return parseJSON(spec.slice('json:'.length), '--state json:');
  }
  if (spec.startsWith('@')) {
    const path = spec.slice(1);
    const text = (await readOrUsage(deps, path)).toString('utf-8');
    return extname(path).toLowerCase() === '.json' ? parseJSON(text, path) : text;
  }
  return spec;
}

async function readOrUsage(deps: DecideDeps, path: string): Promise<Buffer> {
  try {
    return await deps.readFile(path);
  } catch (error) {
    throw new DecideUsageError(
      `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function resolveQuestions(
  args: DecideArgs,
  deps: DecideDeps
): Promise<Record<string, IRDecisionQuestion>> {
  const questions: Record<string, IRDecisionQuestion> = {};

  if (args.questionsFile !== undefined) {
    const raw = parseJSON(
      (await readOrUsage(deps, args.questionsFile)).toString('utf-8'),
      args.questionsFile
    );
    try {
      // Same validation (and `type` inference) as an HTTP request body.
      Object.assign(
        questions,
        wireToDecisionRequest({ state: '-', questions: raw }, 'systemone').questions
      );
    } catch (error) {
      if (error instanceof DecisionWireError) {
        throw new DecideUsageError(`${args.questionsFile}: ${error.message}`);
      }
      throw error;
    }
  }
  for (const spec of args.questions) {
    const { name, question } = parseQuestionSpec(spec);
    if (name in questions) {
      throw new DecideUsageError(`Question '${name}' is defined more than once`);
    }
    questions[name] = question;
  }
  return questions;
}

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

async function resolveImages(paths: readonly string[], deps: DecideDeps): Promise<ImageContent[]> {
  const images: ImageContent[] = [];
  for (const path of paths) {
    const mediaType = IMAGE_TYPES[extname(path).toLowerCase()];
    if (!mediaType) {
      throw new DecideUsageError(`--image ${path}: unsupported type (use png, jpg, gif or webp)`);
    }
    const data = (await readOrUsage(deps, path)).toString('base64');
    images.push({ type: 'image', source: { type: 'base64', mediaType, data } });
  }
  return images;
}

/** One state per non-blank line: JSON (`{"state": ...}` unwrapped) or, failing that, the line's text. */
function parseBatchLines(text: string): unknown[] {
  const states: unknown[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      states.push(trimmed);
      continue;
    }
    const wrapped =
      typeof value === 'object' && value !== null && !Array.isArray(value) && 'state' in value;
    states.push(wrapped ? (value as { state: unknown }).state : value);
  }
  return states;
}

// ============================================================================
// Backends
// ============================================================================

const BUILTIN_BACKENDS = ['ollama', 'typesafe', 'openrouter', 'systemone'];

/**
 * Build the backend `--backend` names: a built-in (`ollama`, `typesafe`,
 * `openrouter`, `systemone`) or the path of a backend module, loaded the way
 * the proxy loads it.
 */
export async function createDecideBackend(
  args: Pick<DecideArgs, 'backend' | 'url' | 'dialect' | 'model'>,
  env: Record<string, string | undefined>
): Promise<BackendAdapter> {
  const name = args.backend;
  if (!name) {
    throw new DecideUsageError(
      `--backend is required: ${BUILTIN_BACKENDS.join(', ')}, or the path of a backend module`
    );
  }
  if (!BUILTIN_BACKENDS.includes(name)) {
    return loadBackend({ path: name });
  }

  const backends = await import('@johnhenry/aimatey-backend');
  const need = (key: string): string => {
    const value = env[key];
    if (!value) {
      throw new DecideUsageError(`--backend ${name} needs ${key} in the environment`);
    }
    return value;
  };

  switch (name) {
    case 'ollama':
      return new backends.OllamaBackendAdapter({ baseURL: args.url ?? env.OLLAMA_URL });
    case 'typesafe':
      return new backends.TypeSafeBackendAdapter({ apiKey: need('TYPESAFE_API_KEY') });
    case 'openrouter':
      return new backends.OpenRouterBackendAdapter({ apiKey: need('OPENROUTER_API_KEY') });
    default: {
      if (!args.url) {
        throw new DecideUsageError(
          '--backend systemone needs --url <base URL, e.g. http://host/v1>'
        );
      }
      const dialect = (args.dialect ??
        'systemone') as import('@johnhenry/aimatey-backend').SystemOneDialect;
      if (!(dialect in backends.SYSTEMONE_DIALECTS)) {
        throw new DecideUsageError(`Unknown --dialect '${args.dialect}'`);
      }
      return new backends.SystemOneBackendAdapter({
        baseURL: args.url,
        apiKey: env.SYSTEMONE_API_KEY,
        dialect,
      });
    }
  }
}

// ============================================================================
// Command
// ============================================================================

const HELP = `
ai-matey decide - ask typed questions about a state

Usage:
  ai-matey decide --backend <name|path> --state <state> --question <spec> [options]
  ai-matey decide --backend <name|path> --batch @states.jsonl --question <spec> [options]

Options:
  --backend <name|path>   ollama | typesafe | openrouter | systemone | path to a backend module
  --url <url>             Base URL (ollama; systemone: e.g. http://host/v1)
  --dialect <dialect>     systemone backend: systemone | openrouter | vercel-evaluate
  --model <model>         Decision model (e.g. tev1:0.8b)
  --state <state>         Text, @file (.json is parsed), - for stdin, or json:<value>
  --question <spec>       Repeatable; see the grammar below
  --questions @file.json  Questions as a JSON object: { name: { type, instructions, criteria } }
  --image <path>          Repeatable; png, jpg, gif or webp
  --json                  Print the raw IR response (JSON Lines with --batch)
  --batch @file.jsonl     One state per line (JSON, {"state": ...}, or plain text)
  --concurrency <n>       Batch: most calls in flight
  --timeout <seconds>     Abort each call after this long
  -h, --help              Show this help

--question grammar:
  name:type:"instructions"[:options]
    choice   team:choice:"Who owns this?":billing=invoices and refunds,tech=bugs
    score    urgency:score:"How urgent?":low,medium,high
    noul     spam:noul:"Is this spam?"[:true=unsolicited,false=wanted]
  Quote the instructions to include ':'; wrap an option description in "..." to
  include ','. 'boolean' is an alias of 'noul'.

Exit codes: 0 ok, 1 usage or backend failure, 2 validation error.

Examples:
  ai-matey decide --backend ollama --model tev1:0.8b \\
    --state "Duplicate charge, please refund" \\
    --question 'team:choice:"Who owns this?":billing=money,tech=bugs' \\
    --question 'urgent:noul:"Is this urgent?"'
`;

function preview(state: unknown): string {
  const text = typeof state === 'string' ? state : JSON.stringify(state);
  const line = text.replace(/\s+/g, ' ');
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run `decide` and return the exit code. Nothing here calls `process.exit`;
 * {@link main} does.
 */
export async function decideCommand(
  argv: readonly string[],
  overrides: Partial<DecideDeps> = {}
): Promise<number> {
  const deps: DecideDeps = { ...defaultDeps, ...overrides };

  try {
    const args = parseDecideArgs(argv);
    if (args.help) {
      deps.stdout(`${HELP.trim()}\n`);
      return 0;
    }

    const questions = await resolveQuestions(args, deps);
    if (Object.keys(questions).length === 0) {
      throw new DecideUsageError('Provide at least one --question (or --questions @file.json)');
    }
    if (args.batch !== undefined && args.state !== undefined) {
      throw new DecideUsageError('Use --state or --batch, not both');
    }
    if (args.batch === undefined && args.state === undefined) {
      throw new DecideUsageError('--state is required (or --batch @file.jsonl)');
    }

    const states =
      args.batch !== undefined
        ? parseBatchLines((await readOrUsage(deps, args.batch)).toString('utf-8'))
        : [await resolveState(args.state!, deps)];
    if (states.length === 0) {
      throw new DecideUsageError(`${args.batch} contains no states`);
    }
    const images = await resolveImages(args.images, deps);

    const backend = deps.backend ?? (await createDecideBackend(args, deps.env));
    const bridge = new Bridge(createGenericFrontend(), backend);
    const signal = (): AbortSignal | undefined =>
      args.timeout ? AbortSignal.timeout(args.timeout * 1000) : undefined;

    if (args.batch === undefined) {
      return await runOne(bridge, states[0], questions, args, signal(), images, deps);
    }
    return await runBatch(bridge, states, questions, args, images, deps);
  } catch (error) {
    if (error instanceof DecideUsageError) {
      deps.stderr(`Error: ${error.message}\nRun 'ai-matey decide --help' for usage.\n`);
      return 1;
    }
    deps.stderr(`Error: ${errorMessage(error)}\n`);
    return error instanceof ValidationError ? 2 : 1;
  }
}

async function runOne(
  bridge: Bridge,
  state: unknown,
  questions: Record<string, IRDecisionQuestion>,
  args: DecideArgs,
  signal: AbortSignal | undefined,
  images: readonly ImageContent[],
  deps: DecideDeps
): Promise<number> {
  const response = await bridge.decide(state, questions, { model: args.model, signal, images });
  deps.stdout(
    args.json
      ? `${JSON.stringify(response, null, 2)}\n`
      : `${formatDecisionTable(response, { questions })}\n`
  );
  return 0;
}

async function runBatch(
  bridge: Bridge,
  states: unknown[],
  questions: Record<string, IRDecisionQuestion>,
  args: DecideArgs,
  images: readonly ImageContent[],
  deps: DecideDeps
): Promise<number> {
  const results = await bridge.decideBatch(states, questions, {
    model: args.model,
    images,
    concurrency: args.concurrency,
    onError: 'collect',
    signal: args.timeout ? AbortSignal.timeout(args.timeout * 1000 * states.length) : undefined,
    onProgress: (done, total) =>
      deps.stderr(`decided ${done}/${total}${done === total ? '\n' : '\r'}`),
  });

  let exit = 0;
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      deps.stdout(
        args.json
          ? `${JSON.stringify(result.value)}\n`
          : `[${i + 1}] ${preview(states[i])}\n${formatDecisionTable(result.value, { questions })}\n\n`
      );
      return;
    }
    exit = Math.max(exit, result.reason instanceof ValidationError ? 2 : 1);
    const message = errorMessage(result.reason);
    deps.stdout(
      args.json
        ? `${JSON.stringify({ error: message })}\n`
        : `[${i + 1}] ${preview(states[i])}\n  error: ${message}\n\n`
    );
  });
  return exit;
}

/** CLI entry point (`ai-matey decide ...`). */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  process.exitCode = await decideCommand(argv);
}
