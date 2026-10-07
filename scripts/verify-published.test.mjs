import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyPublished, formatTable } from './verify-published.mjs';

const pkgs = [
  { name: 'a', version: '1.0.0' },
  { name: 'b', version: '2.0.0' },
];

test('all found on first poll', async () => {
  const { results, missing } = await verifyPublished(pkgs, { view: () => true, sleep: async () => {} });
  assert.equal(missing.length, 0);
  assert.deepEqual(results.map((r) => r.attempts), [1, 1]);
});

test('polls until a late package appears', async () => {
  let calls = 0;
  const view = (name) => (name === 'a' ? true : ++calls >= 3);
  let t = 0;
  const { results, missing } = await verifyPublished(pkgs, {
    view,
    sleep: async (ms) => { t += ms; },
    now: () => t,
    timeoutMs: 100_000,
    intervalMs: 10_000,
  });
  assert.equal(missing.length, 0);
  assert.equal(results[0].attempts, 1);
  assert.equal(results[1].attempts, 3);
});

test('reports packages that never appear after timeout', async () => {
  let t = 0;
  const { missing } = await verifyPublished(pkgs, {
    view: (name) => name === 'a',
    sleep: async (ms) => { t += ms; },
    now: () => t,
    timeoutMs: 60_000,
    intervalMs: 20_000,
  });
  assert.deepEqual(missing.map((m) => m.name), ['b']);
  assert.ok(t <= 60_000);
  assert.match(formatTable(missing), /MISSING/);
});
