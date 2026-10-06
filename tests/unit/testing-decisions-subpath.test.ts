/**
 * `@johnhenry/aimatey-testing/decisions` (#164): a subpath a CLI can import
 * outside a Vitest run. Runs against the built package, the way a consumer
 * resolves it (build first: `npm run build`).
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pkgDir = resolve(root, 'packages/aimatey-testing');
const entry = resolve(pkgDir, 'dist/esm/decisions/index.js');

/** Every bare/relative module specifier reachable from `file` (built ESM). */
function importGraph(
  file: string,
  seen = new Set<string>()
): { files: Set<string>; bare: Set<string> } {
  const bare = new Set<string>();
  const visit = (f: string): void => {
    if (seen.has(f)) return;
    seen.add(f);
    const src = readFileSync(f, 'utf-8');
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (spec.startsWith('.')) {
        const next = resolve(dirname(f), spec);
        if (existsSync(next)) visit(next);
      } else {
        bare.add(spec);
      }
    }
  };
  visit(file);
  return { files: seen, bare };
}

describe('@johnhenry/aimatey-testing/decisions subpath', () => {
  it('is declared in package.json exports (import + require, with types)', () => {
    const pkg = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf-8'));
    expect(pkg.exports['./decisions']).toEqual({
      import: {
        types: './dist/types/decisions/index.d.ts',
        default: './dist/esm/decisions/index.js',
      },
      require: {
        types: './dist/types/decisions/index.d.ts',
        default: './dist/cjs/decisions/index.js',
      },
    });
  });

  it('has no Vitest anywhere in its built import graph', () => {
    const { bare } = importGraph(entry);
    expect([...bare].filter((s) => /vitest/.test(s))).toEqual([]);
  });

  it('loads in a plain Node process and exposes the decision helpers', () => {
    const script = `
      const m = await import('@johnhenry/aimatey-testing/decisions');
      const names = ['calibrationReport','fitTemperature','nameInvariance','createDecisionCapture','joinDecisionLines'];
      const missing = names.filter((n) => typeof m[n] !== 'function');
      if (missing.length) { console.error('missing: ' + missing); process.exit(2); }
      console.log('ok');
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf-8',
    });
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('ok');
    expect(result.status).toBe(0);
  });
});
