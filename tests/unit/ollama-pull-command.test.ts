/**
 * Ollama emulator `pull` command tests
 *
 * Covers packages/cli/src/ollama/commands/pull.ts: the GGUF-download flow
 * against the Ollama registry (manifest fetch -> model-layer selection ->
 * blob download -> file write). No real network calls are made -- `global.fetch`
 * is mocked with real `Response` objects, matching the mocking style already
 * used for backend `listModels()` network tests in this repo
 * (tests/unit/backend-function.test.ts, tests/unit/embeddings.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pullCommand } from '../../packages/cli/src/ollama/commands/pull.js';

function manifestResponse(layers: Array<Record<string, unknown>>): Response {
  return new Response(JSON.stringify({ layers }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function blobResponse(content: string): Response {
  return new Response(content, { status: 200 });
}

/**
 * `pullCommand` calls `process.exit(1)` on failure and relies on that
 * actually terminating the process. In-test, `process.exit` is mocked, so it
 * must *throw* rather than silently return `undefined` -- otherwise
 * execution falls through past the guard (e.g. the "file already exists"
 * check) into the download step it was supposed to prevent, which is not
 * what the real CLI does.
 */
class ProcessExitSignal extends Error {
  constructor(public code?: number) {
    super(`process.exit(${code})`);
  }
}

describe('pullCommand', () => {
  let tmpDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorLogSpy: ReturnType<typeof vi.spyOn>;
  let infoLogSpy: ReturnType<typeof vi.spyOn>;
  let warnLogSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  const originalForceOverwrite = process.env.FORCE_OVERWRITE;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aimatey-pull-test-'));
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitSignal(code);
    }) as unknown as typeof process.exit);
    errorLogSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    infoLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnLogSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    delete process.env.FORCE_OVERWRITE;
  });

  afterEach(async () => {
    exitSpy.mockRestore();
    errorLogSpy.mockRestore();
    infoLogSpy.mockRestore();
    warnLogSpy.mockRestore();
    stdoutSpy.mockRestore();
    vi.unstubAllGlobals();
    await rm(tmpDir, { recursive: true, force: true });
    if (originalForceOverwrite === undefined) {
      delete process.env.FORCE_OVERWRITE;
    } else {
      process.env.FORCE_OVERWRITE = originalForceOverwrite;
    }
  });

  it('downloads the GGUF layer to the requested output path', async () => {
    const outputPath = join(tmpDir, 'phi3.gguf');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        manifestResponse([
          { mediaType: 'application/vnd.ollama.image.config', digest: 'sha256:cfg', size: 10 },
          {
            mediaType: 'application/vnd.ollama.image.model',
            digest: 'sha256:modellayer',
            size: 17,
          },
        ])
      )
      .mockResolvedValueOnce(blobResponse('fake gguf content'));
    vi.stubGlobal('fetch', fetchMock);

    await pullCommand({ model: 'phi3:3.8b', output: outputPath });

    expect(existsSync(outputPath)).toBe(true);
    const written = await readFile(outputPath, 'utf-8');
    expect(written).toBe('fake gguf content');
    expect(exitSpy).not.toHaveBeenCalled();

    // Manifest and blob URLs are built from the parsed model name/tag.
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://registry.ollama.ai/v2/library/phi3/manifests/3.8b',
      expect.anything()
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://registry.ollama.ai/v2/library/phi3/blobs/sha256:modellayer'
    );
  });

  it('selects the layer tagged as the Ollama model, not merely the largest layer', async () => {
    // Regression-shaped case: a bigger *non*-model layer must not be chosen
    // over the correctly-tagged (but smaller) model layer.
    const outputPath = join(tmpDir, 'model.gguf');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        manifestResponse([
          { mediaType: 'application/vnd.ollama.image.params', digest: 'sha256:bigparams', size: 999_999 },
          { mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:realmodel', size: 42 },
        ])
      )
      .mockResolvedValueOnce(blobResponse('x'.repeat(42)));
    vi.stubGlobal('fetch', fetchMock);

    await pullCommand({ model: 'tinymodel', output: outputPath });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://registry.ollama.ai/v2/library/tinymodel/blobs/sha256:realmodel'
    );
  });

  it('defaults the tag to "latest" when the model spec has no tag', async () => {
    const outputPath = join(tmpDir, 'llama.gguf');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        manifestResponse([{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:d', size: 3 }])
      )
      .mockResolvedValueOnce(blobResponse('abc'));
    vi.stubGlobal('fetch', fetchMock);

    await pullCommand({ model: 'llama3.1', output: outputPath });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://registry.ollama.ai/v2/library/llama3.1/manifests/latest',
      expect.anything()
    );
  });

  it('exits with an error when the manifest 404s', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response('not found', { status: 404, statusText: 'Not Found' })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      pullCommand({ model: 'does-not-exist', output: join(tmpDir, 'x.gguf') })
    ).rejects.toThrow(ProcessExitSignal);

    expect(errorLogSpy.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining('Model not found: does-not-exist:latest')
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // never attempted the blob download
  });

  it('exits with an error when the manifest has no usable layer', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(manifestResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      pullCommand({ model: 'empty-model', output: join(tmpDir, 'x.gguf') })
    ).rejects.toThrow(ProcessExitSignal);

    expect(errorLogSpy.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining('No model layer found in manifest')
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('refuses to overwrite an existing file without FORCE_OVERWRITE', async () => {
    const outputPath = join(tmpDir, 'existing.gguf');
    await mkdir(tmpDir, { recursive: true });
    await (await import('node:fs/promises')).writeFile(outputPath, 'already here');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        manifestResponse([{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:d', size: 3 }])
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      pullCommand({ model: 'existing', output: outputPath })
    ).rejects.toThrow(ProcessExitSignal);

    expect(errorLogSpy.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining('Use FORCE_OVERWRITE=true to overwrite existing file')
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    // Blob download must never have been attempted -- process.exit() inside
    // the guard must stop execution before it falls through to downloadBlob().
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const content = await readFile(outputPath, 'utf-8');
    expect(content).toBe('already here'); // untouched
  });

  it('overwrites an existing file when FORCE_OVERWRITE=true', async () => {
    const outputPath = join(tmpDir, 'existing.gguf');
    await mkdir(tmpDir, { recursive: true });
    await (await import('node:fs/promises')).writeFile(outputPath, 'stale content');
    process.env.FORCE_OVERWRITE = 'true';

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        manifestResponse([{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:d', size: 5 }])
      )
      .mockResolvedValueOnce(blobResponse('fresh'));
    vi.stubGlobal('fetch', fetchMock);

    await pullCommand({ model: 'existing', output: outputPath });

    expect(exitSpy).not.toHaveBeenCalled();
    const content = await readFile(outputPath, 'utf-8');
    expect(content).toBe('fresh');
  });
});
