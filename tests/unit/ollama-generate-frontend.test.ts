/**
 * Ollama /api/generate frontend: prompt/system/images/format/options in,
 * the generate shape (`response`, not `message`) out, whole and streamed;
 * raw/suffix/template/context/keep_alive kept in metadata with warnings.
 */

import { describe, it, expect } from 'vitest';
import {
  OllamaGenerateFrontendAdapter,
  isOllamaStreamError,
  type OllamaGenerateStreamEvent,
} from '@johnhenry/aimatey-frontend';
import { Bridge } from '@johnhenry/aimatey-core';
import { MockBackendAdapter } from '@johnhenry/aimatey-backend-browser';
import type { IRStreamChunk } from '@johnhenry/aimatey-types';

const adapter = new OllamaGenerateFrontendAdapter();

async function* from(chunks: IRStreamChunk[]): AsyncGenerator<IRStreamChunk, void, undefined> {
  for (const c of chunks) yield c;
}

describe('OllamaGenerateFrontendAdapter.toIR', () => {
  it('maps prompt, system, images, format and options', async () => {
    const ir = await adapter.toIR({
      model: 'llava',
      prompt: 'Describe this',
      system: 'Be brief.',
      images: ['iVBORw0K'],
      format: 'json',
      options: { temperature: 0, num_predict: 50, stop: ['\n'], repeat_penalty: 1.2 },
      stream: true,
    });
    expect(ir.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this' },
          { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'iVBORw0K' } },
        ],
      },
    ]);
    expect(ir.responseFormat).toEqual({ type: 'json_schema', schema: { type: 'object' } });
    expect(ir.parameters).toEqual({
      model: 'llava',
      temperature: 0,
      maxTokens: 50,
      stopSequences: ['\n'],
      custom: { repeatPenalty: 1.2 },
    });
    expect(ir.stream).toBe(true);
    expect(ir.metadata.warnings).toBeUndefined();
    expect(ir.metadata.custom).toBeUndefined();
  });

  it('a plain prompt is a single user message', async () => {
    const ir = await adapter.toIR({ model: 'm', prompt: 'Hi' });
    expect(ir.messages).toEqual([{ role: 'user', content: 'Hi' }]);
  });

  it('keeps raw, suffix, template, context and keep_alive in metadata, warning on the first four', async () => {
    const ir = await adapter.toIR({
      model: 'm',
      prompt: 'def f(',
      raw: true,
      suffix: ')',
      template: '{{ .Prompt }}',
      context: [1, 2, 3],
      keep_alive: '5m',
    });
    expect(ir.metadata.custom).toEqual({
      ollama: {
        raw: true,
        suffix: ')',
        template: '{{ .Prompt }}',
        context: [1, 2, 3],
        keep_alive: '5m',
      },
    });
    expect(ir.metadata.warnings?.map((w) => [w.category, w.field])).toEqual([
      ['parameter-unsupported', 'raw'],
      ['parameter-unsupported', 'suffix'],
      ['parameter-unsupported', 'template'],
      ['parameter-unsupported', 'context'],
    ]);
  });

  it('rejects a body without a prompt', async () => {
    await expect(adapter.toIR({ model: 'm' } as never)).rejects.toThrow(/prompt/);
  });
});

describe('OllamaGenerateFrontendAdapter responses', () => {
  it('fromIR returns the generate shape', async () => {
    const out = await adapter.fromIR({
      message: { role: 'assistant', content: [{ type: 'text', text: 'Blue.' }] },
      finishReason: 'length',
      usage: { promptTokens: 7, completionTokens: 2, totalTokens: 9 },
      metadata: { requestId: 'r', timestamp: 0, provenance: { servedModel: 'llama3' } },
    });
    expect(out).toEqual({
      model: 'llama3',
      created_at: expect.any(String),
      response: 'Blue.',
      done: true,
      done_reason: 'length',
      prompt_eval_count: 7,
      eval_count: 2,
    });
    expect(out).not.toHaveProperty('message');
  });

  it('fromIRStream yields partial responses then the done one', async () => {
    const events: OllamaGenerateStreamEvent[] = [];
    for await (const e of adapter.fromIRStream(
      from([
        {
          type: 'start',
          sequence: 0,
          metadata: { requestId: 'r', timestamp: 0, provenance: { servedModel: 'llama3' } },
        },
        { type: 'content', sequence: 1, delta: 'Bl' },
        { type: 'content', sequence: 2, delta: 'ue' },
        {
          type: 'done',
          sequence: 3,
          finishReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        },
      ])
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { model: 'llama3', created_at: expect.any(String), response: 'Bl', done: false },
      { model: 'llama3', created_at: expect.any(String), response: 'ue', done: false },
      {
        model: 'llama3',
        created_at: expect.any(String),
        response: '',
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 1,
        eval_count: 2,
      },
    ]);
  });

  it('fromIRStream ends with { error } on failure', async () => {
    const events: OllamaGenerateStreamEvent[] = [];
    for await (const e of adapter.fromIRStream(
      from([{ type: 'error', sequence: 0, error: { code: 'PROVIDER_ERROR', message: 'gone' } }])
    )) {
      events.push(e);
    }
    expect(events).toEqual([{ error: 'gone' }]);
    expect(isOllamaStreamError(events[0])).toBe(true);
  });

  it('works end to end through a Bridge', async () => {
    const bridge = new Bridge(
      adapter,
      new MockBackendAdapter({ defaultResponse: 'Because of Rayleigh scattering.' })
    );
    const out = await bridge.chat({ model: 'm', prompt: 'Why is the sky blue?' });
    expect(out.response).toBe('Because of Rayleigh scattering.');
    expect(out.done).toBe(true);
  });
});
