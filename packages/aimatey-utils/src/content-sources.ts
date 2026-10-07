/**
 * Media Source Helpers
 *
 * `ImageContent`, `AudioContent`, `DocumentContent` and `VideoContent` carry a
 * `source` that is a URL, inline base64, or (#122) a {@link BlobRefSource} --
 * a handle only the originating transport can resolve. These helpers enforce
 * the contract that goes with the third member: a transport resolves its
 * handles before a request reaches a backend adapter, and a backend that
 * cannot resolve one refuses it with `UNSUPPORTED_FEATURE` rather than
 * dropping it or sending a handle to a provider as if it were data.
 *
 * @module
 */

import type {
  BlobRefSource,
  IRCapabilities,
  IRMessage,
  MessageContent,
} from '@johnhenry/aimatey-types';
import { AdapterError, ErrorCode } from '@johnhenry/aimatey-errors';

/**
 * Where an unresolved reference sits.
 */
export interface UnresolvedBlobRef {
  /** Path from the checked request, e.g. `messages[2].content[0]` or `images[1]`. */
  readonly path: string;
  /** The content kind carrying it (`'image'`, `'audio'`, `'document'`, `'video'`). */
  readonly kind: string;
  readonly ref: BlobRefSource;
}

function refOf(block: unknown): BlobRefSource | undefined {
  if (block === null || typeof block !== 'object') {
    return undefined;
  }
  const source = (block as { source?: unknown }).source;
  if (
    source !== null &&
    typeof source === 'object' &&
    (source as { type?: unknown }).type === 'ref'
  ) {
    return source as BlobRefSource;
  }
  return undefined;
}

function scanContent(
  content: IRMessage['content'] | readonly MessageContent[],
  base: string,
  out: UnresolvedBlobRef[]
): void {
  if (typeof content === 'string') {
    return;
  }
  content.forEach((block, i) => {
    const ref = refOf(block);
    if (ref) {
      out.push({ path: `${base}[${i}]`, kind: (block as { type: string }).type, ref });
    }
  });
}

/**
 * Find every unresolved {@link BlobRefSource} in a chat request's messages or a
 * decision request's `images`.
 */
export function findUnresolvedBlobRefs(request: {
  readonly messages?: readonly IRMessage[];
  readonly images?: readonly unknown[];
}): UnresolvedBlobRef[] {
  const out: UnresolvedBlobRef[] = [];
  request.messages?.forEach((message, m) => {
    scanContent(message.content, `messages[${m}].content`, out);
  });
  request.images?.forEach((image, i) => {
    const ref = refOf(image);
    if (ref) {
      out.push({ path: `images[${i}]`, kind: 'image', ref });
    }
  });
  return out;
}

/**
 * Throw `UNSUPPORTED_FEATURE` if `request` still contains an unresolved
 * {@link BlobRefSource} and the backend does not declare
 * `capabilities.blobRefs`.
 *
 * Called by `Bridge` and `Router` after request middleware has run (a
 * middleware is where a transport resolves its handles), so what is checked is
 * what the backend would actually receive.
 *
 * @param request Chat request, or decision request
 * @param backend Name of the backend about to receive it, for the error
 * @param capabilities The backend's declared capabilities
 */
export function assertNoUnresolvedBlobRefs(
  request: Parameters<typeof findUnresolvedBlobRefs>[0],
  backend: string,
  capabilities?: Pick<IRCapabilities, 'blobRefs'>
): void {
  if (capabilities?.blobRefs === true) {
    return;
  }
  const refs = findUnresolvedBlobRefs(request);
  if (refs.length === 0) {
    return;
  }
  throw new AdapterError({
    code: ErrorCode.UNSUPPORTED_FEATURE,
    message: `Backend '${backend}' cannot resolve blob references, and the request still contains ${refs.length} (${refs.map((r) => r.path).join(', ')}). The transport that minted a reference must resolve it to a url or base64 source before the request reaches a backend.`,
    isRetryable: false,
    provenance: { backend },
    details: { unresolved: refs.map((r) => ({ path: r.path, kind: r.kind, ref: r.ref.ref })) },
  });
}

/**
 * Narrow a media `source` to the members a provider adapter can translate,
 * throwing `UNSUPPORTED_FEATURE` for a {@link BlobRefSource}.
 *
 * The adapter-level half of the contract, for the one place an unresolved
 * reference could still slip through (an adapter called directly, bypassing
 * `Bridge`/`Router`): refuse loudly, never drop silently.
 */
export function rejectBlobRef<S extends { readonly type: string }>(
  source: S,
  backend: string
): Exclude<S, { readonly type: 'ref' }> {
  if (source.type === 'ref') {
    const ref = (source as unknown as BlobRefSource).ref;
    throw new AdapterError({
      code: ErrorCode.UNSUPPORTED_FEATURE,
      message: `Backend '${backend}' cannot resolve blob reference '${ref}'; the transport that minted it must resolve it to a url or base64 source first.`,
      isRetryable: false,
      provenance: { backend },
    });
  }
  return source as Exclude<S, { readonly type: 'ref' }>;
}

/**
 * The `url` form of a media source: the URL itself, or a `data:` URL for
 * base64. Throws `UNSUPPORTED_FEATURE` for a {@link BlobRefSource}.
 */
export function mediaSourceToUrl(
  source:
    | { readonly type: 'url'; readonly url: string }
    | { readonly type: 'base64'; readonly mediaType: string; readonly data: string }
    | BlobRefSource,
  backend: string
): string {
  const resolved = rejectBlobRef(source, backend);
  return resolved.type === 'url'
    ? resolved.url
    : `data:${resolved.mediaType};base64,${resolved.data}`;
}

/**
 * A content block whose media `source`, if it has one, can no longer be a
 * {@link BlobRefSource}.
 */
export type ResolvedContent<T> = T extends { readonly source: infer S }
  ? Omit<T, 'source'> & { readonly source: Exclude<S, { readonly type: 'ref' }> }
  : T;

/**
 * Narrow a content block for a provider translation loop: throws
 * `UNSUPPORTED_FEATURE` if its media source is an unresolved
 * {@link BlobRefSource}, otherwise returns it typed as having a `url` or
 * `base64` source.
 */
export function requireResolvedContent<T extends { readonly type: string }>(
  block: T,
  backend: string
): ResolvedContent<T> {
  const source = (block as { source?: { readonly type?: string } }).source;
  if (source !== undefined && source !== null && source.type === 'ref') {
    rejectBlobRef(source as { readonly type: string }, backend);
  }
  return block as ResolvedContent<T>;
}
