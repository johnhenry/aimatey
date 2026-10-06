/**
 * createEmulatedDecisionBackend tests (#144)
 *
 * Wraps a chat backend so Bridge.decide() works against it through
 * structured output. Opt-in; returns no probabilities.
 */

import { describe, it, expect } from 'vitest';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { createEmulatedDecisionBackend } from '@johnhenry/aimatey-patterns';
import { supportsDecisions, validateDecisionResponse } from '@johnhenry/aimatey-utils';
import type {
  BackendAdapter,
  IRChatRequest,
  IRChatResponse,
  IRDecisionRequest,
} from '@johnhenry/aimatey-types';

function fakeChat(
  reply: string | ((req: IRChatRequest) => string),
  caps: Partial<BackendAdapter['metadata']['capabilities']> = {}
) {
  const calls: IRChatRequest[] = [];
  const adapter: BackendAdapter & { calls: IRChatRequest[] } = {
    calls,
    metadata: {
      name: 'fake-chat',
      version: '1',
      provider: 'Fake',
      capabilities: {
        streaming: false,
        multiModal: false,
        structuredOutput: 'native',
        systemMessageStrategy: 'in-messages',
        supportsMultipleSystemMessages: true,
        ...caps,
      },
    },
    async execute(request): Promise<IRChatResponse> {
      calls.push(request);
      const content = typeof reply === 'function' ? reply(request) : reply;
      return {
        message: { role: 'assistant', content },
        finishReason: 'stop',
        usage: { promptTokens: 50, completionTokens: 12, totalTokens: 62 },
        metadata: { ...request.metadata, warnings: undefined },
      };
    },
  };
  return adapter;
}

const questions = {
  team: {
    type: 'choice',
    instructions: 'Which team?',
    criteria: { auth: 'Login problems', billing: 'Charges', other: 'Other' },
  },
  urgent: { type: 'noul', instructions: 'Is it urgent?' },
  severity: {
    type: 'score',
    instructions: 'How severe?',
    criteria: ['low', 'medium', 'high'],
  },
} as const satisfies IRDecisionRequest['questions'];

function req(extra: Partial<IRDecisionRequest> = {}): IRDecisionRequest {
  return {
    state: 'I was charged twice and I need this fixed today!',
    questions,
    metadata: { requestId: 'r1', timestamp: 1 },
    ...extra,
  };
}

const goodReply = JSON.stringify({
  answers: { team: 'billing', urgent: true, severity: 'high' },
});

