/**
 * Locality helpers for adapters (#174).
 *
 * `IRProvenance.locality` must be set by the adapter that performed the hop; it
 * can never be inferred by a walker. An adapter whose endpoint is configurable
 * -- Ollama, LM Studio, a System One server -- *is* that adapter, and the one
 * thing it can know about its own link is whether the URL it just called is on
 * this machine. These helpers are that one rule, shared so that no two adapters
 * disagree about what "loopback" means.
 *
 * @module
 */

import type { ProvenanceLocality } from '@johnhenry/aimatey-types';

const UNIX_SOCKET_PROTOCOLS = new Set(['unix:', 'http+unix:', 'https+unix:']);

function parse(baseURL: string | URL | undefined): URL | undefined {
  if (baseURL === undefined || baseURL === '') {
    return undefined;
  }
  try {
    return baseURL instanceof URL ? baseURL : new URL(baseURL);
  } catch {
    return undefined;
  }
}

/**
 * Whether a (normalised, WHATWG-parsed) hostname is the loopback interface.
 * The URL parser has already canonicalised exotic spellings (`127.1`,
 * `0x7f.1`, `[0:0:0:0:0:0:0:1]`, `[::ffff:127.0.0.1]`), so this only has to
 * recognise the canonical forms.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return true;
  }
  if (host === '[::1]') {
    return true;
  }
  // IPv4-mapped IPv6 loopback, canonicalised by URL as ::ffff:7fxx:xxxx.
  return /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host);
}

/**
 * The {@link ProvenanceLocality} of an HTTP-ish endpoint: `'same-host'` when it
 * is loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) or a unix
 * socket, `'external'` for anything else -- a LAN peer, a hostname that merely
 * resolves locally, `0.0.0.0`, a cloud API.
 *
 * **Fails closed.** A URL that is missing or does not parse is `'external'`, the
 * same answer an adapter that declared nothing gets from `resolveEgress()`.
 *
 * This never returns `'in-process'`: a URL is by definition a link, and
 * "no link at all" is something only an adapter that calls a function can say.
 *
 * @param baseURL The endpoint the adapter actually called.
 */
export function localityForBaseURL(baseURL: string | URL | undefined): ProvenanceLocality {
  const url = parse(baseURL);
  if (!url) {
    return 'external';
  }
  if (UNIX_SOCKET_PROTOCOLS.has(url.protocol)) {
    return 'same-host';
  }
  return isLoopbackHost(url.hostname) ? 'same-host' : 'external';
}

/**
 * The `host[:port]` of an endpoint, for {@link IRProvenance.servedBy}. Nothing
 * else from the URL: no credentials, path or query string. `undefined` when
 * there is no meaningful host to report (unparseable, or a unix socket).
 *
 * @param baseURL The endpoint the adapter actually called.
 */
export function servedByForBaseURL(baseURL: string | URL | undefined): string | undefined {
  const url = parse(baseURL);
  if (!url || UNIX_SOCKET_PROTOCOLS.has(url.protocol) || url.host === '') {
    return undefined;
  }
  return url.host;
}
