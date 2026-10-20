/** Lifecycle state of a model. */
export type ModelStatus = 'current' | 'legacy' | 'deprecated' | 'retired';

/** Roles a provider's recommended models can fill. */
export type RecommendedRole = 'default' | 'fast' | 'best';

export interface CatalogCapabilities {
  readonly tools?: boolean;
  readonly vision?: boolean;
  readonly audio?: boolean;
  readonly json?: boolean;
  readonly streaming?: boolean;
  /** Most tool definitions one request may carry. */
  readonly maxTools?: number;
}

/** Prices are USD per 1M tokens. */
export interface CatalogPricing {
  readonly inputPer1M: number;
  readonly outputPer1M: number;
  readonly cachedInputPer1M?: number;
}

export interface CatalogModel {
  readonly id: string;
  readonly name: string;
  readonly family: string;
  readonly status: ModelStatus;
  /** ISO date the provider announced deprecation. */
  readonly deprecatedOn?: string;
  /** ISO date the provider retires (or retired) the model. */
  readonly retiresOn?: string;
  /** Provider's "not sooner than" retirement commitment (ISO date). */
  readonly retiresNoSoonerThan?: string;
  /** Replacement model id in the same provider. */
  readonly successor?: string;
  readonly releaseDate?: string;
  readonly capabilities?: CatalogCapabilities;
  /** Input context window, tokens. */
  readonly contextWindow?: number;
  /** Max output tokens per response. */
  readonly maxOutputTokens?: number;
  readonly pricing?: CatalogPricing;
  /** ISO date the pricing was last verified. Present whenever pricing is. */
  readonly pricingAsOf?: string;
  /** Free-text caveat, e.g. scheduled price changes or tiers. */
  readonly pricingNote?: string;
  /** Last ISO date the current price is known to hold (scheduled change follows). */
  readonly pricingEffectiveUntil?: string;
  /** 'openrouter' when pricing was filled from OpenRouter rather than a first-party page. */
  readonly pricingSource?: string;
  readonly notes?: string;
  /** 'live' when the model was discovered from a provider list and is not yet curated. */
  readonly source?: string;
}

export interface ProviderLimits {
  readonly maxTools?: number;
  readonly contextTokens?: number;
  /** The backend has no native tool calling (tools run through the code lane). */
  readonly unsupportedTools?: boolean;
}

export interface CatalogProvider {
  readonly label: string;
  /** Runs on this machine / in the browser. */
  readonly local?: boolean;
  /** ISO date the curated data was last checked against first-party docs. Absent = not curated. */
  readonly verifiedOn?: string;
  readonly sources?: readonly string[];
  readonly notes?: string;
  readonly recommended: Partial<Record<RecommendedRole, string>>;
  readonly limits?: ProviderLimits;
  /** False when the generator must not fill pricing from OpenRouter for this provider. */
  readonly openrouterPricing?: boolean;
  readonly models: Readonly<Record<string, CatalogModel>>;
}

export interface ModelCatalog {
  readonly schemaVersion: 1;
  /** ISO date of the last generator run. */
  readonly generatedOn: string;
  readonly providers: Readonly<Record<string, CatalogProvider>>;
}

/** Structural subset of `ListModelsResult` from @johnhenry/aimatey-types (no dependency needed). */
export interface LiveModelsResult {
  readonly models: readonly { readonly id: string; readonly name?: string }[];
  readonly source?: string;
  readonly fetchedAt?: number;
  readonly isComplete?: boolean;
}

export interface MergedModel {
  readonly id: string;
  readonly name: string;
  /** In the live list (true) or only in the catalog (false, with includeUnavailable). */
  readonly available: boolean;
  readonly inCatalog: boolean;
  readonly status?: ModelStatus;
  readonly recommended?: readonly RecommendedRole[];
  readonly successor?: string;
  readonly family?: string;
  readonly capabilities?: CatalogCapabilities;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly pricing?: CatalogPricing;
  readonly pricingAsOf?: string;
  readonly retiresOn?: string;
}

export interface MergeOptions {
  /** Provider's recommended map, to tag roles. */
  readonly recommended?: Partial<Record<RecommendedRole, string>>;
  /** Also return catalog models absent from the live list, flagged available:false. */
  readonly includeUnavailable?: boolean;
}
