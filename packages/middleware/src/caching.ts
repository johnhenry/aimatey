/**
 * Caching Middleware
 *
 * Caches responses with TTL-based expiration and LRU eviction.
 *
 * **Cache entries are scoped to a caller, and a request with no caller is
 * not cached at all.** A cache keyed only on model/messages/parameters
 * serves whoever asks first: in a deployment where one process answers for
 * several users, the second user to send a prompt receives the first user's
 * completion (#44). So the default key mixes in a *scope* taken from, in
 * order:
 *
 * 1. `scopeKey` from this middleware's config, if set;
 * 2. `request.metadata.principal` -- the IR's first-class caller identity,
 *    settable per request via `bridge.chat(request, { principal })`.
 *
 * If neither is present the request is **not cached**: the response is
 * passed straight through with a `cache-bypassed` warning on
 * `metadata.warnings`. Nothing is written, so nothing can later be read by
 * the wrong caller.
 *
 * A genuinely single-tenant deployment -- one process, one audience, where
 * sharing every entry is exactly why caching was switched on -- says so with
 * `unidentified: 'share'`, which restores unscoped sharing for requests
 * that carry no identity.
 *
 * @module
 */

import type {
  Middleware,
  MiddlewareContext,
  MiddlewareNext,
  CacheStorage,
} from '@johnhenry/aimatey-types';
import type {
  IRChatRequest,
  IRChatResponse,
  IRMetadata,
  IRWarning,
} from '@johnhenry/aimatey-types';
import { stableHash } from './hash.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for caching middleware.
 */
export interface CachingConfig {
  /**
   * Cache key generator function.
   *
   * Supplying one takes over key derivation completely: `scopeKey`,
   * `metadata.principal` and `unidentified` are all bypassed, and the
   * generator MUST itself mix in caller identity if the cache is shared
   * across users. Prefer `scopeKey` unless the key really has to change
   * shape.
   *
   * @default Default implementation based on request hash + caller scope
   */
  keyGenerator?: (request: IRChatRequest) => string;

  /**
   * A tenant/user/session identifier (or a function deriving one from the
   * request) mixed into the *default* cache key, taking precedence over
   * `request.metadata.principal`.
   *
   * Use it when identity lives somewhere the IR does not reach -- an
   * ambient async-local store, a per-tenant middleware instance. When the
   * caller already sets `metadata.principal`, leave this unset.
   *
   * Returning `undefined` or `''` from the function form means "this
   * request has no identity", and `unidentified` then decides what happens.
   * Ignored when a custom `keyGenerator` is supplied.
   */
  scopeKey?: string | ((request: IRChatRequest) => string | undefined);

  /**
   * What to do with a request that carries no caller identity -- no
   * `scopeKey`, no `metadata.principal`.
   *
   * - `'bypass'` (default): do not cache it. The request goes to the
   *   backend, the response is returned with a `cache-bypassed` warning,
   *   and nothing is stored. An unidentified request can then never be
   *   answered from another caller's entry, whatever the deployment looks
   *   like.
   * - `'share'`: cache it in one unscoped bucket shared by every
   *   unidentified caller. This is the pre-#44 behaviour and the right
   *   answer for a single-tenant deployment, where sharing every entry is
   *   the point. It is the wrong answer anywhere a cache outlives a single
   *   user's session.
   *
   * The default is `'bypass'` because the failure mode of guessing wrong is
   * asymmetric: guessing `'share'` in a multi-tenant deployment discloses
   * one user's completion to another, while guessing `'bypass'` in a
   * single-tenant one only costs cache hits until someone sets one option.
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
   * Maximum cache size (number of entries).
   * @default 1000
   */
  maxSize?: number;

  /**
   * Cache storage implementation.
   * @default InMemoryCacheStorage
   */
  storage?: CacheStorage;

  /**
   * Whether to cache streaming responses.
   * @default false
   */
  cacheStreaming?: boolean;
}

// ============================================================================
// Default Key Generator
// ============================================================================

/**
 * Resolve the caller scope a request's cache entry belongs to.
 *
 * `scopeKey` (this middleware's own config) wins over the request's
 * `metadata.principal`, so a deployment that derives identity out of band
 * can override what the request claims. `undefined` means the request
 * carries no identity at all.
 *
 * Generic over the request type so the decision caching middleware shares it.
 *
 * @internal
 */
