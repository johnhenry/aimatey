/**
 * The served model on the chat response (#113).
 *
 * The IR had no typed place to record *which model answered*. `IRParameters.model` is the
 * request side, so the only source was the provider's own payload in `raw` -- which couples
 * any generic reader to provider payload shapes, and simply cannot see Gemini, whose key is
 * `modelVersion`. Two independent improvisations existed because of the gap:
 * `openrouter`'s `metadata.custom.actualModel` (a write with no reader) and the dead
 * `provenance.backendModel` read removed by #112.
 *
 * `IRProvenance.servedModel` is that place. It sits on provenance rather than flat on the
 * response because it is a **per-hop** fact: in `phone -> desktop -> llama-cpp` the model
 * that answered belongs to the last hop, and the tunnel served nothing at all. A single
 * flat field could record only one of the two -- the ambiguity #110 removed from `backend`
 * one field over.
 *
 * The payoff these tests pin down: `'model-substituted'` becomes verifiable end to end. A
 * consumer was previously told a substitution had happened but could not learn *what*
 * answered without parsing `raw` per provider.
 */

import { describe, it, expect } from 'vitest';
import { Bridge, Router } from '@johnhenry/aimatey-core';
import { GenericFrontendAdapter, OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { resolveServedModel, withUpstreamProvenance } from '@johnhenry/aimatey-types';
import {
  OpenAIBackendAdapter,
  GeminiBackendAdapter,
  OpenRouterBackendAdapter,
  CohereBackendAdapter,
} from '@johnhenry/aimatey-backend';
import type {
  AdapterMetadata,
  BackendAdapter,
  IRCapabilities,
  IRChatRequest,
  IRChatResponse,
  IRProvenance,
  IRStreamChunk,
} from '@johnhenry/aimatey-types';

// ============================================================================
// Helpers
// ============================================================================

function makeRequest(model = 'gpt-4'): IRChatRequest {
  return {
    messages: [{ role: 'user', content: 'Hello' }],
    parameters: { model },
    metadata: { requestId: 'req-113', timestamp: Date.now(), provenance: {} },
  } satisfies IRChatRequest;
}

const CAPABILITIES = {
  streaming: true,
  multiModal: false,
  tools: false,
  systemMessageStrategy: 'in-messages' as const,
} as IRCapabilities;

/**
 * A backend that echoes back, as its served model, whichever model it was actually asked
 * for -- which is what a provider's `model` key amounts to once the router has finished
 * substituting. `defaultModel` is what the Router's hybrid translation falls back to.
 */
function createEchoBackend(name: string, defaultModel?: string): BackendAdapter {
  const metadata: AdapterMetadata = {
    name,
    version: '1.0.0',
    provider: 'mock',
    capabilities: CAPABILITIES,
  };

  return {
    metadata,
    config: defaultModel ? { defaultModel } : undefined,
    fromIR: (request: IRChatRequest) => request,
    toIR: (response: IRChatResponse) => response,

    async execute(request: IRChatRequest): Promise<IRChatResponse> {
      return {
        message: { role: 'assistant', content: 'answered' },
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        metadata: {
          ...request.metadata,
          provenance: {
            ...request.metadata.provenance,
            backend: name,
            servedModel: request.parameters?.model,
          },
        },
      };
    },

    async *executeStream(request: IRChatRequest): AsyncGenerator<IRStreamChunk, void, undefined> {
      yield { type: 'start', sequence: 0, metadata: request.metadata };
      yield { type: 'content', sequence: 1, delta: 'answered', role: 'assistant' };
      yield {
        type: 'done',
        sequence: 2,
        finishReason: 'stop',
        message: { role: 'assistant', content: 'answered' },
      };
    },
  } as unknown as BackendAdapter;
}

/**
 * A backend that forwards rather than serving: it names itself under `backend`, leaves its
 * own `servedModel` unset because it did not serve, and nests what the far side reported.
 */
function createProxyBackend(name: string, far: IRProvenance): BackendAdapter {
  const metadata: AdapterMetadata = {
    name,
    version: '1.0.0',
    provider: 'mock',
    capabilities: CAPABILITIES,
  };

  return {
    metadata,
    fromIR: (request: IRChatRequest) => request,
    toIR: (response: IRChatResponse) => response,

    async execute(request: IRChatRequest): Promise<IRChatResponse> {
      return {
        message: { role: 'assistant', content: 'answered on the desktop' },
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        metadata: {
          requestId: request.metadata.requestId,
          timestamp: Date.now(),
          provenance: withUpstreamProvenance({ backend: name }, far),
        },
      };
    },

    async *executeStream(request: IRChatRequest): AsyncGenerator<IRStreamChunk, void, undefined> {
      yield { type: 'start', sequence: 0, metadata: request.metadata };
      yield {
        type: 'done',
        sequence: 1,
        finishReason: 'stop',
        message: { role: 'assistant', content: '' },
      };
    },
  } as unknown as BackendAdapter;
}

// ============================================================================
// #113 (1) - resolveServedModel()
// ============================================================================

describe('resolveServedModel() (#113)', () => {
  it('reads the served model off a single hop', () => {
    expect(resolveServedModel({ backend: 'openai-backend', servedModel: 'gpt-4-0613' })).toBe(
      'gpt-4-0613'
    );
  });

  it('walks past a forwarding hop to the model that actually served', () => {
    // The canonical `phone -> desktop -> llama-cpp` chain. The tunnel has no `servedModel`
    // *because it did not serve* -- that omission is the design, not a gap.
    const chain: IRProvenance = {
      frontend: 'openai',
      backend: 'tunnel',
      upstream: {
        backend: 'llama-cpp',
        servedModel: 'qwen2.5-7b-instruct',
        router: 'desktop-router',
      },
    };

    expect(resolveServedModel(chain)).toBe('qwen2.5-7b-instruct');
  });

  it('walks a chain deeper than two hops', () => {
    const chain: IRProvenance = {
      backend: 'tunnel',
      upstream: {
        backend: 'gateway',
        upstream: { backend: 'llama-cpp', servedModel: 'qwen2.5-7b-instruct' },
      },
    };

    expect(resolveServedModel(chain)).toBe('qwen2.5-7b-instruct');
  });

  it('prefers the nearest hop that reported, not the far end', () => {
    // Nearest-first is the documented rule. A hop's `servedModel` is a true claim about that
    // hop, so the nearest one is never wrong -- and preferring it means a chain whose far hop
    // is a provider that reports nothing can still resolve, instead of returning undefined.
    const chain: IRProvenance = {
      backend: 'http-proxy',
      servedModel: 'parsed-off-the-wire',
      upstream: { backend: 'cohere' },
    };

    expect(resolveServedModel(chain)).toBe('parsed-off-the-wire');
  });

  it('returns undefined when no hop reported one', () => {
    // "Not reported" must stay distinguishable from "reported as X". Callers leave their
    // field absent rather than substituting the requested model.
    expect(resolveServedModel({ backend: 'cohere-backend' })).toBeUndefined();
    expect(
      resolveServedModel({ backend: 'tunnel', upstream: { backend: 'cohere-backend' } })
    ).toBeUndefined();
  });

  it('treats an empty string as not reported', () => {
    expect(resolveServedModel({ backend: 'x', servedModel: '' })).toBeUndefined();
    expect(
      resolveServedModel({
        backend: 'x',
        servedModel: '',
        upstream: { backend: 'y', servedModel: 'real' },
      })
    ).toBe('real');
  });

  it('accepts an absent provenance', () => {
    expect(resolveServedModel(undefined)).toBeUndefined();
  });
});

// ============================================================================
// #113 (2) - the field crosses a wire
// ============================================================================

describe('servedModel survives a JSON round trip (#113)', () => {
  // The IR must stay plain JSON: it crosses process and device boundaries, which is the
  // whole reason nesting was viable in #110. A getter, a class instance or a Map anywhere in
  // this chain would silently flatten on the far side.
  //
  // The chain is built by the *real* pipeline -- a shipped adapter's `toIR()` plus
  // `withUpstreamProvenance()` -- rather than written as a literal here, so that a change
  // making provenance non-plain actually fails this test instead of sailing past a
  // hand-rolled object.
  function realChain(): IRProvenance {
    const adapter = new OpenAIBackendAdapter({ apiKey: 'test' });
    const far = adapter.toIR(
      {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 0,
        model: 'qwen2.5-7b-instruct',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
        ],
      } as never,
      makeRequest('qwen2.5'),
      5
    ).metadata.provenance;

    return withUpstreamProvenance(
      {
        frontend: 'openai-frontend',
        backend: 'tunnel',
        router: 'phone-router',
        middleware: ['auth'],
      },
      far
    );
  }

  it('deep-equals itself after JSON.parse(JSON.stringify(...))', () => {
    const chain = realChain();
    const roundTripped = JSON.parse(JSON.stringify(chain)) as IRProvenance;

    expect(roundTripped).toEqual(chain);

    // `toEqual` compares only *enumerable* own properties, so it alone would not notice a
    // hop whose fields had become getters or been hidden behind a class. Comparing the full
    // own-property set at each hop is what actually pins "the IR is plain JSON".
    expect(Object.getOwnPropertyNames(roundTripped)).toEqual(Object.getOwnPropertyNames(chain));
    expect(Object.getOwnPropertyNames(roundTripped.upstream!)).toEqual(
      Object.getOwnPropertyNames(chain.upstream!)
    );
  });

  it('carries the served model through the serialised form', () => {
    const chain = realChain();

    expect(JSON.stringify(chain)).toContain('"servedModel":"qwen2.5-7b-instruct"');
  });

  it('resolves to the same served model on the far side of the wire', () => {
    const chain = realChain();
    const roundTripped = JSON.parse(JSON.stringify(chain)) as IRProvenance;

    expect(resolveServedModel(roundTripped)).toBe('qwen2.5-7b-instruct');
    expect(resolveServedModel(roundTripped)).toBe(resolveServedModel(chain));
  });

  it('drops an unreported served model rather than serialising a null', () => {
    // Adapters assign a plain key, so a provider that reports nothing leaves
    // `servedModel: undefined` present in memory. JSON.stringify omits it, so the wire form
    // is the same either way and no consumer sees a null model name.
    const adapter = new CohereBackendAdapter({ apiKey: 'test' });
    const provenance = adapter.toIR(
      {
        id: 'gen-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        finish_reason: 'COMPLETE',
      } as never,
      makeRequest('command-r'),
      5
    ).metadata.provenance;

    expect(JSON.stringify(provenance)).not.toContain('servedModel');
    expect(JSON.stringify(provenance)).not.toContain('null');
    expect(
      resolveServedModel(JSON.parse(JSON.stringify(provenance)) as IRProvenance)
    ).toBeUndefined();
  });
});

