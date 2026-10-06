/**
 * IRProvenance.locality and resolveEgress (#130).
 *
 * `IRProvenance` could name every hop of `phone -> desktop -> llama-cpp` but not
 * say which link left the device. `locality` is the per-hop answer, set by the
 * adapter that performed the hop, and `resolveEgress` is the single walker.
 * The rule everything here pins: unknown is external.
 */

import { describe, it, expect } from 'vitest';
import { resolveEgress, withUpstreamProvenance } from '@johnhenry/aimatey-types';
import type { IRProvenance } from '@johnhenry/aimatey-types';

describe('resolveEgress', () => {
  it('reports a single declared hop as it is', () => {
    expect(resolveEgress({ backend: 'llama-cpp', locality: 'in-process' })).toEqual({
      locality: 'in-process',
      declared: true,
    });
    expect(resolveEgress({ backend: 'ollama', locality: 'same-host' })).toEqual({
      locality: 'same-host',
      declared: true,
    });
    expect(resolveEgress({ backend: 'openai', locality: 'external' })).toEqual({
      locality: 'external',
      declared: true,
    });
  });

  it('takes the widest link across a proxied chain, not the near hop', () => {
    // phone -> desktop -> llama-cpp: the phone crossed a network.
    expect(
      resolveEgress({
        backend: 'tunnel',
        locality: 'external',
        upstream: { backend: 'llama-cpp', locality: 'in-process' },
      })
    ).toEqual({ locality: 'external', declared: true });

    // The reverse shape: a local daemon that itself calls a cloud API.
    expect(
      resolveEgress({
        backend: 'local-gateway',
        locality: 'same-host',
        upstream: { backend: 'openai', locality: 'external' },
      })
    ).toEqual({ locality: 'external', declared: true });

    expect(
      resolveEgress({
        backend: 'daemon',
        locality: 'same-host',
        upstream: { backend: 'llama-cpp', locality: 'in-process' },
      })
    ).toEqual({ locality: 'same-host', declared: true });
  });

  it('fails closed: a hop that did not declare its link is external, and undeclared', () => {
    expect(resolveEgress({ backend: 'tunnel' })).toEqual({ locality: 'external', declared: false });
  });

  it('does not let a declared far hop vouch for an undeclared near one', () => {
    expect(
      resolveEgress({
        backend: 'tunnel', // forgot to say where it went
        upstream: { backend: 'llama-cpp', locality: 'in-process' },
      })
    ).toEqual({ locality: 'external', declared: false });
  });

  it('does not let a declared near hop vouch for an undeclared far one', () => {
    expect(
      resolveEgress({
        backend: 'daemon',
        locality: 'in-process',
        upstream: { backend: 'somewhere' },
      })
    ).toEqual({ locality: 'external', declared: false });
  });

  it('treats missing or empty provenance as unknown, not local', () => {
    expect(resolveEgress(undefined)).toEqual({ locality: 'external', declared: false });
    expect(resolveEgress({})).toEqual({ locality: 'external', declared: false });
  });

  it('skips an empty link in the chain rather than counting it unknown', () => {
    expect(
      resolveEgress({
        backend: 'llama-cpp',
        locality: 'in-process',
        upstream: {},
      })
    ).toEqual({ locality: 'in-process', declared: true });
  });

  it('treats a locality it cannot rank (from a newer IR) as unknown', () => {
    const future = { backend: 'x', locality: 'orbital' } as unknown as IRProvenance;
    expect(resolveEgress(future)).toEqual({ locality: 'external', declared: false });
  });

  it('survives withUpstreamProvenance, which keeps the proxy hop intact', () => {
    const provenance = withUpstreamProvenance(
      { backend: 'tunnel', locality: 'external' },
      { backend: 'llama-cpp', locality: 'in-process' }
    );
    expect(provenance.locality).toBe('external');
    expect(provenance.upstream?.locality).toBe('in-process');
    expect(resolveEgress(provenance).locality).toBe('external');
  });
});
