/**
 * Ollama emulator `run` with a decision model (packages/cli/src/ollama/commands/run.ts).
 *
 * A decision model does not chat: `run` asks one noul question,
 * "Is the following true? <prompt>", and prints true/false with P(true).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockDecisionBackend } from '@johnhenry/aimatey-testing';
import { FunctionBackendAdapter } from '@johnhenry/aimatey-backend-browser';
import type { BackendAdapter, IRChatResponse } from '@johnhenry/aimatey-types';
import {
  buildTruthQuestion,
  isDecisionModelRun,
  runCommand,
} from '../../packages/cli/src/ollama/commands/run.js';

describe('runCommand with a decision model', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('asks a single noul question about the prompt and prints the verdict', async () => {
    const backend = createMockDecisionBackend({ answers: { answer: { type: 'noul', value: 0.92 } } });

    await runCommand({ backend, model: 'tev1:0.8b', prompt: 'The sky is blue' });

    expect(backend.calls).toHaveLength(1);
    const request = backend.calls[0]!;
    expect(request.questions).toEqual({
      answer: { type: 'noul', instructions: 'Is the following true? The sky is blue' },
    });
    expect(request.parameters?.model).toBe('tev1:0.8b');
    expect(request.state).toBe('The sky is blue');
    expect(logSpy).toHaveBeenCalledWith('true (P(true) = 0.92)');
  });

  it('judges the prompt against --state when given', async () => {
    const backend = createMockDecisionBackend({ answers: { answer: { type: 'noul', value: 0.1 } } });

    await runCommand({
      backend,
      model: 'nimble:latest',
      prompt: 'It is raining',
      state: 'Weather report: clear skies all day.',
    });

    expect(backend.calls[0]!.state).toBe('Weather report: clear skies all day.');
    expect(logSpy).toHaveBeenCalledWith('false (P(true) = 0.10)');
  });

  it('prints the IR response with --json', async () => {
    const backend = createMockDecisionBackend({ answers: { answer: { type: 'noul', value: 0.7 } } });

    await runCommand({ backend, model: 'tev1', prompt: 'x', json: true });

    expect(JSON.parse(String(logSpy.mock.calls[0]![0])).answers.answer.value).toBe(0.7);
  });

  it('applies the model mapping before deciding', async () => {
    const backend = createMockDecisionBackend({ answers: { answer: { type: 'noul', value: 0.7 } } });

    await runCommand({ backend, model: 'nimble', prompt: 'x', modelMapping: { nimble: 'tev1:0.8b' } });

    expect(backend.calls[0]!.parameters?.model).toBe('tev1:0.8b');
  });
});

describe('isDecisionModelRun', () => {
  const decider = createMockDecisionBackend({});

  it('is true for a decision backend and a decision-family model name', () => {
    expect(isDecisionModelRun(decider, 'tev1:0.8b')).toBe(true);
    expect(isDecisionModelRun(decider, 'library/kev:4b')).toBe(true);
  });

  it('is false for a chat model name, even on a decision-capable backend', () => {
    expect(isDecisionModelRun(decider, 'qwen2.5:3b')).toBe(false);
    expect(isDecisionModelRun(decider, 'monkey')).toBe(false);
  });

  it('is false when the backend cannot decide, so chat behaviour is unchanged', async () => {
    const chat: BackendAdapter = new FunctionBackendAdapter({
      execute: async () =>
        ({
          message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
          finishReason: 'stop',
          metadata: { requestId: 'r', timestamp: 0, provenance: {} },
        }) satisfies IRChatResponse,
    });
    expect(isDecisionModelRun(chat, 'tev1:0.8b')).toBe(false);
  });

  it('builds the documented question', () => {
    expect(buildTruthQuestion('a thing').answer).toEqual({
      type: 'noul',
      instructions: 'Is the following true? a thing',
    });
  });
});
