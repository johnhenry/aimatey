/**
 * LiteRT-LM abort + load progress (aimatey#208)
 *
 * Mocked runtime: `Engine.create` can hang forever or consume a stream, and
 * generation can hang without ever yielding.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  LiteRtLmBackendAdapter,
  clearLiteRtLmEngineCache,
  type LiteRtLmModule,
  type LiteRtLmLoadProgress,
} from '@johnhenry/aimatey-backend-browser';
import type { IRChatRequest } from '@johnhenry/aimatey-types';

const URL_A = 'https://x/model-a.litertlm';

function req(): IRChatRequest {
  return {
    messages: [{ role: 'user', content: 'Hi' }],
    parameters: {},
    metadata: { requestId: 'r', timestamp: 0, provenance: {} },
  };
}

const STUCK = Symbol('stuck');
const settlesWithin = async (p: Promise<unknown>, ms = 200) =>
  (await Promise.race([
    p.then(() => 'settled'),
    new Promise((r) => setTimeout(() => r(STUCK), ms)),
  ])) !== STUCK;

async function drain(adapter: LiteRtLmBackendAdapter, signal?: AbortSignal) {
  const chunks: any[] = [];
  for await (const c of adapter.executeStream(req(), signal)) chunks.push(c);
  return chunks;
}

function engineWith(conv: Partial<Record<string, unknown>> = {}) {
  const state = { cancelled: 0, deleted: 0 };
  const engine = {
    // eslint-disable-next-line @typescript-eslint/require-await
    createConversation: async () => ({
      sendMessage: async () => ({ content: [] }),
      sendMessageStreaming: () =>
        (async function* () {
          yield { content: [{ type: 'text', text: 'ok' }] };
        })(),
      cancel: () => {
        state.cancelled++;
      },
      ...conv,
    }),
    // eslint-disable-next-line @typescript-eslint/require-await
    delete: async () => {
      state.deleted++;
    },
  };
  return { engine, state };
}

/** A fetch whose body streams `chunks` (one per `intervalMs`) and errors when the request signal aborts. */
function fakeFetch(chunks: number[], opts: { hang?: boolean; length?: boolean } = {}) {
  const seen: { signal?: AbortSignal; calls: number } = { calls: 0 };
  const impl = ((_url: string, init?: RequestInit) => {
    seen.calls++;
    seen.signal = init?.signal ?? undefined;
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        // Like a real fetch body: aborting the request errors the stream
        init?.signal?.addEventListener('abort', () => {
          try {
            c.error(new DOMException('aborted', 'AbortError'));
          } catch {
            /* already closed */
          }
        });
      },
      async pull(c) {
        await new Promise((r) => setTimeout(r, 5));
        if (init?.signal?.aborted) return;
        if (i >= chunks.length) {
          if (opts.hang) return new Promise<void>(() => {});
          c.close();
          return;
        }
        c.enqueue(new Uint8Array(chunks[i++]!));
      },
    });
    const total = chunks.reduce((a, b) => a + b, 0);
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: opts.length === false ? {} : { 'content-length': String(total) },
      })
    );
  }) as unknown as typeof fetch;
  return { impl, seen };
}

/** Engine.create that reads the whole model stream, like the real runtime does. */
function consumingModule(): { module: LiteRtLmModule; created: () => number } {
  let created = 0;
  const { engine } = engineWith();
  return {
    created: () => created,
    module: {
      Engine: {
        create: async ({ model }) => {
          created++;
          if (model instanceof ReadableStream) {
            const r = model.getReader();
            for (;;) {
              const { done } = await r.read();
              if (done) break;
            }
          }
          return engine;
        },
      },
    },
  };
}

beforeEach(() => clearLiteRtLmEngineCache());

