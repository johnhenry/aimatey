/**
 * Structured/schema-constrained output (`responseFormat`) mapping tests.
 *
 * Verifies that native backends (OpenAI, Anthropic, Gemini, Groq, Ollama) map
 * `IRChatRequest.responseFormat` onto their own provider mechanism, and that
 * fallback backends (Mistral, Cohere) emulate it via prompt injection
 * plus best-effort JSON extraction - in both cases setting
 * `metadata.custom.responseFormatEnforced` appropriately.
 */

import { describe, it, expect } from 'vitest';
import {
  OpenAIBackendAdapter,
  AnthropicBackendAdapter,
  GeminiBackendAdapter,
  GroqBackendAdapter,
  MistralBackendAdapter,
  OllamaBackendAdapter,
  CohereBackendAdapter,
} from '@johnhenry/aimatey-backend';
import type { IRChatRequest, IRResponseFormat } from '@johnhenry/aimatey-types';

const FLAT_SCHEMA: IRResponseFormat = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  },
};

// A non-trivial discriminated-union schema, in the spirit of PTM's
// PROPOSAL_JSON_SCHEMA (a tagged union over multiple action "kinds").
const PROPOSAL_SCHEMA: IRResponseFormat = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['click', 'type', 'wait', 'done'] },
      target: { type: 'string' },
      value: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['kind', 'reason'],
  },
  strict: true,
};

function makeRequest(overrides: Partial<IRChatRequest> = {}): IRChatRequest {
  return {
    messages: [{ role: 'user', content: 'Extract the answer.' }],
    parameters: { model: 'test-model' },
    metadata: { requestId: 'req-1', timestamp: Date.now(), provenance: {} },
    ...overrides,
  };
}

describe('OpenAI backend responseFormat mapping (native)', () => {
  const adapter = new OpenAIBackendAdapter({ apiKey: 'test-key' });

  it('maps responseFormat to response_format.json_schema', () => {
    const req = adapter.fromIR(makeRequest({ responseFormat: FLAT_SCHEMA }));
    expect(req.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', schema: FLAT_SCHEMA.schema, strict: undefined },
    });
  });

  it('maps a discriminated-union schema with strict:true', () => {
    const req = adapter.fromIR(makeRequest({ responseFormat: PROPOSAL_SCHEMA }));
    expect(req.response_format?.json_schema.schema).toEqual(PROPOSAL_SCHEMA.schema);
    expect(req.response_format?.json_schema.strict).toBe(true);
  });

  it('omits response_format when no responseFormat is requested', () => {
    const req = adapter.fromIR(makeRequest());
    expect(req.response_format).toBeUndefined();
  });

  it('sets responseFormatEnforced: true in toIR when responseFormat was requested', () => {
    const response = adapter.toIR(
      {
        id: 'resp_1',
        object: 'chat.completion',
        created: 0,
        model: 'test-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '{"answer":"42"}' },
            finish_reason: 'stop',
          },
        ],
      },
      makeRequest({ responseFormat: FLAT_SCHEMA }),
      10
    );
    expect(response.metadata.custom?.responseFormatEnforced).toBe(true);
  });

  it('omits responseFormatEnforced when no responseFormat was requested', () => {
    const response = adapter.toIR(
      {
        id: 'resp_1',
        object: 'chat.completion',
        created: 0,
        model: 'test-model',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
        ],
      },
      makeRequest(),
      10
    );
    expect(response.metadata.custom?.responseFormatEnforced).toBeUndefined();
  });
});

describe('Anthropic backend responseFormat mapping (native)', () => {
  const adapter = new AnthropicBackendAdapter({ apiKey: 'test-key' });

  it('maps responseFormat to output_config.format', () => {
    const req = adapter.fromIR(makeRequest({ responseFormat: FLAT_SCHEMA }));
    expect(req.output_config).toEqual({
      format: { type: 'json_schema', schema: FLAT_SCHEMA.schema },
    });
  });

  it('omits output_config when no responseFormat is requested', () => {
    const req = adapter.fromIR(makeRequest());
    expect(req.output_config).toBeUndefined();
  });
});

describe('Gemini backend responseFormat mapping (native)', () => {
  const adapter = new GeminiBackendAdapter({ apiKey: 'test-key' });

  it('maps responseFormat to generationConfig.responseSchema', () => {
    const req = adapter.fromIR(makeRequest({ responseFormat: FLAT_SCHEMA }));
    expect(req.generationConfig?.responseMimeType).toBe('application/json');
    expect(req.generationConfig?.responseSchema).toEqual(FLAT_SCHEMA.schema);
  });

  it('omits responseSchema when no responseFormat is requested', () => {
    const req = adapter.fromIR(makeRequest());
    expect(req.generationConfig?.responseMimeType).toBeUndefined();
    expect(req.generationConfig?.responseSchema).toBeUndefined();
  });
});