// ============================================================================
// #113 (3) - backend adapters populate it from the provider payload
// ============================================================================

describe('backend adapters report the served model (#113)', () => {
  it('OpenAI-shaped adapters read the provider echo, not the requested model', () => {
    const adapter = new OpenAIBackendAdapter({ apiKey: 'test' });

    const ir = adapter.toIR(
      {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 0,
        model: 'gpt-4-0613', // what answered
        choices: [
          { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
        ],
      } as never,
      makeRequest('gpt-4'), // what was asked for
      5
    );

    expect(ir.metadata.provenance?.servedModel).toBe('gpt-4-0613');
    expect(ir.metadata.provenance?.servedModel).not.toBe(ir.metadata.requestId);
    expect(resolveServedModel(ir.metadata.provenance)).toBe('gpt-4-0613');
  });

  it('Gemini reports it from modelVersion, which no generic raw.model read could see', () => {
    // The concrete coverage win over #112: Gemini has no top-level `model` key at all, so
    // the previous `raw.model` read left the attribute unset for every Gemini response.
    const adapter = new GeminiBackendAdapter({ apiKey: 'test' });

    const ir = adapter.toIR(
      {
        candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
        modelVersion: 'gemini-3.6-flash-001',
      } as never,
      makeRequest('gemini-3.6-flash'),
      5
    );

    expect(ir.raw?.['model']).toBeUndefined(); // the old mechanism genuinely cannot see it
    expect(ir.metadata.provenance?.servedModel).toBe('gemini-3.6-flash-001');
  });

  it('Cohere leaves it unset, because Cohere does not report it', () => {
    // "Absent" is an acceptable outcome; "wrong" is not. Cohere's v2 /chat response has no
    // model field, so this must not fall back to the requested model.
    const adapter = new CohereBackendAdapter({ apiKey: 'test' });

    const ir = adapter.toIR(
      {
        id: 'gen-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        finish_reason: 'COMPLETE',
      } as never,
      makeRequest('command-r'),
      5
    );

    expect(ir.metadata.provenance?.servedModel).toBeUndefined();
    expect(resolveServedModel(ir.metadata.provenance)).toBeUndefined();
    expect(ir.metadata.provenance?.servedModel).not.toBe('command-r');
  });

  it('a provider that reports no model does not inherit one from the hop before it', () => {
    // The four adapters that cannot report a served model all build their provenance as
    // `{ ...originalRequest.metadata.provenance, backend: this.metadata.name }`. That spread
    // carries an upstream hop's `servedModel` straight through, and the very next line
    // relabels the hop as this backend -- so the response would claim THIS provider served a
    // model it has never heard of. The test above cannot catch it: `makeRequest` sends empty
    // provenance, so there is nothing to inherit.
    const upstream: IRChatRequest = {
      messages: [{ role: 'user', content: 'Hello' }],
      parameters: { model: 'command-r' },
      metadata: {
        requestId: 'req-113',
        timestamp: Date.now(),
        provenance: { backend: 'some-earlier-hop', servedModel: 'qwen2.5-7b-instruct' },
      },
    } satisfies IRChatRequest;

    const adapter = new CohereBackendAdapter({ apiKey: 'test' });
    const ir = adapter.toIR(
      {
        id: 'gen-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        finish_reason: 'COMPLETE',
      } as never,
      upstream,
      5
    );

    expect(ir.metadata.provenance?.backend).toBe(adapter.metadata.name);
    expect(ir.metadata.provenance?.servedModel).toBeUndefined();
    expect(ir.metadata.provenance?.servedModel).not.toBe('qwen2.5-7b-instruct');
    expect(resolveServedModel(ir.metadata.provenance)).toBeUndefined();
  });

  it('OpenRouter fills the typed field and keeps custom.actualModel as a deprecated alias', () => {
    // Removing the alias would be an invisible break: `custom` is Record<string, unknown>,
    // so an external reader gets no compile error and no lint warning -- just undefined at
    // runtime. Both are computed from one read, so they cannot disagree.
    const adapter = new OpenRouterBackendAdapter({ apiKey: 'test' });

    const ir = adapter.toIR(
      {
        id: 'gen-1',
        object: 'chat.completion',
        created: 0,
        model: 'meta-llama/llama-3.1-70b-instruct', // OpenRouter routed elsewhere
        choices: [
          { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
        ],
      } as never,
      makeRequest('openai/gpt-4'),
      5
    );

    expect(ir.metadata.provenance?.servedModel).toBe('meta-llama/llama-3.1-70b-instruct');
    expect(ir.metadata.custom?.['actualModel']).toBe(ir.metadata.provenance?.servedModel);
  });
});

// ============================================================================
// #113 (4) - multi-hop, through a real Bridge
// ============================================================================

describe('a proxied response reports the model that actually served (#113)', () => {
  const DESKTOP: IRProvenance = {
    frontend: 'openai-frontend',
    backend: 'llama-cpp',
    router: 'desktop-router',
    servedModel: 'qwen2.5-7b-instruct',
  };

  it('keeps the near hop honest while naming the far model', async () => {
    const bridge = new Bridge(new GenericFrontendAdapter(), createProxyBackend('tunnel', DESKTOP));

    const response = (await bridge.chat(makeRequest())) as IRChatResponse;
    const provenance = response.metadata.provenance!;

    // The phone talked to a tunnel and served nothing itself...
    expect(provenance.backend).toBe('tunnel');
    expect(provenance.servedModel).toBeUndefined();
    // ...while the model that answered is recoverable, per-hop, from the far link.
    expect(provenance.upstream?.servedModel).toBe('qwen2.5-7b-instruct');
    expect(resolveServedModel(provenance)).toBe('qwen2.5-7b-instruct');
  });

  it('is exactly what a single flat field could not express', async () => {
    // Both facts are simultaneously true and distinguishable: the near hop ran a tunnel,
    // and something else ran qwen. One string could hold only one of them.
    const bridge = new Bridge(new GenericFrontendAdapter(), createProxyBackend('tunnel', DESKTOP));

    const response = (await bridge.chat(makeRequest())) as IRChatResponse;
    const provenance = response.metadata.provenance!;

    expect(provenance.backend).not.toBe(resolveServedModel(provenance));
    expect(provenance.upstream?.backend).toBe('llama-cpp');
  });
});

// ============================================================================
// #113 (5) - 'model-substituted', end to end
// ============================================================================

describe("'model-substituted' says what answered, not just that something did (#113)", () => {
  it('names the substituted model on the response, alongside the warning', async () => {
    // The Router's hybrid translation has no mapping for 'gpt-4' on this backend, so it
    // falls back to the backend's default model and warns. Before #113 a consumer got the
    // warning but had to parse `raw` per provider to learn what actually ran.
    const router = new Router({ routingStrategy: 'explicit', defaultBackend: 'local' });
    router.register('local', createEchoBackend('local', 'llama-3.1-8b'));

    const bridge = new Bridge(new GenericFrontendAdapter(), router);
    const response = (await bridge.chat(makeRequest('gpt-4'))) as IRChatResponse;

    const warning = response.metadata.warnings?.find((w) => w.category === 'model-substituted');
    expect(warning).toBeDefined();

    const served = resolveServedModel(response.metadata.provenance);
    expect(served).toBe('llama-3.1-8b');
    expect(served).not.toBe('gpt-4');
    // The pair is the point: what was asked for, and what answered.
    expect(warning?.originalValue).toBe('gpt-4');
    expect(warning?.transformedValue).toBe(served);
  });

  it('reports the requested model when no substitution happened', async () => {
    const router = new Router({ routingStrategy: 'explicit', defaultBackend: 'local' });
    router.register('local', createEchoBackend('local'));

    const bridge = new Bridge(new GenericFrontendAdapter(), router);
    const response = (await bridge.chat(makeRequest('gpt-4'))) as IRChatResponse;

    expect(response.metadata.warnings?.some((w) => w.category === 'model-substituted')).toBeFalsy();
    expect(resolveServedModel(response.metadata.provenance)).toBe('gpt-4');
  });
});

// ============================================================================
// #113 (6) - the frontend wire projection
// ============================================================================

describe('a frontend projects the served model onto the wire (#113)', () => {
  it('emits the model that answered, not the backend adapter name', async () => {
    // This is "improvising it per provider" in the issue title, literally: the OpenAI
    // frontend used to emit `provenance.backend`, so an HTTP client of an aimatey server
    // was handed `"model": "openai-backend"` in an otherwise OpenAI-shaped payload.
    const adapter = new OpenAIFrontendAdapter();

    const projected = await adapter.fromIR({
      message: { role: 'assistant', content: 'hi' },
      finishReason: 'stop',
      metadata: {
        requestId: 'req-113',
        timestamp: Date.now(),
        provenance: { backend: 'openai-backend', servedModel: 'gpt-4-0613' },
      },
    } as IRChatResponse);

    expect(projected.model).toBe('gpt-4-0613');
    expect(projected.model).not.toBe('openai-backend');
  });

  it('falls back to the backend name only when nothing reported a served model', async () => {
    // Preserves today's behaviour for the providers that genuinely do not report one, so
    // nothing that had a value loses one.
    const adapter = new OpenAIFrontendAdapter();

    const projected = await adapter.fromIR({
      message: { role: 'assistant', content: 'hi' },
      finishReason: 'stop',
      metadata: {
        requestId: 'req-113',
        timestamp: Date.now(),
        provenance: { backend: 'cohere-backend' },
      },
    } as IRChatResponse);

    expect(projected.model).toBe('cohere-backend');
  });

  it('projects the far model across a proxy hop', async () => {
    const adapter = new OpenAIFrontendAdapter();

    const projected = await adapter.fromIR({
      message: { role: 'assistant', content: 'hi' },
      finishReason: 'stop',
      metadata: {
        requestId: 'req-113',
        timestamp: Date.now(),
        provenance: {
          backend: 'tunnel',
          upstream: { backend: 'llama-cpp', servedModel: 'qwen2.5-7b-instruct' },
        },
      },
    } as IRChatResponse);

    expect(projected.model).toBe('qwen2.5-7b-instruct');
  });
});
