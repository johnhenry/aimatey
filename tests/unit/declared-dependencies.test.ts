/**
 * Every bare package a workspace package imports from `src/` must be declared
 * in its own package.json (#172). In the monorepo an undeclared import
 * resolves through npm hoisting, so it works here and fails for a published
 * install.
 *
 * Policy:
 * - Declared means `dependencies`, `peerDependencies` or `optionalDependencies`.
 *   `devDependencies` do not count: they are not installed for consumers.
 * - `import type` / `export type` count too. The emitted `.d.ts` files
 *   reference those packages, so consumers need them to type-check.
 * - Relative paths, `node:` builtins and a package's own name are skipped.
 * - Subpath imports (`pkg/sub`, `@scope/pkg/sub`) are checked as `pkg` / `@scope/pkg`.
 * - Non-literal specifiers (`const s = '@receptron/laya'; await import(s)`,
 *   used for the optional native runtimes) are invisible to the scan by
 *   construction; those packages declare them as optional peers.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { builtinModules } from 'node:module';

const root = resolve(__dirname, '../..');
const packagesDir = join(root, 'packages');

/** `package name -> specifiers` that are intentionally not declared. Keep tiny; explain each. */
const ALLOWLIST: Record<string, Record<string, string>> = {
  '@johnhenry/aimatey-testing': {
    vitest:
      'src/test-helpers.ts (exported assertion helpers) imports `expect` from vitest at runtime, but vitest is only a devDependency. ' +
      'It should become an (optional) peerDependency; changing the published contract is out of scope for #172, tracked as a follow-up.',
  },
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...walk(p));
    } else if (/\.(ts|tsx|mts|cts)$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;

function bareName(spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) {
    return null;
  }
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  if (builtinModules.includes(name)) {
    return null;
  }
  return /^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/.test(name) ? name : null;
}

function importedPackages(file: string): Set<string> {
  const found = new Set<string>();
  for (const m of stripComments(readFileSync(file, 'utf8')).matchAll(SPECIFIER)) {
    const name = bareName(m[2]!);
    if (name) {
      found.add(name);
    }
  }
  return found;
}

const packageDirs = readdirSync(packagesDir)
  .map((d) => join(packagesDir, d))
  .filter((d) => existsSync(join(d, 'package.json')) && existsSync(join(d, 'src')));

describe('declared dependencies (#172)', () => {
  it('finds the workspace packages', () => {
    expect(packageDirs.length).toBeGreaterThan(10);
  });

  for (const dir of packageDirs) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    it(`${pkg.name} declares every package it imports from src/`, () => {
      const declared = new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
        ...Object.keys(pkg.optionalDependencies ?? {}),
      ]);
      const allowed = ALLOWLIST[pkg.name] ?? {};
      const undeclared: string[] = [];
      for (const file of walk(join(dir, 'src'))) {
        for (const name of importedPackages(file)) {
          if (name !== pkg.name && !declared.has(name) && !(name in allowed)) {
            undeclared.push(`${name} (${file.slice(dir.length + 1)})`);
          }
        }
      }
      expect(undeclared.sort()).toEqual([]);
    });
  }
});
