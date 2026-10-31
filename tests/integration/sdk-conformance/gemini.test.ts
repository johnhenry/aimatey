/**
 * The official `@google/genai` SDK against aimatey's Gemini frontend over HTTP.
 * The SDK streams with `:streamGenerateContent?alt=sse`; the JSON-array
 * framing (no `alt=sse`) is checked with a plain fetch.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GoogleGenAI, ApiError } from '@google/genai';
import { GeminiFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { startHarness, collect, TOOL_CALL_ID, type Harness } from './harness.js';

let h: Harness;
let ai: GoogleGenAI;

beforeAll(async () => {
  h = await startHarness(new GeminiFrontendAdapter());
  ai = new GoogleGenAI({ apiKey: 'test-key', httpOptions: { baseUrl: h.url } });
});
afterAll(() => h.close());

const model = 'gemini-2.5-flash';
const tools = [
  {
    functionDeclarations: [
      {
        name: 'get_weather',
        parametersJsonSchema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ],
  },
];

describe('@google/genai', () => {
  it('plain reply', async () => {
    h.scenario = 'text';
    const res = await ai.models.generateContent({ model, contents: 'Hi' });
    expect(res.text).toBe('Hello world');
    expect(res.candidates?.[0]?.finishReason).toBe('STOP');
    expect(res.usageMetadata).toMatchObject({
      promptTokenCount: 7,
      candidatesTokenCount: 2,
      totalTokenCount: 9,
    });
    // The model comes from the URL (models/{model}:generateContent).
    expect(h.lastRequest?.parameters?.model).toBe(model);
  });

  it('streamed reply (alt=sse)', async () => {
    h.scenario = 'text';
    const chunks = await collect(await ai.models.generateContentStream({ model, contents: 'Hi' }));
    expect(chunks.map((c) => c.text ?? '').join('')).toBe('Hello world');
    expect(chunks.at(-1)?.candidates?.[0]?.finishReason).toBe('STOP');
    expect(chunks.at(-1)?.usageMetadata?.totalTokenCount).toBe(9);
    expect(h.lastRequest?.parameters?.model).toBe(model);
  });

  it('streamed reply without alt=sse: one JSON array of GenerateContentResponse', async () => {
    h.scenario = 'text';
    const res = await fetch(`${h.url}/v1beta/models/${model}:streamGenerateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': 'test-key' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Hi' }] }] }),
    });
    expect(res.headers.get('content-type')).toContain('application/json');
    const arr = (await res.json()) as Array<{
      candidates: Array<{ content: { parts: Array<{ text?: string }> }; finishReason?: string }>;
    }>;
    expect(arr.map((c) => c.candidates[0]!.content.parts[0]!.text).join('')).toBe('Hello world');
    expect(arr.at(-1)!.candidates[0]!.finishReason).toBe('STOP');
  });

  it('tool call', async () => {
    h.scenario = 'tool';
    const res = await ai.models.generateContent({ model, contents: 'Weather?', config: { tools } });
    expect(res.functionCalls).toEqual([
      expect.objectContaining({ id: TOOL_CALL_ID, name: 'get_weather', args: { city: 'Paris' } }),
    ]);
    expect(h.lastRequest?.tools?.[0]?.name).toBe('get_weather');
  });

  it('streamed tool call', async () => {
    h.scenario = 'tool';
    const chunks = await collect(
      await ai.models.generateContentStream({ model, contents: 'Weather?', config: { tools } })
    );
    const calls = chunks.flatMap((c) => c.functionCalls ?? []);
    expect(calls).toEqual([
      expect.objectContaining({ id: TOOL_CALL_ID, name: 'get_weather', args: { city: 'Paris' } }),
    ]);
  });

  it('error before the reply: ApiError with status 429', async () => {
    h.scenario = 'preError';
    const err = await ai.models.generateContent({ model, contents: 'Hi' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
  });

  it('error before the stream starts: ApiError with status 429', async () => {
    h.scenario = 'preError';
    const err = await (async () => {
      await collect(await ai.models.generateContentStream({ model, contents: 'Hi' }));
    })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
  });

  it.each(['midError', 'midThrow'] as const)(
    'error mid-stream (%s): the SDK raises it',
    async (s) => {
      h.scenario = s;
      const seen: string[] = [];
      const err = await (async () => {
        for await (const c of await ai.models.generateContentStream({ model, contents: 'Hi' })) {
          seen.push(c.text ?? '');
        }
      })().catch((e: unknown) => e);
      expect(seen.join('')).toBe('Hel');
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(s === 'midError' ? /overloaded/ : /connection reset/);
    }
  );
});
