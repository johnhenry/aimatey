/**
 * runTools tool-call gating: `gate`, `onReview`, `maxDenials`.
 *
 * Uses a scripted chat backend that emits tool calls, and a gate function
 * under test control. The decision-model gate has its own file
 * (`decision-gate.test.ts`).
 */

import { describe, it, expect, vi } from 'vitest';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import type {
  BackendAdapter,
  AdapterMetadata,
  IRChatRequest,
  IRChatResponse,
  ToolCallGate,
  ToolDefinition,
} from '@johnhenry/aimatey-types';

function scriptedBackend(script: Array<Partial<IRChatResponse>>): BackendAdapter {
  let call = 0;
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
    fromIR: (request) => request,
    toIR: () => {
      throw new Error('unused');
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- mock interface
    execute: async (request: IRChatRequest): Promise<IRChatResponse> => {
      const scripted = script[Math.min(call, script.length - 1)];
      call++;
      return {
        message: { role: 'assistant', content: 'done' },
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
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

const toolCalls = (
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>
): Partial<IRChatResponse> => ({
  message: {
    role: 'assistant',
    content: calls.map((call) => ({ type: 'tool_use' as const, ...call })),
  },
  finishReason: 'tool_calls',
});

const final = (text: string): Partial<IRChatResponse> => ({
  message: { role: 'assistant', content: text },
  finishReason: 'stop',
});

function tool(execute: ToolDefinition['execute']): ToolDefinition {
  return {
    description: 'a tool',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    execute,
  };
}

const bridgeFor = (backend: BackendAdapter) => new Bridge(new OpenAIFrontendAdapter(), backend);

/** Tool-result contents appended after the loop, flattened. */
function toolResultTexts(messages: readonly { role: string; content: unknown }[]): string[] {
  return messages
    .filter((m) => m.role === 'tool')
    .flatMap((m) => m.content as Array<{ content: string }>)
    .map((block) => block.content);
}

describe('runTools gate', () => {
  it('runs the tool on allow and passes the call context to the gate', async () => {
    const execute = vi.fn(() => 'ok');
    const gate = vi.fn<ToolCallGate>(() => ({ action: 'allow' }));
    const backend = scriptedBackend([
      toolCalls([{ id: 't1', name: 'readFile', input: { path: '/tmp/x' } }]),
      final('read it'),
    ]);

    const result = await bridgeFor(backend).runTools({
      prompt: 'read /tmp/x',
      tools: { readFile: tool(execute) },
      gate,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(gate).toHaveBeenCalledTimes(1);
    const call = gate.mock.calls[0]![0];
    expect(call).toMatchObject({
      name: 'readFile',
      input: { path: '/tmp/x' },
      iteration: 1,
      toolCallId: 't1',
    });
    // history ends with the assistant's tool-call message
    expect(call.history[0]).toMatchObject({ role: 'user', content: 'read /tmp/x' });
    expect(call.history.at(-1)?.role).toBe('assistant');
    expect(result.status).toBe('completed');
    expect(result.denials).toEqual([]);
  });

  it('does not run a denied tool and feeds the reason back so the loop continues', async () => {
    const execute = vi.fn(() => 'deleted');
    const backend = scriptedBackend([
      toolCalls([{ id: 't1', name: 'deleteAll', input: { path: '/' } }]),
      final('I could not delete that.'),
    ]);

    const result = await bridgeFor(backend).runTools({
      prompt: 'wipe it',
      tools: { deleteAll: tool(execute) },
      gate: () => ({ action: 'deny', reason: 'destructive' }),
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.text).toBe('I could not delete that.');
    expect(result.status).toBe('completed');
    expect(result.steps[0]!.toolResults).toEqual([
      { toolCallId: 't1', result: 'Tool call denied: destructive', isError: true },
    ]);
    expect(toolResultTexts(result.messages)).toEqual(['Tool call denied: destructive']);
    expect(result.denials).toEqual([
      {
        iteration: 1,
        toolCallId: 't1',
        name: 'deleteAll',
        input: { path: '/' },
        action: 'deny',
        reason: 'destructive',
      },
    ]);
  });

  it('uses a default message when deny has no reason', async () => {
    const backend = scriptedBackend([toolCalls([{ id: 't1', name: 'x', input: {} }]), final('ok')]);
    const result = await bridgeFor(backend).runTools({
      prompt: 'go',
      tools: { x: tool(() => 'ran') },
      gate: () => ({ action: 'deny' }),
    });
    expect(toolResultTexts(result.messages)).toEqual(['Tool call denied']);
  });

  it('treats review as a distinct denial by default and emits onReview', async () => {
    const execute = vi.fn(() => 'ran');
    const onReview = vi.fn();
    const backend = scriptedBackend([
      toolCalls([{ id: 't1', name: 'sendEmail', input: { path: 'a' } }]),
      final('waiting on a human'),
    ]);

    const result = await bridgeFor(backend).runTools({
      prompt: 'email',
      tools: { sendEmail: tool(execute) },
      gate: () => ({ action: 'review', reason: 'uncertain' }),
      onReview,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(onReview.mock.calls[0]![0]).toMatchObject({
      name: 'sendEmail',
      input: { path: 'a' },
      toolCallId: 't1',
      reason: 'uncertain',
    });
    expect(toolResultTexts(result.messages)).toEqual([
      'Tool call requires human review and was not run: uncertain',
    ]);
    expect(result.denials[0]).toMatchObject({ action: 'review', reason: 'uncertain' });
  });

  it('lets onReview approve a reviewed call (human in the loop)', async () => {
    const execute = vi.fn(() => 'sent');
    const backend = scriptedBackend([
      toolCalls([{ id: 't1', name: 'sendEmail', input: {} }]),
      final('sent'),
    ]);

    const result = await bridgeFor(backend).runTools({
      prompt: 'email',
      tools: { sendEmail: tool(execute) },
      gate: () => ({ action: 'review' }),
      onReview: () => ({ action: 'allow' }),
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(toolResultTexts(result.messages)).toEqual(['sent']);
    expect(result.denials).toEqual([]);
  });

  it('lets onReview reject with its own reason', async () => {
    const execute = vi.fn(() => 'sent');
    const backend = scriptedBackend([toolCalls([{ id: 't1', name: 'x', input: {} }]), final('no')]);

    const result = await bridgeFor(backend).runTools({
      prompt: 'go',
      tools: { x: tool(execute) },
      gate: () => ({ action: 'review' }),
      onReview: async () => ({ action: 'deny', reason: 'reviewer said no' }),
    });

    expect(execute).not.toHaveBeenCalled();
    expect(toolResultTexts(result.messages)).toEqual(['Tool call denied: reviewer said no']);
    expect(result.denials[0]).toMatchObject({ action: 'deny', reason: 'reviewer said no' });
  });

  it('gates each call of a parallel batch independently, awaiting async gates', async () => {
    const ran: string[] = [];
    const backend = scriptedBackend([
      toolCalls([
        { id: 't1', name: 'safe', input: {} },
        { id: 't2', name: 'risky', input: {} },
      ]),
      final('done'),
    ]);

    const result = await bridgeFor(backend).runTools({
      prompt: 'go',
      tools: {
        safe: tool(() => ran.push('safe')),
        risky: tool(() => ran.push('risky')),
      },
      gate: async ({ name }) => {
        await Promise.resolve();
        return name === 'risky' ? { action: 'deny', reason: 'nope' } : { action: 'allow' };
      },
    });

    expect(ran).toEqual(['safe']);
    expect(result.denials.map((d) => d.name)).toEqual(['risky']);
  });

  it('fails closed when the gate throws', async () => {
    const execute = vi.fn(() => 'ran');
    const backend = scriptedBackend([toolCalls([{ id: 't1', name: 'x', input: {} }]), final('ok')]);

    const result = await bridgeFor(backend).runTools({
      prompt: 'go',
      tools: { x: tool(execute) },
      gate: () => {
        throw new Error('gate backend down');
      },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(toolResultTexts(result.messages)).toEqual([
      'Tool call denied: gate error: gate backend down',
    ]);
    expect(result.denials[0]).toMatchObject({ action: 'deny' });
  });

  it('does not consult the gate for unknown tools or invalid arguments', async () => {
    const gate = vi.fn<ToolCallGate>(() => ({ action: 'allow' }));
    const backend = scriptedBackend([
      toolCalls([
        { id: 't1', name: 'ghost', input: {} },
        { id: 't2', name: 'typed', input: { path: 5 } },
      ]),
      final('ok'),
    ]);

    await bridgeFor(backend).runTools({
      prompt: 'go',
      tools: { typed: tool(() => 'ran') },
      gate,
    });

    expect(gate).not.toHaveBeenCalled();
  });

  it('ends the loop with status max-denials once the limit is reached', async () => {
    const execute = vi.fn(() => 'ran');
    const backend = scriptedBackend([
      toolCalls([{ id: 't1', name: 'x', input: {} }]),
      toolCalls([{ id: 't2', name: 'x', input: {} }]),
      toolCalls([{ id: 't3', name: 'x', input: {} }]),
      final('never reached'),
    ]);

    const result = await bridgeFor(backend).runTools({
      prompt: 'go',
      tools: { x: tool(execute) },
      gate: () => ({ action: 'deny', reason: 'no' }),
      maxDenials: 2,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe('max-denials');
    expect(result.denials).toHaveLength(2);
    expect(result.steps).toHaveLength(2);
    expect(result.text).toBe('');
    // the conversation ends with the last denial fed back as a tool result
    expect(result.messages.at(-1)?.role).toBe('tool');
  });

  it('leaves status completed and denials empty when no gate is set', async () => {
    const backend = scriptedBackend([toolCalls([{ id: 't1', name: 'x', input: {} }]), final('ok')]);
    const result = await bridgeFor(backend).runTools({
      prompt: 'go',
      tools: { x: tool(() => 'ran') },
    });
    expect(result.status).toBe('completed');
    expect(result.denials).toEqual([]);
  });
});