export function resolveCacheScope<R extends { readonly metadata?: IRMetadata }>(
  request: R,
  scopeKey?: string | ((request: R) => string | undefined)
): string | undefined {
  const explicit = typeof scopeKey === 'function' ? scopeKey(request) : scopeKey;
  if (explicit !== undefined && explicit !== '') {
    return explicit;
  }

  const principal = request.metadata?.principal;
  return principal !== undefined && principal !== '' ? principal : undefined;
}

/**
 * The default cache key for a request within a resolved caller `scope`.
 *
 * Derived from the scope, model, messages and parameters. Excludes metadata
 * and the streaming flag.
 *
 * `scope` is dropped from the hashed payload when undefined, so an
 * explicitly shared (`unidentified: 'share'`) cache produces exactly the
 * keys it produced before caller scoping existed -- upgrading does not
 * invalidate an existing single-tenant cache.
 */
function defaultCacheKey(request: IRChatRequest, scope: string | undefined): string {
  // Create a stable cache key from request
  const cacheableData = {
    scope,
    model: request.parameters?.model,
    messages: request.messages,
    temperature: request.parameters?.temperature,
    maxTokens: request.parameters?.maxTokens,
    topP: request.parameters?.topP,
    topK: request.parameters?.topK,
    stopSequences: request.parameters?.stopSequences,
    tools: request.tools,
    toolChoice: request.toolChoice,
  };

  // Generate hash.
  //
  // This is a *cache index*, not a security primitive, so it uses the
  // pure-JS `stableHash` rather than Node's `crypto.createHash`: the
  // middleware is consumed from browsers/webviews/Electron renderers where
  // bundlers externalize `crypto` and `createHash` is undefined at runtime.
  const json = JSON.stringify(cacheableData);
  return stableHash(json);
}

// ============================================================================
// In-Memory Cache Storage with LRU
// ============================================================================

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * In-memory cache storage with LRU eviction.
 *
 * Generic over the cached value so `createDecisionCachingMiddleware` can use
 * it as `InMemoryCacheStorage<IRDecisionResponse>`; the default keeps the
 * chat shape.
 */
export class InMemoryCacheStorage<T = IRChatResponse> {
  private cache = new Map<string, CacheEntry<T>>();
  private accessOrder: string[] = [];
  private maxSize: number;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  get(key: string): Promise<T | undefined> {
    const entry = this.cache.get(key);

    if (!entry) {
      return Promise.resolve(undefined);
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.removeFromAccessOrder(key);
      return Promise.resolve(undefined);
    }

    // Update access order (LRU)
    this.updateAccessOrder(key);

    return Promise.resolve(entry.value);
  }

  set(key: string, value: T, ttl: number = 3600000): Promise<void> {
    // Evict if at max size
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }

    // Store entry
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttl,
    });

    // Update access order
    this.updateAccessOrder(key);

    return Promise.resolve();
  }

  has(key: string): Promise<boolean> {
    const entry = this.cache.get(key);

    if (!entry) {
      return Promise.resolve(false);
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.removeFromAccessOrder(key);
      return Promise.resolve(false);
    }

    return Promise.resolve(true);
  }

  delete(key: string): Promise<boolean> {
    this.removeFromAccessOrder(key);
    return Promise.resolve(this.cache.delete(key));
  }

  clear(): Promise<void> {
    this.cache.clear();
    this.accessOrder = [];
    return Promise.resolve();
  }

  /**
   * Get cache statistics.
   */
  getStats(): { size: number; maxSize: number; hitRate?: number } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
    };
  }

  /**
   * Update LRU access order.
   */
  private updateAccessOrder(key: string): void {
    // Remove from current position
    this.removeFromAccessOrder(key);

    // Add to end (most recently used)
    this.accessOrder.push(key);
  }

  /**
   * Remove key from access order.
   */
  private removeFromAccessOrder(key: string): void {
    const index = this.accessOrder.indexOf(key);
    if (index !== -1) {
      this.accessOrder.splice(index, 1);
    }
  }

  /**
   * Evict least recently used entry.
   */
  private evictLRU(): void {
    if (this.accessOrder.length === 0) {
      return;
    }

    // Get least recently used key (first in array)
    const lruKey = this.accessOrder[0];

    if (lruKey) {
      this.cache.delete(lruKey);
      this.accessOrder.shift();
    }
  }

  /**
   * Clean up expired entries.
   */
  cleanup(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];

    // Use Array.from to avoid iteration issues
    for (const [key, entry] of Array.from(this.cache.entries())) {
      if (now > entry.expiresAt) {
        expiredKeys.push(key);
      }
    }

    for (const key of expiredKeys) {
      this.cache.delete(key);
      this.removeFromAccessOrder(key);
    }
  }
}

