/**
 * System One Backend Adapter
 *
 * A generic, decision-only adapter for any server that speaks the "System
 * One" typed-decision protocol (`POST { model, state, questions }` -> typed
 * answers). The pydantic-ai `SystemOneModel` equivalent: point it at a URL,
 * pick a {@link SystemOneDialect}, and `Bridge.decide()` works.
 *
 * Targets:
 * - self-hosted Kev, Strands Decider, `laya[serve]` and Nimble servers
 *   (dialect `'systemone'`, the default);
 * - a local Ollama (`baseURL: 'http://localhost:11434/v1'`) -- though
 *   {@link OllamaBackendAdapter} is the better fit there;
 * - Vercel AI Gateway's TypeSafe route
 *   (`baseURL: 'https://ai-gateway.vercel.sh/typesafe/v1'`, dialect
 *   `'systemone'`; its own `/v1/evaluate` route is dialect `'vercel-evaluate'`);
 * - OpenRouter (dialect `'openrouter'`);
 * - OpenAI Decisions once its schema is public (dialect `'openai-decisions'`
 *   is an unverified placeholder until then).
 *
 * Like {@link TypeSafeBackendAdapter} it implements only `metadata` and
 * `decide()`; there is no chat.
 *
 * @module
 */

import type {
  BackendAdapter,
  AdapterMetadata,
  BackendAdapterConfig,
  IRDecisionRequest,
  IRDecisionResponse,
  IRCapabilities,
} from '@johnhenry/aimatey-types';
import {
  SYSTEMONE_DIALECTS,
  buildImageDroppedWarning,
  buildSystemOneRequest,
  decideViaSystemOne,
  postSystemOne,
  type SystemOneDialect,
} from '../decisions/systemone-client.js';

export interface SystemOneBackendConfig extends BackendAdapterConfig {
  /**
   * Server base URL, up to but not including the dialect's endpoint
   * (`http://localhost:11434/v1` -> POSTs to `.../v1/systemone`). For the
   * `'cloudflare'` dialect it is the complete, model-specific URL.
   */
  readonly baseURL: string;
  /** Sent as `Authorization: Bearer <key>` when set; self-hosted servers usually need none. */
  readonly apiKey?: string;
  /** Wire dialect (default `'systemone'`). */
  readonly dialect?: SystemOneDialect;
  /** Adapter name in provenance and errors (default `'systemone-backend'`). */
  readonly name?: string;
  /** Model used when a request names none. */
  readonly defaultModel?: string;
  /** Question types the server answers (default all three). */
  readonly decisionTypes?: IRCapabilities['decisionTypes'];
  /** Server limits, declared so callers can pre-flight a request. */
  readonly decisionLimits?: IRCapabilities['decisionLimits'];
  /** Whether the server accepts `images` (default false: they are dropped with a warning). */
  readonly decisionImages?: boolean;
  /** Overrides the dialect's endpoint path (`'/systemone'`, `'/evaluate'`, ...). */
  readonly path?: string;
}

/**
 * Backend adapter for any System One-compatible decision server.
 */
export class SystemOneBackendAdapter implements BackendAdapter {
  readonly metadata: AdapterMetadata;
  private readonly config: SystemOneBackendConfig;
  private readonly dialect: SystemOneDialect;
  private readonly url: string;

  constructor(config: SystemOneBackendConfig) {
    this.config = config;
    this.dialect = config.dialect ?? 'systemone';
    const path = config.path ?? SYSTEMONE_DIALECTS[this.dialect].defaultPath;
    this.url = `${config.baseURL.replace(/\/+$/, '')}${path}`;
    this.metadata = {
      name: config.name ?? 'systemone-backend',
      version: '1.0.0',
      provider: 'SystemOne',
      capabilities: {
        decisions: true,
        ...(config.defaultModel && { decisionModels: [config.defaultModel] }),
        decisionTypes: config.decisionTypes ?? ['choice', 'score', 'noul'],
        decisionImages: config.decisionImages ?? false,
        ...(config.decisionLimits && { decisionLimits: config.decisionLimits }),
        // Chat-shaped fields don't apply to a decision-only backend.
        streaming: false,
        multiModal: false,
        tools: false,
        systemMessageStrategy: 'not-supported',
        supportsMultipleSystemMessages: false,
      },
      config: { baseURL: config.baseURL, dialect: this.dialect },
    };
  }

  decide(request: IRDecisionRequest, signal?: AbortSignal): Promise<IRDecisionResponse> {
    const sendImages = this.config.decisionImages ?? false;
    return decideViaSystemOne(request, {
      url: this.url,
      dialect: this.dialect,
      model: request.parameters?.model || this.config.defaultModel,
      sendImages,
      headers: this.getHeaders(),
      signal,
      backendName: this.metadata.name,
      warnings: sendImages
        ? []
        : buildImageDroppedWarning(request, this.metadata.name, this.metadata.name),
    });
  }

  /** Cost depends on the server; not estimable ahead of the call. */
  estimateDecisionCost(_request: IRDecisionRequest): Promise<number | null> {
    return Promise.resolve(null);
  }

  private getHeaders(): Record<string, string> {
    return {
      ...(this.config.apiKey && { Authorization: `Bearer ${this.config.apiKey}` }),
      ...this.config.headers,
    };
  }

  /**
   * Health check: a real `decide()` with a trivial question, as
   * {@link TypeSafeBackendAdapter} does -- System One has no separate
   * liveness endpoint. Uses `config.timeout` (default 5 s); a server that
   * loads its model on first call (Ollama) may need more.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const body = buildSystemOneRequest(
        {
          state: 'health check',
          questions: { ok: { type: 'noul', instructions: 'Is this a health check?' } },
          parameters: { model: this.config.defaultModel },
          metadata: { requestId: 'health-check', timestamp: Date.now() },
        },
        { dialect: this.dialect }
      );
      await postSystemOne(this.url, body, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(this.config.timeout ?? 5000),
        backendName: this.metadata.name,
      });
      return true;
    } catch {
      return false;
    }
  }
}
