/**
 * createDecisionGate / createDecisionTool: a decision model as a
 * tool-call gate and as a tool an LLM agent can consult.
 */

import { describe, it, expect } from 'vitest';
import { Bridge, createDecisionGate, createDecisionTool } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { createMockDecisionBackend } from '@johnhenry/aimatey-testing';
import type {
  BackendAdapter,
  AdapterMetadata,
  IRChatRequest,
  IRChatResponse,
  IRDecisionRequest,
  IRMessage,
  ToolCallGateCall,
} from '@johnhenry/aimatey-types';

const history: IRMessage[] = [
  { role: 'user', content: 'Clean up my temp folder' },
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 't1', name: 'deleteFiles', input: { path: '/tmp' } }],
  },
];

const call = (overrides: Partial<ToolCallGateCall> = {}): ToolCallGateCall => ({
  name: 'deleteFiles',
  input: { path: '/tmp' },
  iteration: 1,
  toolCallId: 't1',
  history,
  ...overrides,
});

const backendAnswering = (value: number) =>
  createMockDecisionBackend({ answers: { safe: { type: 'noul', value } } });

describe('createDecisionGate', () => {
  it('maps P(true) to allow / review / deny with the default policy', async () => {
    const verdict = async (p: number) =>
      (await createDecisionGate(backendAnswering(p))(call())).action;

    expect(await verdict(0.95)).toBe('allow');
    expect(await verdict(0.8)).toBe('allow'); // >= allowAbove
    expect(await verdict(0.5)).toBe('review');
    expect(await verdict(0.31)).toBe('review');
    expect(await verdict(0.3)).toBe('deny'); // <= denyBelow
    expect(await verdict(0.02)).toBe('deny');
  });

  it('honours a custom policy', async () => {
    const gate = createDecisionGate(backendAnswering(0.6), {
      policy: { allowAbove: 0.5, denyBelow: 0.1 },
    });
    expect((await gate(call())).action).toBe('allow');
  });

  it('rejects an incoherent policy', () => {
    expect(() =>
      createDecisionGate(backendAnswering(0.5), { policy: { allowAbove: 0.2, denyBelow: 0.6 } })
    ).toThrow(/allowAbove/);
  });

  it('asks the default question with tool name, input and the last user message in state', async () => {
    const backend = backendAnswering(0.9);
    await createDecisionGate(backend, { model: 'tev1:0.8b' })(call());

    const request = backend.calls[0] as IRDecisionRequest;
    expect(request.parameters?.model).toBe('tev1:0.8b');
    expect(request.questions.safe).toMatchObject({ type: 'noul' });
    expect(request.questions.safe!.instructions).toMatch(/safe and consistent with the user/i);
    expect(request.state).toEqual({
      toolName: 'deleteFiles',
      input: { path: '/tmp' },
      lastUserMessage: 'Clean up my temp folder',
    });
  });

  it('reads the last user message from text blocks, skipping tool results', async () => {
    const backend = backendAnswering(0.9);
    const messages: IRMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'x', content: 'r' }] },
    ];
    await createDecisionGate(backend)(call({ history: messages }));
    expect((backend.calls[0]!.state as { lastUserMessage: string }).lastUserMessage).toBe('second');
  });

  it('attaches the decision response for auditing', async () => {
    const decision = await createDecisionGate(backendAnswering(0.1))(call());
    expect(decision.action).toBe('deny');
    expect(decision.response?.answers.safe).toEqual({ type: 'noul', value: 0.1 });
    expect(decision.action === 'deny' && decision.reason).toMatch(/0\.10/);
  });

  it('accepts custom questions and a custom state builder', async () => {
    const backend = createMockDecisionBackend({
      answers: { ok: { type: 'noul', value: 0.95 } },
    });
    const gate = createDecisionGate(backend, {
      questions: { ok: { type: 'noul', instructions: 'Is this within policy?' } },
      stateBuilder: (c) => `${c.name}:${JSON.stringify(c.input)}`,
    });
    expect((await gate(call())).action).toBe('allow');
    expect(backend.calls[0]!.state).toBe('deleteFiles:{"path":"/tmp"}');
    expect(backend.calls[0]!.questions.ok!.instructions).toBe('Is this within policy?');
  });

  it('takes the lowest P(true) when several noul questions are asked', async () => {
    const backend = createMockDecisionBackend({
      answers: { a: { type: 'noul', value: 0.95 }, b: { type: 'noul', value: 0.1 } },
    });
    const gate = createDecisionGate(backend, {
      questions: {
        a: { type: 'noul', instructions: 'A?' },
        b: { type: 'noul', instructions: 'B?' },
      },
    });
    expect((await gate(call())).action).toBe('deny');
  });

  it('throws at creation for a backend without decide() or questions without a noul', () => {
    const chatOnly = { metadata: { capabilities: {} } } as unknown as BackendAdapter;
    expect(() => createDecisionGate(chatOnly)).toThrow(/decision/i);
    expect(() =>
      createDecisionGate(backendAnswering(0.5), {
        questions: { c: { type: 'choice', instructions: '?', criteria: { a: 'a' } } },
      })
    ).toThrow(/noul/);
  });

  it('propagates backend errors (runTools then fails closed)', async () => {
    const gate = createDecisionGate(createMockDecisionBackend({ error: new Error('down') }));
    await expect(gate(call())).rejects.toThrow('down');
  });
});

