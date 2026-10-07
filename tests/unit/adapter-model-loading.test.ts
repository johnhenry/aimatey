/**
 * Adapters say "warming up" with MODEL_LOADING (#173 part 2).
 *
 * A backend loading a model is slow, not sick. The router's default breaker
 * predicate does not count `MODEL_LOADING`, but only an adapter can tell the two
 * apart, so the adapters that can detect a load phase report it:
 *
 * - Ollama: a 503 whose body says the runner is loading a model, and a request
 *   that outlived its deadline while `/api/ps` shows the model is not resident.
 * - native-model-runner: a request that arrives while `start()` is still
 *   waiting for the process to come up.
 * - native-node-llamacpp: a request that arrives while another request's
 *   `initialize()` is still loading the model (which used to load it twice).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { OllamaBackendAdapter } from '@johnhenry/aimatey-backend';
import { Router } from '@johnhenry/aimatey-core';
import { ErrorCode } from '@johnhenry/aimatey-errors';
import { GenericModelRunnerBackend } from '@johnhenry/aimatey-native-model-runner';
import { NodeLlamaCppBackend } from '@johnhenry/aimatey-native-node-llamacpp';
import type {
  AdapterMetadata,
  IRChatRequest,
  IRChatResponse,
  IRStreamChunk,
  ModelRunnerBackendConfig,
} from '@johnhenry/aimatey-types';

function chatRequest(model = 'qwen2.5:3b'): IRChatRequest {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    parameters: { model },
    metadata: { requestId: 'req-1', timestamp: 0, provenance: {} },
  } as unknown as IRChatRequest;
}

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

function stubFetch(route: Route) {
  const fn = vi.fn((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(route(String(url), init))
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Ollama', () => {
  it('reports a 503 "llm server loading model" as MODEL_LOADING', async () => {
    stubFetch(() => json({ error: 'llm server loading model' }, 503));
    const adapter = new OllamaBackendAdapter({} as never);

    await expect(adapter.execute(chatRequest())).rejects.toMatchObject({
      code: ErrorCode.MODEL_LOADING,
      isRetryable: true,
    });
  });

  it('does not mistake another 503 for a warm-up', async () => {
    stubFetch(() => json({ error: 'server busy, please try again' }, 503));
    const adapter = new OllamaBackendAdapter({} as never);

    await expect(adapter.execute(chatRequest())).rejects.not.toMatchObject({
      code: ErrorCode.MODEL_LOADING,
    });
  });

  it('reports it in-band on a stream, where the router will read it', async () => {
    stubFetch(() => json({ error: 'llm server loading model' }, 503));
    const adapter = new OllamaBackendAdapter({} as never);

    const chunks: IRStreamChunk[] = [];
    for await (const chunk of adapter.executeStream(chatRequest())) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ type: 'error', error: { code: 'MODEL_LOADING' } });
  });

  describe('a request that outlived its deadline', () => {
    const expire = (): AbortSignal => {
      const controller = new AbortController();
      controller.abort(new DOMException('The operation timed out', 'TimeoutError'));
      return controller.signal;
    };

    const route =
      (resident: string[] | 'unreachable'): Route =>
      (url, init) => {
        if (url.endsWith('/api/ps')) {
          if (resident === 'unreachable') {
            throw new TypeError('fetch failed');
          }
          return json({ models: resident.map((name) => ({ name, model: name })) });
        }
        // The chat call: dies with whatever its signal says.
        throw init?.signal?.reason ?? new Error('unreachable');
      };

    it('is MODEL_LOADING when /api/ps shows the model is not resident', async () => {
      stubFetch(route([]));
      const adapter = new OllamaBackendAdapter({} as never);

      await expect(adapter.execute(chatRequest(), expire())).rejects.toMatchObject({
        code: ErrorCode.MODEL_LOADING,
        isRetryable: true,
      });
    });

    it('is MODEL_LOADING when only other models are resident', async () => {
      stubFetch(route(['llama3:8b']));
      const adapter = new OllamaBackendAdapter({} as never);

      await expect(adapter.execute(chatRequest(), expire())).rejects.toMatchObject({
        code: ErrorCode.MODEL_LOADING,
      });
    });

    it('is an ordinary failure when the model is resident (it was slow, not loading)', async () => {
      stubFetch(route(['qwen2.5:3b']));
      const adapter = new OllamaBackendAdapter({} as never);

      await expect(adapter.execute(chatRequest(), expire())).rejects.not.toMatchObject({
        code: ErrorCode.MODEL_LOADING,
      });
    });

    it('treats a bare model name as :latest when matching', async () => {
      stubFetch(route(['llama3:latest']));
      const adapter = new OllamaBackendAdapter({} as never);

      await expect(adapter.execute(chatRequest('llama3'), expire())).rejects.not.toMatchObject({
        code: ErrorCode.MODEL_LOADING,
      });
    });

    it('does not guess when /api/ps cannot be read', async () => {
      stubFetch(route('unreachable'));
      const adapter = new OllamaBackendAdapter({} as never);

      await expect(adapter.execute(chatRequest(), expire())).rejects.not.toMatchObject({
        code: ErrorCode.MODEL_LOADING,
      });
    });

    it("never relabels the caller's own cancellation", async () => {
      const probe = vi.fn();
      stubFetch((url, init) => {
        if (url.endsWith('/api/ps')) {
          probe();
          return json({ models: [] });
        }
        throw init?.signal?.reason;
      });
      const controller = new AbortController();
      controller.abort(new DOMException('user pressed stop', 'AbortError'));

      await expect(
        new OllamaBackendAdapter({} as never).execute(chatRequest(), controller.signal)
      ).rejects.not.toMatchObject({ code: ErrorCode.MODEL_LOADING });
      expect(probe).not.toHaveBeenCalled();
    });
  });

  it('end to end: a slow-loading Ollama does not trip the router breaker', async () => {
    stubFetch(() => json({ error: 'llm server loading model' }, 503));
    const router = new Router({
      enableCircuitBreaker: true,
      circuitBreakerThreshold: 2,
      fallbackStrategy: 'none',
    });
    router.register('ollama', new OllamaBackendAdapter({} as never));

    for (let i = 0; i < 6; i++) {
      await router.execute(chatRequest()).catch(() => undefined);
    }
    expect(router.isCircuitBreakerOpen('ollama')).toBe(false);
  });
});

class TestRunner extends GenericModelRunnerBackend {
  readonly metadata: AdapterMetadata = {
    name: 'test-runner',
    version: '1.0.0',
    provider: 'test',
    capabilities: {
      streaming: true,
      multiModal: false,
      tools: false,
      systemMessageStrategy: 'in-messages',
    } as AdapterMetadata['capabilities'],
  };

  constructor(communication: 'http' | 'stdio' = 'http') {
    super({
      model: 'm',
      process: { command: 'true' },
      communication: communication === 'http' ? { type: 'http' } : { type: 'stdio' },
      port: 4242,
    } as unknown as ModelRunnerBackendConfig);
  }

  markStarting(): void {
    this.isStarting = true;
  }

  markRunning(): void {
    this.isRunning = true;
  }

  protected override async executeHttp(request: IRChatRequest): Promise<IRChatResponse> {
    return {
      message: { role: 'assistant', content: 'ok' },
      finishReason: 'stop',
      metadata: { ...request.metadata, provenance: { backend: 'test-runner' } },
    } as unknown as IRChatResponse;
  }

  protected override async *executeStreamHttp(request: IRChatRequest) {
    yield {
      type: 'start',
      sequence: 0,
      metadata: { ...request.metadata, provenance: { backend: 'test-runner' } },
    } as unknown as IRStreamChunk;
    yield { type: 'done', sequence: 1, finishReason: 'stop' } as unknown as IRStreamChunk;
  }

  protected buildCommandArgs(): string[] {
    return [];
  }
  protected formatPrompt(): string {
    return '';
  }
  protected parseResponse(): IRChatResponse {
    throw new Error('unused');
  }
  protected parseStreamChunk(): IRStreamChunk | null {
    return null;
  }
  protected getPromptTemplate(): never {
    throw new Error('unused');
  }
}

describe('native-model-runner', () => {
  it('a request while the runner is starting is MODEL_LOADING, not "not running"', async () => {
    const runner = new TestRunner();
    runner.markStarting();

    await expect(runner.execute(chatRequest())).rejects.toMatchObject({
      code: ErrorCode.MODEL_LOADING,
      isRetryable: true,
    });
    const stream = runner.executeStream(chatRequest());
    await expect(stream.next()).rejects.toMatchObject({ code: ErrorCode.MODEL_LOADING });
  });

  it('a runner nobody started is still PROVIDER_ERROR (a real fault)', async () => {
    await expect(new TestRunner().execute(chatRequest())).rejects.toMatchObject({
      code: ErrorCode.PROVIDER_ERROR,
      isRetryable: false,
    });
  });

  it('declares its hop same-host on responses and stream chunks', async () => {
    const runner = new TestRunner();
    runner.markRunning();

    const response = await runner.execute(chatRequest());
    expect(response.metadata.provenance).toMatchObject({
      backend: 'test-runner',
      locality: 'same-host',
      servedBy: 'localhost:4242',
    });

    const chunks: IRStreamChunk[] = [];
    for await (const chunk of runner.executeStream(chatRequest())) {
      chunks.push(chunk);
    }
    const start = chunks[0] as unknown as { metadata: { provenance: Record<string, unknown> } };
    expect(start.metadata.provenance.locality).toBe('same-host');
    expect(chunks[1]).not.toHaveProperty('metadata');
  });
});

describe('native-node-llamacpp', () => {
  it('a request that arrives while the model is loading is MODEL_LOADING, and the model loads once', async () => {
    const backend = new NodeLlamaCppBackend({ modelPath: '/nonexistent.gguf' });
    let finishLoading!: () => void;
    const initialize = vi.spyOn(backend, 'initialize').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishLoading = resolve;
        })
    );

    const first = backend.execute(chatRequest()).catch((e) => e);
    await new Promise((resolve) => setImmediate(resolve));

    await expect(backend.execute(chatRequest())).rejects.toMatchObject({
      code: ErrorCode.MODEL_LOADING,
      isRetryable: true,
    });
    const stream = backend.executeStream(chatRequest());
    await expect(stream.next()).rejects.toMatchObject({ code: ErrorCode.MODEL_LOADING });

    finishLoading();
    await first;
    expect(initialize).toHaveBeenCalledTimes(1);
  });
});
