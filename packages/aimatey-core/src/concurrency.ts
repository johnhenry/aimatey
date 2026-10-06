/**
 * Bounded-concurrency map.
 *
 * `Bridge.decideBatch` needs "run N async jobs, at most K at a time, results
 * in input order". Kept here (not in `aimatey-patterns`, which core must not
 * import) as a small internal helper.
 *
 * @module
 */

/**
 * Run `fn` over `items` with at most `limit` calls in flight, returning
 * settled results in input order.
 *
 * Workers pull the next index as they free up, so a slow item never holds a
 * slot's successors hostage. `fn` never rejects the pool: each outcome is
 * recorded, and `shouldStop` (checked before each item starts) lets the
 * caller stop launching new work -- items never started are `undefined`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  shouldStop: () => boolean = () => false
): Promise<Array<PromiseSettledResult<R> | undefined>> {
  const results: Array<PromiseSettledResult<R> | undefined> = Array.from({ length: items.length });
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length && !shouldStop()) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index] as T, index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
