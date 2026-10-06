/**
 * Blob reference media source (#122)
 *
 * `{ type: 'ref' }` names a payload a transport moves over its own blob
 * channel. The contract: the transport resolves it before the request reaches a
 * backend adapter; anything that cannot resolve one refuses it with
 * UNSUPPORTED_FEATURE -- never drops it, never sends the handle to a provider,
 * never fetches it.
 */

import { describe, it, expect, vi, afterEach, expectTypeOf } from 'vitest';
import { Bridge, Router } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import {
  OpenAIBackendAdapter,
  AnthropicBackendAdapter,
  GeminiBackendAdapter,
  XAIBackendAdapter,
  SystemOneBackendAdapter,
} from '@johnhenry/aimatey-backend';
import {
  assertNoUnresolvedBlobRefs,
  findUnresolvedBlobRefs,
  validateDecisionRequest,
} from '@johnhenry/aimatey-utils';
import type {
  AudioContent,
  BackendAdapter,
  BlobRefSource,
  DocumentContent,
  IRChatRequest,
  IRDecisionRequest,
  ImageContent,
  VideoContent,
} from '@johnhenry/aimatey-types';

const ref: BlobRefSource = { type: 'ref', ref: 'blob://7f3a', mediaType: 'image/png', bytes: 2048 };

function requestWith(source: unknown): IRChatRequest {
  return {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', source },
        ],
      },
    ],
    parameters: { model: 'test-model' },
    metadata: { requestId: 'req-ref', timestamp: 1, provenance: {} },
  } as unknown as IRChatRequest;
}

function mockBackend(name: string, blobRefs?: boolean): BackendAdapter {
  const reply = {
    message: { role: 'assistant', content: 'a cat' },
    finishReason: 'stop',
    metadata: { requestId: 'req-ref', timestamp: 1, provenance: { backend: name } },
  };
  return {
    metadata: {
      name,
      version: '1',
      provider: name,
      capabilities: {
        streaming: true,
        multiModal: true,
        tools: false,
        ...(blobRefs !== undefined ? { blobRefs } : {}),
        systemMessageStrategy: 'in-messages',
        supportsMultipleSystemMessages: true,
      },
    },
    execute: vi.fn(async () => reply),
    executeStream: vi.fn(async function* () {
      yield { type: 'done', sequence: 0, finishReason: 'stop' };
    }),
  } as unknown as BackendAdapter;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function rootCode(error: unknown): string | undefined {
  let current = error as { code?: string; cause?: unknown } | undefined;
  let code: string | undefined;
  while (current) {
    code = current.code;
    current = current.cause as typeof current;
  }
  return code;
}

describe('the type', () => {
  it('is a third member of every media content source', () => {
    expectTypeOf<BlobRefSource>().toMatchTypeOf<ImageContent['source']>();
    expectTypeOf<BlobRefSource>().toMatchTypeOf<AudioContent['source']>();
    expectTypeOf<BlobRefSource>().toMatchTypeOf<DocumentContent['source']>();
    expectTypeOf<BlobRefSource>().toMatchTypeOf<VideoContent['source']>();
    const image: ImageContent = { type: 'image', source: ref };
    expect(image.source.type).toBe('ref');
  });
});

describe('findUnresolvedBlobRefs', () => {
  it('locates a reference and reports what carries it', () => {
    const found = findUnresolvedBlobRefs(requestWith(ref));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path: 'messages[0].content[1]', kind: 'image' });
  });

  it('finds none in url and base64 sources', () => {
    expect(findUnresolvedBlobRefs(requestWith({ type: 'url', url: 'https://x/y.png' }))).toEqual(
      []
    );
    expect(
      findUnresolvedBlobRefs(requestWith({ type: 'base64', mediaType: 'image/png', data: 'AA==' }))
    ).toEqual([]);
  });
});

