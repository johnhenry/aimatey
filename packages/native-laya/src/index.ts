/**
 * Laya Backend Adapter
 *
 * Backend adapter for ConvAI's Laya typed-decision model, via
 * `@receptron/laya` -- a real, MIT-licensed TypeScript/ONNX Runtime port
 * of Laya's inference (github.com/receptron/laya), not a wrapper around a
 * hosted API. This supersedes the "needs a new Python wrapper service"
 * assumption documented in `@johnhenry/aimatey-frontend`'s
 * `LayaFrontendAdapter` when it was written frontend-only -- that comment
 * is now stale; this package is the thing it was waiting for.
 *
 * Like `TypeSafeBackendAdapter`, this implements only `metadata` +
 * `decide()` + `estimateDecisionCost()` -- Laya is not a chat model, and
 * `fromIR`/`toIR`/`execute`/`executeStream` are optional on
 * `BackendAdapter` precisely so a decision-only backend isn't forced to
 * fake a capability it doesn't have.
 *
 * Node only -- `@receptron/laya` depends on `onnxruntime-node` (native
 * bindings), same constraint as `@johnhenry/aimatey-native-onnx`
 * (this package's sibling, which owns the shared execution-provider/
 * session/cache config shape reused below). See that package's module
 * comment for why a browser variant isn't a flag on this one.
 *
 * Answer-shape mapping below is verified against Laya's actual source,
 * not assumed -- see `LayaFrontendAdapter`'s module comment
 * (`packages/frontend/src/adapters/laya.ts`) for the three confirmed
 * structural differences from Jev this adapter's `toIRAnswer` un-does:
 * answers self-report their own `type`, `score` probabilities are keyed
 * by stringified index rather than an array, and `noul` answers carry a
 * real `confidence`.
 *
 * @module
 */

import type {
  BackendAdapter,
  AdapterMetadata,
  IRDecisionRequest,
  IRDecisionResponse,
  IRDecisionAnswer,
} from '@johnhenry/aimatey-types';
import { AdapterError, ErrorCode, ProviderError } from '@johnhenry/aimatey-errors';
import { toOnnxProviderError, type OnnxRuntimeConfig } from '@johnhenry/aimatey-native-onnx';

// ============================================================================
// Laya-native wire types, verified against a real, live @receptron/laya
// response, not just source reading -- see the `noul` variant below for
// what that live check corrected.
// ============================================================================

type LayaWireAnswer =
  | {
      readonly type: 'choice';
      readonly choice: string;
      readonly probabilities: Record<string, number>;
      readonly confidence: number;
    }
  | {
      readonly type: 'score';
      /** Probability-weighted expected value over the level indices -- not
       * necessarily an integer (e.g. `1.1157` for a distribution weighted
       * toward index 1). Confirmed live, not assumed. */
      readonly score: number;
      readonly probabilities: Record<string, number>;
      readonly confidence: number;
    }
  | {
      readonly type: 'noul';
      readonly noul: number;
      /** Absent in practice -- a live `@receptron/laya` response's `noul`
       * answer carries no `confidence` field at all, contrary to this
       * adapter's original (source-reading-only) assumption. `toIRAnswer`
       * derives one the same way `LayaFrontendAdapter` already does. */
      readonly confidence?: number;
    };

interface LayaWireResponse {
  readonly model: string;
  readonly answers: Record<string, LayaWireAnswer>;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

// ============================================================================
// Lazy load
// ============================================================================

let laya: any;

async function loadLaya(): Promise<any> {
  if (!laya) {
    try {
      // Non-literal specifier: see native-onnx's loadOnnxRuntime() for why
      // a `@ts-expect-error` directive here is unreliable across environments.
      const specifier = '@receptron/laya';
      laya = await import(specifier);
    } catch (error) {
      throw new AdapterError({
        code: ErrorCode.PROVIDER_ERROR,
        message:
          'Failed to load @receptron/laya. Install it with: npm install @receptron/laya\n' +
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        cause: error instanceof Error ? error : undefined,
      });
    }
  }
  return laya;
}

// ============================================================================
// Configuration
// ============================================================================

export interface LayaBackendConfig extends OnnxRuntimeConfig {
  /** Local directory holding an already-downloaded ONNX bundle; skips the HF download. */
  readonly modelDir?: string;
  /** HuggingFace repo holding the ONNX bundle. Defaults to Laya's own published repo. */
  readonly repo?: string;
  /** Checkpoint variant within the repo (e.g. 'english', 'multilingual'). */
  readonly subfolder?: string;
  /** Repo revision/ref. */
  readonly revision?: string;
  /** HuggingFace access token, for private/gated repos. */
  readonly token?: string;
}

// ============================================================================
// Laya Backend Adapter
// ============================================================================

export class LayaBackendAdapter implements BackendAdapter {
  readonly metadata: AdapterMetadata;
  private readonly config: LayaBackendConfig;
  private instance: any;
  private loading?: Promise<any>;

