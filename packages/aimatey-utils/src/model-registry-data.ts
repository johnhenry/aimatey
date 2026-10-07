/**
 * Model Registry Seed Data
 *
 * The built-in model database consumed by the model registry
 * (see ./model-registry.ts). Pricing is USD per 1M tokens.
 *
 * UPDATING THIS FILE
 * - This file is intentionally the only place in the monorepo where model
 *   metadata is hardcoded. Everything else (pricing helpers, capability
 *   inference, cost tracking, token counting) derives from it.
 * - Add new models at the top of their provider section; mark superseded
 *   models `deprecated: true` instead of deleting them (cost tracking for
 *   historical usage still needs their prices).
 * - Users can add or correct models at runtime with `registerModels()`,
 *   so an out-of-date seed never blocks anyone.
 *
 * - `latency` and `qualityScore` are hand-authored routing heuristics, not
 *   measurements: no provider publishes either number. Entries added from
 *   2026-09-03 on therefore omit both rather than invent plausible values.
 *   The capability matcher scores a missing field as a neutral 50, so this
 *   is a deliberate gap, not an oversight - do not "helpfully" fill it.
 *
 * Data last refreshed: 2026-09-03 (verified against first-party provider
 * pages only - no secondary sources. Sources checked: OpenAI's model pages,
 * pricing page, changelog and deprecations table; Anthropic's models
 * overview, per-model overview pages, pricing page and model-deprecations
 * page; Google's Gemini API pricing, changelog, deprecations and model
 * cards; xAI's docs.x.ai model pages, models table and May-15 retirement
 * migration guide; Mistral's pricing page, model cards, vision capability
 * page and models overview (legacy table); DeepSeek's pricing, updates and
 * vision guide; Moonshot's platform.kimi.ai pricing and models pages.
 * Numbers with no first-party page behind them were left untouched - see
 * the changeset for the full unverified list.)
 *
 * @module
 */

import type { ModelRegistryEntry } from '@johnhenry/aimatey-types';

