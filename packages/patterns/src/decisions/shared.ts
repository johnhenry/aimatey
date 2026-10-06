/**
 * Shared helpers for the decision patterns: usage summing, a seedable RNG,
 * a concurrency gate, and the distribution math the calibration and
 * ensemble patterns agree on.
 *
 * @module
 */

import { ValidationError, ErrorCode } from '@johnhenry/aimatey-errors';
import type { IRDecisionUsage } from '@johnhenry/aimatey-types';

/** Raise a ValidationError for a bad option or condition. */
export function invalid(field: string, value: unknown, reason: string): ValidationError {
  return new ValidationError({
    code: ErrorCode.INVALID_REQUEST,
    message: `Invalid decision pattern configuration: ${reason}`,
    validationDetails: [{ field, value, reason }],
  });
}

/**
 * Add decision usages together. A field is present on the result when either
 * side reports it, so a free (output-less) stage never erases a billed one.
 */
export function sumUsage(
  a: IRDecisionUsage | undefined,
  b: IRDecisionUsage | undefined
): IRDecisionUsage | undefined {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  const add = (x: number | undefined, y: number | undefined): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  const outputTokens = add(a.outputTokens, b.outputTokens);
  const cost = add(a.cost, b.cost);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    ...(outputTokens !== undefined && { outputTokens }),
    ...(cost !== undefined && { cost }),
  };
}

/** mulberry32: a tiny seedable PRNG returning floats in [0, 1). */
export function createRng(seed?: number | string): () => number {
  if (seed === undefined) {
    return Math.random;
  }
  let h = 1779033703 ^ String(seed).length;
  for (const ch of String(seed)) {
    h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle into a new array. */
export function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Normalize non-negative weights to sum to 1 (uniform if they sum to 0). */
export function normalize(weights: readonly number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  return total > 0 ? weights.map((w) => w / total) : weights.map(() => 1 / weights.length);
}

/**
 * Distribution concentration: `1 - H(p) / ln(n)` with H the Shannon
 * entropy. 1 is one-hot, 0 is uniform. This is the measure the Together
 * Tev1 adapter reports as `confidence`.
 *
 * TODO(consolidate): the same formula lives, unexported, in
 * `packages/backend/src/providers/together-ai.ts` (`tev1Parse`). Export one
 * copy from `@johnhenry/aimatey-utils` and use it in both places.
 */
export function concentration(probabilities: readonly number[]): number {
  const n = probabilities.length;
  if (n < 2) {
    return 1;
  }
  const entropy = -probabilities.reduce((h, p) => (p > 0 ? h + p * Math.log(p) : h), 0);
  return Math.min(1, Math.max(0, 1 - entropy / Math.log(n)));
}

/** A counting semaphore: `gate(fn)` runs `fn` once fewer than `limit` calls are in flight. */
export function createGate(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  const max = Math.max(1, Math.floor(limit));
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < max) {
      active++;
    } else {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) {
        next();
      } else {
        active--;
      }
    }
  };
}
