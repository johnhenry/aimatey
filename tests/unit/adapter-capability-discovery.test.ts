/**
 * Async capability discovery (#127)
 *
 * `AdapterMetadata.capabilities` is read synchronously and the metadata is
 * readonly, which is right for an in-process SDK adapter and wrong for one
 * whose far side is another machine: a paired device's inventory changes
 * while the adapter's metadata cannot. `discoverCapabilities()` is the
 * optional async answer; `metadata.capabilities` stays as the static lower
 * bound the sync guards keep reading.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Router } from '@johnhenry/aimatey-core';
import {
  resolveCapabilities,
  supportsEmbeddings,
  supportsDecisions,
} from '@johnhenry/aimatey-utils';
import type {
  AdapterMetadata,
  BackendAdapter,
  IRCapabilities,
  IREmbedRequest,
} from '@johnhenry/aimatey-types';

const base = {
  streaming: true,
  multiModal: false,
  tools: false,
  systemMessageStrategy: 'in-messages' as const,
};

/** A peer whose embeddings support is a fact about another machine. */
function createPeer(opts: {
  staticCaps?: Partial<IRCapabilities>;
  resolved?: boolean;
  discover?: boolean;
}) {
  const far = { embeddings: false as boolean };
  const calls = { discover: 0, embed: 0 };
  let failDiscovery = false;

  const metadata: AdapterMetadata = {
    name: 'peer',
    version: '1.0.0',
    provider: 'mock',
    capabilities: { ...base, ...opts.staticCaps } as IRCapabilities,
    ...(opts.resolved !== undefined ? { capabilitiesResolved: opts.resolved } : {}),
  };

  const adapter: BackendAdapter = {
    metadata,
    async embed() {
      calls.embed++;
      return { embeddings: [], model: 'm', usage: {} } as never;
    },
    async healthCheck() {
      return true;
    },
    ...(opts.discover === false
      ? {}
      : {
          async discoverCapabilities(): Promise<IRCapabilities> {
            calls.discover++;
            if (failDiscovery) {
              throw new Error('peer offline');
            }
            return { ...base, ...opts.staticCaps, embeddings: far.embeddings } as IRCapabilities;
          },
        }),
  } as unknown as BackendAdapter;

  return {
    adapter,
    far,
    calls,
    breakDiscovery: () => (failDiscovery = true),
  };
}

const embedRequest = { input: 'x' } as unknown as IREmbedRequest;

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveCapabilities', () => {
  it('returns the static metadata for an adapter that cannot discover', async () => {
    const peer = createPeer({ discover: false, staticCaps: { embeddings: true } });

    expect(await resolveCapabilities(peer.adapter)).toBe(peer.adapter.metadata.capabilities);
  });

  it('returns the far side answer for an adapter that can, and passes the signal through', async () => {
    const peer = createPeer({});
    peer.far.embeddings = true;

    expect((await resolveCapabilities(peer.adapter)).embeddings).toBe(true);
    expect(peer.calls.discover).toBe(1);
  });

  it('skips discovery when the metadata says it is already resolved', async () => {
    const peer = createPeer({ resolved: true });

    await resolveCapabilities(peer.adapter);

    expect(peer.calls.discover).toBe(0);
  });
});

describe('the sync guards keep reading static metadata, with an optional override', () => {
  it('supportsEmbeddings/supportsDecisions accept resolved capabilities explicitly', () => {
    const peer = createPeer({ staticCaps: { embeddings: true } });
    const resolved = { ...base, embeddings: false } as IRCapabilities;

    expect(supportsEmbeddings(peer.adapter)).toBe(true);
    expect(supportsEmbeddings(peer.adapter, resolved)).toBe(false);

    const decider = { ...peer.adapter, decide: async () => ({}) } as unknown as BackendAdapter;
    expect(supportsDecisions(decider)).toBe(true);
    expect(supportsDecisions(decider, { ...base, decisions: false } as IRCapabilities)).toBe(false);
  });
});

describe('Router routes on discovered capabilities', () => {
  it('stops routing embeddings to a peer whose far side stopped offering them, after the cache expires', async () => {
    vi.useFakeTimers();
    const peer = createPeer({ staticCaps: { embeddings: true } });
    peer.far.embeddings = true;
    const router = new Router({ routingStrategy: 'explicit', capabilityCacheDuration: 1000 });
    router.register('peer', peer.adapter);

    await router.embed(embedRequest);
    expect(peer.calls.embed).toBe(1);

    peer.far.embeddings = false;
    await router.embed(embedRequest); // still inside the cache window
    expect(peer.calls.embed).toBe(2);
    expect(peer.calls.discover).toBe(1);

    vi.advanceTimersByTime(1001);
    await expect(router.embed(embedRequest)).rejects.toThrow(
      /No registered backend supports embeddings/
    );
    expect(peer.calls.discover).toBe(2);
  });

  it('uses the far side answer over a static placeholder that says no', async () => {
    const peer = createPeer({ staticCaps: { embeddings: false } });
    peer.far.embeddings = true;
    const router = new Router({ routingStrategy: 'explicit' });
    router.register('peer', peer.adapter);

    await router.embed(embedRequest);

    expect(peer.calls.embed).toBe(1);
  });

  it('refreshes on health check without waiting for the cache to expire', async () => {
    const peer = createPeer({ staticCaps: { embeddings: true } });
    peer.far.embeddings = true;
    const router = new Router({ routingStrategy: 'explicit', capabilityCacheDuration: 3600000 });
    router.register('peer', peer.adapter);

    await router.embed(embedRequest);
    peer.far.embeddings = false;
    await router.checkHealth();

    await expect(router.embed(embedRequest)).rejects.toThrow(
      /No registered backend supports embeddings/
    );
  });

  it('falls back to the static lower bound when discovery fails, without failing the request', async () => {
    const peer = createPeer({ staticCaps: { embeddings: true } });
    peer.breakDiscovery();
    const router = new Router({ routingStrategy: 'explicit' });
    router.register('peer', peer.adapter);

    await router.embed(embedRequest);

    expect(peer.calls.embed).toBe(1);
  });

  it('does not discover for an adapter without discoverCapabilities (static path unchanged)', async () => {
    const peer = createPeer({ discover: false, staticCaps: { embeddings: true } });
    const router = new Router({ routingStrategy: 'explicit' });
    router.register('peer', peer.adapter);

    await router.embed(embedRequest);

    expect(peer.calls.discover).toBe(0);
    expect(peer.calls.embed).toBe(1);
  });

  it('re-discovers for a replacement adapter rather than serving the replaced one from cache', async () => {
    const first = createPeer({ staticCaps: { embeddings: true } });
    first.far.embeddings = true;
    const second = createPeer({ staticCaps: { embeddings: true } });
    second.far.embeddings = false;
    const router = new Router({ routingStrategy: 'explicit' });
    router.register('peer', first.adapter);
    await router.embed(embedRequest);

    router.replace('peer', second.adapter);

    await expect(router.embed(embedRequest)).rejects.toThrow(
      /No registered backend supports embeddings/
    );
  });
});
