/**
 * JSON Serializability
 *
 * The IR is JSON-shaped (see `JsonValue` in `@johnhenry/aimatey-types`), but its
 * free-form bags are typed `unknown`. These helpers give a transport one shared
 * answer to "can this cross the wire unchanged?" instead of a hand-written
 * walker per transport that will each disagree about `Date`, `NaN` and cycles.
 *
 * @module
 */

import { ValidationError, ErrorCode } from '@johnhenry/aimatey-errors';

/**
 * One value that would not survive a JSON round trip.
 */
export interface NonJsonValue {
  /** Where it is, as a path from the checked root, e.g. `metadata.custom.when` or `messages[0].content[1].input.tags[2]`. */
  readonly path: string;
  /** What is wrong with it. */
  readonly reason: string;
}

function describe(value: unknown): string | undefined {
  switch (typeof value) {
    case 'bigint':
      return 'a bigint (JSON.stringify throws)';
    case 'symbol':
      return 'a symbol';
    case 'function':
      return 'a function';
    case 'number':
      return Number.isFinite(value) ? undefined : `${String(value)} (JSON turns it into null)`;
    default:
      return undefined;
  }
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * List every value inside `value` that would not survive
 * `JSON.parse(JSON.stringify(value))` unchanged.
 *
 * Rules, matching the IR's contract:
 *
 * - Strings, booleans, `null` and finite numbers pass.
 * - **`undefined` is "absent"**: allowed as an object property (the key simply
 *   drops), but flagged in an array (where JSON makes it `null`) and at the root.
 * - `Date`, `Map`, `Set`, typed arrays, class instances and anything else that
 *   is not a plain object or array are flagged -- `JSON.stringify` would
 *   silently turn them into something else. Convert explicitly instead.
 * - `NaN`, `Infinity`, `bigint`, `symbol` and functions are flagged.
 * - Cycles are flagged rather than followed.
 *
 * @param value Anything; typically an `IRChatRequest`, `IRChatResponse`,
 *   `IRStreamChunk` or one of the IR's `custom`/`raw`/`input` bags.
 * @param root Name to start paths from (default `'value'`).
 */
export function findNonJsonValues(value: unknown, root = 'value'): NonJsonValue[] {
  const found: NonJsonValue[] = [];
  const ancestors = new Set<object>();

  const visit = (v: unknown, path: string, allowUndefined: boolean): void => {
    if (v === undefined) {
      if (!allowUndefined) {
        found.push({
          path,
          reason:
            'undefined (absent in an object, but null once serialized in an array, and not a value at the root)',
        });
      }
      return;
    }
    if (v === null || typeof v === 'string' || typeof v === 'boolean') {
      return;
    }
    const bad = describe(v);
    if (bad !== undefined) {
      found.push({ path, reason: bad });
      return;
    }
    if (typeof v === 'number') {
      return;
    }

    const obj = v as object;
    if (ancestors.has(obj)) {
      found.push({ path, reason: 'a circular reference' });
      return;
    }

    if (Array.isArray(obj)) {
      ancestors.add(obj);
      obj.forEach((item, i) => visit(item, `${path}[${i}]`, false));
      ancestors.delete(obj);
      return;
    }

    if (!isPlainObject(obj)) {
      const name = (obj as { constructor?: { name?: string } }).constructor?.name ?? 'object';
      found.push({
        path,
        reason: `a ${name} instance (not a plain object; JSON would silently convert it)`,
      });
      return;
    }

    ancestors.add(obj);
    for (const key of Object.keys(obj)) {
      visit((obj as Record<string, unknown>)[key], `${path}.${key}`, true);
    }
    ancestors.delete(obj);
  };

  visit(value, root, false);
  return found;
}

/**
 * `true` when `value` survives a JSON round trip unchanged.
 */
export function isJsonSerializable(value: unknown): boolean {
  return findNonJsonValues(value).length === 0;
}

/**
 * Throw a `ValidationError` (`INVALID_REQUEST`) naming every offending path
 * when `value` would not survive a JSON round trip. A transport calls this on
 * the IR it is about to send; a test calls it on what an adapter produced.
 *
 * @param value Value to check
 * @param root Name to start paths from (default `'value'`)
 */
export function assertJsonSerializable(value: unknown, root = 'value'): void {
  const found = findNonJsonValues(value, root);
  if (found.length === 0) {
    return;
  }
  throw new ValidationError({
    code: ErrorCode.INVALID_REQUEST,
    message: `${root} is not JSON-serializable: ${found.map((f) => `${f.path} is ${f.reason}`).join('; ')}`,
    validationDetails: found.map((f) => ({
      field: f.path,
      value: undefined,
      reason: f.reason,
      expected: 'a JsonValue (string, finite number, boolean, null, array or plain object)',
    })),
  });
}