// ============================================================================
// With a chat agent
// ============================================================================

function scriptedChat(script: Array<Partial<IRChatResponse>>): BackendAdapter & {
  requests: IRChatRequest[];
} {
  let n = 0;
  const requests: IRChatRequest[] = [];
  const metadata: AdapterMetadata = {
    name: 'scripted',
    version: '1.0.0',
    provider: 'Mock',
    capabilities: {
      streaming: false,
      multiModal: false,
      tools: true,
      systemMessageStrategy: 'in-messages',
      supportsMultipleSystemMessages: false,
    },
  };
  return {
    metadata,
    requests,
    fromIR: (r) => r,
    toIR: () => {
      throw new Error('unused');
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- mock interface
    execute: async (request: IRChatRequest): Promise<IRChatResponse> => {
      requests.push(request);
      const scripted = script[Math.min(n++, script.length - 1)];
      return {
        message: { role: 'assistant', content: 'done' },
        finishReason: 'stop',
        metadata: request.metadata,
        ...scripted,
      } as IRChatResponse;
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- mock generator interface
    executeStream: async function* () {
      throw new Error('unused');
    },
  };
}

const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
  ({
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    finishReason: 'tool_calls',
  }) as Partial<IRChatResponse>;

describe('decision gate inside runTools', () => {
  it('blocks a risky call and lets a safe one through', async () => {
    const ran: string[] = [];
    const gateBackend = createMockDecisionBackend({
      handler: (request) => {
        const state = request.state as { toolName: string };
        const value = state.toolName === 'deleteFiles' ? 0.05 : 0.97;
        return {
          answers: { safe: { type: 'noul', value } },
          model: 'mock',
          metadata: request.metadata,
        };
      },
    });

    const chat = scriptedChat([
      toolUse('t1', 'getWeather', { city: 'SF' }),
      toolUse('t2', 'deleteFiles', { path: '/' }),
      { message: { role: 'assistant', content: 'finished' }, finishReason: 'stop' },
    ]);

    const result = await new Bridge(new OpenAIFrontendAdapter(), chat).runTools({
      prompt: 'weather then wipe',
      tools: {
        getWeather: { description: 'w', parameters: { type: 'object' }, execute: () => ran.push('w') },
        deleteFiles: { description: 'd', parameters: { type: 'object' }, execute: () => ran.push('d') },
      },
      gate: createDecisionGate(gateBackend),
    });

    expect(ran).toEqual(['w']);
    expect(result.denials).toHaveLength(1);
    expect(result.denials[0]).toMatchObject({ name: 'deleteFiles', action: 'deny' });
    expect(result.denials[0]!.response?.answers.safe).toMatchObject({ value: 0.05 });
    expect(gateBackend.calls).toHaveLength(2);
  });
});

describe('createDecisionTool', () => {
  const questions = {
    urgent: { type: 'noul', instructions: 'Is this urgent?' },
    team: {
      type: 'choice',
      instructions: 'Which team?',
      criteria: { billing: 'invoices', technical: 'bugs' },
    },
  } as const;

  const backend = createMockDecisionBackend({
    answers: {
      urgent: { type: 'noul', value: 0.9 },
      team: {
        type: 'choice',
        value: 'billing',
        probabilities: { billing: 0.8, technical: 0.2 },
        confidence: 0.8,
      },
    },
  });

  it('describes itself as a tool taking a state', () => {
    const tool = createDecisionTool(backend, questions);
    expect(tool.name).toBe('consult_decision_model');
    expect(tool.description).toMatch(/urgent/);
    expect(tool.parameters).toMatchObject({ type: 'object', required: ['state'] });

    const named = createDecisionTool(backend, questions, { name: 'triage', description: 'Triage it' });
    expect(named.name).toBe('triage');
    expect(named.description).toBe('Triage it');
  });

  it('answers with JSON of the answers and probabilities', async () => {
    const tool = createDecisionTool(backend, questions);
    const out = (await tool.execute({ state: 'I was charged twice' }, { toolCallId: 'x', messages: [] })) as {
      answers: Record<string, unknown>;
      model: string;
    };

    expect(out.model).toBe('mock-decision-model');
    expect(out.answers.urgent).toEqual({ type: 'noul', value: 0.9 });
    expect(out.answers.team).toEqual({
      type: 'choice',
      value: 'billing',
      probabilities: { billing: 0.8, technical: 0.2 },
      confidence: 0.8,
    });
    expect(backend.calls.at(-1)!.state).toBe('I was charged twice');
  });

  it('round-trips through a chat agent loop', async () => {
    const tool = createDecisionTool(backend, questions);
    const chat = scriptedChat([
      toolUse('t1', tool.name, { state: 'Server is down' }),
      { message: { role: 'assistant', content: 'Routing to billing.' }, finishReason: 'stop' },
    ]);

    const result = await new Bridge(new OpenAIFrontendAdapter(), chat).runTools({
      prompt: 'triage this',
      tools: { [tool.name]: tool },
    });

    expect(result.text).toBe('Routing to billing.');
    const toolResult = result.steps[0]!.toolResults[0]!;
    expect(toolResult.isError).toBeUndefined();
    expect(JSON.parse(JSON.stringify(toolResult.result)).answers.urgent.value).toBe(0.9);
    // the tool is advertised to the model like any other
    expect(chat.requests[0]!.tools?.[0]?.name).toBe('consult_decision_model');
  });
});
