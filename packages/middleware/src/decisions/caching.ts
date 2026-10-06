/**
 * Decision Caching Middleware
 *
 * Caches typed-decision responses with TTL-based expiration and LRU
 * eviction. The decision counterpart of `createCachingMiddleware`, for
 * `bridge.useDecision()`.
 *
 * Shares the caller-scoping semantics, in-memory LRU store and bypass
 * warning with the chat middleware (see `../caching.ts` for why a request
 * with no caller identity is not cached); only the key derivation is
 * decision-specific, because it is keyed on a different request shape.
 *
 * @module
 */

import type {
  DecisionMiddleware,
  IRDecisionRequest,
  IRDecisionResponse,
  WarningCategory,
} from '@johnhenry/aimatey-types';
import { InMemoryCacheStorage, resolveCacheScope, withBypassWarning } from '../caching.js';
import { stableHash } from '../hash.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Cache storage for decision responses. Same shape as the chat
 * `CacheStorage`, over `IRDecisionResponse`.
 */
export interface DecisionCacheStorage {
  get(key: string): Promise<IRDecisionResponse | undefined>;
  set(key: string, value: IRDecisionResponse, ttl?: number): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;
}

/**
 * Warning categories whose presence marks a response as not safe to replay
 * from a cache: it was malformed, or it was produced by an emulation /
 * dropped part of the request, so a later call (to a fixed backend or a
 * different one) should be allowed to do better.
 */
export const DEFAULT_UNCACHEABLE_WARNINGS: readonly WarningCategory[] = [
  'response-malformed',
  'capability-emulated',
  'capability-unsupported',
];

/**
 * Configuration for decision caching middleware.
 */
export interface DecisionCachingConfig {
  /**
   * Cache key generator function.
   *
   * Supplying one takes over key derivation completely: `scopeKey`,
   * `metadata.principal` and `unidentified` are all bypassed, and the
   * generator MUST itself mix in caller identity if the cache is shared
   * across users.
   *
   * @default hash of { scope, state, questions, images, model, custom }
   */
  keyGenerator?: (request: IRDecisionRequest) => string;

  /**
   * A tenant/user/session identifier (or a function deriving one from the
   * request) mixed into the *default* cache key, taking precedence over
   * `request.metadata.principal`. Ignored when a custom `keyGenerator` is
   * supplied.
   */
  scopeKey?: string | ((request: IRDecisionRequest) => string | undefined);

  /**
   * What to do with a request that carries no caller identity -- no
   * `scopeKey`, no `metadata.principal`.
   *
   * - `'bypass'` (default): do not cache it; the response is returned with a
   *   `cache-bypassed` warning.
   * - `'share'`: cache it in one unscoped bucket (single-tenant deployments).
   *
   * A decision's `state` is usually exactly the sensitive part of a request
   * (a ticket, an email, an invoice), so the same default applies here as
   * for chat: a hit would reveal that another caller asked about this state.
   *
   * @default 'bypass'
   */
  unidentified?: 'bypass' | 'share';

  /**
   * Cache TTL in milliseconds.
   * @default 3600000 (1 hour)
   */
  ttl?: number;

  /**
   * Maximum cache size (number of entries) of the default in-memory store.
   * @default 1000
   */
  maxSize?: number;

  /**
   * Cache storage implementation.
   * @default InMemoryCacheStorage
   */
  storage?: DecisionCacheStorage;

  /**
   * Responses carrying a warning in one of these categories are returned but
   * never stored.
   * @default ['response-malformed', 'capability-emulated', 'capability-unsupported']
   */
  uncacheableWarnings?: readonly WarningCategory[];
}

// ============================================================================
// Default Key Generator
// ============================================================================

/**
 * `JSON.stringify` with object keys sorted, so `{a, b}` and `{b, a}` hash
 * alike. Used for `state` and `parameters.custom`, which are arbitrary
 * caller-built JSON; `questions` deliberately keeps its insertion order,
 * since option and question order can change what a decision model answers.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
      const record = nested as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((k) => [k, record[k]])
      );
    }
    return nested;
  });
}

/**
 * The default cache key for a decision request within a resolved caller
 * `scope`.
 *
 * Derived from scope, state, questions, images, model and
 * `parameters.custom`. Excludes metadata. Images are reduced to a hash of
 * their content so a large base64 payload is not re-serialized into the key
 * payload twice.
 */
function defaultDecisionCacheKey(request: IRDecisionRequest, scope: string | undefined): string {
  const cacheableData = {
    scope,
    state: stableStringify(request.state),
    questions: request.questions,
    images: request.images?.map((image) => stableHash(JSON.stringify(image))),
    model: request.parameters?.model,
    custom: stableStringify(request.parameters?.custom),
  };

  // Cache index only -- see `../hash.ts` for why this is not Node crypto.
  return stableHash(JSON.stringify(cacheableData));
}

// ============================================================================
// Middleware Factory
// ============================================================================

/**
 * Create decision caching middleware.
 *
 * Entries are scoped to a caller: a request with no `scopeKey` and no
 * `metadata.principal` is not cached at all unless the deployment declares
 * itself single-tenant with `unidentified: 'share'`. A hit is returned with
 * a fresh `metadata.requestId` / `timestamp` and
 * `metadata.custom.cacheHit = true`, like the chat middleware.
 *
 * @param config Caching configuration
 * @returns Decision middleware
 *
 * @example
 * ```typescript
 * bridge.useDecision(createDecisionCachingMiddleware({ ttl: 600_000 }));
 *
 * await bridge.decide(ticket, questions, { principal: `tenant-${tenantId}` });
 * ```
 */
export function createDecisionCachingMiddleware(
  config: DecisionCachingConfig = {}
): DecisionMiddleware {
  const {
    keyGenerator,
    ttl = 3600000, // 1 hour
    maxSize = 1000,
    storage = new InMemoryCacheStorage<IRDecisionResponse>(maxSize),
    unidentified = 'bypass',
    uncacheableWarnings = DEFAULT_UNCACHEABLE_WARNINGS,
  } = config;

  return async (request, next) => {
    let cacheKey: string;
    if (keyGenerator) {
      cacheKey = keyGenerator(request);
    } else {
      const scope = resolveCacheScope(request, config.scopeKey);

      if (scope === undefined && unidentified === 'bypass') {
        return withBypassWarning(await next(request));
      }

      cacheKey = defaultDecisionCacheKey(request, scope);
    }

    const cached = await storage.get(cacheKey);

    if (cached) {
      // Hit: the answer is replayed, but the response belongs to *this* call.
      return {
        ...cached,
        metadata: {
          ...cached.metadata,
          requestId: request.metadata.requestId,
          timestamp: Date.now(),
          custom: {
            ...cached.metadata.custom,
            cacheHit: true,
            cacheKey,
          },
        },
      };
    }

    const response = await next(request);

    const cacheable = !(response.metadata.warnings ?? []).some((warning) =>
      uncacheableWarnings.includes(warning.category)
    );
    if (cacheable) {
      await storage.set(cacheKey, response, ttl);
    }

    return {
      ...response,
      metadata: {
        ...response.metadata,
        custom: {
          ...response.metadata.custom,
          cacheHit: false,
          cacheKey,
        },
      },
    };
  };
}