describe('Bridge refuses an unresolved reference', () => {
  it('throws UNSUPPORTED_FEATURE and never reaches the backend', async () => {
    const backend = mockBackend('plain');
    const bridge = new Bridge(new OpenAIFrontendAdapter(), backend);

    await expect(bridge.executeIR(requestWith(ref))).rejects.toMatchObject({
      code: 'UNSUPPORTED_FEATURE',
    });
    expect(backend.execute).not.toHaveBeenCalled();
  });

  it('refuses on the streaming path too', async () => {
    const backend = mockBackend('plain');
    const bridge = new Bridge(new OpenAIFrontendAdapter(), backend);

    await expect(
      (async () => {
        for await (const _ of bridge.executeIRStream(requestWith(ref))) {
          // drain
        }
      })()
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FEATURE' });
    expect(backend.executeStream).not.toHaveBeenCalled();
  });

  it('accepts a reference a middleware resolved first (the transport does it there)', async () => {
    const backend = mockBackend('plain');
    const bridge = new Bridge(new OpenAIFrontendAdapter(), backend);
    bridge.use(async (context, next) => {
      context.request = requestWith({ type: 'base64', mediaType: 'image/png', data: 'AA==' });
      return next();
    });

    await expect(bridge.executeIR(requestWith(ref))).resolves.toBeDefined();
    expect(backend.execute).toHaveBeenCalledTimes(1);
  });

  it('lets a backend that declares blobRefs receive it', async () => {
    const backend = mockBackend('tunnel', true);
    const bridge = new Bridge(new OpenAIFrontendAdapter(), backend);

    await bridge.executeIR(requestWith(ref));

    expect(backend.execute).toHaveBeenCalledTimes(1);
  });
});

describe('Router', () => {
  it('skips a backend that cannot resolve a reference for one that can, without counting a failure', async () => {
    const plain = mockBackend('plain');
    const tunnel = mockBackend('tunnel', true);
    const router = new Router({ defaultBackend: 'plain', fallbackStrategy: 'sequential' });
    router.register('plain', plain);
    router.register('tunnel', tunnel);
    router.setFallbackChain(['tunnel']);

    await router.execute(requestWith(ref));

    expect(plain.execute).not.toHaveBeenCalled();
    expect(tunnel.execute).toHaveBeenCalledTimes(1);
    expect(router.getBackendStats('plain')?.failedRequests).toBe(0);
  });

  it('refuses outright when no backend can resolve it', async () => {
    const router = new Router({ defaultBackend: 'plain', fallbackStrategy: 'none' });
    router.register('plain', mockBackend('plain'));

    await expect(router.execute(requestWith(ref))).rejects.toMatchObject({
      code: 'UNSUPPORTED_FEATURE',
    });
  });
});

describe('provider adapters called directly refuse rather than drop', () => {
  const adapters: [string, () => BackendAdapter][] = [
    ['openai', () => new OpenAIBackendAdapter({ apiKey: 'k' })],
    ['anthropic', () => new AnthropicBackendAdapter({ apiKey: 'k' })],
    ['gemini', () => new GeminiBackendAdapter({ apiKey: 'k' })],
    [
      'xai (representative of the OpenAI-compatible family)',
      () => new XAIBackendAdapter({ apiKey: 'k' }),
    ],
  ];

  it.each(adapters)('%s', async (_name, make) => {
    global.fetch = vi.fn() as never;
    // Adapters wrap conversion failures in their own error type; the refusal is
    // the root of the cause chain.
    const error = await make()
      .execute(requestWith(ref))
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(rootCode(error)).toBe('UNSUPPORTED_FEATURE');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('decision requests', () => {
  const decision = (source: unknown): IRDecisionRequest =>
    ({
      state: 'x',
      questions: { q: { type: 'binary', instructions: 'Is it a cat?' } },
      images: [{ type: 'image', source }],
      metadata: { requestId: 'd', timestamp: 1, provenance: {} },
    }) as unknown as IRDecisionRequest;

  it('validateDecisionRequest rejects a reference even for a backend that takes images', () => {
    expect(() =>
      validateDecisionRequest(decision(ref), {
        streaming: false,
        multiModal: false,
        decisions: true,
        decisionImages: true,
      } as never)
    ).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_FEATURE' }));
  });

  it('rejects without capabilities too', () => {
    expect(() => validateDecisionRequest(decision(ref))).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_FEATURE' })
    );
  });

  it('still accepts base64 images', () => {
    expect(() =>
      validateDecisionRequest(decision({ type: 'base64', mediaType: 'image/png', data: 'AA==' }), {
        streaming: false,
        multiModal: false,
        decisions: true,
        decisionImages: true,
      } as never)
    ).not.toThrow();
  });

  it('the System One client refuses it as unsupported, not as a mislabelled url', async () => {
    global.fetch = vi.fn() as never;
    const adapter = new SystemOneBackendAdapter({
      baseURL: 'http://localhost:1',
      decisionImages: true,
    });
    await expect(adapter.decide(decision(ref))).rejects.toMatchObject({
      code: 'UNSUPPORTED_FEATURE',
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('assertNoUnresolvedBlobRefs', () => {
  it('names every unresolved path in the error', () => {
    try {
      assertNoUnresolvedBlobRefs(requestWith(ref), 'plain');
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('messages[0].content[1]');
    }
  });
});