export const MODEL_REGISTRY_SEED: readonly ModelRegistryEntry[] = [
  // ==========================================================================
  // OpenAI
  // ==========================================================================
  // Not seeded: `gpt-daybreak-blue-latest` / `gpt-daybreak-red-latest`. OpenAI
  // documents them as moving pointers that "currently point to" gpt-5.6-sol
  // and gpt-5.6-cyber. A repointable alias in a file whose job includes
  // pricing historical usage would silently reprice the past.
  {
    id: 'gpt-5.6-cyber',
    provider: 'openai',
    family: 'gpt-5',
    releaseDate: '2026-08-07',
    // Access is gated behind the Daybreak program and the model is
    // Responses-API-only. Seeded anyway: being unable to price real Daybreak
    // usage is the worse failure, and at $12.50/$75 it is the most expensive
    // OpenAI entry, so cost-based routing avoids it regardless. Drop it if
    // the registry is meant to list only generally-available ids.
    contextWindow: 400000,
    maxOutputTokens: 128000,
    pricing: { inputPer1M: 12.5, outputPer1M: 75.0, cachedInputPer1M: 1.25 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
  },
  {
    id: 'gpt-5.6-sol',
    provider: 'openai',
    family: 'gpt-5',
    releaseDate: '2026-07-09',
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    // Price cut 2026-08-21 from $5/$30. Unlike the Terra/Luna cuts this one
    // is TIME-BOXED: OpenAI's pricing page says the promotional pricing is
    // available "at least through November 21, 2026". Recheck on that date.
    // Above 272K input tokens the whole session bills at 2x input / 1.5x
    // output, which this flat schema cannot express.
    pricing: { inputPer1M: 4.0, outputPer1M: 20.0, cachedInputPer1M: 0.4 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 1400, p95: 3200 },
    qualityScore: 98,
  },
  {
    id: 'gpt-5.6-terra',
    provider: 'openai',
    family: 'gpt-5',
    releaseDate: '2026-07-09',
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    // Permanent 20% cut effective 2026-07-30 (was $2.50/$15). Above 272K
    // input tokens the whole session bills at 2x input / 1.5x output.
    pricing: { inputPer1M: 2.0, outputPer1M: 12.0, cachedInputPer1M: 0.2 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 750, p95: 1700 },
    qualityScore: 90,
  },
  {
    id: 'gpt-5.6-luna',
    provider: 'openai',
    family: 'gpt-5',
    releaseDate: '2026-07-09',
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    // Permanent 80% cut effective 2026-07-30 (was $1.00/$6.00). Above 272K
    // input tokens the whole session bills at 2x input / 1.5x output.
    pricing: { inputPer1M: 0.2, outputPer1M: 1.2, cachedInputPer1M: 0.02 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 450, p95: 1000 },
    qualityScore: 80,
  },
  {
    // releaseDate for gpt-5.5/5.4/5.2 is DERIVED from the default snapshot id
    // (gpt-5.5-2026-04-23 etc.), not from an explicit release statement. This
    // matches the file's existing convention (gpt-5's 2025-08-07 is likewise
    // the snapshot date) but is weaker evidence than a stated date.
    id: 'gpt-5.5',
    provider: 'openai',
    family: 'gpt-5',
    releaseDate: '2026-04-23',
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    // Above 272K input tokens the whole session bills at 2x input /
    // 1.5x output. The pricing page's "limited to <272K context" label marks
    // that surcharge band, not a smaller context window.
    pricing: { inputPer1M: 5.0, outputPer1M: 30.0, cachedInputPer1M: 0.5 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
  },
  {
    id: 'gpt-5.4',
    provider: 'openai',
    family: 'gpt-5',
    releaseDate: '2026-03-05',
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    pricing: { inputPer1M: 2.5, outputPer1M: 15.0, cachedInputPer1M: 0.25 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
  },
  {
    id: 'gpt-5.2',
    provider: 'openai',
    family: 'gpt-5',
    releaseDate: '2025-12-11',
    // NOT deprecated: OpenAI's docs call it the previous flagship but it
    // carries no row on the deprecations table and no shutdown date.
    contextWindow: 400000,
    maxOutputTokens: 128000,
    pricing: { inputPer1M: 1.75, outputPer1M: 14.0, cachedInputPer1M: 0.175 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
  },
  {
    id: 'gpt-5.1',
    provider: 'openai',
    family: 'gpt-5',
    releaseDate: '2025-11-12',
    contextWindow: 400000,
    maxOutputTokens: 128000,
    pricing: { inputPer1M: 1.25, outputPer1M: 10.0, cachedInputPer1M: 0.125 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 1400, p95: 3200 },
    qualityScore: 98,
  },
  {
    id: 'gpt-5',
    provider: 'openai',
    family: 'gpt-5',
    releaseDate: '2025-08-07',
    // Deprecated by OpenAI 2026-06-11; removal from the API 2026-12-11.
    // Replacement per OpenAI's own migration mapping: gpt-5.6-sol.
    deprecated: true,
    contextWindow: 400000,
    maxOutputTokens: 128000,
    pricing: { inputPer1M: 1.25, outputPer1M: 10.0, cachedInputPer1M: 0.125 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 1500, p95: 3400 },
    qualityScore: 97,
  },
  {
    id: 'gpt-5-mini',
    provider: 'openai',
    family: 'gpt-5',
    releaseDate: '2025-08-07',
    // Deprecated by OpenAI 2026-06-11; removal from the API 2026-12-11.
    // Replacement per OpenAI's own migration mapping: gpt-5.6-terra.
    deprecated: true,
    contextWindow: 400000,
    maxOutputTokens: 128000,
    pricing: { inputPer1M: 0.25, outputPer1M: 2.0, cachedInputPer1M: 0.025 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 800, p95: 1800 },
    qualityScore: 88,
  },
  {
    id: 'gpt-5-nano',
    provider: 'openai',
    family: 'gpt-5',
    releaseDate: '2025-08-07',
    // Deprecated by OpenAI 2026-06-11; removal from the API 2026-12-11.
    // Replacement per OpenAI's own migration mapping: gpt-5.6-luna.
    deprecated: true,
    contextWindow: 400000,
    maxOutputTokens: 128000,
    pricing: { inputPer1M: 0.05, outputPer1M: 0.4, cachedInputPer1M: 0.005 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 500, p95: 1100 },
    qualityScore: 78,
  },
  {
    id: 'gpt-4.1',
    provider: 'openai',
    family: 'gpt-4',
    releaseDate: '2025-04-14',
    contextWindow: 1047576,
    maxOutputTokens: 32768,
    pricing: { inputPer1M: 2.0, outputPer1M: 8.0, cachedInputPer1M: 0.5 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 1300, p95: 2800 },
    qualityScore: 94,
  },
  {
    id: 'gpt-4.1-mini',
    provider: 'openai',
    family: 'gpt-4',
    releaseDate: '2025-04-14',
    contextWindow: 1047576,
    maxOutputTokens: 32768,
    pricing: { inputPer1M: 0.4, outputPer1M: 1.6, cachedInputPer1M: 0.1 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 700, p95: 1500 },
    qualityScore: 85,
  },
  {
    id: 'o3',
    provider: 'openai',
    family: 'o-series',
    releaseDate: '2025-04-16',
    // Deprecated by OpenAI 2026-06-11; removal from the API 2026-12-11.
    // Replacement per OpenAI's own migration mapping: gpt-5.6-sol.
    deprecated: true,
    contextWindow: 200000,
    maxOutputTokens: 100000,
    pricing: { inputPer1M: 2.0, outputPer1M: 8.0, cachedInputPer1M: 0.5 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 4000, p95: 12000 },
    qualityScore: 96,
  },
  {
    id: 'o4-mini',
    provider: 'openai',
    family: 'o-series',
    releaseDate: '2025-04-16',
    // Deprecated by OpenAI 2026-04-22; removal from the API 2026-10-23.
    // Replacement per OpenAI's migration mapping: gpt-5.6-terra. The
    // deprecations row names the bare `o4-mini` alias, not only the dated
    // snapshot, so this id is directly covered. Announced before the
    // 2026-07-23 refresh - this was a miss in that pass, not news.
    deprecated: true,
    contextWindow: 200000,
    maxOutputTokens: 100000,
    pricing: { inputPer1M: 1.1, outputPer1M: 4.4, cachedInputPer1M: 0.275 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 2500, p95: 7000 },
    qualityScore: 91,
  },
  {
    id: 'gpt-4o',
    provider: 'openai',
    family: 'gpt-4',
    releaseDate: '2024-05-13',
    // UNRESOLVED CONVENTION, deliberately left as-is: $5/$15 was the launch
    // price of the gpt-4o-2024-05-13 snapshot this entry's releaseDate names,
    // but the floating `gpt-4o` alias bills $2.50 input / $1.25 cached /
    // $10.00 output today. The header does not say whether a deprecated entry
    // prices its dated snapshot or the id as currently billed. Same question
    // governs gpt-4-turbo, gpt-4 and gpt-3.5-turbo. Filed as a follow-up.
    // `deprecated` here also means "superseded", not "has a shutdown date":
    // OpenAI announces no API shutdown for gpt-4o or gpt-4o-mini.
    deprecated: true,
    contextWindow: 128000,
    maxOutputTokens: 4096,
    pricing: { inputPer1M: 5.0, outputPer1M: 15.0 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 1200, p95: 2500 },
    qualityScore: 96,
  },
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    family: 'gpt-4',
    releaseDate: '2024-07-18',
    // "Superseded", not shut down: OpenAI announces no API retirement for
    // gpt-4o-mini. A consumer routing away from `deprecated` avoids a model
    // that is still fully supported.
    deprecated: true,
    contextWindow: 128000,
    maxOutputTokens: 16384,
    pricing: { inputPer1M: 0.15, outputPer1M: 0.6, cachedInputPer1M: 0.075 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 600, p95: 1200 },
    qualityScore: 80,
  },
  {
    id: 'gpt-4-turbo',
    provider: 'openai',
    family: 'gpt-4',
    releaseDate: '2024-04-09',
    deprecated: true,
    contextWindow: 128000,
    maxOutputTokens: 4096,
    pricing: { inputPer1M: 10.0, outputPer1M: 30.0 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 1800, p95: 3500 },
    qualityScore: 95,
  },
  {
    id: 'gpt-4-turbo-preview',
    provider: 'openai',
    family: 'gpt-4',
    releaseDate: '2024-01-25',
    deprecated: true,
    contextWindow: 128000,
    maxOutputTokens: 4096,
    pricing: { inputPer1M: 10.0, outputPer1M: 30.0 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 1800, p95: 3500 },
    qualityScore: 94,
  },
  {
    id: 'gpt-4',
    provider: 'openai',
    family: 'gpt-4',
    releaseDate: '2023-03-14',
    deprecated: true,
    contextWindow: 8192,
    maxOutputTokens: 4096,
    pricing: { inputPer1M: 30.0, outputPer1M: 60.0 },
    capabilities: { streaming: true, vision: false, tools: true, json: true },
    latency: { p50: 2000, p95: 4000 },
    qualityScore: 95,
  },
  {
    id: 'gpt-3.5-turbo',
    provider: 'openai',
    family: 'gpt-3.5',
    releaseDate: '2023-03-01',
    deprecated: true,
    contextWindow: 16385,
    maxOutputTokens: 4096,
    pricing: { inputPer1M: 0.5, outputPer1M: 1.5 },
    capabilities: { streaming: true, vision: false, tools: true, json: true },
    latency: { p50: 800, p95: 1500 },
    qualityScore: 75,
  },
  {
    id: 'text-embedding-3-small',
    provider: 'openai',
    family: 'text-embedding-3',
    kind: 'embedding',
    releaseDate: '2024-01-25',
    contextWindow: 8191,
    pricing: { inputPer1M: 0.02, outputPer1M: 0 },
    embeddingDimensions: 1536,
  },
  {
    id: 'text-embedding-3-large',
    provider: 'openai',
    family: 'text-embedding-3',
    kind: 'embedding',
    releaseDate: '2024-01-25',
    contextWindow: 8191,
    pricing: { inputPer1M: 0.13, outputPer1M: 0 },
    embeddingDimensions: 3072,
  },

  // ==========================================================================
  // Anthropic
  // ==========================================================================
  // Not seeded: claude-mythos-5 / claude-mythos-5-1. Real and priced
  // identically to the Fable models, but limited availability by invitation
  // only (Project Glasswing), so seeding ids almost nobody can call is noise.
  {
    id: 'claude-fable-5-1',
    provider: 'anthropic',
    family: 'claude-5',
    aliases: ['claude-fable-5.1'],
    releaseDate: '2026-09-01',
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    // The $0.25 cache-read rate is deliberately NOT claude-fable-5's $1.00:
    // Anthropic prices cache hits at 0.1x base input on every model EXCEPT
    // Fable 5.1 and Mythos 5.1, which are 0.025x. Before this entry existed,
    // a lookup of 'claude-fable-5-1' fell through longest-prefix matching to
    // the 'claude-fable-5' entry and billed cache reads at 4x the true rate,
    // while looking like a successful resolution.
    pricing: { inputPer1M: 10.0, outputPer1M: 50.0, cachedInputPer1M: 0.25 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
  },
  {
    id: 'claude-opus-5',
    provider: 'anthropic',
    family: 'claude-5',
    releaseDate: '2026-07-24',
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    // Fast mode (research preview, Claude API only) bills Opus 5 at $10/$50
    // per MTok across the full context window. The single-price schema cannot
    // express that, so fast-mode traffic is under-counted by this entry.
    pricing: { inputPer1M: 5.0, outputPer1M: 25.0, cachedInputPer1M: 0.5 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
  },
  {
    id: 'claude-fable-5',
    provider: 'anthropic',
    family: 'claude-5',
    releaseDate: '2026-06-09',
    // Status "Active (legacy)", retirement not sooner than 2027-06-09 - NOT
    // deprecated. Anthropic separates Legacy (no longer updated) from
    // Deprecated (replacement named, retirement date assigned); every
    // existing deprecated flag in this section is a model Anthropic lists as
    // retired. Pricing and releaseDate now confirmed on Anthropic's own
    // model page, replacing the previous medium-confidence secondary source.
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    pricing: { inputPer1M: 10.0, outputPer1M: 50.0, cachedInputPer1M: 1.0 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 1600, p95: 3400 },
    qualityScore: 99,
  },
  {
    id: 'claude-opus-4-8',
    provider: 'anthropic',
    family: 'claude-4',
    aliases: ['claude-opus-4.8'],
    releaseDate: '2026-05-28',
    // CONTEXT/OUTPUT CORRECTED 200000 -> 1000000 and 64000 -> 128000, a 5x
    // change worth a reviewer's eye. Anthropic's model page header, its
    // capabilities table and the pricing page's long-context section
    // ("Claude 4.6 and later models include the full 1M token context window
    // at standard pricing") all agree; the previous values came from the
    // secondary sources the old comment flagged as medium confidence.
    // Status "Active (legacy)", retirement not sooner than 2027-05-28.
    // Temperature/top_p/top_k are deprecated for this model (HTTP 400 if
    // set to a non-default value) - see AnthropicBackendAdapter's
    // supportsSamplingParams().
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    pricing: { inputPer1M: 5.0, outputPer1M: 25.0, cachedInputPer1M: 0.5 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 2000, p95: 4300 },
    qualityScore: 99,
  },
  {
    id: 'claude-sonnet-5',
    provider: 'anthropic',
    family: 'claude-5',
    releaseDate: '2026-06-30',
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    // The file previously bet on a price increase Anthropic then cancelled,
    // over-pricing the mainstream Sonnet model by 50% on both input and
    // output. Anthropic's pricing page now states the $2/$10 launch pricing
    // "is now the standard price" and that the increase to $3/$15 scheduled
    // for 2026-09-01 "will not occur".
    // Temperature/top_p/top_k are deprecated for this model (HTTP 400 if
    // set to a non-default value) - see AnthropicBackendAdapter's
    // supportsSamplingParams().
    pricing: { inputPer1M: 2.0, outputPer1M: 10.0, cachedInputPer1M: 0.2 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 1400, p95: 2900 },
    qualityScore: 98,
  },
  {
    id: 'claude-opus-4-5-20251101',
    provider: 'anthropic',
    family: 'claude-4',
    aliases: ['claude-opus-4-5', 'claude-opus-4.5'],
    releaseDate: '2025-11-24',
    contextWindow: 200000,
    maxOutputTokens: 64000,
    pricing: { inputPer1M: 5.0, outputPer1M: 25.0, cachedInputPer1M: 0.5 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 2000, p95: 4500 },
    qualityScore: 99,
  },
  {
    id: 'claude-sonnet-4-5-20250929',
    provider: 'anthropic',
    family: 'claude-4',
    aliases: ['claude-sonnet-4-5', 'claude-sonnet-4.5'],
    releaseDate: '2025-09-29',
    contextWindow: 200000,
    maxOutputTokens: 64000,
    pricing: { inputPer1M: 3.0, outputPer1M: 15.0, cachedInputPer1M: 0.3 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 1500, p95: 3000 },
    qualityScore: 97,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    family: 'claude-4',
    aliases: ['claude-haiku-4-5', 'claude-haiku-4.5'],
    // Anthropic's model page says "Released October 15, 2025"; 2025-10-01 is
    // the snapshot date embedded in the id, not the release date. The file's
    // convention elsewhere is the release date (claude-opus-4-5-20251101
    // carries 2025-11-24).
    releaseDate: '2025-10-15',
    contextWindow: 200000,
    maxOutputTokens: 64000,
    pricing: { inputPer1M: 1.0, outputPer1M: 5.0, cachedInputPer1M: 0.1 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 600, p95: 1300 },
    qualityScore: 90,
  },
  {
    id: 'claude-opus-4-1-20250805',
    provider: 'anthropic',
    family: 'claude-4',
    aliases: ['claude-opus-4-1', 'claude-opus-4.1'],
    releaseDate: '2025-08-05',
    deprecated: true,
    contextWindow: 200000,
    maxOutputTokens: 32000,
    pricing: { inputPer1M: 15.0, outputPer1M: 75.0, cachedInputPer1M: 1.5 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 2400, p95: 5000 },
    qualityScore: 98,
  },
  {
    id: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    family: 'claude-4',
    aliases: ['claude-sonnet-4'],
    releaseDate: '2025-05-14',
    deprecated: true,
    contextWindow: 200000,
    maxOutputTokens: 64000,
    pricing: { inputPer1M: 3.0, outputPer1M: 15.0, cachedInputPer1M: 0.3 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 1500, p95: 3100 },
    qualityScore: 95,
  },
  {
    id: 'claude-3-5-sonnet-20241022',
    provider: 'anthropic',
    family: 'claude-3',
    aliases: ['claude-3-5-sonnet'],
    releaseDate: '2024-10-22',
    deprecated: true,
    contextWindow: 200000,
    maxOutputTokens: 8192,
    pricing: { inputPer1M: 3.0, outputPer1M: 15.0 },
    capabilities: { streaming: true, vision: true, tools: true, json: false },
    latency: { p50: 1500, p95: 3000 },
    qualityScore: 97,
  },
  {
    id: 'claude-3-5-haiku-20241022',
    provider: 'anthropic',
    family: 'claude-3',
    aliases: ['claude-3-5-haiku'],
    releaseDate: '2024-10-22',
    deprecated: true,
    contextWindow: 200000,
    maxOutputTokens: 8192,
    // Was $1/$5, which is Haiku 4.5's price rather than Haiku 3.5's.
    // Anthropic's pricing row reads $0.80 base input, $0.08 cache hits,
    // $4 output. Exactly the historical-cost-tracking case this file keeps
    // deprecated entries for, so the wrong number was live in cost reports.
    pricing: { inputPer1M: 0.8, outputPer1M: 4.0, cachedInputPer1M: 0.08 },
    capabilities: { streaming: true, vision: false, tools: true, json: false },
    latency: { p50: 500, p95: 1000 },
    qualityScore: 82,
  },
  {
    id: 'claude-3-opus-20240229',
    provider: 'anthropic',
    family: 'claude-3',
    aliases: ['claude-3-opus'],
    releaseDate: '2024-02-29',
    deprecated: true,
    contextWindow: 200000,
    maxOutputTokens: 4096,
    pricing: { inputPer1M: 15.0, outputPer1M: 75.0 },
    capabilities: { streaming: true, vision: true, tools: true, json: false },
    latency: { p50: 2200, p95: 4500 },
    qualityScore: 96,
  },
  {
    id: 'claude-3-sonnet-20240229',
    provider: 'anthropic',
    family: 'claude-3',
    aliases: ['claude-3-sonnet'],
    releaseDate: '2024-02-29',
    deprecated: true,
    contextWindow: 200000,
    maxOutputTokens: 4096,
    pricing: { inputPer1M: 3.0, outputPer1M: 15.0 },
    capabilities: { streaming: true, vision: true, tools: true, json: false },
    latency: { p50: 1600, p95: 3200 },
    qualityScore: 92,
  },
  {
    id: 'claude-3-haiku-20240307',
    provider: 'anthropic',
    family: 'claude-3',
    aliases: ['claude-3-haiku'],
    releaseDate: '2024-03-07',
    deprecated: true,
    contextWindow: 200000,
    maxOutputTokens: 4096,
    pricing: { inputPer1M: 0.25, outputPer1M: 1.25 },
    capabilities: { streaming: true, vision: true, tools: true, json: false },
    latency: { p50: 400, p95: 800 },
    qualityScore: 78,
  },

  // ==========================================================================
  // Google Gemini
  // ==========================================================================
  // INTRODUCTORY PRICING, expires 2026-12-31: gemini-3.8-flash, 3.7-flash and
  // 3.6-flash are all at exactly half rate through 2026-12-31 and double to
  // $1.50 / $7.50 / $0.15 on 2027-01-01. The schema has no validity window,
  // so this needs a diary entry, not just a comment. Recheck 2026-12-28.
  // Context windows below are written as 1048576 for Google's "up to 1M" -
  // a unit interpretation of a sourced string, matching this section's
  // existing entries, not a figure Google states as an integer.
  {
    id: 'gemini-3.8-flash',
    provider: 'gemini',
    family: 'gemini-3',
    releaseDate: '2026-09-02',
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    pricing: { inputPer1M: 0.75, outputPer1M: 3.75, cachedInputPer1M: 0.075 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
  },
  {
    id: 'gemini-3.7-flash',
    provider: 'gemini',
    family: 'gemini-3',
    releaseDate: '2026-08-13',
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    pricing: { inputPer1M: 0.75, outputPer1M: 3.75, cachedInputPer1M: 0.075 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
  },
  {
    id: 'gemini-3.6-flash',
    provider: 'gemini',
    family: 'gemini-3',
    releaseDate: '2026-07-21',
    // Was $1.20/$7.50/$0.12, which the entry's own comment admitted were
    // unconfirmed estimates. They were wrong. Now read off Google's pricing
    // page. Same 2026-12-31 introductory expiry as 3.7/3.8 above.
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    pricing: { inputPer1M: 0.75, outputPer1M: 3.75, cachedInputPer1M: 0.075 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 850, p95: 1900 },
    qualityScore: 94,
  },
  {
    id: 'gemini-3.5-flash-lite',
    provider: 'gemini',
    family: 'gemini-3',
    releaseDate: '2026-07-21',
    // Output corrected $1.50 -> $2.50 (the file was 40% low); input $0.30
    // confirmed. UNRESOLVED, left absent on purpose: two reads of Google's
    // pricing page in the same session disagreed about whether this model
    // has a cache-read rate - one reported context caching "Not available",
    // the other reported $0.03/1M. Absent matches the previous state and
    // cannot over- or under-bill a rate that may not exist; do not add
    // cachedInputPer1M here without re-reading the page.
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    pricing: { inputPer1M: 0.3, outputPer1M: 2.5 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 450, p95: 1000 },
    qualityScore: 82,
  },
  {
    id: 'gemini-3.5-flash',
    provider: 'gemini',
    family: 'gemini-3',
    // Was 2026-06-17, which is gemini-2.5-pro/2.5-flash's 2025-06-17 with the
    // year changed. Google's changelog and deprecations table both date the
    // GA release 2026-05-19.
    releaseDate: '2026-05-19',
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    pricing: { inputPer1M: 1.5, outputPer1M: 9.0, cachedInputPer1M: 0.15 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 900, p95: 2000 },
    qualityScore: 94,
  },
  {
    id: 'gemini-3.1-flash-lite',
    provider: 'gemini',
    family: 'gemini-3',
    // Not a new release - GA'd 2026-05-07, so it was already missing at the
    // 2026-07-23 refresh. DATE DISAGREEMENT, resolved in the open: the
    // DeepMind model card says 2026-03-03, which the deprecations page shows
    // is the gemini-3.1-flash-lite-PREVIEW date (that preview shut down
    // 2026-05-25). The changelog's GA date is used here.
    releaseDate: '2026-05-07',
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    // $0.25 is the text/image/video input rate; audio input is $0.50 and is
    // not representable in this schema.
    pricing: { inputPer1M: 0.25, outputPer1M: 1.5, cachedInputPer1M: 0.025 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
  },
  {
    id: 'gemini-3.1-pro-preview',
    provider: 'gemini',
    family: 'gemini-3',
    aliases: ['gemini-3.1-pro'],
    releaseDate: '2026-03-01',
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    // Base tier; input doubles and output rises ~50% above 200K tokens
    pricing: { inputPer1M: 2.0, outputPer1M: 12.0 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 1500, p95: 3300 },
    qualityScore: 97,
  },
  {
    id: 'gemini-3-pro',
    provider: 'gemini',
    family: 'gemini-3',
    releaseDate: '2025-11-18',
    // Deprecated with an ID CAVEAT rather than a silent flag. This id appears
    // on neither Google's current pricing page nor its models index. The
    // deprecations table lists `gemini-3-pro-preview`, released 2025-11-18 -
    // exactly this entry's releaseDate - as deprecated with shutdown
    // 2026-03-09, replaced by gemini-3.1-pro-preview. No evidence was found
    // that a GA `gemini-3-pro` ever existed. An alias to
    // `gemini-3-pro-preview` is deliberately NOT added: the deprecation flag
    // is low-risk, but an alias would assert an identity nobody confirmed.
    // Pricing left untouched for historical cost tracking.
    deprecated: true,
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    pricing: { inputPer1M: 2.0, outputPer1M: 12.0 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 1600, p95: 3500 },
    qualityScore: 98,
  },
  {
    id: 'gemini-2.5-pro',
    provider: 'gemini',
    family: 'gemini-2.5',
    releaseDate: '2025-06-17',
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    pricing: { inputPer1M: 1.25, outputPer1M: 10.0 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 1500, p95: 3200 },
    qualityScore: 96,
  },
  {
    id: 'gemini-2.5-flash',
    provider: 'gemini',
    family: 'gemini-2.5',
    releaseDate: '2025-06-17',
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    pricing: { inputPer1M: 0.3, outputPer1M: 2.5 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 700, p95: 1500 },
    qualityScore: 89,
  },
  {
    id: 'gemini-2.5-flash-lite',
    provider: 'gemini',
    family: 'gemini-2.5',
    releaseDate: '2025-07-22',
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    pricing: { inputPer1M: 0.1, outputPer1M: 0.4 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 400, p95: 900 },
    qualityScore: 80,
  },
  {
    id: 'gemini-2.0-flash',
    provider: 'gemini',
    family: 'gemini-2.0',
    releaseDate: '2025-01-30',
    deprecated: true,
    contextWindow: 1048576,
    maxOutputTokens: 8192,
    pricing: { inputPer1M: 0.1, outputPer1M: 0.4 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 500, p95: 1100 },
    qualityScore: 84,
  },
  {
    id: 'gemini-1.5-pro',
    provider: 'gemini',
    family: 'gemini-1.5',
    releaseDate: '2024-02-15',
    deprecated: true,
    contextWindow: 1000000,
    maxOutputTokens: 8192,
    pricing: { inputPer1M: 1.25, outputPer1M: 5.0 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 1400, p95: 2800 },
    qualityScore: 93,
  },
  {
    id: 'gemini-1.5-flash',
    provider: 'gemini',
    family: 'gemini-1.5',
    releaseDate: '2024-05-14',
    deprecated: true,
    contextWindow: 1000000,
    maxOutputTokens: 8192,
    pricing: { inputPer1M: 0.075, outputPer1M: 0.3 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 600, p95: 1200 },
    qualityScore: 80,
  },
  {
    id: 'gemini-1.5-flash-8b',
    provider: 'gemini',
    family: 'gemini-1.5',
    releaseDate: '2024-10-03',
    deprecated: true,
    contextWindow: 1000000,
    maxOutputTokens: 8192,
    pricing: { inputPer1M: 0.0375, outputPer1M: 0.15 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 400, p95: 800 },
    qualityScore: 70,
  },
  {
    id: 'gemini-embedding-2',
    provider: 'gemini',
    family: 'gemini-embedding',
    kind: 'embedding',
    // ID CAUTION: Google's pricing page and changelog say `gemini-embedding-2`
    // while the models index says `gemini-embedding-2-preview`. Both are
    // carried rather than picking one silently; confirm against a live
    // GET /v1beta/models before dropping either.
    aliases: ['gemini-embedding-2-preview'],
    releaseDate: '2026-04-22',
    contextWindow: 8192,
    // $0.20 is the TEXT input rate. Image $0.45, audio $6.50 and video
    // $12.00 - a 60x spread - are not representable in this schema.
    pricing: { inputPer1M: 0.2, outputPer1M: 0 },
    embeddingDimensions: 3072,
  },
  {
    id: 'gemini-embedding-001',
    provider: 'gemini',
    family: 'gemini-embedding',
    kind: 'embedding',
    releaseDate: '2025-07-01',
    contextWindow: 2048,
    pricing: { inputPer1M: 0.15, outputPer1M: 0 },
    embeddingDimensions: 3072,
  },

  // ==========================================================================
  // Mistral AI
  // ==========================================================================
  // Every non-embedding Mistral entry below the new block was not merely
  // stale but RETIRED - two of them (mistral-small-2501, codestral-2501)
  // since 2025-11-30, i.e. missed by the previous two refreshes. The
  // `-latest` aliases have been migrated off them onto the current models:
  // before this change, `mistral-small-latest` resolved to a retired model's
  // 32000-token window and $0.10/$0.30 prices.
  //
  // contextWindow 262144 is a UNIT INTERPRETATION: Mistral publishes
  // contextLength as the string "256k" and never an exact token count.
  // 262144 (256*1024) matches this file's existing treatment of Mistral
  // "256k" at codestral-2501. Note the file is already internally
  // inconsistent here - mistral-large-2411 uses 128000 for Mistral's "128k".
  // 256000 would be equally defensible; undocumented would not.
  //
  // maxOutputTokens is omitted throughout this block: Mistral publishes no
  // max-output figure for any of these models, and a neighbour's number is
  // not a source.
  {
    id: 'mistral-medium-3-5',
    provider: 'mistral',
    family: 'mistral',
    // Use `mistral-medium-3-5` exactly - it does NOT follow the dated -YYMM
    // convention of its siblings, which is what makes it easy to "correct"
    // into mistral-medium-2604. The verbatim apiNames array in Mistral's own
    // docs repo is the tiebreak.
    aliases: ['mistral-medium-3', 'mistral-medium-latest'],
    releaseDate: '2026-04-28',
    contextWindow: 262144,
    pricing: { inputPer1M: 1.5, outputPer1M: 7.5 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
  },
  {
    id: 'mistral-small-2603',
    provider: 'mistral',
    family: 'mistral',
    aliases: ['mistral-small-latest'],
    releaseDate: '2026-03-16',
    contextWindow: 262144,
    pricing: { inputPer1M: 0.15, outputPer1M: 0.6 },
    // vision:false is deliberate - Mistral Small 4's Modalities row reads
    // "Text" only and it is absent from Mistral's vision-capable list.
    capabilities: { streaming: true, vision: false, tools: true, json: true },
  },
  {
    id: 'mistral-large-2512',
    provider: 'mistral',
    family: 'mistral',
    aliases: ['mistral-large-latest'],
    releaseDate: '2025-12-02',
    contextWindow: 262144,
    pricing: { inputPer1M: 0.5, outputPer1M: 1.5 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
  },
  {
    // Short ids on purpose: the doc-page slug (ministral-3-14b-25-12)
    // deliberately differs from the API id.
    id: 'ministral-14b-2512',
    provider: 'mistral',
    family: 'ministral-3',
    releaseDate: '2025-12-02',
    contextWindow: 262144,
    pricing: { inputPer1M: 0.2, outputPer1M: 0.2 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
  },
  {
    id: 'ministral-8b-2512',
    provider: 'mistral',
    family: 'ministral-3',
    releaseDate: '2025-12-02',
    contextWindow: 262144,
    pricing: { inputPer1M: 0.15, outputPer1M: 0.15 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
  },
  {
    id: 'ministral-3b-2512',
    provider: 'mistral',
    family: 'ministral-3',
    releaseDate: '2025-12-02',
    contextWindow: 262144,
    pricing: { inputPer1M: 0.1, outputPer1M: 0.1 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
  },
  {
    id: 'codestral-2508',
    provider: 'mistral',
    family: 'codestral',
    // INFERRED, unlike the three -latest mappings above: no apiNames array
    // was obtained for Codestral. The inference is Mistral's convention plus
    // the fact that Codestral 25.08 is the current Codestral. Moved anyway -
    // dropping the alias would leave `codestral-latest` resolving to nothing
    // at all, which is worse than a flagged inference.
    aliases: ['codestral-latest'],
    releaseDate: '2025-07-30',
    contextWindow: 128000,
    pricing: { inputPer1M: 0.3, outputPer1M: 0.9 },
    capabilities: { streaming: true, vision: false, tools: true, json: true },
  },
  {
    id: 'mistral-large-2411',
    provider: 'mistral',
    family: 'mistral',
    // Mistral Large 2.1 v24.11: deprecated 2026-02-27, retired 2026-05-31.
    // Alternative per Mistral: Mistral Medium 3.5. `mistral-large-latest`
    // moved to mistral-large-2512. Pricing kept for historical cost tracking.
    deprecated: true,
    releaseDate: '2024-11-18',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    pricing: { inputPer1M: 2.0, outputPer1M: 6.0 },
    capabilities: { streaming: true, vision: false, tools: true, json: true },
    latency: { p50: 1300, p95: 2600 },
    qualityScore: 90,
  },
  {
    id: 'mistral-medium-2505',
    provider: 'mistral',
    family: 'mistral',
    // Mistral Medium 3 v25.05: deprecated 2026-05-22, retired 2026-08-31.
    // `mistral-medium-latest` moved to mistral-medium-3-5.
    deprecated: true,
    releaseDate: '2025-05-07',
    contextWindow: 128000,
    maxOutputTokens: 8192,
    pricing: { inputPer1M: 0.4, outputPer1M: 2.0 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 1100, p95: 2200 },
    qualityScore: 88,
  },
  {
    id: 'mistral-small-2501',
    provider: 'mistral',
    family: 'mistral',
    // Mistral Small 3.0 v25.01: deprecated 2025-11-06, retired 2025-11-30 -
    // before the previous two refreshes ran. `mistral-small-latest` moved to
    // mistral-small-2603.
    deprecated: true,
    releaseDate: '2025-01-13',
    contextWindow: 32000,
    maxOutputTokens: 4096,
    pricing: { inputPer1M: 0.1, outputPer1M: 0.3 },
    capabilities: { streaming: true, vision: false, tools: true, json: true },
    latency: { p50: 700, p95: 1400 },
    qualityScore: 80,
  },
  {
    id: 'codestral-2501',
    provider: 'mistral',
    family: 'codestral',
    // Codestral v25.01: deprecated 2025-11-06, retired 2025-11-30 - before
    // the previous two refreshes ran. `codestral-latest` moved to
    // codestral-2508.
    deprecated: true,
    releaseDate: '2025-01-13',
    contextWindow: 262144,
    maxOutputTokens: 8192,
    pricing: { inputPer1M: 0.3, outputPer1M: 0.9 },
    capabilities: { streaming: true, vision: false, tools: true, json: true },
    latency: { p50: 700, p95: 1400 },
    qualityScore: 86,
  },
  {
    id: 'mistral-embed',
    provider: 'mistral',
    family: 'mistral-embed',
    kind: 'embedding',
    releaseDate: '2023-12-11',
    contextWindow: 8192,
    pricing: { inputPer1M: 0.1, outputPer1M: 0 },
    embeddingDimensions: 1024,
  },

  // ==========================================================================
  // DeepSeek
  // ==========================================================================
  // Prices below are DeepSeek's PEAK rates; off-peak is exactly half in every
  // case. The schema has no time dimension, so the peak rate is used so that
  // cost tracking cannot under-report. contextWindow 1000000 is a unit
  // interpretation of DeepSeek's "1M" string, matching the sibling entries.
  {
    id: 'deepseek-v4-flash-vision-exp',
    provider: 'deepseek',
    family: 'deepseek-v4',
    releaseDate: '2026-08-21',
    contextWindow: 1000000,
    maxOutputTokens: 384000,
    // Peak; off-peak is 0.22 / 0.66 / 0.007. Images bill up to 384 tokens
    // each at V4-Flash pricing. The id is explicitly experimental.
    pricing: { inputPer1M: 0.44, outputPer1M: 1.32, cachedInputPer1M: 0.014 },
    // Vision (OpenAI-style image_url). As of the 2026-08 vision guide this is
    // the ONLY DeepSeek model that accepts images; the others return 400.
    capabilities: { streaming: true, vision: true, tools: true, json: true },
  },
  {
    id: 'deepseek-v4-flash',
    provider: 'deepseek',
    family: 'deepseek-v4',
    releaseDate: '2026-04-24',
    contextWindow: 1000000,
    maxOutputTokens: 384000,
    // Repriced by DeepSeek at 16:00 UTC on 2026-08-16 (was 0.14 / 0.28 /
    // 0.003, correct when recorded). Peak; off-peak is 0.22 / 0.66 / 0.007.
    pricing: { inputPer1M: 0.44, outputPer1M: 1.32, cachedInputPer1M: 0.014 },
    // vision:false as of DeepSeek's 2026-08 vision guide, which states only
    // vision models (deepseek-v4-flash-vision-exp) accept images and others
    // return a 400. The file's previous `true` was SOURCED in July - the
    // provider changed the rule. Capability-based routing was picking a
    // model that HTTP 400s on an image request.
    capabilities: { streaming: true, vision: false, tools: true, json: true },
    latency: { p50: 700, p95: 1500 },
    qualityScore: 90,
  },
  {
    id: 'deepseek-v4-pro',
    provider: 'deepseek',
    family: 'deepseek-v4',
    releaseDate: '2026-04-24',
    contextWindow: 1000000,
    maxOutputTokens: 384000,
    // Repriced 2026-08-16 (was 0.435 / 0.87 / 0.004). Peak; off-peak is
    // 0.66 / 1.98 / 0.022.
    pricing: { inputPer1M: 1.32, outputPer1M: 3.96, cachedInputPer1M: 0.044 },
    // vision:false - see deepseek-v4-flash above.
    capabilities: { streaming: true, vision: false, tools: true, json: true },
    latency: { p50: 1600, p95: 3800 },
    qualityScore: 95,
  },
  {
    id: 'deepseek-chat',
    provider: 'deepseek',
    family: 'deepseek',
    releaseDate: '2024-12-26',
    // Retired by DeepSeek on 2026-07-24; kept for historical cost tracking
    deprecated: true,
    contextWindow: 64000,
    maxOutputTokens: 8192,
    pricing: { inputPer1M: 0.27, outputPer1M: 1.1, cachedInputPer1M: 0.07 },
    capabilities: { streaming: true, vision: false, tools: true, json: true },
    latency: { p50: 900, p95: 1800 },
    qualityScore: 88,
  },
  {
    id: 'deepseek-reasoner',
    provider: 'deepseek',
    family: 'deepseek',
    releaseDate: '2025-01-20',
    // Retired by DeepSeek on 2026-07-24; kept for historical cost tracking
    deprecated: true,
    contextWindow: 64000,
    maxOutputTokens: 65536,
    pricing: { inputPer1M: 0.55, outputPer1M: 2.19, cachedInputPer1M: 0.14 },
    capabilities: { streaming: true, vision: false, tools: false, json: true },
    latency: { p50: 4000, p95: 12000 },
    qualityScore: 93,
  },
  {
    id: 'deepseek-coder',
    provider: 'deepseek',
    family: 'deepseek',
    releaseDate: '2024-01-01',
    deprecated: true,
    contextWindow: 64000,
    maxOutputTokens: 4096,
    pricing: { inputPer1M: 0.14, outputPer1M: 0.28 },
    capabilities: { streaming: true, vision: false, tools: true, json: true },
    latency: { p50: 900, p95: 1800 },
    qualityScore: 88,
  },

  // ==========================================================================
  // LiteRT-LM (on-device, browser/WebGPU — $0)
  // ==========================================================================
  {
    id: 'gemma-4-E2B-it-litert-lm',
    provider: 'litert-lm',
    family: 'gemma-4',
    aliases: ['gemma-4-E2B-it-web'],
    releaseDate: '2026-05-01',
    contextWindow: 8192,
    maxOutputTokens: 8192,
    pricing: { inputPer1M: 0, outputPer1M: 0 },
    capabilities: { streaming: true, vision: false, tools: false, json: false },
    latency: { p50: 400, p95: 1500 },
    qualityScore: 62,
  },
  {
    id: 'gemma-4-E4B-it-litert-lm',
    provider: 'litert-lm',
    family: 'gemma-4',
    aliases: ['gemma-4-E4B-it-web'],
    releaseDate: '2026-05-01',
    contextWindow: 8192,
    maxOutputTokens: 8192,
    pricing: { inputPer1M: 0, outputPer1M: 0 },
    capabilities: { streaming: true, vision: false, tools: false, json: false },
    latency: { p50: 700, p95: 2500 },
    qualityScore: 70,
  },

  // ==========================================================================
  // xAI
  // ==========================================================================
  // WHOLE-REQUEST TIER PRICING, not representable here: on grok-4.6, 4.5, 4.3,
  // the grok-4.20 variants and grok-build-0.1, xAI doubles the rate at 200k
  // and states that a request whose prompt REACHES 200k is billed at the
  // higher rate for ALL tokens in the request. A 201k-token call therefore
  // costs exactly 2x what this flat schema predicts - it always under-bills,
  // never over-bills. maxOutputTokens is omitted on grok-4.6 because xAI
  // publishes no max-output figure; the 32768 on the older entries is itself
  // unsourced and is deliberately not propagated forward.
  {
    id: 'grok-4.6',
    provider: 'xai',
    family: 'grok',
    releaseDate: '2026-08-12',
    contextWindow: 500000,
    // <200k-prompt tier. At >=200k: 4.0 / 12.0 / 1.0 for the whole request.
    pricing: { inputPer1M: 2.0, outputPer1M: 6.0, cachedInputPer1M: 0.5 },
    // vision from the documented "text, image -> text" modality; tools/json
    // from the page's explicit function-calling and structured-output rows.
    capabilities: { streaming: true, vision: true, tools: true, json: true },
  },
  {
    id: 'grok-4.5',
    provider: 'xai',
    family: 'grok',
    releaseDate: '2026-07-08',
    // 1.5T-param "V9" foundation. CORRECTED: the previous contextWindow and
    // pricing were, as the old comment admitted, copied from grok-4.3 as
    // placeholders. The file over-stated the context window by 2x and
    // under-billed output by 2.4x. <200k-prompt tier; at >=200k the whole
    // request bills at 4.0 / 12.0 / 0.6.
    contextWindow: 500000,
    maxOutputTokens: 32768,
    pricing: { inputPer1M: 2.0, outputPer1M: 6.0, cachedInputPer1M: 0.3 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 1300, p95: 3000 },
    qualityScore: 97,
  },
  {
    id: 'grok-4.3',
    provider: 'xai',
    family: 'grok',
    releaseDate: '2026-06-15',
    contextWindow: 1000000,
    maxOutputTokens: 32768,
    // Base prices re-confirmed unchanged; only the cache rate is new.
    pricing: { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 1400, p95: 3200 },
    qualityScore: 96,
  },
  {
    id: 'grok-4.20-0309-reasoning',
    provider: 'xai',
    family: 'grok',
    aliases: ['grok-4.20', 'grok-4.20-0309-non-reasoning', 'grok-4.20-multi-agent-0309'],
    releaseDate: '2026-03-09',
    contextWindow: 1000000,
    maxOutputTokens: 32768,
    // All three declared aliases still present in xAI's current table at
    // identical prices; only the cache rate is new.
    pricing: { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 1800, p95: 4200 },
    qualityScore: 94,
  },
  {
    id: 'grok-build-0.1',
    provider: 'xai',
    family: 'grok-build',
    releaseDate: '2026-06-01',
    contextWindow: 256000,
    maxOutputTokens: 32768,
    // Base prices re-confirmed unchanged; only the cache rate is new.
    pricing: { inputPer1M: 1.0, outputPer1M: 2.0, cachedInputPer1M: 0.2 },
    capabilities: { streaming: true, vision: false, tools: true, json: true },
    latency: { p50: 600, p95: 1400 },
    qualityScore: 90,
  },
  {
    id: 'grok-4',
    provider: 'xai',
    family: 'grok',
    releaseDate: '2025-07-09',
    // WEAKEST deprecation in this file - the inference is stated, not hidden.
    // Evidence: absent from xAI's current models/pricing table, and both
    // /docs/models/grok-4 and /developers/models/grok-4 404 while the same
    // URL patterns resolve for 4.6/4.5/4.3. The 2026-05-15 retirement list
    // names `grok-4-0709` (-> grok-4.3 at low reasoning effort) but never a
    // bare `grok-4`; this entry's releaseDate 2025-07-09 is exactly the 0709
    // snapshot. So "grok-4 == grok-4-0709" is an inference from a fetched
    // page, not something xAI states. The flag changes no number and only
    // steers routing away; hold it if you want zero inference in this file.
    deprecated: true,
    contextWindow: 256000,
    maxOutputTokens: 32768,
    pricing: { inputPer1M: 3.0, outputPer1M: 15.0, cachedInputPer1M: 0.75 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 2000, p95: 5000 },
    qualityScore: 95,
  },
  {
    id: 'grok-3',
    provider: 'xai',
    family: 'grok',
    releaseDate: '2025-02-19',
    // Named verbatim in xAI's 2026-05-15 retirement list, replacement
    // "grok-4.3 with none reasoning effort". Retired ~10 weeks before the
    // previous refresh - another pre-existing miss. Pricing kept.
    deprecated: true,
    contextWindow: 131072,
    maxOutputTokens: 16384,
    pricing: { inputPer1M: 3.0, outputPer1M: 15.0 },
    capabilities: { streaming: true, vision: false, tools: true, json: true },
    latency: { p50: 1800, p95: 4200 },
    qualityScore: 92,
  },
  {
    id: 'grok-3-mini',
    provider: 'xai',
    family: 'grok',
    // Deliberately NOT deprecated: grok-3-mini is specifically absent from
    // the 2026-05-15 retirement list that names grok-3, and absence from a
    // docs table is not a retirement announcement. Needs a live GET
    // /v1/models to settle. Entry left entirely unverified this pass.
    releaseDate: '2025-02-19',
    contextWindow: 131072,
    maxOutputTokens: 16384,
    pricing: { inputPer1M: 0.3, outputPer1M: 0.5 },
    capabilities: { streaming: true, vision: false, tools: true, json: true },
    latency: { p50: 900, p95: 2000 },
    qualityScore: 84,
  },

  // ==========================================================================
  // Moonshot AI
  // ==========================================================================
  {
    id: 'kimi-k3',
    provider: 'moonshot',
    family: 'moonshot',
    aliases: ['moonshotai/kimi-k3'],
    releaseDate: '2026-07-16',
    // 2.8T-param open-weight flagship, native multimodal input, always-on
    // thinking mode. Pricing and context window now confirmed against
    // Moonshot's own first-party page, replacing the previous
    // OpenRouter-catalog citation; every number below was already correct.
    // maxOutputTokens 65536 remains unverified - not published.
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    pricing: { inputPer1M: 3.0, outputPer1M: 15.0, cachedInputPer1M: 0.3 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
    latency: { p50: 1600, p95: 3600 },
    qualityScore: 93,
  },
  // The three entries below ship WITHOUT releaseDate: Moonshot's docs carry
  // no release dates for active models, and the only dates available came
  // from third-party write-ups and an X post that was never fetched. Ordering
  // here therefore falls back to version-descending. maxOutputTokens is
  // likewise omitted - not published. Note the docs domain has moved:
  // platform.moonshot.ai/docs/* now 301-redirects to platform.kimi.ai/docs/*.
  {
    id: 'kimi-k2.7-code',
    provider: 'moonshot',
    family: 'moonshot',
    aliases: ['moonshotai/kimi-k2.7-code'],
    contextWindow: 262144,
    pricing: { inputPer1M: 0.95, outputPer1M: 4.0, cachedInputPer1M: 0.19 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
  },
  {
    id: 'kimi-k2.7-code-highspeed',
    provider: 'moonshot',
    family: 'moonshot',
    contextWindow: 262144,
    pricing: { inputPer1M: 1.9, outputPer1M: 8.0, cachedInputPer1M: 0.38 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
  },
  {
    id: 'kimi-k2.6',
    provider: 'moonshot',
    family: 'moonshot',
    aliases: ['moonshotai/kimi-k2.6'],
    contextWindow: 262144,
    pricing: { inputPer1M: 0.95, outputPer1M: 4.0, cachedInputPer1M: 0.16 },
    capabilities: { streaming: true, vision: true, tools: true, json: true },
  },

  // ==========================================================================
  // Decision models (kind: 'decision')
  // ==========================================================================
  // "System One" typed-decision models: output is free, so only the input
  // rate is priced. Unlike the sections above, these were NOT verified
  // against first-party pricing pages: the figures come from the provider
  // announcements surveyed in docs/plans/decision-models.md (2026-10), so
  // re-check them before relying on them for billing. `contextWindow` is set only where a
  // provider states it (Clef); `latency`/`qualityScore` are omitted for the
  // reason in the header.
  {
    id: 'jev-1.13.0',
    provider: 'typesafe',
    family: 'jev',
    kind: 'decision',
    aliases: ['jev-latest', '~typesafe/jev-latest', 'typesafe/jev-1.13'],
    contextWindow: 64_000,
    pricing: { inputPer1M: 0.042, outputPer1M: 0 },
  },
  {
    id: 'clef',
    provider: 'cloudflare',
    family: 'clef',
    kind: 'decision',
    contextWindow: 65_536,
    pricing: { inputPer1M: 0.24, outputPer1M: 0 },
  },
  {
    id: 'clef-flash',
    provider: 'cloudflare',
    family: 'clef',
    kind: 'decision',
    contextWindow: 65_536,
    pricing: { inputPer1M: 0.09, outputPer1M: 0 },
  },
  {
    id: 'pplx-decider-v1-27b',
    provider: 'perplexity',
    family: 'pplx-decider',
    kind: 'decision',
    pricing: { inputPer1M: 0.04, outputPer1M: 0 },
  },
  {
    id: 'nimble',
    provider: 'ollama',
    family: 'nimble',
    kind: 'decision',
    // Local inference: no per-token cost.
    pricing: { inputPer1M: 0, outputPer1M: 0 },
  },
  {
    id: 'tev1',
    provider: 'together',
    family: 'tev1',
    kind: 'decision',
    pricing: { inputPer1M: 0.042, outputPer1M: 0 },
  },
  {
    id: 'kev-4b',
    provider: 'openrouter',
    family: 'kev',
    kind: 'decision',
    pricing: { inputPer1M: 0.042, outputPer1M: 0 },
  },
  {
    id: 'gpt-6-luna',
    provider: 'openai',
    family: 'gpt-6',
    kind: 'decision',
    // No pricing: OpenAI has published none for the Decisions API (preview,
    // verified live 2026-10-06). Cost estimates return null until it does.
  },
  {
    id: 'mercury-decide',
    provider: 'inception',
    family: 'mercury',
    kind: 'decision',
    // Free on OpenRouter at launch.
    pricing: { inputPer1M: 0, outputPer1M: 0 },
  },
];
