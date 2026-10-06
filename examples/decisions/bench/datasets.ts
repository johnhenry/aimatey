/**
 * Dataset loading for the decision benchmark.
 *
 * Three sources, one in-memory shape ({@link BenchItem}):
 *
 * - `builtin`: the 40 hand-written items in `datasets/builtin.ts`.
 * - A **Typed Decisions** file (JSONL, or a JSON array): one row per state,
 *   several named questions each. See `readme.md` for the schema.
 * - A **Decision Index** subset (JSON array or JSONL): one row per
 *   (input, question, label). Wrapped as a single question named `answer`.
 *
 * Nothing here downloads anything; see `fetch-datasets.md` for where the
 * public files live.
 *
 * @module
 */

import { readFile } from 'node:fs/promises';
import type { IRDecisionQuestion } from '@johnhenry/aimatey-types';
import { BUILTIN_ITEMS } from './datasets/builtin.js';
import type { BenchItem, GoldValue } from './types.js';

export { BUILTIN_ITEMS };
export type { BenchItem, GoldValue };

const QUESTION_TYPES = new Set(['choice', 'score', 'noul']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Reduce a soft gold object (the public Typed Decisions export keeps full
 * distributions) to a hard label: `label`, else the argmax of
 * `probabilities`, else the rounded `score`, else `probability_true >= 0.5`.
 */
function fromSoftGold(question: IRDecisionQuestion, soft: Record<string, unknown>): unknown {
  if (question.type === 'noul') {
    const p = soft.probability_true ?? soft.probability ?? soft.value;
    return typeof p === 'number' ? p >= 0.5 : (soft.label ?? soft.answer);
  }
  if (soft.label !== undefined) {
    return soft.label;
  }
  const p = soft.probabilities;
  if (question.type === 'choice' && isRecord(p)) {
    return Object.entries(p).sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0];
  }
  if (question.type === 'score') {
    if (typeof soft.score === 'number') {
      return Math.round(soft.score);
    }
    if (Array.isArray(p)) {
      return p.indexOf(Math.max(...(p as number[])));
    }
  }
  return soft.answer;
}

/**
 * Turn a raw label into the normalized gold value for a question, or throw.
 *
 * - `choice`: an option key, or a 0-based index into the option keys.
 * - `score`: a 0-based level index, or a level label.
 * - `noul`: `true`/`false`, `1`/`0`, or `"yes"`/`"no"`/`"true"`/`"false"`.
 */
export function normalizeGold(question: IRDecisionQuestion, rawInput: unknown): GoldValue {
  const raw = isRecord(rawInput) ? fromSoftGold(question, rawInput) : rawInput;
  switch (question.type) {
    case 'choice': {
      const keys = Object.keys(question.criteria);
      if (typeof raw === 'string' && keys.includes(raw)) {
        return raw;
      }
      if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw < keys.length) {
        return keys[raw]!;
      }
      throw new Error(`label ${JSON.stringify(raw)} is not one of [${keys.join(', ')}]`);
    }
    case 'score': {
      const levels = question.criteria;
      if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw < levels.length) {
        return raw;
      }
      if (typeof raw === 'string' && levels.includes(raw)) {
        return levels.indexOf(raw);
      }
      throw new Error(
        `label ${JSON.stringify(raw)} is not a level index 0-${levels.length - 1} or one of [${levels.join(', ')}]`
      );
    }
    case 'noul': {
      if (typeof raw === 'boolean') {
        return raw;
      }
      if (raw === 1 || raw === 0) {
        return raw === 1;
      }
      if (typeof raw === 'string') {
        const s = raw.trim().toLowerCase();
        if (s === 'yes' || s === 'true') {
          return true;
        }
        if (s === 'no' || s === 'false') {
          return false;
        }
      }
      throw new Error(`label ${JSON.stringify(raw)} is not a boolean, 0/1 or yes/no`);
    }
  }
}

function validateQuestion(id: string, name: string, q: unknown): IRDecisionQuestion {
  if (!isRecord(q) || typeof q.type !== 'string' || !QUESTION_TYPES.has(q.type)) {
    throw new Error(`${id}: question '${name}' needs a "type" of choice, score or noul`);
  }
  if (typeof q.instructions !== 'string') {
    throw new Error(`${id}: question '${name}' needs "instructions"`);
  }
  if (q.type === 'choice' && !isRecord(q.criteria)) {
    throw new Error(`${id}: choice question '${name}' needs "criteria" as {option: description}`);
  }
  if (q.type === 'score' && !Array.isArray(q.criteria)) {
    throw new Error(`${id}: score question '${name}' needs "criteria" as an ordered array of levels`);
  }
  return q as unknown as IRDecisionQuestion;
}

