#!/usr/bin/env node
// CI gate: stale pricing, missing defaults, dangling successors.
//   node scripts/check.mjs                 offline checks on data/catalog.json
//   node scripts/check.mjs --live          also require every recommended id to be in the provider's live list
//                                          (providers without a key in the env are skipped)
//   --max-age <days>                       pricingAsOf limit (default 60)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkCatalog } from './lib.mjs';
import { LIST_ENDPOINTS } from './generate.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const catalog = JSON.parse(readFileSync(`${root}data/catalog.json`, 'utf8'));
const maxPricingAgeDays = args.includes('--max-age')
  ? Number(args[args.indexOf('--max-age') + 1])
  : 60;

let live;
if (args.includes('--live')) {
  live = {};
  for (const [pid, ep] of Object.entries(LIST_ENDPOINTS)) {
    if (pid === 'openrouter' || !process.env[ep.key]) continue;
    const res = await fetch(ep.url, {
      headers: ep.headers(process.env[ep.key]),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      console.error(`live ${pid}: ${res.status}`);
      process.exit(1);
    }
    const j = await res.json();
    const rows = ep.pick ? ep.pick(j) : (j.data ?? []);
    live[pid] = rows.map((r) => ({ id: r.id }));
  }
}
const { errors, warnings } = checkCatalog(catalog, { maxPricingAgeDays, live });
for (const w of warnings) console.warn(`warn: ${w}`);
for (const e of errors) console.error(`error: ${e}`);
if (errors.length) process.exit(1);
console.log(
  `catalog ok (${Object.keys(catalog.providers).length} providers, ${warnings.length} warnings)`
);