describe('createEmulatedDecisionBackend', () => {
  it('is a decision backend that declares itself emulated', () => {
    const backend = createEmulatedDecisionBackend(fakeChat(goodReply));
    const caps = backend.metadata.capabilities;
    expect(supportsDecisions(backend)).toBe(true);
    expect(caps.decisions).toBe(true);
    expect(caps.decisionsEmulated).toBe(true);
    expect(caps.decisionTypes).toEqual(['choice', 'score', 'noul']);
    expect(caps.decisionImages).toBe(false);
    expect(backend.metadata.name).toBe('fake-chat-decisions');
    expect(createEmulatedDecisionBackend(fakeChat(goodReply), { name: 'mine' }).metadata.name).toBe(
      'mine'
    );
    // Decision-only: it does not pretend to be a chat backend.
    expect(backend.execute).toBeUndefined();
  });

  it('mirrors the chat backend multiModal flag into decisionImages', () => {
    const backend = createEmulatedDecisionBackend(fakeChat(goodReply, { multiModal: true }));
    expect(backend.metadata.capabilities.decisionImages).toBe(true);
  });

  it('asks all questions in ONE chat call with a schema generated from the questions', async () => {
    const chat = fakeChat(goodReply);
    const backend = createEmulatedDecisionBackend(chat);
    await backend.decide!(req());

    expect(chat.calls).toHaveLength(1);
    const call = chat.calls[0]!;
    expect(call.parameters?.temperature).toBe(0);
    const format = call.responseFormat!;
    expect(format.type).toBe('json_schema');
    expect(format.strict).toBe(true);
    const schema = format.schema as any;
    expect(schema.required).toEqual(['answers']);
    const props = schema.properties.answers.properties;
    expect(props.team).toEqual({ type: 'string', enum: ['auth', 'billing', 'other'] });
    expect(props.urgent).toEqual({ type: 'boolean' });
    expect(props.severity).toEqual({ type: 'string', enum: ['low', 'medium', 'high'] });
    expect(schema.properties.answers.required).toEqual(['team', 'urgent', 'severity']);
    expect(schema.additionalProperties).toBe(false);

    // The state is delimited as data, and the system message says so.
    const system = call.messages.find((m) => m.role === 'system')!;
    expect(String(system.content)).toMatch(/data/i);
    const user = call.messages.find((m) => m.role === 'user')!;
    expect(JSON.stringify(user.content)).toContain('charged twice');
    expect(JSON.stringify(user.content)).toContain('Login problems');
  });

  it('returns IR answers with no probabilities or confidence, usage and provider', async () => {
    const chat = fakeChat(goodReply);
    const backend = createEmulatedDecisionBackend(chat);
    const request = req();
    const response = await backend.decide!(request);

    expect(response.answers).toEqual({
      team: { type: 'choice', value: 'billing' },
      urgent: { type: 'noul', value: 1 },
      severity: { type: 'score', value: 2 },
    });
    for (const answer of Object.values(response.answers)) {
      expect('probabilities' in answer).toBe(false);
      expect('confidence' in answer).toBe(false);
    }
    expect(response.usage).toEqual({ inputTokens: 50, outputTokens: 12 });
    expect(response.provider).toBe('fake-chat');
    expect(validateDecisionResponse(request, response)).toEqual([]);
  });

  it('marks every response with a capability warning', async () => {
    const response = await createEmulatedDecisionBackend(fakeChat(goodReply)).decide!(req());
    const warning = response.metadata.warnings?.find((w) => /emulat/i.test(w.message));
    expect(warning).toBeDefined();
    expect(warning!.category).toBe('capability-emulated');
    expect(warning!.message).toMatch(/no calibrated probabilities/i);
  });

  it('populates reasoning when includeReasoning is set, and asks for it in the schema', async () => {
    const chat = fakeChat(
      JSON.stringify({
        answers: {
          team: { reasoning: 'double charge', answer: 'billing' },
          urgent: { reasoning: 'today', answer: true },
          severity: { reasoning: 'money', answer: 'medium' },
        },
      })
    );
    const backend = createEmulatedDecisionBackend(chat, { includeReasoning: true });
    const response = await backend.decide!(req());
    expect(response.answers.team).toEqual({
      type: 'choice',
      value: 'billing',
      reasoning: 'double charge',
    });
    expect(response.answers.severity).toEqual({ type: 'score', value: 1, reasoning: 'money' });
    const team = (chat.calls[0]!.responseFormat!.schema as any).properties.answers.properties.team;
    expect(team.properties.reasoning).toEqual({ type: 'string' });
    expect(team.properties.answer).toEqual({ type: 'string', enum: ['auth', 'billing', 'other'] });
    expect(team.required).toEqual(['reasoning', 'answer']);
  });

  it('parses defensively: fenced JSON and surrounding prose', async () => {
    const wrapped = 'Sure!\n```json\n' + goodReply + '\n```\nHope that helps.';
    const response = await createEmulatedDecisionBackend(
      fakeChat(wrapped, { structuredOutput: 'fallback' })
    ).decide!(req());
    expect(response.answers.team).toEqual({ type: 'choice', value: 'billing' });
  });

  it('adds a strict JSON instruction when the chat backend only has fallback structured output', async () => {
    const chat = fakeChat(goodReply, { structuredOutput: 'fallback' });
    await createEmulatedDecisionBackend(chat).decide!(req());
    const system = String(chat.calls[0]!.messages.find((m) => m.role === 'system')!.content);
    expect(system).toMatch(/only (a )?JSON|JSON only/i);
  });

  it('adds the same instruction when structuredOutput is not declared at all', async () => {
    const chat = fakeChat(goodReply);
    (chat.metadata.capabilities as any).structuredOutput = undefined;
    await createEmulatedDecisionBackend(chat).decide!(req());
    const system = String(chat.calls[0]!.messages.find((m) => m.role === 'system')!.content);
    expect(system).toMatch(/only (a )?JSON|JSON only/i);
  });

  it('rejects a choice outside the enum, naming the question', async () => {
    const bad = JSON.stringify({ answers: { team: 'sales', urgent: true, severity: 'low' } });
    await expect(createEmulatedDecisionBackend(fakeChat(bad)).decide!(req())).rejects.toThrow(
      /'team'.*sales/s
    );
  });

  it('rejects a score label outside the levels, naming the question', async () => {
    const bad = JSON.stringify({ answers: { team: 'auth', urgent: true, severity: 'extreme' } });
    await expect(createEmulatedDecisionBackend(fakeChat(bad)).decide!(req())).rejects.toThrow(
      /'severity'/
    );
  });

  it('rejects a non-boolean noul answer, naming the question', async () => {
    const bad = JSON.stringify({ answers: { team: 'auth', urgent: 'yes', severity: 'low' } });
    await expect(createEmulatedDecisionBackend(fakeChat(bad)).decide!(req())).rejects.toThrow(
      /'urgent'/
    );
  });

  it('rejects a missing answer, naming the question', async () => {
    const bad = JSON.stringify({ answers: { team: 'auth', urgent: true } });
    await expect(createEmulatedDecisionBackend(fakeChat(bad)).decide!(req())).rejects.toThrow(
      /'severity'/
    );
  });

  it('rejects unparseable output', async () => {
    await expect(
      createEmulatedDecisionBackend(fakeChat('I cannot do that.')).decide!(req())
    ).rejects.toThrow(/JSON/);
  });

  it('disambiguates duplicate score labels with their index', async () => {
    const chat = fakeChat((r) => {
      const levels = (r.responseFormat!.schema as any).properties.answers.properties.s.enum;
      return JSON.stringify({ answers: { s: levels[1] } });
    });
    const response = await createEmulatedDecisionBackend(chat).decide!(
      req({ questions: { s: { type: 'score', instructions: 'x', criteria: ['ok', 'ok', 'bad'] } } })
    );
    expect(response.answers.s).toEqual({ type: 'score', value: 1 });
  });

  it('passes images to a multimodal chat backend as image parts', async () => {
    const chat = fakeChat(goodReply, { multiModal: true });
    const image = { type: 'image', source: { type: 'url', url: 'https://x/y.png' } } as const;
    await createEmulatedDecisionBackend(chat).decide!(req({ images: [image] }));
    const user = chat.calls[0]!.messages.find((m) => m.role === 'user')!;
    expect(Array.isArray(user.content)).toBe(true);
    expect((user.content as any[]).some((b) => b.type === 'image')).toBe(true);
  });

  it('warns that images were dropped when the chat backend is text-only', async () => {
    const chat = fakeChat(goodReply);
    const image = { type: 'image', source: { type: 'url', url: 'https://x/y.png' } } as const;
    const response = await createEmulatedDecisionBackend(chat).decide!(req({ images: [image] }));
    const user = chat.calls[0]!.messages.find((m) => m.role === 'user')!;
    expect(JSON.stringify(user.content)).not.toContain('image');
    expect(response.metadata.warnings?.some((w) => w.field === 'images')).toBe(true);
  });

  it('uses parameters.model, then opts.model, for the chat call', async () => {
    const chat = fakeChat(goodReply);
    await createEmulatedDecisionBackend(chat, { model: 'small' }).decide!(req());
    expect(chat.calls[0]!.parameters?.model).toBe('small');
    await createEmulatedDecisionBackend(chat, { model: 'small' }).decide!(
      req({ parameters: { model: 'big' } })
    );
    expect(chat.calls[1]!.parameters?.model).toBe('big');
  });

  it('accepts a custom system prompt', async () => {
    const chat = fakeChat(goodReply);
    await createEmulatedDecisionBackend(chat, { systemPrompt: 'CUSTOM-SYSTEM' }).decide!(req());
    expect(String(chat.calls[0]!.messages[0]!.content)).toContain('CUSTOM-SYSTEM');
  });

  it('bounds concurrent chat calls across decide() calls', async () => {
    let inFlight = 0;
    let peak = 0;
    const chat = fakeChat(goodReply);
    const original = chat.execute!.bind(chat);
    chat.execute = async (r, s) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((res) => setTimeout(res, 5));
      inFlight--;
      return original(r, s);
    };
    const backend = createEmulatedDecisionBackend(chat, { concurrency: 2 });
    await Promise.all(Array.from({ length: 6 }, () => backend.decide!(req())));
    expect(peak).toBe(2);
  });

  it('propagates the abort signal to the chat backend', async () => {
    const chat = fakeChat(goodReply);
    let seen: AbortSignal | undefined;
    const original = chat.execute!.bind(chat);
    chat.execute = (r, s) => {
      seen = s;
      return original(r, s);
    };
    const controller = new AbortController();
    await createEmulatedDecisionBackend(chat).decide!(req(), controller.signal);
    expect(seen).toBe(controller.signal);
  });

  it('delegates estimateDecisionCost to the chat backend estimateCost', async () => {
    const chat = fakeChat(goodReply);
    chat.estimateCost = async (r) => {
      expect(r.responseFormat).toBeDefined();
      return 0.5;
    };
    expect(await createEmulatedDecisionBackend(chat).estimateDecisionCost!(req())).toBe(0.5);
    expect(
      await createEmulatedDecisionBackend(fakeChat(goodReply)).estimateDecisionCost!(req())
    ).toBeNull();
  });

  it('refuses a backend with no chat support', () => {
    const decisionOnly = { metadata: fakeChat('').metadata } as BackendAdapter;
    expect(() => createEmulatedDecisionBackend(decisionOnly)).toThrow(/chat/i);
  });

  it('works through Bridge.decide() and never changes what Bridge does by default', async () => {
    const chat = fakeChat(goodReply);
    const bridge = new Bridge(new OpenAIFrontendAdapter(), createEmulatedDecisionBackend(chat));
    const response = await bridge.decide('I was charged twice', questions);
    expect(response.answers.team).toEqual({ type: 'choice', value: 'billing' });

    // A plain chat backend is still not silently emulated.
    const plain = new Bridge(new OpenAIFrontendAdapter(), fakeChat(goodReply));
    await expect(plain.decide('x', questions)).rejects.toThrow(/does not support typed decisions/);
  });
});

