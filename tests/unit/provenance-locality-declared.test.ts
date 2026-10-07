/**
 * Adapters declare `IRProvenance.locality` and, where they know it, `servedBy`
 * (#174, follow-up to #130).
 *
 * `locality` is only worth anything if the adapter that performed the hop sets
 * it; `undefined` fails closed to `'external'`, which is correct for a cloud API
 * and merely conservative for everything else. So:
 *
 * - `localityForBaseURL()` is the one rule for "is this endpoint on this host";
 * - every shipped adapter sets it (the grep test below fails for a new provider
 *   that forgets);
 * - what is set is checked on a representative sample.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OpenAIBackendAdapter,
  AnthropicBackendAdapter,
  GroqBackendAdapter,
  LMStudioBackendAdapter,
  OmniRouteBackendAdapter,
  OllamaBackendAdapter,
  SystemOneBackendAdapter,
} from '@johnhenry/aimatey-backend';
import {
  localityForBaseURL,
  servedByForBaseURL,
  prepareForwardedResponse,
} from '@johnhenry/aimatey-utils';
import { resolveEgress } from '@johnhenry/aimatey-types';
import type {
  IRChatRequest,
  IRChatResponse,
  IRDecisionRequest,
  IRStreamChunk,
} from '@johnhenry/aimatey-types';

const ROOT = join(__dirname, '..', '..', 'packages');

function chatRequest(provenance?: Record<string, unknown>): IRChatRequest {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    parameters: { model: 'm' },
    metadata: { requestId: 'req-1', timestamp: 0, provenance: provenance ?? {} },
  } as unknown as IRChatRequest;
}

function stubFetch(body: unknown, ndjson?: string) {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
    body: ndjson
      ? new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(ndjson));
            controller.close();
          },
        })
      : null,
    headers: new Headers(),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('localityForBaseURL', () => {
  const cases: Array<[string | undefined, 'same-host' | 'external']> = [
    ['http://localhost:11434', 'same-host'],
    ['http://LOCALHOST:11434/v1', 'same-host'],
    ['http://localhost.:11434', 'same-host'],
    ['http://ollama.localhost:11434', 'same-host'],
    ['http://127.0.0.1:1234/v1', 'same-host'],
    ['http://127.0.0.53/', 'same-host'],
    ['http://127.255.255.254:80', 'same-host'],
    ['http://[::1]:8080', 'same-host'],
    ['http://[::ffff:127.0.0.1]:8080', 'same-host'],
    ['https://localhost', 'same-host'],
    ['unix:///var/run/ollama.sock', 'same-host'],
    ['unix:/var/run/ollama.sock', 'same-host'],
    ['http+unix://%2Fvar%2Frun%2Follama.sock/api', 'same-host'],
    // Everything else, including what only *looks* local, is external.
    ['https://api.openai.com/v1', 'external'],
    ['http://192.168.1.50:11434', 'external'],
    ['http://10.0.0.2:11434', 'external'],
    ['http://128.0.0.1', 'external'],
    ['http://126.255.255.255', 'external'],
    ['http://0.0.0.0:11434', 'external'],
    ['http://localhost.evil.example', 'external'],
    ['http://notlocalhost:11434', 'external'],
    ['http://127.0.0.1.evil.example', 'external'],
    ['http://[2001:db8::1]', 'external'],
    ['http://desktop.local:11434', 'external'],
    ['http://user:pass@evil.example@localhost/', 'same-host'],
    ['http://localhost@evil.example/', 'external'],
    ['not a url', 'external'],
    ['', 'external'],
    [undefined, 'external'],
  ];

  it.each(cases)('%s -> %s', (url, expected) => {
    expect(localityForBaseURL(url)).toBe(expected);
  });

  it('accepts a URL object', () => {
    expect(localityForBaseURL(new URL('http://127.0.0.1:1'))).toBe('same-host');
  });
});

describe('servedByForBaseURL', () => {
  it('is the host (with port), informational only', () => {
    expect(servedByForBaseURL('http://localhost:11434')).toBe('localhost:11434');
    expect(servedByForBaseURL('https://api.openai.com/v1')).toBe('api.openai.com');
    expect(servedByForBaseURL('http://desktop.local:11434/v1')).toBe('desktop.local:11434');
  });

  it('never leaks credentials, paths or query strings', () => {
    expect(servedByForBaseURL('https://user:secret@gateway.example/v1?key=abc')).toBe(
      'gateway.example'
    );
  });

  it('is undefined when there is no meaningful host', () => {
    expect(servedByForBaseURL(undefined)).toBeUndefined();
    expect(servedByForBaseURL('not a url')).toBeUndefined();
    expect(servedByForBaseURL('unix:///var/run/ollama.sock')).toBeUndefined();
  });
});

describe('every shipped adapter declares locality (grep guard)', () => {
  const sources = (dir: string, only?: (file: string) => boolean): string[] =>
    readdirSync(join(ROOT, dir))
      .filter((f) => f.endsWith('.ts') && (only ? only(f) : true))
      .map((f) => join(dir, f));

  const providers = sources('backend/src/providers');

  it('finds the providers it is supposed to guard', () => {
    expect(providers.length).toBeGreaterThanOrEqual(30);
  });

  it.each(providers)('%s', (file) => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    // A subclass of the OpenAI-compatible adapter inherits that base's
    // declaration (and may override it); everything else must set it itself.
    const inherits = /extends\s+OpenAIBackendAdapter/.test(text);
    expect(
      inherits || /\blocality\b/.test(text),
      `${file} adds a provenance hop but declares no \`locality\``
    ).toBe(true);
  });

  const others = [
    'backend/src/shared.ts',
    'backend/src/decisions/systemone-client.ts',
    'backend-browser/src/chrome-ai.ts',
    'backend-browser/src/litert-lm.ts',
    'backend-browser/src/function.ts',
    'native-apple/src/index.ts',
    'native-laya/src/index.ts',
    'native-model-runner/src/index.ts',
    'native-node-llamacpp/src/index.ts',
  ];

  it.each(others)('%s', (file) => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    expect(/\blocality\b/.test(text), `${file} declares no \`locality\``).toBe(true);
  });

  it('in-process native packages declare only in-process', () => {
    for (const file of others.filter(
      (f) => f.startsWith('native-') && !f.includes('model-runner')
    )) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      const declared = [...text.matchAll(/\blocality:\s*([^,}\n]+)/g)].map((m) => m[1]!.trim());
      expect(declared.length, file).toBeGreaterThan(0);
      for (const value of declared) {
        expect(value, `${file}`).toBe("'in-process'");
      }
    }
  });

  it('the model runner talks to a child process it spawned: same-host', () => {
    const text = readFileSync(join(ROOT, 'native-model-runner/src/index.ts'), 'utf8');
    expect(text).toMatch(/locality: ProvenanceLocality = 'same-host'/);
  });
});

describe('what adapters declare', () => {
  const OPENAI_BODY = {
    id: 'x',
    model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };

  it('OpenAI-compatible cloud adapters are external', async () => {
    stubFetch(OPENAI_BODY);
    const openai = new OpenAIBackendAdapter({ apiKey: 'k' });
    const response = await openai.execute(chatRequest());

    expect(response.metadata.provenance?.locality).toBe('external');
    expect(response.metadata.provenance?.servedBy).toBe('api.openai.com');
    expect(resolveEgress(response.metadata.provenance!)).toEqual({
      locality: 'external',
      declared: true,
    });
  });

  it('a subclass that does not override it (Groq) inherits external', async () => {
    stubFetch(OPENAI_BODY);
    const response = await new GroqBackendAdapter({ apiKey: 'k' }).execute(chatRequest());
    expect(response.metadata.provenance?.locality).toBe('external');
  });

  it('an OpenAI-compatible adapter pointed at a loopback server is same-host', async () => {
    stubFetch(OPENAI_BODY);
    const vllm = new OpenAIBackendAdapter({ apiKey: 'k', baseURL: 'http://127.0.0.1:8000/v1' });
    const response = await vllm.execute(chatRequest());
    expect(response.metadata.provenance?.locality).toBe('same-host');
    expect(response.metadata.provenance?.servedBy).toBe('127.0.0.1:8000');
  });

  it('LM Studio and OmniRoute are same-host by default, external when remote', async () => {
    stubFetch(OPENAI_BODY);
    const local = await new LMStudioBackendAdapter({} as never).execute(chatRequest());
    expect(local.metadata.provenance?.locality).toBe('same-host');

    const remote = await new LMStudioBackendAdapter({
      baseURL: 'http://192.168.1.50:1234/v1',
    } as never).execute(chatRequest());
    expect(remote.metadata.provenance?.locality).toBe('external');
    expect(remote.metadata.provenance?.servedBy).toBe('192.168.1.50:1234');

    const omni = await new OmniRouteBackendAdapter({} as never).execute(chatRequest());
    expect(omni.metadata.provenance?.locality).toBe('same-host');
  });

  it('Anthropic is external', async () => {
    stubFetch({
      id: 'x',
      model: 'm',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const response = await new AnthropicBackendAdapter({ apiKey: 'k' }).execute(chatRequest());
    expect(response.metadata.provenance?.locality).toBe('external');
  });

  describe('Ollama', () => {
    const body = {
      model: 'qwen2.5:3b',
      created_at: 'now',
      message: { role: 'assistant', content: 'ok' },
      done: true,
    };

    it('is same-host on the default loopback URL, with servedBy', async () => {
      stubFetch(body);
      const response = await new OllamaBackendAdapter({} as never).execute(chatRequest());

      expect(response.metadata.provenance).toMatchObject({
        backend: 'ollama-backend',
        locality: 'same-host',
        servedBy: 'localhost:11434',
      });
      expect(resolveEgress(response.metadata.provenance!)).toEqual({
        locality: 'same-host',
        declared: true,
      });
    });

    it('is external when pointed at another machine', async () => {
      stubFetch(body);
      const response = await new OllamaBackendAdapter({
        baseURL: 'http://desktop.lan:11434',
      } as never).execute(chatRequest());

      expect(response.metadata.provenance?.locality).toBe('external');
      expect(response.metadata.provenance?.servedBy).toBe('desktop.lan:11434');
    });

    it("declares it on the stream's start chunk too", async () => {
      stubFetch(body, `${JSON.stringify(body)}\n`);
      const chunks: IRStreamChunk[] = [];
      for await (const chunk of new OllamaBackendAdapter({} as never).executeStream(
        chatRequest()
      )) {
        chunks.push(chunk);
      }
      const start = chunks.find((c) => c.type === 'start') as unknown as {
        metadata: { provenance: Record<string, unknown> };
      };
      expect(start.metadata.provenance.locality).toBe('same-host');
    });

    it('does not inherit a locality the request arrived with', async () => {
      stubFetch(body);
      const response = await new OllamaBackendAdapter({
        baseURL: 'http://desktop.lan:11434',
      } as never).execute(chatRequest({ locality: 'in-process', servedBy: 'somewhere-else' }));

      expect(response.metadata.provenance?.locality).toBe('external');
      expect(response.metadata.provenance?.servedBy).toBe('desktop.lan:11434');
    });
  });

  describe('System One decisions', () => {
    const decision: IRDecisionRequest = {
      state: 's',
      questions: { q: { type: 'noul', instructions: 'Yes?' } },
      metadata: { requestId: 'r', timestamp: 0 },
    };
    const answerBody = {
      model: 'nimble',
      results: { q: { type: 'noul', value: 0.9 } },
      answers: { q: { type: 'noul', value: 0.9 } },
    };

    it('SystemOneBackendAdapter declares the locality of its server URL', async () => {
      stubFetch(answerBody);
      const local = await new SystemOneBackendAdapter({
        baseURL: 'http://localhost:8000/v1',
      }).decide(decision);
      expect(local.metadata.provenance).toMatchObject({
        locality: 'same-host',
        servedBy: 'localhost:8000',
      });

      const remote = await new SystemOneBackendAdapter({
        baseURL: 'https://gateway.example/v1',
      }).decide(decision);
      expect(remote.metadata.provenance).toMatchObject({
        locality: 'external',
        servedBy: 'gateway.example',
      });
    });
  });
});

describe('proxying adapters declare their own hop', () => {
  const far = {
    message: { role: 'assistant', content: 'ok' },
    finishReason: 'stop',
    metadata: {
      requestId: 'r',
      timestamp: 0,
      provenance: { backend: 'llama-cpp', locality: 'in-process' },
    },
  } as unknown as IRChatResponse;

  it('prepareForwardedResponse marks the proxy hop external unless told otherwise', () => {
    const out = prepareForwardedResponse(far, { proxyName: 'tunnel' });
    expect(out.metadata.provenance).toEqual({
      backend: 'tunnel',
      locality: 'external',
      upstream: { backend: 'llama-cpp', locality: 'in-process' },
    });
    expect(resolveEgress(out.metadata.provenance!).locality).toBe('external');
  });

  it('lets a loopback proxy say so, and still reports the widest link', () => {
    const out = prepareForwardedResponse(far, { proxyName: 'daemon', locality: 'same-host' });
    expect(out.metadata.provenance?.locality).toBe('same-host');
    expect(resolveEgress(out.metadata.provenance!).locality).toBe('same-host');
  });
});
