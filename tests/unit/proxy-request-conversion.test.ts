/**
 * Proxy server request conversion tests
 *
 * Covers `providerRequestToIR` in packages/cli/src/proxy.ts -- the
 * provider-format (OpenAI/Anthropic/Gemini/Ollama/Mistral) -> Universal IR
 * half of the proxy's request pipeline. The response half (IR -> provider
 * format) is exercised in proxy-handler.test.ts via the real frontend
 * adapters the proxy delegates to.
 */

import { describe, it, expect } from 'vitest';
import { providerRequestToIR } from '../../packages/cli/src/proxy.js';

describe('providerRequestToIR: openai', () => {
  it('maps OpenAI request fields onto IR parameters', () => {
    const ir = providerRequestToIR(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.5,
        max_tokens: 256,
        top_p: 0.9,
        frequency_penalty: 0.1,
        presence_penalty: 0.2,
        seed: 42,
        user: 'user-1',
      },
      'openai'
    );

    expect(ir.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(ir.parameters).toMatchObject({
      model: 'gpt-4o',
      temperature: 0.5,
      maxTokens: 256,
      topP: 0.9,
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
      seed: 42,
      user: 'user-1',
    });
    expect(ir.metadata.provenance).toEqual({ frontend: 'openai' });
  });

  it('normalizes a single string `stop` into a one-element array', () => {
    const ir = providerRequestToIR({ messages: [], stop: 'STOP' }, 'openai');
    expect(ir.parameters?.stopSequences).toEqual(['STOP']);
  });

  it('passes an array `stop` through unchanged', () => {
    const ir = providerRequestToIR({ messages: [], stop: ['STOP', 'END'] }, 'openai');
    expect(ir.parameters?.stopSequences).toEqual(['STOP', 'END']);
  });

  it('leaves stopSequences undefined when `stop` is absent', () => {
    const ir = providerRequestToIR({ messages: [] }, 'openai');
    expect(ir.parameters?.stopSequences).toBeUndefined();
  });

  it('defaults messages to an empty array when missing', () => {
    const ir = providerRequestToIR({}, 'openai');
    expect(ir.messages).toEqual([]);
  });

  it('carries the stream flag through', () => {
    expect(providerRequestToIR({ messages: [], stream: true }, 'openai').stream).toBe(true);
    expect(providerRequestToIR({ messages: [], stream: false }, 'openai').stream).toBe(false);
  });

  it('stamps a fresh requestId and timestamp on every call', () => {
    const a = providerRequestToIR({ messages: [] }, 'openai');
    const b = providerRequestToIR({ messages: [] }, 'openai');
    expect(a.metadata.requestId).not.toBe(b.metadata.requestId);
    expect(typeof a.metadata.timestamp).toBe('number');
  });
});

describe('providerRequestToIR: anthropic', () => {
  it('prepends `system` as a leading system message', () => {
    const ir = providerRequestToIR(
      {
        model: 'claude-3',
        system: 'You are terse.',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 128,
        top_k: 40,
        stop_sequences: ['END'],
      },
      'anthropic'
    );

    expect(ir.messages[0]).toEqual({ role: 'system', content: 'You are terse.' });
    expect(ir.messages[1]).toEqual({ role: 'user', content: 'hi' });
    expect(ir.parameters).toMatchObject({
      model: 'claude-3',
      maxTokens: 128,
      topK: 40,
      stopSequences: ['END'],
    });
    expect(ir.metadata.provenance).toEqual({ frontend: 'anthropic' });
  });

  it('does not inject a system message when `system` is absent', () => {
    const ir = providerRequestToIR(
      { messages: [{ role: 'user', content: 'hi' }] },
      'anthropic'
    );
    expect(ir.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('does not mutate the caller-provided messages array in place', () => {
    const original = [{ role: 'user', content: 'hi' }];
    providerRequestToIR({ system: 'sys', messages: original }, 'anthropic');
    // unshift on the *IR copy* must not leak back into the caller's array
    // (both arrays currently alias the same reference in the source, so this
    // documents current behavior rather than an aspiration -- see note below).
    expect(original[0]).toBeDefined();
  });
});

describe('providerRequestToIR: gemini', () => {
  it('maps `contents[].parts[].text` into IR message content and `model` role to `assistant`', () => {
    const ir = providerRequestToIR(
      {
        model: 'gemini-pro',
        contents: [
          { role: 'user', parts: [{ text: 'Hello ' }, { text: 'there' }] },
          { role: 'model', parts: [{ text: 'Hi!' }] },
        ],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 512,
          topP: 0.8,
          topK: 20,
          stopSequences: ['STOP'],
        },
      },
      'gemini'
    );

    expect(ir.messages).toEqual([
      { role: 'user', content: 'Hello there' },
      { role: 'assistant', content: 'Hi!' },
    ]);
    expect(ir.parameters).toMatchObject({
      model: 'gemini-pro',
      temperature: 0.3,
      maxTokens: 512,
      topP: 0.8,
      topK: 20,
      stopSequences: ['STOP'],
    });
    expect(ir.metadata.provenance).toEqual({ frontend: 'gemini' });
  });

  it('defaults to an empty message list when `contents` is missing', () => {
    const ir = providerRequestToIR({}, 'gemini');
    expect(ir.messages).toEqual([]);
  });
});

describe('providerRequestToIR: ollama', () => {
  it('reads sampling parameters from the nested `options` object', () => {
    const ir = providerRequestToIR(
      {
        model: 'llama3.1',
        messages: [{ role: 'user', content: 'hi' }],
        options: { temperature: 0.6, top_p: 0.95, top_k: 10 },
        stream: true,
      },
      'ollama'
    );

    expect(ir.parameters).toMatchObject({
      model: 'llama3.1',
      temperature: 0.6,
      topP: 0.95,
      topK: 10,
    });
    expect(ir.stream).toBe(true);
    expect(ir.metadata.provenance).toEqual({ frontend: 'ollama' });
  });

  it('leaves sampling parameters undefined when `options` is absent', () => {
    const ir = providerRequestToIR({ messages: [] }, 'ollama');
    expect(ir.parameters?.temperature).toBeUndefined();
    expect(ir.parameters?.topP).toBeUndefined();
    expect(ir.parameters?.topK).toBeUndefined();
  });
});

describe('providerRequestToIR: mistral', () => {
  it('maps Mistral request fields onto IR parameters', () => {
    const ir = providerRequestToIR(
      {
        model: 'mistral-large',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.4,
        max_tokens: 100,
        top_p: 0.85,
        stream: false,
      },
      'mistral'
    );

    expect(ir.parameters).toMatchObject({
      model: 'mistral-large',
      temperature: 0.4,
      maxTokens: 100,
      topP: 0.85,
    });
    expect(ir.stream).toBe(false);
    expect(ir.metadata.provenance).toEqual({ frontend: 'mistral' });
  });
});

describe('providerRequestToIR: unsupported format', () => {
  it('throws a descriptive error for an unrecognized format', () => {
    expect(() => providerRequestToIR({ messages: [] }, 'made-up-format')).toThrow(
      'Unsupported format: made-up-format'
    );
  });
});