// ----------------------------------------------------------------------------
// Live: local Ollama (0.35.1) with qwen2.5:3b. Run with OLLAMA_LIVE=1.
// ----------------------------------------------------------------------------
describe.skipIf(process.env.OLLAMA_LIVE !== '1')(
  'emulated decisions on local Ollama (live)',
  () => {
    it('answers choice + noul + score through Bridge.decide()', async () => {
      const { OllamaBackendAdapter } = await import('@johnhenry/aimatey-backend');
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const chat = new OllamaBackendAdapter({ baseURL: 'http://localhost:11434' });
      const backend = createEmulatedDecisionBackend(chat, {
        model: 'qwen2.5:3b',
      });
      const bridge = new Bridge(new OpenAIFrontendAdapter(), backend);
      const state =
        'Subject: charged twice!! Hi, my card was billed two times for the October plan and I am locked out of my account too. Please fix today.';
      const response = await bridge.decide(state, questions, {
        signal: AbortSignal.timeout(600_000),
      });

      const team = response.answers.team!;
      expect(team.type).toBe('choice');
      expect(['auth', 'billing', 'other']).toContain(team.value);
      expect(response.answers.urgent!.type).toBe('noul');
      expect([0, 1]).toContain(response.answers.urgent!.value);
      const severity = response.answers.severity!;
      expect(severity.type).toBe('score');
      expect([0, 1, 2]).toContain(severity.value);
      expect(response.metadata.warnings?.some((w) => /emulat/i.test(w.message))).toBe(true);

      mkdirSync('fixtures/decisions', { recursive: true });
      writeFileSync(
        'fixtures/decisions/ollama-qwen2.5-3b-emulated-triage.json',
        JSON.stringify(
          {
            metadata: {
              provider: 'ollama',
              scenario: 'emulated-decision-triage',
              model: 'qwen2.5:3b',
              ollamaVersion: '0.35.1',
              capturedAt: new Date().toISOString(),
              description:
                'createEmulatedDecisionBackend over OllamaBackendAdapter: choice + noul + score through Bridge.decide()',
            },
            request: { state, questions },
            response: { answers: response.answers, usage: response.usage, model: response.model },
          },
          null,
          2
        ) + '\n'
      );
    }, 630_000); // a CPU-only box under load generates a few tokens per minute
  }
);