/** Convert one raw row (either supported shape) to a {@link BenchItem}. */
function toItem(input: unknown, index: number): BenchItem {
  if (!isRecord(input)) {
    throw new Error(`row ${index}: expected an object`);
  }
  let row: Record<string, unknown> = input;
  const id = typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id) : `item-${index}`;
  const workflow =
    typeof row.workflow === 'string'
      ? row.workflow
      : typeof row.benchmark === 'string'
        ? row.benchmark
        : 'unknown';
  const state = row.state ?? row.input ?? row.text;
  if (state === undefined) {
    throw new Error(`${id}: row has no "state" (or "input"/"text")`);
  }

  const unJson = (v: unknown): unknown => {
    if (typeof v !== 'string') {
      return v;
    }
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  };
  row = { ...row, questions: unJson(row.questions), question: unJson(row.question), gold: unJson(row.gold), answers: unJson(row.answers), labels: unJson(row.labels) };

  let rawQuestions: Record<string, unknown>;
  let rawGold: Record<string, unknown>;
  if (isRecord(row.questions)) {
    rawQuestions = row.questions;
    const g = row.gold ?? row.answers ?? row.labels;
    if (!isRecord(g)) {
      throw new Error(`${id}: row has no "gold" (or "answers"/"labels") object`);
    }
    rawGold = g;
  } else if (isRecord(row.question)) {
    rawQuestions = { answer: row.question };
    rawGold = { answer: row.label ?? row.gold };
  } else {
    throw new Error(`${id}: row needs "questions" (Typed Decisions) or "question" (Decision Index)`);
  }

  const questions: Record<string, IRDecisionQuestion> = {};
  const gold: Record<string, GoldValue> = {};
  for (const [name, raw] of Object.entries(rawQuestions)) {
    const q = validateQuestion(id, name, raw);
    questions[name] = q;
    if (!(name in rawGold) || rawGold[name] === undefined) {
      throw new Error(`${id}: question '${name}' has no gold label`);
    }
    try {
      gold[name] = normalizeGold(q, rawGold[name]);
    } catch (error) {
      throw new Error(`${id}: question '${name}': ${(error as Error).message}`);
    }
  }
  if (Object.keys(questions).length === 0) {
    throw new Error(`${id}: row has no questions`);
  }
  return { id, workflow, state, questions, gold };
}

/**
 * Parse dataset text. A JSON array (or an object with an `items`/`data`/`rows`
 * array) is read whole; anything else is read as JSONL, skipping blank lines.
 *
 * @param filename Only used for error messages and to tell `.json` from `.jsonl`.
 */
export function parseDatasetText(text: string, filename: string): BenchItem[] {
  const trimmed = text.trim();
  let rows: unknown[];

  const wholeJson =
    trimmed.startsWith('[') || (trimmed.startsWith('{') && /\.json$/i.test(filename));
  if (wholeJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`${filename}: invalid JSON: ${(error as Error).message}`);
    }
    if (Array.isArray(parsed)) {
      rows = parsed;
    } else if (isRecord(parsed)) {
      const inner = parsed.items ?? parsed.data ?? parsed.rows;
      rows = Array.isArray(inner) ? inner : [parsed];
    } else {
      throw new Error(`${filename}: expected a JSON array or object`);
    }
  } else {
    rows = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (line === '') {
        continue;
      }
      try {
        rows.push(JSON.parse(line));
      } catch (error) {
        throw new Error(`${filename}: line ${i + 1}: invalid JSON: ${(error as Error).message}`);
      }
    }
  }
  return rows.map((row, i) => toItem(row, i + 1));
}

export interface LoadOptions {
  /** Keep only the first N items. */
  readonly limit?: number;
}

/**
 * Load a dataset by spec: `builtin`, or a path to a JSON/JSONL file.
 */
export async function loadDataset(spec: string, options: LoadOptions = {}): Promise<BenchItem[]> {
  const items =
    spec === 'builtin'
      ? [...BUILTIN_ITEMS]
      : parseDatasetText(await readFile(spec, 'utf8'), spec);
  return options.limit !== undefined ? items.slice(0, options.limit) : items;
}
