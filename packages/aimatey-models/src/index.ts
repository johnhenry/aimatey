/**
 * @johnhenry/aimatey-models: a data-only model catalog plus small helpers.
 *
 * The catalog (`CATALOG`, also shipped as `catalog.json`) holds per provider
 * and model: lifecycle status with dates and successor, recommended defaults,
 * capabilities, context limits and pricing with `pricingAsOf`. It is
 * regenerated weekly by a GitHub Action; see readme.md.
 *
 * @module
 */
import { CATALOG } from './catalog-data.js';
import type {
  CatalogModel,
  CatalogProvider,
  LiveModelsResult,
  MergedModel,
  MergeOptions,
  ModelCatalog,
  ProviderLimits,
  RecommendedRole,
} from './types.js';

export { CATALOG };
export type * from './types.js';

const stripPrefix = (id: string): string => id.replace(/^models\//, '');

export function getCatalog(): ModelCatalog {
  return CATALOG;
}

export function getProvider(providerId: string): CatalogProvider | undefined {
  return CATALOG.providers[providerId];
}

export function getModel(providerId: string, modelId: string): CatalogModel | undefined {
  return CATALOG.providers[providerId]?.models[stripPrefix(modelId)];
}

/** First catalog entry with this id, searching every provider (or just `providerId`). */
export function findModel(modelId: string, providerId?: string): CatalogModel | undefined {
  const id = stripPrefix(modelId);
  if (providerId) {
    return getModel(providerId, id);
  }
  for (const p of Object.values(CATALOG.providers)) {
    if (p.models[id]) {
      return p.models[id];
    }
  }
  return undefined;
}

/** The provider's recommended model for a role (default, fast, best). */
export function recommendedModel(
  providerId: string,
  role: RecommendedRole = 'default'
): CatalogModel | undefined {
  const p = getProvider(providerId);
  const id = p?.recommended[role];
  return id ? p?.models[id] : undefined;
}

/**
 * The model to move to when `modelId` is retired or deprecated. Follows the
 * successor chain until it reaches a `current` model (or the last reachable
 * one). Undefined when the model is unknown or has no successor.
 */
export function successorOf(modelId: string, providerId?: string): string | undefined {
  const start = findModel(modelId, providerId);
  if (!start?.successor) {
    return undefined;
  }
  const providerOf =
    providerId ??
    Object.keys(CATALOG.providers).find((p) => CATALOG.providers[p]?.models[start.id]);
  if (!providerOf) {
    return undefined;
  }
  let id = start.successor;
  const seen = new Set<string>([start.id]);
  for (;;) {
    const m = getModel(providerOf, id);
    if (!m || seen.has(id)) {
      return id;
    }
    seen.add(id);
    if (m.status === 'current' || !m.successor) {
      return id;
    }
    id = m.successor;
  }
}

/** True for deprecated or retired models. Unknown ids are not deprecated. */
export function isDeprecated(modelId: string, providerId?: string): boolean {
  const s = findModel(modelId, providerId)?.status;
  return s === 'deprecated' || s === 'retired';
}

/** Request limits for a model: model-level metadata first, then the provider's. */
export function limitsFor(providerId: string, modelId?: string): ProviderLimits {
  const p = getProvider(providerId);
  const m = modelId ? p?.models[stripPrefix(modelId)] : undefined;
  const out: { maxTools?: number; contextTokens?: number; unsupportedTools?: boolean } = {
    ...p?.limits,
  };
  if (m?.capabilities?.maxTools !== undefined) {
    out.maxTools = m.capabilities.maxTools;
  }
  if (m?.contextWindow !== undefined) {
    out.contextTokens = m.contextWindow;
  }
  return out;
}

const RANK: Record<string, number> = { current: 0, none: 1, legacy: 2, deprecated: 3, retired: 4 };

/**
 * Merge an adapter's live `listModels()` result with catalog entries. Live is
 * authoritative for availability; the catalog supplies metadata. Models the
 * catalog has never seen are kept (`inCatalog:false`) so a new release shows
 * up before the catalog does. Order: recommended default first, then current,
 * uncatalogued, legacy, deprecated, retired; alphabetical within a group.
 */
export function mergeLiveModels(
  catalogEntries: readonly CatalogModel[],
  live: LiveModelsResult,
  options: MergeOptions = {}
): MergedModel[] {
  const byId = new Map(catalogEntries.map((e) => [e.id, e]));
  const roles = (id: string): RecommendedRole[] =>
    (Object.entries(options.recommended ?? {}) as [RecommendedRole, string][])
      .filter(([, v]) => v === id)
      .map(([k]) => k);
  const build = (id: string, name: string | undefined, available: boolean): MergedModel => {
    const e = byId.get(id);
    const r = roles(id);
    return {
      id,
      name: e?.name ?? name ?? id,
      available,
      inCatalog: !!e,
      ...(e && { status: e.status, family: e.family }),
      ...(r.length && { recommended: r }),
      ...(e?.successor && { successor: e.successor }),
      ...(e?.capabilities && { capabilities: e.capabilities }),
      ...(e?.contextWindow !== undefined && { contextWindow: e.contextWindow }),
      ...(e?.maxOutputTokens !== undefined && { maxOutputTokens: e.maxOutputTokens }),
      ...(e?.pricing && { pricing: e.pricing, pricingAsOf: e.pricingAsOf }),
      ...(e?.retiresOn && { retiresOn: e.retiresOn }),
    };
  };
  const seen = new Set<string>();
  const out: MergedModel[] = [];
  for (const m of live.models) {
    const id = stripPrefix(m.id);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(build(id, m.name, true));
  }
  if (options.includeUnavailable) {
    for (const e of catalogEntries) {
      if (!seen.has(e.id)) {
        out.push(build(e.id, e.name, false));
      }
    }
  }
  const group = (m: MergedModel): number => RANK[m.status ?? 'none'] ?? 1;
  const isDefault = (m: MergedModel): number => (m.recommended?.includes('default') ? 0 : 1);
  return out.sort(
    (a, b) => isDefault(a) - isDefault(b) || group(a) - group(b) || a.id.localeCompare(b.id)
  );
}
