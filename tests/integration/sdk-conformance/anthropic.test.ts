/**
 * The official `@anthropic-ai/sdk` against aimatey's Anthropic frontend over HTTP.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { startHarness, collect, TOOL_CALL_ID, type Harness } from './harness.js';

let h: Harness;
let client: Anthropic;

beforeAll(async () => {
  h = await startHarness(new AnthropicFrontendAdapter());
  client = new Anthropic({ apiKey: 'test-key', baseURL: h.url, maxRetries: 0 });
});
afterAll(() => h.close());

const base = {
  model: 'claude-sonnet-4-5',
  max_tokens: 64,
  messages: [{ role: 'user' as const, content: 'Hi' }],
};
const tools = [
  {
    name: 'get_weather',
    input_schema: { type: 'object' as const, properties: { city: { type: 'string' } } },
  },
];

describe('@anthropic-ai/sdk', () => {
  it('plain reply', async () => {
    h.scenario = 'text';
    const msg = await client.messages.create(base);
    expect(msg.content).toEqual([expect.objectContaining({ type: 'text', text: 'Hello world' })]);
    expect(msg.stop_reason).toBe('end_turn');
    expect(msg.usage).toMatchObject({ input_tokens: 7, output_tokens: 2 });
    expect(h.lastRequest?.parameters?.model).toBe('claude-sonnet-4-5');
  });

  it('streamed reply: raw events and the stream helper', async () => {
    h.scenario = 'text';
    const events = await collect(await client.messages.create({ ...base, stream: true }));
    expect(events[0]!.type).toBe('message_start');
    expect(events.at(-1)!.type).toBe('message_stop');
    const text = events
      .map((e) =>
        e.type === 'content_block_delta' && e.delta.type === 'text_delta' ? e.delta.text : ''
      )
      .join('');
    expect(text).toBe('Hello world');

    const deltas: string[] = [];
    const stream = client.messages.stream(base).on('text', (t) => deltas.push(t));
    const final = await stream.finalMessage();
    expect(deltas.join('')).toBe('Hello world');
    expect(final.content).toEqual([expect.objectContaining({ type: 'text', text: 'Hello world' })]);
    expect(final.stop_reason).toBe('end_turn');
    expect(final.usage.output_tokens).toBe(2);
  });

  it('tool call', async () => {
    h.scenario = 'tool';
    const msg = await client.messages.create({ ...base, tools });
    expect(msg.stop_reason).toBe('tool_use');
    const block = msg.content.find((b) => b.type === 'tool_use');
    expect(block).toMatchObject({
      id: TOOL_CALL_ID,
      name: 'get_weather',
      input: { city: 'Paris' },
    });
  });

  it('streamed tool call', async () => {
    h.scenario = 'tool';
    const final = await client.messages.stream({ ...base, tools }).finalMessage();
    expect(final.stop_reason).toBe('tool_use');
    const block = final.content.find((b) => b.type === 'tool_use');
    expect(block).toMatchObject({
      id: TOOL_CALL_ID,
      name: 'get_weather',
      input: { city: 'Paris' },
    });
  });

  it('error before the reply: typed RateLimitError', async () => {
    h.scenario = 'preError';
    const err = await client.messages.create(base).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.RateLimitError);
    expect((err as InstanceType<typeof Anthropic.APIError>).status).toBe(429);
  });

  it('error before the stream starts: typed RateLimitError', async () => {
    h.scenario = 'preError';
    const err = await client.messages
      .stream(base)
      .finalMessage()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.RateLimitError);
    expect((err as InstanceType<typeof Anthropic.APIError>).status).toBe(429);
  });

  it.each(['midError', 'midThrow'] as const)(
    'error mid-stream (%s): the SDK raises it',
    async (s) => {
      h.scenario = s;
      const deltas: string[] = [];
      const err = await client.messages
        .stream(base)
        .on('text', (t) => deltas.push(t))
        .finalMessage()
        .catch((e: unknown) => e);
      expect(deltas.join('')).toBe('Hel');
      expect(err).toBeInstanceOf(Anthropic.APIError);
      expect((err as Error).message).toMatch(s === 'midError' ? /overloaded/ : /connection reset/);
    }
  );
});