describe('abort during engine load', () => {
  it('stops waiting for an Engine.create that never resolves', async () => {
    const adapter = new LiteRtLmBackendAdapter({
      model: URL_A,
      engineModule: { Engine: { create: () => new Promise(() => {}) } },
    });
    const ac = new AbortController();
    const done = drain(adapter, ac.signal);
    ac.abort();
    expect(await settlesWithin(done)).toBe(true);
    const chunks = await done;
    expect(chunks.at(-1)).toMatchObject({ type: 'error', error: { code: 'STREAM_CANCELLED' } });
  });

  it('rejects immediately when the signal is already aborted, without starting a load', async () => {
    let created = 0;
    const adapter = new LiteRtLmBackendAdapter({
      model: URL_A,
      engineModule: {
        Engine: {
          create: () => {
            created++;
            return new Promise(() => {});
          },
        },
      },
    });
    const ac = new AbortController();
    ac.abort();
    const chunks = await drain(adapter, ac.signal);
    expect(chunks[0]).toMatchObject({ type: 'error' });
    expect(created).toBe(0);
  });

  it('leaves the (unmanaged) load running and cached so a retry reuses it', async () => {
    let resolveEngine!: (e: any) => void;
    let created = 0;
    const { engine } = engineWith();
    const adapter = new LiteRtLmBackendAdapter({
      model: URL_A,
      engineModule: {
        Engine: {
          create: () => {
            created++;
            return new Promise((r) => {
              resolveEngine = r;
            });
          },
        },
      },
    });
    const ac = new AbortController();
    const first = drain(adapter, ac.signal);
    ac.abort();
    await first;
    const second = drain(adapter); // retry joins the same load
    resolveEngine(engine);
    const chunks = await second;
    expect(chunks.at(-1)?.type).toBe('done');
    expect(created).toBe(1);
  });

  it('cancels an adapter-managed download when the only waiter aborts, and evicts the cache', async () => {
    const { impl, seen } = fakeFetch([10, 10], { hang: true });
    const { module, created } = consumingModule();
    const adapter = new LiteRtLmBackendAdapter({
      model: URL_A,
      engineModule: module,
      fetchModel: impl,
    });
    const ac = new AbortController();
    const done = drain(adapter, ac.signal);
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    expect(await settlesWithin(done)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.signal?.aborted).toBe(true);
    // a retry starts a fresh download
    const retry = fakeFetch([5]);
    const adapter2 = new LiteRtLmBackendAdapter({
      model: URL_A,
      engineModule: module,
      fetchModel: retry.impl,
    });
    const chunks = await drain(adapter2);
    expect(chunks.at(-1)?.type).toBe('done');
    expect(retry.seen.calls).toBe(1);
    expect(created()).toBe(2);
  });

  it('does not cancel a shared download while another caller still waits', async () => {
    const { impl, seen } = fakeFetch([10, 10, 10]);
    const { module, created } = consumingModule();
    const a = new LiteRtLmBackendAdapter({ model: URL_A, engineModule: module, fetchModel: impl });
    const b = new LiteRtLmBackendAdapter({ model: URL_A, engineModule: module, fetchModel: impl });
    const acA = new AbortController();
    const doneA = drain(a, acA.signal);
    const doneB = drain(b);
    await new Promise((r) => setTimeout(r, 8));
    acA.abort();
    expect((await doneA).at(-1)).toMatchObject({ type: 'error' });
    expect((await doneB).at(-1)?.type).toBe('done');
    expect(seen.calls).toBe(1);
    expect(seen.signal?.aborted).toBe(false);
    expect(created()).toBe(1);
  });

  it('abort during compile returns promptly but keeps the engine cached', async () => {
    const { impl } = fakeFetch([10]);
    let release!: () => void;
    let created = 0;
    const { engine } = engineWith();
    const module: LiteRtLmModule = {
      Engine: {
        create: async ({ model }) => {
          created++;
          if (model instanceof ReadableStream) {
            const r = model.getReader();
            while (!(await r.read()).done);
          }
          await new Promise<void>((r) => {
            release = r;
          }); // "compiling"
          return engine;
        },
      },
    };
    const adapter = new LiteRtLmBackendAdapter({
      model: URL_A,
      engineModule: module,
      fetchModel: impl,
    });
    const ac = new AbortController();
    const done = drain(adapter, ac.signal);
    await new Promise((r) => setTimeout(r, 60));
    ac.abort();
    expect(await settlesWithin(done)).toBe(true);
    release();
    const chunks = await drain(adapter);
    expect(chunks.at(-1)?.type).toBe('done');
    expect(created).toBe(1);
  });
});

describe('abort during generation', () => {
  it('cancels the conversation immediately when no chunk ever arrives', async () => {
    const { engine, state } = engineWith({
      sendMessageStreaming: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise(() => {}),
          return: () => new Promise(() => {}),
        }),
      }),
    });
    const adapter = new LiteRtLmBackendAdapter({
      model: URL_A,
      engineModule: { Engine: { create: async () => engine } },
    });
    const ac = new AbortController();
    const done = drain(adapter, ac.signal);
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    expect(await settlesWithin(done)).toBe(true);
    expect(state.cancelled).toBeGreaterThanOrEqual(1);
    expect((await done).at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'STREAM_CANCELLED' },
    });
  });
});

