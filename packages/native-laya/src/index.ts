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
 * by stringified index rather than an array, and `noul` answers carry
 * *no* `confidence` on the wire (a live check corrected an earlier
 * source-reading claim that they did) -- `toIRAnswer` derives one.
 *
 * Every wire answer also carries an `rl_agent: { act_probability }`
 * sub-object with no IR equivalent. It is kept, per question, under
 * `response.raw.rl_agent` rather than dropped. (Convai's own
 * evaluation found `act_probability` uninformative -- AUROC 0.30 -- so
 * treat it as diagnostic, not as a confidence signal.)
 *
 * `Laya.systemOne(state, questions)` takes nothing else: the checkpoint is
 * chosen at load time (`subfolder`), and there is no per-call `task`/`lang`
 * routing hint (those belong to the Python `Router`, not the ONNX port).
 * `decide()` therefore cannot honour `parameters.model` or
 * `parameters.custom.task`/`lang` per request and says so with
 * `parameter-unsupported` warnings instead of ignoring them silently.
 *
 * @module
 */

import type {
  BackendAdapter,
  AdapterMetadata,
  IRDecisionRequest,
  IRDecisionResponse,
  IRDecisionAnswer,
  IRWarning,
} from '@johnhenry/aimatey-types';
import { AdapterError, ErrorCode, ProviderError } from '@johnhenry/aimatey-errors';
import { toOnnxProviderError, type OnnxRuntimeConfig } from '@johnhenry/aimatey-native-onnx';

// ============================================================================
// Laya-native wire types, verified against a real, live @receptron/laya
// response, not just source reading -- see the `noul` variant below for
// what that live check corrected.
// ============================================================================

type LayaWireAnswer = (
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
    }
) & {
  /** Action-selection sub-object on every live answer; no IR equivalent. */
  readonly rl_agent?: { readonly act_probability: number };
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
        decisionModels: ['english', 'multilingual', 'typed-decisions'],
        decisionTypes: ['choice', 'score', 'noul'],
        decisionImages: false,
        // Laya's own guidance: weak past ~20 options. The state budget is
        // the English checkpoint's 512 tokens (multilingual allows 1024).
        decisionLimits: {
          maxChoiceOptions: 20,
          maxScoreLevels: 10,
          maxStateTokens: 512,
          maxImages: 0,
        },
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
   *
   * An in-flight ONNX run cannot be cancelled, so `signal` is checked
   * before the (possibly slow) load, before `systemOne()`, and once the
   * result arrives; an abort rejects with the signal's own reason (an
   * `AbortError`), like a `fetch` aborted mid-request.
   */
  async decide(request: IRDecisionRequest, signal?: AbortSignal): Promise<IRDecisionResponse> {
    try {
      signal?.throwIfAborted();
      await this.initialize();
      signal?.throwIfAborted();
      const response = (await this.instance.systemOne(
        request.state,
        request.questions
      )) as LayaWireResponse;
      signal?.throwIfAborted();

      // Build from the request's questions, not the response's answers, so
      // an unanswered question is an error rather than a silent gap.
      const answers: Record<string, IRDecisionAnswer> = {};
      const rlAgent: Record<string, unknown> = {};
      for (const name of Object.keys(request.questions)) {
        const raw = response.answers[name];
        if (!raw) {
          throw new ProviderError({
            code: ErrorCode.PROVIDER_ERROR,
            message: `Laya response is missing an answer for question '${name}'`,
            isRetryable: false,
            provenance: { backend: this.metadata.name },
          });
        }
        answers[name] = toIRAnswer(raw);
        if (raw.rl_agent) {
          rlAgent[name] = raw.rl_agent;
        }
      }

      const warnings = this.unsupportedParameterWarnings(request);

      return {
        provider: 'laya',
        answers,
        model: response.model,
        usage: { inputTokens: response.usage.input_tokens },
        metadata: {
          ...request.metadata,
          provenance: {
            ...request.metadata.provenance,
            backend: this.metadata.name,
          },
          ...(warnings.length > 0 && {
            warnings: [...(request.metadata.warnings ?? []), ...warnings],
          }),
        },
        raw: {
          ...(response as unknown as Record<string, unknown>),
          ...(Object.keys(rlAgent).length > 0 && { rl_agent: rlAgent }),
        },
      };
    } catch (error) {
      if (signal?.aborted || error instanceof AdapterError || error instanceof ProviderError) {
        throw error;
      }
      throw toOnnxProviderError(error, this.metadata.name);
    }
  }

  /**
   * `Laya.systemOne()` takes only `(state, questions)`: the checkpoint is
   * fixed when the session loads, and there is no per-call `task`/`lang`.
   * Rather than drop those request parameters silently, report them.
   */
  private unsupportedParameterWarnings(request: IRDecisionRequest): IRWarning[] {
    const warnings: IRWarning[] = [];
    const source = this.metadata.name;

    const model = request.parameters?.model;
    if (model !== undefined && model !== this.config.subfolder) {
      warnings.push({
        category: 'parameter-unsupported',
        severity: 'warning',
        message:
          `Laya's checkpoint is fixed when the session loads (subfolder: ${this.config.subfolder ?? 'default'}); ` +
          `parameters.model '${model}' was ignored. Construct a LayaBackendAdapter with subfolder '${model}' instead.`,
        field: 'parameters.model',
        originalValue: model,
        source,
      });
    }

    if (request.images?.length) {
      warnings.push({
        category: 'capability-unsupported',
        severity: 'warning',
        message: `Laya takes no images; ${request.images.length} image(s) were ignored.`,
        field: 'images',
        source,
      });
    }

    for (const hint of ['task', 'lang'] as const) {
      const value = request.parameters?.custom?.[hint];
      if (value !== undefined) {
        warnings.push({
          category: 'parameter-unsupported',
          severity: 'warning',
          message: `@receptron/laya's systemOne() has no per-call '${hint}' routing hint; '${String(value)}' was ignored.`,
          field: `parameters.custom.${hint}`,
          originalValue: value,
          source,
        });
      }
    }

    return warnings;
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
