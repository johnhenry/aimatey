/**
 * The official `ollama` SDK against aimatey's Ollama frontends over HTTP:
 * `OllamaFrontendAdapter` for `/api/chat`, `OllamaGenerateFrontendAdapter`
 * for `/api/generate`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Ollama } from 'ollama';
import { OllamaFrontendAdapter, OllamaGenerateFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { startHarness, collect, TOOL_CALL_ID, type Harness } from './harness.js';

let chat: Harness;
let gen: Harness;
let chatClient: Ollama;
let genClient: Ollama;

beforeAll(async () => {
  chat = await startHarness(new OllamaFrontendAdapter());
  gen = await startHarness(new OllamaGenerateFrontendAdapter());
  chatClient = new Ollama({ host: chat.url });
  genClient = new Ollama({ host: gen.url });
});
afterAll(async () => {
  await chat.close();
  await gen.close();
});

const model = 'llama3.1:8b';
const messages = [{ role: 'user', content: 'Hi' }];
const tools = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    },
  },
];

/** The status of an `ollama` ResponseError (not exported by the package). */
const statusOf = (e: unknown) => (e as { status_code?: number }).status_code;

describe('ollama SDK: chat', () => {
  it('plain reply', async () => {
    chat.scenario = 'text';
    const res = await chatClient.chat({ model, messages, stream: false });
    expect(res.message).toMatchObject({ role: 'assistant', content: 'Hello world' });
    expect(res).toMatchObject({
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 7,
      eval_count: 2,
    });
    expect(chat.lastRequest?.parameters?.model).toBe(model);
  });

  it('streamed reply', async () => {
    chat.scenario = 'text';
    const parts = await collect(await chatClient.chat({ model, messages, stream: true }));
    expect(parts.map((p) => p.message.content).join('')).toBe('Hello world');
    expect(parts.at(-1)).toMatchObject({ done: true, done_reason: 'stop', eval_count: 2 });
  });

  it('tool call', async () => {
    chat.scenario = 'tool';
    const res = await chatClient.chat({ model, messages, tools, stream: false });
    expect(res.message.tool_calls).toEqual([
      expect.objectContaining({
        function: expect.objectContaining({ name: 'get_weather', arguments: { city: 'Paris' } }),
      }),
    ]);
    expect((res.message.tool_calls![0] as { id?: string }).id).toBe(TOOL_CALL_ID);
  });

  it('streamed tool call', async () => {
    chat.scenario = 'tool';
    const parts = await collect(await chatClient.chat({ model, messages, tools, stream: true }));
    const calls = parts.flatMap((p) => p.message.tool_calls ?? []);
    expect(calls).toEqual([
      expect.objectContaining({
        function: expect.objectContaining({ name: 'get_weather', arguments: { city: 'Paris' } }),
      }),
    ]);
    expect(parts.at(-1)?.done).toBe(true);
  });

  it('error before the reply: ResponseError with status 429', async () => {
    chat.scenario = 'preError';
    const err = await chatClient.chat({ model, messages, stream: false }).catch((e: unknown) => e);
    expect((err as Error).name).toBe('ResponseError');
    expect(statusOf(err)).toBe(429);
    expect((err as Error).message).toMatch(/rate limit/i);
  });

  it('error before the stream starts: ResponseError with status 429', async () => {
    chat.scenario = 'preError';
    const err = await (async () => {
      await collect(await chatClient.chat({ model, messages, stream: true }));
    })().catch((e: unknown) => e);
    expect((err as Error).name).toBe('ResponseError');
    expect(statusOf(err)).toBe(429);
  });

  it.each(['midError', 'midThrow'] as const)(
    'error mid-stream (%s): the SDK raises it',
    async (s) => {
      chat.scenario = s;
      const seen: string[] = [];
      const err = await (async () => {
        for await (const p of await chatClient.chat({ model, messages, stream: true })) {
          seen.push(p.message.content);
        }
      })().catch((e: unknown) => e);
      expect(seen.join('')).toBe('Hel');
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(s === 'midError' ? /overloaded/ : /connection reset/);
    }
  );
});

describe('ollama SDK: generate', () => {
  it('plain reply', async () => {
    gen.scenario = 'text';
    const res = await genClient.generate({
      model,
      prompt: 'Hi',
      system: 'Be brief',
      stream: false,
    });
    expect(res).toMatchObject({ response: 'Hello world', done: true, done_reason: 'stop' });
    expect(gen.lastRequest?.messages).toEqual([
      { role: 'system', content: 'Be brief' },
      { role: 'user', content: 'Hi' },
    ]);
  });

  it('streamed reply', async () => {
    gen.scenario = 'text';
    const parts = await collect(await genClient.generate({ model, prompt: 'Hi', stream: true }));
    expect(parts.map((p) => p.response).join('')).toBe('Hello world');
    expect(parts.at(-1)).toMatchObject({ done: true, eval_count: 2, prompt_eval_count: 7 });
  });

  it('error before the stream starts: ResponseError with status 429', async () => {
    gen.scenario = 'preError';
    const err = await (async () => {
      await collect(await genClient.generate({ model, prompt: 'Hi', stream: true }));
    })().catch((e: unknown) => e);
    expect((err as Error).name).toBe('ResponseError');
    expect(statusOf(err)).toBe(429);
  });

  it('error mid-stream: the SDK raises it', async () => {
    gen.scenario = 'midError';
    const seen: string[] = [];
    const err = await (async () => {
      for await (const p of await genClient.generate({ model, prompt: 'Hi', stream: true })) {
        seen.push(p.response);
      }
    })().catch((e: unknown) => e);
    expect(seen.join('')).toBe('Hel');
    expect((err as Error).message).toMatch(/overloaded/);
  });
});