describe('Groq backend responseFormat mapping (inherited native)', () => {
  const adapter = new GroqBackendAdapter({ apiKey: 'test-key' });

  it('advertises native structuredOutput support', () => {
    expect(adapter.metadata.capabilities.structuredOutput).toBe('native');
  });

  it('maps responseFormat via the inherited OpenAI fromIR', () => {
    const req = adapter.fromIR(makeRequest({ responseFormat: FLAT_SCHEMA }));
    expect(req.response_format?.json_schema.schema).toEqual(FLAT_SCHEMA.schema);
  });
});

describe('Mistral backend responseFormat fallback', () => {
  const adapter = new MistralBackendAdapter({ apiKey: 'test-key' });

  it('advertises fallback structuredOutput support', () => {
    expect(adapter.metadata.capabilities.structuredOutput).toBe('fallback');
  });

  it('folds a schema-instruction message into the combined system message', () => {
    // Mistral's 'in-messages' + supportsMultipleSystemMessages:false strategy
    // combines all system-role messages (including the appended fallback
    // instruction) into a single leading system message.
    const req = adapter.fromIR(makeRequest({ responseFormat: FLAT_SCHEMA }));
    expect(req.messages).toHaveLength(2);
    expect(req.messages[0]?.role).toBe('system');
    expect(req.messages[0]?.content).toContain(JSON.stringify(FLAT_SCHEMA.schema));
    expect(req.messages[1]?.role).toBe('user');
  });

  it('does not append an instruction message when responseFormat is absent', () => {
    const req = adapter.fromIR(makeRequest());
    expect(req.messages).toHaveLength(1);
  });

  it('extracts JSON from a prose-wrapped reply and marks responseFormatEnforced: false', () => {
    const response = adapter.toIR(
      {
        id: 'resp_1',
        object: 'chat.completion',
        created: 0,
        model: 'test-model',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Sure, here you go:\n```json\n{"answer": "42"}\n```\nHope that helps!',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      makeRequest({ responseFormat: FLAT_SCHEMA }),
      10
    );

    expect(response.message.content).toBe('{"answer": "42"}');
    expect(response.metadata.custom?.responseFormatEnforced).toBe(false);
    expect(response.metadata.warnings).toEqual([
      expect.objectContaining({ category: 'capability-unsupported', field: 'responseFormat' }),
    ]);
  });

  it('repairs trailing commas in an extracted JSON span', () => {
    const response = adapter.toIR(
      {
        id: 'resp_1',
        object: 'chat.completion',
        created: 0,
        model: 'test-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '{"kind": "done", "reason": "ok",}' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      makeRequest({ responseFormat: PROPOSAL_SCHEMA }),
      10
    );

    expect(() => JSON.parse(response.message.content as string)).not.toThrow();
    expect(JSON.parse(response.message.content as string)).toEqual({ kind: 'done', reason: 'ok' });
  });

  it('leaves content untouched when no responseFormat was requested', () => {
    const response = adapter.toIR(
      {
        id: 'resp_1',
        object: 'chat.completion',
        created: 0,
        model: 'test-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'plain text reply' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      makeRequest(),
      10
    );

    expect(response.message.content).toBe('plain text reply');
    expect(response.metadata.custom?.responseFormatEnforced).toBeUndefined();
    expect(response.metadata.warnings).toBeUndefined();
  });
});

describe('Ollama backend responseFormat (native format)', () => {
  const adapter = new OllamaBackendAdapter({});

  it('advertises native structuredOutput support', () => {
    expect(adapter.metadata.capabilities.structuredOutput).toBe('native');
  });

  it('sends the schema as `format` without injecting a prompt', () => {
    const req = adapter.fromIR(makeRequest({ responseFormat: PROPOSAL_SCHEMA }));
    expect(req.format).toEqual(PROPOSAL_SCHEMA.schema);
    expect(JSON.stringify(req.messages)).not.toContain(JSON.stringify(PROPOSAL_SCHEMA.schema));

    const response = adapter.toIR(
      {
        model: 'test-model',
        created_at: 'now',
        message: { role: 'assistant', content: '{"kind": "wait", "reason": "loading"}' },
        done: true,
      },
      makeRequest({ responseFormat: PROPOSAL_SCHEMA }),
      10
    );

    expect(response.message.content).toBe('{"kind": "wait", "reason": "loading"}');
    expect(response.metadata.custom?.responseFormatEnforced).toBe(true);
    expect(response.metadata.warnings ?? []).toEqual([]);
  });

  it('omits `format` when no responseFormat is set', () => {
    expect(adapter.fromIR(makeRequest({})).format).toBeUndefined();
  });
});

describe('Cohere backend responseFormat fallback', () => {
  const adapter = new CohereBackendAdapter({ apiKey: 'test-key' });

  it('advertises fallback structuredOutput support', () => {
    expect(adapter.metadata.capabilities.structuredOutput).toBe('fallback');
  });
});
