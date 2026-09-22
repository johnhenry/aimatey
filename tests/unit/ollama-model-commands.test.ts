/**
 * Ollama emulator `list`/`ps`/`show` command tests
 *
 * Covers packages/cli/src/ollama/commands/{list,ps,show}.ts against a
 * mocked/fixture backend and (for `ps`) the real `stateManager` singleton --
 * no network or real backend is used, matching the task's fixture-registry
 * requirement.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BackendAdapter } from '@johnhenry/aimatey-types';
import { listCommand } from '../../packages/cli/src/ollama/commands/list.js';
import { psCommand } from '../../packages/cli/src/ollama/commands/ps.js';
import { showCommand } from '../../packages/cli/src/ollama/commands/show.js';
import { stateManager } from '../../packages/cli/src/utils/state-manager.js';
import { setColorsEnabled } from '../../packages/cli/src/utils/output-formatter.js';

// Disable ANSI color codes for the whole file so assertions can match plain
// substrings instead of escape-sequence-wrapped strings.
setColorsEnabled(false);

function makeBackend(overrides: Record<string, unknown> = {}): BackendAdapter {
  return {
    metadata: {
      name: 'test-backend',
      provider: 'TestProvider',
      version: '1.0.0',
      capabilities: { streaming: true, tools: false, vision: true },
    },
    execute: vi.fn(),
    ...overrides,
  } as unknown as BackendAdapter;
}

// ============================================================================
// list
// ============================================================================

describe('listCommand', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  const fixtureModels = [
    { id: 'gpt-4o-2024-08-06', name: 'gpt-4o', contextWindow: 128000, created: 1_700_000_000_000 },
    { id: 'gpt-4o-mini-2024', name: 'gpt-4o-mini', contextWindow: 128000, created: 1_700_100_000_000 },
  ];

  it('prints the raw model list as JSON when --json is set', async () => {
    const backend = makeBackend({
      listModels: vi.fn(async () => ({ models: fixtureModels, source: 'static' })),
    });

    await listCommand({ backend, json: true });

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(fixtureModels, null, 2));
  });

  it('reports no models available when the registry is empty', async () => {
    const backend = makeBackend({ listModels: vi.fn(async () => ({ models: [] })) });

    await listCommand({ backend, json: false });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No models available'));
  });

  it('warns and returns when the backend does not implement listModels', async () => {
    const backend = makeBackend(); // no listModels

    await listCommand({ backend, json: false });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('does not support listing models')
    );
  });

  it('renders a table with model names and truncated ids', async () => {
    const backend = makeBackend({
      listModels: vi.fn(async () => ({ models: fixtureModels })),
    });

    await listCommand({ backend, json: false });

    const rendered = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(rendered).toContain('gpt-4o-mini');
    expect(rendered).toContain('gpt-4o-2024-08-06'.slice(0, 12));
    expect(rendered).toContain('128K ctx');
  });

  it('shows the backend model name alongside its mapped alias', async () => {
    const backend = makeBackend({
      listModels: vi.fn(async () => ({ models: [fixtureModels[0]] })),
    });

    await listCommand({ backend, json: false, modelMapping: { 'llama3.1': 'gpt-4o' } });

    const rendered = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    // The mapping is keyed llama3.1 -> gpt-4o; the row must show the *alias*
    // (llama3.1) next to the real backend model name (gpt-4o).
    expect(rendered).toContain('llama3.1');
  });
});

// ============================================================================
// ps
// ============================================================================

describe('psCommand', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stateManager.clear();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    stateManager.clear();
  });

  it('reports nothing running when the state manager is empty', async () => {
    await psCommand({ backend: makeBackend(), json: false });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No models currently running'));
  });

  it('prints "[]" for an empty registry when --json is set', async () => {
    await psCommand({ backend: makeBackend(), json: true });
    expect(logSpy).toHaveBeenCalledWith('[]');
  });

  it('prints the running models as JSON straight from the state manager', async () => {
    stateManager.add({
      name: 'llama3.1',
      backend: 'test-backend',
      pid: 4242,
      startTime: 1_700_000_000_000,
      lastActivity: 1_700_000_000_000,
    });

    await psCommand({ backend: makeBackend(), json: true });

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(stateManager.getAll(), null, 2));
  });

  it('formats size, id, and status in the table for a running model', async () => {
    stateManager.add({
      name: 'llama3.1',
      backend: 'test-backend',
      pid: 4242,
      size: 2_000_000_000, // ~1.9 GB
      startTime: Date.now(),
      lastActivity: Date.now(),
    });

    await psCommand({ backend: makeBackend(), json: false });

    const rendered = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(rendered).toContain('llama3.1');
    expect(rendered).toContain('1.9 GB');
    expect(rendered).toContain('424'); // pid.toString().slice(0, 12)
    expect(rendered).toContain('Running');
  });

  it('labels the processor GPU/CPU for a model-runner backend and API otherwise', async () => {
    stateManager.add({
      name: 'llama3.1',
      backend: 'api-backend',
      startTime: Date.now(),
      lastActivity: Date.now(),
    });

    await psCommand({ backend: makeBackend(), json: false });
    let rendered = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(rendered).toContain('API');

    logSpy.mockClear();

    const runnerBackend = makeBackend({
      start: vi.fn(),
      stop: vi.fn(),
      getStats: vi.fn(() => ({ uptime: 5000, requestCount: 3 })),
    });

    await psCommand({ backend: runnerBackend, json: false });
    rendered = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(rendered).toContain('GPU/CPU');
  });

  it('prints backend uptime and request count in verbose mode for a model runner', async () => {
    stateManager.add({
      name: 'llama3.1',
      backend: 'test-backend',
      startTime: Date.now(),
      lastActivity: Date.now(),
    });
    const runnerBackend = makeBackend({
      start: vi.fn(),
      stop: vi.fn(),
      getStats: vi.fn(() => ({ uptime: 5000, requestCount: 3 })),
    });

    await psCommand({ backend: runnerBackend, json: false, verbose: true });

    const rendered = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(rendered).toContain('Request count: 3');
  });
});

// ============================================================================
// show
// ============================================================================

describe('showCommand', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('prints backend/provider/name info as JSON', async () => {
    const backend = makeBackend();

    await showCommand({ backend, model: 'llama3.1', json: true });

    const jsonCall = logSpy.mock.calls.find((call) => {
      try {
        JSON.parse(String(call[0]));
        return true;
      } catch {
        return false;
      }
    });
    expect(jsonCall).toBeDefined();
    const info = JSON.parse(String(jsonCall![0]));
    expect(info).toMatchObject({
      name: 'llama3.1',
      backend: 'test-backend',
      provider: 'TestProvider',
    });
  });

  it('resolves the translated model name through the model mapping', async () => {
    const backend = makeBackend();

    await showCommand({
      backend,
      model: 'llama3.1',
      modelMapping: { 'llama3.1': 'gpt-4o' },
      json: true,
    });

    const info = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(info.translatedName).toBe('gpt-4o');
  });

  it('attaches modelDetails found via listModels for the translated name', async () => {
    const backend = makeBackend({
      listModels: vi.fn(async () => ({
        models: [{ name: 'gpt-4o', contextWindow: 128000, description: 'flagship model' }],
      })),
    });

    await showCommand({
      backend,
      model: 'llama3.1',
      modelMapping: { 'llama3.1': 'gpt-4o' },
      json: true,
    });

    const info = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(info.modelDetails).toEqual({
      name: 'gpt-4o',
      contextWindow: 128000,
      description: 'flagship model',
    });
  });

  it('ignores listModels failures and still renders base info', async () => {
    const backend = makeBackend({
      listModels: vi.fn(async () => {
        throw new Error('registry unavailable');
      }),
    });

    await expect(
      showCommand({ backend, model: 'llama3.1', json: true })
    ).resolves.toBeUndefined();

    const info = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(info.modelDetails).toBeUndefined();
  });

  it('includes runtime and config details for a model-runner backend', async () => {
    const backend = makeBackend({
      start: vi.fn(),
      stop: vi.fn(),
      getStats: vi.fn(() => ({ isRunning: true, pid: 999, uptime: 1234, requestCount: 7 })),
      config: { runtime: { contextSize: 4096, gpuLayers: 20, threads: 8, batchSize: 512 } },
    });

    await showCommand({ backend, model: 'llama3.1', json: true });

    const info = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(info.runtime).toEqual({
      isRunning: true,
      pid: 999,
      uptime: 1234,
      requestCount: 7,
    });
    expect(info.config).toEqual({
      contextSize: 4096,
      gpuLayers: 20,
      threads: 8,
      batchSize: 512,
    });
  });

  it('renders capability checkmarks in the non-JSON view', async () => {
    const backend = makeBackend();

    await showCommand({ backend, model: 'llama3.1', json: false });

    const rendered = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(rendered).toContain('streaming         ✓');
    expect(rendered).toContain('tools             ✗');
    expect(rendered).toContain('vision            ✓');
  });
});
