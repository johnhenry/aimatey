/**
 * The official `openai` SDK against aimatey's OpenAI frontend over HTTP.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import OpenAI from 'openai';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { startHarness, collect, TOOL_CALL_ID, type Harness } from './harness.js';

let h: Harness;
let client: OpenAI;

beforeAll(async () => {
  h = await startHarness(new OpenAIFrontendAdapter());
  client = new OpenAI({ apiKey: 'test-key', baseURL: `${h.url}/v1`, maxRetries: 0 });
});
afterAll(() => h.close());

const messages = [{ role: 'user' as const, content: 'Hi' }];
const tools = [
  {
    type: 'function' as const,
    function: {
      name: 'get_weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    },
  },
];

describe('openai SDK', () => {
  it('plain reply', async () => {
    h.scenario = 'text';
    const res = await client.chat.completions.create({ model: 'gpt-4o', messages });
    expect(res.choices[0]!.message.content).toBe('Hello world');
    expect(res.choices[0]!.finish_reason).toBe('stop');
    expect(res.usage).toMatchObject({ prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 });
    expect(h.lastRequest?.parameters?.model).toBe('gpt-4o');
  });

  it('streamed reply', async () => {
    h.scenario = 'text';
    const stream = await client.chat.completions.create({
      model: 'gpt-4o',
      messages,
      stream: true,
    });
    const chunks = await collect(stream);
    const text = chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('');
    expect(text).toBe('Hello world');
    expect(
      chunks.at(-1)?.choices[0]?.finish_reason ?? chunks.at(-2)?.choices[0]?.finish_reason
    ).toBe('stop');
  });

  it('streamed reply with stream_options.include_usage', async () => {
    h.scenario = 'text';
    const stream = await client.chat.completions.create({
      model: 'gpt-4o',
      messages,
      stream: true,
      stream_options: { include_usage: true },
    });
    const chunks = await collect(stream);
    const withUsage = chunks.filter((c) => c.usage);
    expect(withUsage.at(-1)?.usage).toMatchObject({
      prompt_tokens: 7,
      completion_tokens: 2,
      total_tokens: 9,
    });
  });

  it('streamed reply through the stream helper', async () => {
    h.scenario = 'text';
    const runner = client.chat.completions.stream({ model: 'gpt-4o', messages });
    const final = await runner.finalChatCompletion();
    expect(final.choices[0]!.message.content).toBe('Hello world');
  });

  it('tool call', async () => {
    h.scenario = 'tool';
    const res = await client.chat.completions.create({ model: 'gpt-4o', messages, tools });
    const call = res.choices[0]!.message.tool_calls![0]!;
    expect(res.choices[0]!.finish_reason).toBe('tool_calls');
    expect(call.id).toBe(TOOL_CALL_ID);
    expect(call.type).toBe('function');
    if (call.type !== 'function') throw new Error('expected a function call');
    expect(call.function.name).toBe('get_weather');
    expect(JSON.parse(call.function.arguments)).toEqual({ city: 'Paris' });
  });

  it('streamed tool call', async () => {
    h.scenario = 'tool';
    const runner = client.chat.completions.stream({ model: 'gpt-4o', messages, tools });
    const final = await runner.finalChatCompletion();
    const call = final.choices[0]!.message.tool_calls![0]!;
    expect(final.choices[0]!.finish_reason).toBe('tool_calls');
    expect(call.id).toBe(TOOL_CALL_ID);
    if (call.type !== 'function') throw new Error('expected a function call');
    expect(call.function.name).toBe('get_weather');
    expect(JSON.parse(call.function.arguments)).toEqual({ city: 'Paris' });
  });

  it('error before the reply: typed RateLimitError', async () => {
    h.scenario = 'preError';
    const err = await client.chat.completions
      .create({ model: 'gpt-4o', messages })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAI.RateLimitError);
    expect((err as InstanceType<typeof OpenAI.APIError>).status).toBe(429);
  });

  it('error before the stream starts: typed RateLimitError', async () => {
    h.scenario = 'preError';
    const err = await (async () => {
      const stream = await client.chat.completions.create({
        model: 'gpt-4o',
        messages,
        stream: true,
      });
      await collect(stream);
    })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAI.RateLimitError);
    expect((err as InstanceType<typeof OpenAI.APIError>).status).toBe(429);
  });

  it.each(['midError', 'midThrow'] as const)(
    'error mid-stream (%s): the SDK raises it',
    async (s) => {
      h.scenario = s;
      const seen: string[] = [];
      const err = await (async () => {
        const stream = await client.chat.completions.create({
          model: 'gpt-4o',
          messages,
          stream: true,
        });
        for await (const c of stream) seen.push(c.choices[0]?.delta?.content ?? '');
      })().catch((e: unknown) => e);
      expect(seen.join('')).toBe('Hel');
      expect(err).toBeInstanceOf(OpenAI.APIError);
      expect((err as Error).message).toMatch(s === 'midError' ? /overloaded/ : /connection reset/);
    }
  );
});
