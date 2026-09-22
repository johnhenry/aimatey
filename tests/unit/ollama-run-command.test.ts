/**
 * Ollama emulator `run` command tests
 *
 * Covers packages/cli/src/ollama/commands/run.ts: single-prompt
 * (non-interactive) execution, streaming vs. non-streaming output,
 * request/response shape sent to the backend, model-name translation, and
 * model-runner lifecycle/state-manager bookkeeping. No network is used --
 * the backend is a `FunctionBackendAdapter` under full test control.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FunctionBackendAdapter } from '@johnhenry/aimatey-backend-browser';
import type { IRChatRequest, IRChatResponse, IRStreamChunk } from '@johnhenry/aimatey-types';
import { runCommand } from '../../packages/cli/src/ollama/commands/run.js';
import { stateManager } from '../../packages/cli/src/utils/state-manager.js';

function textResponse(text: string): IRChatResponse {
  return {
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    finishReason: 'stop',
    metadata: { requestId: 'req-1', timestamp: Date.now(), provenance: {} },
  };
}

describe('runCommand: single prompt (non-streaming)', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('sends system + user messages to backend.execute and writes the reply text', async () => {
    const executeSpy = vi.fn(async () => textResponse('4'));
    const backend = new FunctionBackendAdapter({ execute: executeSpy });

    await runCommand({
      backend,
      model: 'llama3.1',
      prompt: '2+2?',
      system: 'Answer tersely.',
      noStream: true,
    });

    expect(executeSpy).toHaveBeenCalledTimes(1);
    const requestArg: IRChatRequest = executeSpy.mock.calls[0]![0];
    expect(requestArg.messages).toEqual([
      { role: 'system', content: 'Answer tersely.' },
      { role: 'user', content: '2+2?' },
    ]);
    expect(requestArg.parameters).toEqual({ model: 'llama3.1' });

    expect(logSpy).toHaveBeenCalledWith('4');
  });

  it('omits the system message when none is provided', async () => {
    const executeSpy = vi.fn(async () => textResponse('ok'));
    const backend = new FunctionBackendAdapter({ execute: executeSpy });

    await runCommand({ backend, model: 'llama3.1', prompt: 'hi', noStream: true });

    const requestArg: IRChatRequest = executeSpy.mock.calls[0]![0];
    expect(requestArg.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('prints the full IR response as JSON when --json is set (implies non-streaming)', async () => {
    const response = textResponse('json reply');
    const backend = new FunctionBackendAdapter({ execute: vi.fn(async () => response) });

    await runCommand({ backend, model: 'llama3.1', prompt: 'hi', json: true });

    // FunctionBackendAdapter.execute() stamps provenance.backend and
    // custom.latencyMs onto whatever the execute fn returns, so compare the
    // printed JSON against what execute() actually produced rather than the
    // bare fixture.
    const printed = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(printed.message.content).toEqual(response.message.content);
  });

  it('translates the model name before sending the request', async () => {
    const executeSpy = vi.fn(async () => textResponse('ok'));
    const backend = new FunctionBackendAdapter({ execute: executeSpy });

    await runCommand({
      backend,
      model: 'llama3.1',
      prompt: 'hi',
      modelMapping: { 'llama3.1': 'gpt-4o' },
      noStream: true,
    });

    const requestArg: IRChatRequest = executeSpy.mock.calls[0]![0];
    expect(requestArg.parameters?.model).toBe('gpt-4o');
  });

  it('surfaces backend.execute errors and exits non-zero', async () => {
    const backend = new FunctionBackendAdapter({
      execute: async () => {
        throw new Error('boom');
      },
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await runCommand({ backend, model: 'llama3.1', prompt: 'hi', noStream: true });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe('runCommand: single prompt (streaming, the Ollama-compatible default)', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('writes each content delta to stdout as it arrives, then a trailing newline', async () => {
    async function* stream(): AsyncGenerator<IRStreamChunk> {
      yield { type: 'content', sequence: 0, delta: 'Hel' };
      yield { type: 'content', sequence: 1, delta: 'lo!' };
      yield { type: 'done', sequence: 2, finishReason: 'stop' };
    }

    const backend = new FunctionBackendAdapter({
      execute: vi.fn(async () => textResponse('unused')),
      executeStream: stream,
    });

    await runCommand({ backend, model: 'llama3.1', prompt: 'hi' }); // noStream defaults false

    const written = stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(written).toBe('Hel' + 'lo!' + '\n');
  });

  it('ignores non-content stream chunks', async () => {
    async function* stream(): AsyncGenerator<IRStreamChunk> {
      yield { type: 'start', sequence: 0 } as IRStreamChunk;
      yield { type: 'content', sequence: 1, delta: 'ok' };
      yield { type: 'metadata', sequence: 2, metadata: {} } as IRStreamChunk;
      yield { type: 'done', sequence: 3, finishReason: 'stop' };
    }

    const backend = new FunctionBackendAdapter({
      execute: vi.fn(async () => textResponse('unused')),
      executeStream: stream,
    });

    await runCommand({ backend, model: 'llama3.1', prompt: 'hi' });

    const written = stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(written).toBe('ok\n');
  });
});

describe('runCommand: model-runner lifecycle', () => {
  beforeEach(() => {
    stateManager.clear();
  });

  afterEach(() => {
    stateManager.clear();
  });

  it('starts the runner and registers it in the state manager when not already running', async () => {
    const startSpy = vi.fn(async () => {});
    const backend = new FunctionBackendAdapter({
      execute: vi.fn(async () => textResponse('ok')),
      metadata: { name: 'llamacpp-runner' },
    });
    // Attach model-runner lifecycle methods (isModelRunner checks for
    // start/stop/getStats as functions).
    Object.assign(backend, {
      isRunning: false,
      start: startSpy,
      stop: vi.fn(),
      getStats: vi.fn(() => ({ pid: 4242 })),
    });

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runCommand({ backend, model: 'llama3.1', prompt: 'hi', noStream: true });

    expect(startSpy).toHaveBeenCalledTimes(1);
    const running = stateManager.getAll();
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ name: 'llama3.1', backend: 'llamacpp-runner', pid: 4242 });

    vi.restoreAllMocks();
  });

  it('does not restart an already-running model runner', async () => {
    const startSpy = vi.fn(async () => {});
    const backend = new FunctionBackendAdapter({
      execute: vi.fn(async () => textResponse('ok')),
    });
    Object.assign(backend, {
      isRunning: true,
      start: startSpy,
      stop: vi.fn(),
      getStats: vi.fn(() => ({ pid: 1 })),
    });

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runCommand({ backend, model: 'llama3.1', prompt: 'hi', noStream: true });

    expect(startSpy).not.toHaveBeenCalled();
    expect(stateManager.getAll()).toHaveLength(0);

    vi.restoreAllMocks();
  });
});