  constructor(config: LayaBackendConfig = {}) {
    this.config = config;
    this.metadata = {
      name: 'laya-backend',
      version: '1.0.0',
      provider: 'ConvAI (Laya)',
      capabilities: {
        decisions: true,
        // Chat-shaped fields don't apply -- see TypeSafeBackendAdapter's
        // identical reasoning for why these are `false`/'not-supported'
        // rather than omitted.
        streaming: false,
        multiModal: false,
        tools: false,
        systemMessageStrategy: 'not-supported',
        supportsMultipleSystemMessages: false,
      },
      config: {},
    };
  }

  /**
   * Load the ONNX bundle and start a Laya session. Idempotent and
   * concurrency-safe (concurrent callers await the same in-flight load
   * rather than racing two downloads) -- `decide()` calls this lazily, but
   * calling it eagerly surfaces a missing-dependency or download failure
   * before the first real request.
   */
  async initialize(): Promise<void> {
    if (this.instance) {
      return;
    }
    this.loading ??= this.load();
    this.instance = await this.loading;
  }

  private async load(): Promise<any> {
    const Laya = await loadLaya();
    return Laya.Laya.load({
      modelDir: this.config.modelDir,
      repo: this.config.repo,
      subfolder: this.config.subfolder,
      revision: this.config.revision,
      cacheDir: this.config.cacheDir,
      token: this.config.token,
      onProgress: this.config.onProgress,
      executionProviders: this.config.executionProviders,
      sessionOptions: this.config.sessionOptions,
    });
  }

  /**
   * Answer a typed-decision request by running Laya's ONNX model
   * in-process -- no network hop, no hosted API.
   */
  async decide(request: IRDecisionRequest): Promise<IRDecisionResponse> {
    try {
      await this.initialize();
      const response = (await this.instance.systemOne(
        request.state,
        request.questions
      )) as LayaWireResponse;

      const answers: Record<string, IRDecisionAnswer> = {};
      for (const [name, raw] of Object.entries(response.answers)) {
        answers[name] = toIRAnswer(raw);
      }

      return {
        answers,
        model: response.model,
        usage: { inputTokens: response.usage.input_tokens },
        metadata: {
          ...request.metadata,
          provenance: {
            ...request.metadata.provenance,
            backend: this.metadata.name,
          },
        },
        raw: response as unknown as Record<string, unknown>,
      };
    } catch (error) {
      if (error instanceof AdapterError || error instanceof ProviderError) {
        throw error;
      }
      throw toOnnxProviderError(error, this.metadata.name);
    }
  }

  /**
   * Always 0 -- unlike a hosted API (TypeSafe's `estimateDecisionCost`
   * returns `null`, genuinely unknown until the response), local on-device
   * inference has no per-call billing to estimate. This is a known,
   * exact answer, not an unhelpful placeholder.
   */
  estimateDecisionCost(_request: IRDecisionRequest): Promise<number | null> {
    return Promise.resolve(0);
  }

  /** Release the underlying ONNX session. */
  async close(): Promise<void> {
    if (this.instance) {
      await this.instance.close();
      this.instance = undefined;
      this.loading = undefined;
    }
  }

  /**
   * Health check: a real session load is the only meaningful check --
   * Laya has no separate key/connectivity check the way a hosted API might.
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.initialize();
      return true;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// Response mapping
// ============================================================================

/**
 * Exported for direct testing -- `@receptron/laya` is an optional peer
 * dependency, and Vite's own optional-peer-dep handling stubs its
 * specifier to throw before `vi.mock` can intercept it, the same reason
 * `native-apple`/`native-node-llamacpp` don't unit-test their lazy-loaded
 * model invocation paths either. This mapping is the genuinely novel
 * logic worth verifying directly.
 */
export function toIRAnswer(raw: LayaWireAnswer): IRDecisionAnswer {
  switch (raw.type) {
    case 'choice':
      return {
        type: 'choice',
        value: raw.choice,
        probabilities: raw.probabilities,
        confidence: raw.confidence,
      };
    case 'score': {
      // Laya keys `probabilities` by stringified index; the IR's `score`
      // answer is an array ordered the same way the question's own
      // `criteria` array is -- reconstruct by numeric key order, not
      // object-insertion order (not guaranteed to match).
      const probabilities = Object.keys(raw.probabilities)
        .map(Number)
        .sort((a, b) => a - b)
        .map((i) => raw.probabilities[String(i)] ?? 0);
      return {
        type: 'score',
        value: raw.score,
        probabilities,
        confidence: raw.confidence,
      };
    }
    case 'noul':
      return {
        type: 'noul',
        value: raw.noul,
        // Derive if the wire response didn't report one -- see LayaWireAnswer's
        // `noul.confidence` comment; same derivation LayaFrontendAdapter uses.
        confidence: raw.confidence ?? Math.max(raw.noul, 1 - raw.noul),
      };
  }
}
