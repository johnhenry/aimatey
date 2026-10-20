# @johnhenry/aimatey-models

Data-only model catalog for ai.matey consumers: which models exist, which are current or on their way out, what to switch to, what they can do, and what they cost. No runtime dependencies.

```js
import { CATALOG, recommendedModel, successorOf, isDeprecated, mergeLiveModels, limitsFor } from '@johnhenry/aimatey-models';

recommendedModel('anthropic', 'default').id;   // 'claude-sonnet-5-5'
isDeprecated('claude-sonnet-4-5-20250929');    // true
successorOf('claude-opus-4-1-20250805');       // 'claude-opus-5-5'
limitsFor('openai', 'gpt-6.1-sol');            // { maxTools: 128, contextTokens: 1050000 }

// Merge an adapter's live listModels() with the catalog
const live = await adapter.listModels();
const picker = mergeLiveModels(Object.values(CATALOG.providers.anthropic.models), live, {
  recommended: CATALOG.providers.anthropic.recommended,
});
// -> [{ id, name, available, inCatalog, status?, recommended?, successor?, pricing?, ... }]
```

The raw JSON is exported as `@johnhenry/aimatey-models/catalog.json` for consumers that vendor it.

## Shape

`providers[id]` has `label`, `verifiedOn`, `sources`, `recommended` (`default`, `fast`, `best`), `limits` and `models`. Each model has `status` (`current | legacy | deprecated | retired`), `deprecatedOn`, `retiresOn`, `successor`, `capabilities` (`tools`, `vision`, `json`, `streaming`, `maxTools`), `contextWindow`, `maxOutputTokens` and `pricing` (USD per 1M tokens: `inputPer1M`, `outputPer1M`, `cachedInputPer1M`) with `pricingAsOf`. Providers without `verifiedOn` are not curated: their models come from the live list.

## Helpers

| Helper | What it does |
| --- | --- |
| `mergeLiveModels(entries, listModelsResult, { recommended, includeUnavailable })` | Live is authoritative for availability, the catalog for metadata. Unknown live models are kept with `inCatalog: false`. Sorted: default, current, uncatalogued, legacy, deprecated, retired. Strips Gemini's `models/` prefix. |
| `successorOf(id, provider?)` | Follows the successor chain to a current model. |
| `isDeprecated(id, provider?)` | True for deprecated and retired. |
| `recommendedModel(provider, role)` | The recommended model for `default`, `fast` or `best`. |
| `limitsFor(provider, model?)` | `maxTools` / `contextTokens` from the model, then the provider. |

## How the data is maintained

- `data/overrides.json` is the hand-maintained source of truth (status, successors, defaults, capabilities, prices, and the doc URLs each provider was verified against). Update it, bump `verifiedOn` / `pricingAsOf`, then `npm run generate -w @johnhenry/aimatey-models`.
- `scripts/generate.mjs --live` layers provider list-models endpoints (API keys from env: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `GROQ_API_KEY`, `TOGETHER_API_KEY`; providers without a key are skipped) and OpenRouter's public `/api/v1/models` underneath the overrides. Overrides always win. New live models are added as `current` and listed for review; OpenRouter only fills gaps (context, output limit, capabilities, and pricing for current models, marked `pricingSource: "openrouter"`); price drift against OpenRouter is reported, never applied.
- `.github/workflows/models-refresh.yml` runs this weekly and on dispatch, runs the checks, and opens a PR whose body is the readable diff (added, removed, status, price and default changes).
- Merging to main publishes through the repo's normal Changesets flow. Nothing publishes by hand.

## Checks

`npm run check -w @johnhenry/aimatey-models` fails on: a recommended id missing from the catalog or not `current`; a provider with current models but no default; a current model whose `pricingAsOf` is older than 60 days (`--max-age`); an expired `pricingEffectiveUntil`; a dangling `successor`. With `--live` it also fails if a recommended default is absent from the provider's live list (keyed providers only). `npm run check:fresh` fails if `catalog.json` / `src/catalog-data.ts` do not match `overrides.json`.

Prices are estimates from public provider pages on `pricingAsOf`; tiered or scheduled changes are described in `pricingNote`.