describe('load progress', () => {
  it('reports download bytes (loaded/total), then compile, then ready', async () => {
    const { impl } = fakeFetch([100, 200, 300]);
    const { module } = consumingModule();
    const events: LiteRtLmLoadProgress[] = [];
    const adapter = new LiteRtLmBackendAdapter({
      model: URL_A,
      engineModule: module,
      fetchModel: impl,
      onProgress: (p) => events.push(p),
    });
    await drain(adapter);
    const downloads = events.filter((e) => e.stage === 'download');
    expect(downloads.at(-1)).toMatchObject({ loaded: 600, total: 600 });
    expect(downloads.map((e) => e.loaded)).toEqual(expect.arrayContaining([0, 100, 300, 600]));
    const stages = events.map((e) => e.stage);
    expect(stages.indexOf('compile')).toBeGreaterThan(stages.lastIndexOf('download') - 1);
    expect(stages.at(-1)).toBe('ready');
    expect(stages.indexOf('compile')).toBeLessThan(stages.indexOf('ready'));
  });

  it('total is undefined when the server sends no Content-Length', async () => {
    const { impl } = fakeFetch([50, 50], { length: false });
    const { module } = consumingModule();
    const events: LiteRtLmLoadProgress[] = [];
    const adapter = new LiteRtLmBackendAdapter({
      model: URL_A,
      engineModule: module,
      fetchModel: impl,
      onProgress: (p) => events.push(p),
    });
    await drain(adapter);
    expect(events.find((e) => e.stage === 'download' && e.loaded === 50)?.total).toBeUndefined();
  });

  it('reports Blob models with total = blob size', async () => {
    const { module } = consumingModule();
    const events: LiteRtLmLoadProgress[] = [];
    const adapter = new LiteRtLmBackendAdapter({
      model: new Blob([new Uint8Array(1234)]),
      engineModule: module,
      fetchModel: true,
      onProgress: (p) => events.push(p),
    });
    await drain(adapter);
    expect(events.filter((e) => e.stage === 'download').at(-1)).toMatchObject({
      loaded: 1234,
      total: 1234,
    });
  });

  it('without fetchModel the URL goes to the runtime unchanged and progress is loading -> ready', async () => {
    let received: unknown;
    const { engine } = engineWith();
    const events: LiteRtLmLoadProgress[] = [];
    const adapter = new LiteRtLmBackendAdapter({
      model: URL_A,
      engineModule: {
        Engine: {
          create: async ({ model }) => {
            received = model;
            return engine;
          },
        },
      },
      onProgress: (p) => events.push(p),
    });
    await drain(adapter);
    expect(received).toBe(URL_A);
    expect(events.map((e) => e.stage)).toEqual(['loading', 'ready']);
  });

  it('preload() loads with its own progress callback and the first request reuses the engine', async () => {
    const { impl } = fakeFetch([10, 10]);
    const { module, created } = consumingModule();
    const adapter = new LiteRtLmBackendAdapter({
      model: URL_A,
      engineModule: module,
      fetchModel: impl,
    });
    const events: LiteRtLmLoadProgress[] = [];
    await adapter.preload({ onProgress: (p) => events.push(p) });
    expect(events.at(-1)?.stage).toBe('ready');
    await drain(adapter);
    expect(created()).toBe(1);
  });

  it('preload() honors abort', async () => {
    const adapter = new LiteRtLmBackendAdapter({
      model: URL_A,
      engineModule: { Engine: { create: () => new Promise(() => {}) } },
    });
    const ac = new AbortController();
    const p = adapter.preload({ signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'STREAM_CANCELLED' });
  });

  it('a throwing progress callback does not break the load', async () => {
    const { module } = consumingModule();
    const adapter = new LiteRtLmBackendAdapter({
      model: URL_A,
      engineModule: module,
      onProgress: () => {
        throw new Error('ui bug');
      },
    });
    expect((await drain(adapter)).at(-1)?.type).toBe('done');
  });

  it('surfaces a non-OK model download as a provider error with the status', async () => {
    const impl = (() =>
      Promise.resolve(new Response('nope', { status: 404 }))) as unknown as typeof fetch;
    const { module } = consumingModule();
    const adapter = new LiteRtLmBackendAdapter({
      model: URL_A,
      engineModule: module,
      fetchModel: impl,
    });
    const err = (await drain(adapter)).at(-1);
    expect(err.type).toBe('error');
    expect(err.error.message).toContain('404');
  });
});