// ============================================================================
// Middleware Factory
// ============================================================================

/**
 * The warning attached to a response that was not cached because the request
 * carried no caller identity.
 */
export const CACHE_BYPASSED_WARNING: IRWarning = {
  category: 'cache-bypassed',
  severity: 'warning',
  message:
    'Response was not cached: the request carries no caller identity, and caching it ' +
    'could serve it to a different caller. Set metadata.principal on the request ' +
    "(bridge.chat(request, { principal })), pass scopeKey, or set unidentified: 'share' " +
    'if this deployment serves a single tenant.',
  field: 'metadata.principal',
  source: 'caching-middleware',
};

/**
 * Pass a response through uncached, recording why.
 *
 * The bypass is deliberately noisy: a cache that silently stops working is
 * as hard to notice as one that silently leaks, so the reason travels on the
 * response rather than only in this module's documentation.
 *
 * Generic over the response type so the decision caching middleware shares
 * it.
 *
 * @internal
 */
export function withBypassWarning<T extends { readonly metadata: IRMetadata }>(response: T): T {
  return {
    ...response,
    metadata: {
      ...response.metadata,
      warnings: [...(response.metadata.warnings ?? []), CACHE_BYPASSED_WARNING],
      custom: {
        ...response.metadata.custom,
        cacheHit: false,
        cacheBypassed: true,
      },
    },
  };
}

/**
 * Create caching middleware.
 *
 * Caches responses with TTL-based expiration and LRU eviction.
 *
 * Entries are scoped to a caller: a request with no `scopeKey` and no
 * `metadata.principal` is not cached at all unless the deployment declares
 * itself single-tenant with `unidentified: 'share'`.
 *
 * @param config Caching configuration
 * @returns Caching middleware
 *
 * @example Multi-tenant: identity travels with the request
 * ```typescript
 * bridge.use(createCachingMiddleware({ ttl: 3600000 }));
 *
 * await bridge.chat(request, { principal: `tenant-${tenantId}:user-${userId}` });
 * ```
 *
 * @example Single-tenant: one audience, one shared cache
 * ```typescript
 * bridge.use(createCachingMiddleware({ ttl: 3600000, unidentified: 'share' }));
 * ```
 */
export function createCachingMiddleware(config: CachingConfig = {}): Middleware {
  const {
    keyGenerator,
    ttl = 3600000, // 1 hour
    maxSize = 1000,
    storage = new InMemoryCacheStorage(maxSize),
    cacheStreaming = false,
    unidentified = 'bypass',
  } = config;

  return async (context: MiddlewareContext, next: MiddlewareNext): Promise<IRChatResponse> => {
    // Skip caching for streaming requests unless explicitly enabled
    if (context.request.stream && !cacheStreaming) {
      return next();
    }

    // Generate cache key. A custom generator owns scoping entirely; the
    // default one refuses to build a key for a request whose caller cannot
    // be identified, unless the deployment has declared itself single-tenant.
    let cacheKey: string;
    if (keyGenerator) {
      cacheKey = keyGenerator(context.request);
    } else {
      const scope = resolveCacheScope(context.request, config.scopeKey);

      if (scope === undefined && unidentified === 'bypass') {
        return withBypassWarning(await next());
      }

      cacheKey = defaultCacheKey(context.request, scope);
    }

    // Check cache
    const cachedResponse = await storage.get(cacheKey);

    if (cachedResponse) {
      // Cache hit - add cache metadata
      return {
        ...cachedResponse,
        metadata: {
          ...cachedResponse.metadata,
          custom: {
            ...cachedResponse.metadata.custom,
            cacheHit: true,
            cacheKey,
          },
        },
      };
    }

    // Cache miss - call next middleware/handler
    const response = await next();

    // Store in cache
    await storage.set(cacheKey, response, ttl);

    // Add cache metadata
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
