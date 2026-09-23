/**
 * Shared ONNX Runtime (Node) integration layer.
 *
 * Not tied to any one model or provider -- this is the piece any
 * `onnxruntime-node`-backed Aimatey backend (Laya today, others later)
 * shares: a common execution-provider/session/cache config shape, a
 * lazy-load helper for the optional native binding with the same
 * graceful-failure pattern `native-apple`/`native-node-llamacpp` already
 * use for their own optional native deps, and a consistent error mapping
 * into `ProviderError`.
 *
 * **Node only, deliberately.** `onnxruntime-node` is native bindings
 * (`.node` addons per platform/arch) -- it cannot run in a browser at
 * all. A browser-capable ONNX backend needs `onnxruntime-web` instead
 * (WASM/WebGPU, fetches its model over HTTP instead of reading the
 * filesystem, different session-creation options), which is a genuinely
 * different runtime with a different API, not a config toggle on this
 * one. That would be a separate package (mirroring how
 * `packages/backend`/`packages/backend-browser` are two packages, not
 * one with a flag) sharing only the pure-IR-mapping half of a decision
 * adapter's job, not this module.
 *
 * @module
 */

import { AdapterError, ErrorCode, ProviderError } from '@johnhenry/aimatey-errors';

// ============================================================================
// Shared config
// ============================================================================

/**
 * Config shared by any `onnxruntime-node`-backed adapter. Mirrors the
 * options real ONNX-model-loading packages already expose (verified
 * against `@receptron/laya`'s `Laya.load()`), generalized so a second
 * ONNX-backed adapter isn't left reinventing the same four fields.
 */
export interface OnnxRuntimeConfig {
  /** Where downloaded model weights are cached on disk. */
  readonly cacheDir?: string;
  /** Passed straight through to `onnxruntime-node`'s session creation. */
  readonly executionProviders?: readonly string[];
  /** Passed straight through to `onnxruntime-node`'s session creation. */
  readonly sessionOptions?: Record<string, unknown>;
  /** Reports weight-download progress (first run only; cached after). */
  readonly onProgress?: (event: { readonly loaded: number; readonly total: number }) => void;
}

// ============================================================================
// Lazy load
// ============================================================================

let onnxRuntime: unknown;

/**
 * Load `onnxruntime-node` with graceful failure. For adapters that talk
 * to a raw `InferenceSession` directly; adapters built on a higher-level
 * package (like `@receptron/laya`) that already bundles its own
 * `onnxruntime-node` dependency don't need this -- see `native-laya`.
 */
export async function loadOnnxRuntime(): Promise<unknown> {
  if (!onnxRuntime) {
    try {
      // Non-literal specifier: `onnxruntime-node` is an optional peer
      // dependency that may not be installed, and TS's "does this resolve"
      // check on a dynamic import() only applies to a literal string
      // argument -- a variable sidesteps it (returns Promise<any>)
      // regardless of TS version/resolution-mode differences across
      // environments, which a `@ts-expect-error` directive does not:
      // whether that specific error fires at all has been observed to
      // differ between a local `tsc` run and a clean CI `npm ci` build.
      const specifier = 'onnxruntime-node';
      onnxRuntime = await import(specifier);
    } catch (error) {
      throw new AdapterError({
        code: ErrorCode.PROVIDER_ERROR,
        message:
          'Failed to load onnxruntime-node. Install it with: npm install onnxruntime-node\n' +
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        cause: error instanceof Error ? error : undefined,
      });
    }
  }
  return onnxRuntime;
}

// ============================================================================
// Error mapping
// ============================================================================

/** Wrap an ONNX-backend failure into the family's standard `ProviderError` shape. */
export function toOnnxProviderError(
  error: unknown,
  backendName: string,
  isRetryable = true
): ProviderError {
  return new ProviderError({
    code: ErrorCode.PROVIDER_ERROR,
    message: `${backendName} execution failed: ${error instanceof Error ? error.message : String(error)}`,
    isRetryable,
    provenance: { backend: backendName },
    cause: error instanceof Error ? error : undefined,
  });
}
