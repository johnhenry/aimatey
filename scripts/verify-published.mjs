#!/usr/bin/env node
/**
 * Post-publish verification: confirm each package's local version is actually
 * visible on the npm registry (`npm view <name>@<version> version`).
 *
 * `npm publish` can report success for a version the registry never stores
 * (seen with aimatey-wrapper@0.2.0 in the v0.3.0 release), so we poll.
 *
 * Usage: node scripts/verify-published.mjs <package-name>...
 * Env:   VERIFY_TIMEOUT   minutes to keep polling (default 10)
 *        VERIFY_INTERVAL  seconds between polls (default 20)
 * Exits 1 listing any package whose version never appeared.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Real registry lookup. Returns true if name@version exists. */
export function npmView(name, version) {
  try {
    const out = execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() === version;
  } catch {
    return false;
  }
}

/** Map workspace package names to their package.json versions. */
export function readWorkspaceVersions(root, names) {
  const pkgsDir = join(root, 'packages');
  const byName = new Map();
  for (const dir of readdirSync(pkgsDir)) {
    const file = join(pkgsDir, dir, 'package.json');
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    byName.set(pkg.name, pkg.version);
  }
  return names.map((name) => {
    if (!byName.has(name)) throw new Error(`Unknown workspace package: ${name}`);
    return { name, version: byName.get(name) };
  });
}

/**
 * Poll until every package is visible or the timeout elapses.
 * `view(name, version)` -> boolean|Promise<boolean>; `sleep(ms)` and `now()` are injectable.
 * Returns { results: [{name, version, found, attempts}], missing: [...] }.
 */
export async function verifyPublished(packages, opts = {}) {
  const {
    timeoutMs = 10 * 60_000,
    intervalMs = 20_000,
    view = npmView,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
  } = opts;
  const results = packages.map((p) => ({ ...p, found: false, attempts: 0 }));
  const start = now();
  for (;;) {
    for (const r of results) {
      if (r.found) continue;
      r.attempts++;
      r.found = Boolean(await view(r.name, r.version));
    }
    const pending = results.some((r) => !r.found);
    if (!pending || now() - start + intervalMs > timeoutMs) break;
    await sleep(intervalMs);
  }
  return { results, missing: results.filter((r) => !r.found) };
}

export function formatTable(results) {
  const w = Math.max(7, ...results.map((r) => r.name.length));
  const lines = [`${'PACKAGE'.padEnd(w)}  VERSION     STATUS`];
  for (const r of results) {
    lines.push(
      `${r.name.padEnd(w)}  ${r.version.padEnd(10)}  ${r.found ? 'ok' : 'MISSING'} (${r.attempts} poll${r.attempts === 1 ? '' : 's'})`
    );
  }
  return lines.join('\n');
}

async function main() {
  const names = process.argv.slice(2);
  if (names.length === 0) {
    console.log('verify-published: no packages to verify');
    return 0;
  }
  const root = resolve(fileURLToPath(import.meta.url), '..', '..');
  const timeoutMs = Number(process.env.VERIFY_TIMEOUT ?? 10) * 60_000;
  const intervalMs = Number(process.env.VERIFY_INTERVAL ?? 20) * 1000;
  const packages = readWorkspaceVersions(root, names);
  console.log(`Verifying ${packages.length} package(s) on the registry (timeout ${timeoutMs / 60_000} min)...`);
  const { results, missing } = await verifyPublished(packages, { timeoutMs, intervalMs });
  console.log(formatTable(results));
  if (missing.length > 0) {
    console.error(`\nNot visible on the registry after verification (${missing.length}):`);
    for (const m of missing) console.error(`  - ${m.name}@${m.version}`);
    console.error('Re-dispatch the Release workflow: already-published versions are skipped.');
    return 1;
  }
  console.log('\nAll packages verified on the registry.');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
