/**
 * Per-API stream framing in http.core: OpenAI SSE ends with [DONE]; Gemini is
 * SSE (alt=sse) or one JSON array, never [DONE]; Ollama is NDJSON.
 */

import { describe, it, expect } from 'vitest';
import {
  createStreamFramer,
  detectStreamFraming,
  isGeminiStreamURL,
  geminiModelFromURL,
  requestWantsStream,
  type StreamFraming,
} from '@johnhenry/aimatey-http-core';

function frameAll(framing: StreamFraming, chunks: unknown[]): string {
  const f = createStreamFramer(framing);
  return chunks.map((c) => f.frame(c)).join('') + f.end();
}

describe('detectStreamFraming', () => {
  it.each([
    ['/v1/chat/completions', undefined, 'openai'],
    ['/v1/messages', undefined, 'anthropic'],
    ['/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse', undefined, 'gemini'],
    ['/v1beta/models/gemini-2.5-flash:streamGenerateContent', { alt: 'sse' }, 'gemini'],
    ['/v1beta/models/gemini-2.5-flash:streamGenerateContent', undefined, 'gemini-array'],
    ['/v1beta/models/gemini-2.5-flash:generateContent', undefined, 'gemini-array'],
    ['/api/chat', undefined, 'ollama'],
    ['/api/generate', undefined, 'ollama'],
    ['/whatever', undefined, 'generic'],
  ] as const)('%s -> %s', (url, query, expected) => {
    expect(detectStreamFraming(url, query)).toBe(expected);
  });

  it('recognises Gemini streaming URLs', () => {
    expect(isGeminiStreamURL('/v1beta/models/m:streamGenerateContent?alt=sse')).toBe(true);
    expect(isGeminiStreamURL('/v1beta/models/m:generateContent')).toBe(false);
  });
});

describe('createStreamFramer', () => {
  const a = { n: 1 };
  const b = { n: 2 };

  it('openai / generic: SSE data lines ending with [DONE]', () => {
    for (const framing of ['openai', 'generic'] as const) {
      expect(createStreamFramer(framing).contentType).toBe('text/event-stream');
      expect(frameAll(framing, [a, b])).toBe('data: {"n":1}\n\ndata: {"n":2}\n\ndata: [DONE]\n\n');
    }
  });

  it('gemini (alt=sse): SSE data lines, no [DONE]', () => {
    expect(createStreamFramer('gemini').contentType).toBe('text/event-stream');
    const out = frameAll('gemini', [a, b]);
    expect(out).toBe('data: {"n":1}\r\n\r\ndata: {"n":2}\r\n\r\n');
    expect(out).not.toContain('[DONE]');
  });

  it('gemini-array: one JSON array', () => {
    expect(createStreamFramer('gemini-array').contentType).toBe('application/json');
    const out = frameAll('gemini-array', [a, b]);
    expect(JSON.parse(out)).toEqual([a, b]);
    expect(JSON.parse(frameAll('gemini-array', []))).toEqual([]);
  });

  it('ollama: NDJSON, no [DONE]', () => {
    expect(createStreamFramer('ollama').contentType).toBe('application/x-ndjson');
    const out = frameAll('ollama', [a, b]);
    expect(out).toBe('{"n":1}\n{"n":2}\n');
    expect(
      out
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    ).toEqual([a, b]);
  });

  it('anthropic: named events, no [DONE]', () => {
    expect(frameAll('anthropic', [{ type: 'message_stop' }])).toBe(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    );
  });
});

describe('geminiModelFromURL', () => {
  it.each([
    ['/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse', 'gemini-2.5-flash'],
    ['/v1beta/models/gemini-2.5-pro:generateContent', 'gemini-2.5-pro'],
    ['/v1/models/my%2Dmodel:generateContent', 'my-model'],
    ['/v1/chat/completions', undefined],
    ['/api/chat', undefined],
  ] as const)('%s -> %s', (url, expected) => {
    expect(geminiModelFromURL(url)).toBe(expected);
  });
});

describe('requestWantsStream', () => {
  it.each([
    ['/v1/chat/completions', { stream: true }, true],
    ['/v1/chat/completions', {}, false],
    ['/v1/messages', { stream: false }, false],
    ['/v1beta/models/m:streamGenerateContent', {}, true],
    ['/v1beta/models/m:generateContent', {}, false],
    ['/api/chat', {}, true],
    ['/api/chat', { stream: false }, false],
    ['/api/generate?x=1', undefined, true],
    ['/api/generate', { stream: false }, false],
  ] as const)('%s %j -> %s', (url, body, expected) => {
    expect(requestWantsStream(url, body)).toBe(expected);
  });
});
