/**
 * Decision Gateway (demo)
 *
 * A self-hostable typed-decision gateway: three wire dialects in front of one
 * `Bridge` over a `Router` of decision backends, with caching, cost tracking,
 * logging, validation and confidence-based escalation to an LLM fallback.
 *
 *   POST /v1/systemone  (and /typesafe/v1/systemone)   TypeSafe / Ollama shape
 *   POST /v1/decisions                                 OpenRouter alpha shape
 *   POST /v1/evaluate                                  Vercel AI Gateway shape (`boolean`)
 *   GET  /v1/models                                    decision-capable backends and models
 *   GET  /health
 *
 * Every dialect is parsed to the decision IR, answered by the same pipeline,
 * and shaped back, so the same ticket gets the same answers from any of the
 * three URLs. The wire mapping is `packages/cli/src/decisions.ts` (the server
 * side of `SYSTEMONE_DIALECTS`); anything that is not a decision route is
 * handed to `@johnhenry/aimatey-http`'s core handler.
 *
 * This is a DEMO built on top of the library, not a product feature: one
 * optional bearer key, an in-memory cache, no rate limiting.
 *
 * Run with:
 *   npx tsx examples/decisions/gateway/server.ts
 *
 * Configuration (environment):
 *   PORT                 listen port (default 8787)
 *   OLLAMA_URL           default http://localhost:11434
 *   DECISION_MODEL       default tev1:0.8b (the primary Ollama decision model)
 *   EMULATION_MODEL      default qwen2.5:3b (chat model used as the escalation fallback)
 *   ESCALATE_BELOW       default 0.6 (confidence under which a choice/score answer escalates)
 *   TYPESAFE_API_KEY, OPENROUTER_API_KEY, CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN
 *                        optional hosted backends, tried after Ollama
 *   GATEWAY_API_KEY      if set, every route except /health needs `Authorization: Bearer <key>`
 *
 * @example
 */

import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Bridge, Router } from '@johnhenry/aimatey-core';
import {
  CloudflareBackendAdapter,
  OllamaBackendAdapter,
  OpenRouterBackendAdapter,
  TypeSafeBackendAdapter,
  isOllamaDecisionModel,
} from '@johnhenry/aimatey-backend';
import {
  DecisionWireError,
  decisionDialectForPath,
  decisionErrorStatus,
  decisionErrorToWire,
  decisionEscalationHeaders,
  decisionResponseToWire,
  wireToDecisionRequest,
  type DecisionDialect,
} from '@johnhenry/aimatey-cli';
import {
  createDecisionCachingMiddleware,
  createDecisionCostTrackingMiddleware,
  createDecisionLoggingMiddleware,
  createDecisionValidationMiddleware,
} from '@johnhenry/aimatey-middleware';
import { createDecisionEscalation, createEmulatedDecisionBackend } from '@johnhenry/aimatey-patterns';
import { createGenericFrontend } from '@johnhenry/aimatey-frontend';
import { NodeHTTPListener } from '@johnhenry/aimatey-http';
import type {
  BackendAdapter,
  FrontendAdapter,
  IRDecisionRequest,
  IRDecisionResponse,
} from '@johnhenry/aimatey-types';

/** Largest accepted request body (Ollama's own limit). */
export const MAX_BODY_BYTES = 64 * 1024;

// ============================================================================
// Dependencies
// ============================================================================

export interface GatewayDeps {
  /**
   * Decision backends by name, tried in this order by a `Router`. The names
   * are what `/health` and `/v1/models` report.
   */
  readonly backends: Readonly<Record<string, BackendAdapter>>;
  /** Backend the whole request is rerun on when the primary's answers are unsure. */
  readonly fallback?: BackendAdapter;
  /** Escalate when a choice/score answer's confidence is below this (default 0.6). */
  readonly escalateBelow?: number;
  /** When set, every route but `/health` needs `Authorization: Bearer <apiKey>`. */
  readonly apiKey?: string;
  /** Log sink (default `console.log`). */
  readonly log?: (line: string) => void;
}

/** Build the gateway's dependencies from environment variables (see the file header). */
export function createGatewayDepsFromEnv(
  env: Record<string, string | undefined> = process.env
): GatewayDeps {
  const baseURL = env.OLLAMA_URL || 'http://localhost:11434';
  const decisionModel = env.DECISION_MODEL || 'tev1:0.8b';
  const emulationModel = env.EMULATION_MODEL || 'qwen2.5:3b';

  const backends: Record<string, BackendAdapter> = {
    ollama: new OllamaBackendAdapter({ baseURL, defaultModel: decisionModel }),
  };
  if (env.TYPESAFE_API_KEY) {
    backends.typesafe = new TypeSafeBackendAdapter({ apiKey: env.TYPESAFE_API_KEY });
  }
  if (env.OPENROUTER_API_KEY) {
    backends.openrouter = new OpenRouterBackendAdapter({ apiKey: env.OPENROUTER_API_KEY });
  }
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) {
    backends.cloudflare = new CloudflareBackendAdapter({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      apiKey: env.CLOUDFLARE_API_TOKEN,
    });
  }

  const escalateBelow = env.ESCALATE_BELOW === undefined ? 0.6 : Number(env.ESCALATE_BELOW);
  return {
    backends,
    fallback: createEmulatedDecisionBackend(
      new OllamaBackendAdapter({ baseURL, defaultModel: emulationModel }),
      { model: emulationModel }
    ),
    escalateBelow: Number.isFinite(escalateBelow) ? escalateBelow : 0.6,
    apiKey: env.GATEWAY_API_KEY || undefined,
  };
}

// ============================================================================
// The pipeline
// ============================================================================

/**
 * Wire requests are already IR, so the gateway's frontend is the identity:
 * `Bridge.decideFrom()` then carries images, `keep_alive` and the routing
 * extras through untouched (`Bridge.decide()` cannot take images).
 */
const gatewayFrontend: FrontendAdapter<IRDecisionRequest, IRDecisionResponse> = {
  metadata: {
    name: 'decision-gateway',
    version: '1.0.0',
    provider: 'aimatey',
    capabilities: {
      streaming: false,
      multiModal: true,
      tools: false,
      decisions: true,
      systemMessageStrategy: 'not-supported',
      supportsMultipleSystemMessages: false,
    },
  },
  decisionToIR: (request) => request,
  decisionFromIR: (response) => response,
};

export interface Gateway {
  readonly handler: http.RequestListener;
  readonly bridge: Bridge;
  readonly router: Router;
}

/** Build the gateway's request handler over injected backends (tests pass mocks). */
export function createGateway(deps: GatewayDeps): Gateway {
  const log = deps.log ?? ((line: string) => console.log(line));
  const logger = {
    debug: () => {},
    info: (message: string, data?: unknown) => log(data === undefined ? message : `${message} ${JSON.stringify(data)}`),
    warn: (message: string, data?: unknown) => log(data === undefined ? message : `${message} ${JSON.stringify(data)}`),
    error: (message: string, data?: unknown) => log(data === undefined ? message : `${message} ${JSON.stringify(data)}`),
  };

  // One Router over the configured backends, in order; a failing or
  // incapable backend falls through to the next.
  const names = Object.keys(deps.backends);
  const router = new Router({ routingStrategy: 'explicit', fallbackStrategy: 'sequential', defaultBackend: names[0] });
  for (const name of names) {
    router.register(name, deps.backends[name]!);
  }
  router.setFallbackChain(names);

  // The Bridge's backend: the router, tagging each response with the backend
  // that served it (the Bridge itself would stamp `router`).
  const backend: BackendAdapter = {
    metadata: {
      ...router.metadata,
      name: 'decision-gateway-router',
      // Pre-flight validation runs against these, so advertise what any
      // backend accepts; the router then skips the ones that cannot serve a
      // given request.
      capabilities: {
        ...router.metadata.capabilities,
        decisions: true,
        decisionImages: names.some((n) => deps.backends[n]!.metadata.capabilities.decisionImages === true),
      },
    },
    decide: async (request, signal) => {
      const response = await router.decide(request, signal);
      return { ...response, provider: response.provider ?? response.metadata.provenance?.backend };
    },
  };

  const bridge = new Bridge(gatewayFrontend, backend);

  // Outermost first: logging sees every call; a cache hit never reaches cost
  // tracking, so a replayed answer is not billed twice; escalation sits next
  // to the router so cost tracking sees both stages' summed usage.
  bridge.useDecision(createDecisionLoggingMiddleware({ logger, prefix: '[gateway]' }));
  bridge.useDecision(createDecisionCachingMiddleware({ unidentified: 'share', maxSize: 500 }));
  bridge.useDecision(
    createDecisionCostTrackingMiddleware({
      includeInMetadata: true,
      logger,
      onCost: (cost) => log(`[cost] ${cost.provider} ${cost.model} $${cost.totalCost.toFixed(6)}`),
    })
  );
  bridge.useDecision(createDecisionValidationMiddleware({ maxStateBytes: MAX_BODY_BYTES }));
  if (deps.fallback) {
    bridge.useDecision(
      createDecisionEscalation({
        // A noul-only request has nothing a confidence threshold can judge: skip, don't 400.
        onUnmatchable: 'skip',
        when: { confidenceBelow: deps.escalateBelow ?? 0.6 },
        fallback: deps.fallback,
        onEscalate: ({ triggeredBy }) =>
          log(`[escalate] ${triggeredBy.map((t) => `${t.question}:${t.reason}`).join(', ')}`),
      })
    );
  }

  // Everything that is not a decision route (chat, embeddings, ...) goes to
  // the core HTTP handler. This gateway has no chat backend, so those answer
  // with the core handler's own errors; `/health` is answered here.
  // Only the chat route is mounted: with no `routes`, the core handler treats
  // every path as a chat request, so an unknown URL would be a 500, not a 404.
  const chatFrontend = createGenericFrontend();
  const delegate = NodeHTTPListener(new Bridge(chatFrontend, backend), {
    cors: true,
    routes: [{ path: '/v1/chat/completions', methods: ['POST'], frontend: chatFrontend }],
  });

  // ------------------------------------------------------------------------
  // HTTP
  // ------------------------------------------------------------------------

  const expectedAuth = deps.apiKey
    ? createHash('sha256').update(`Bearer ${deps.apiKey}`).digest()
    : undefined;

  function authorized(req: http.IncomingMessage): boolean {
    if (!expectedAuth) {
      return true;
    }
    const given = createHash('sha256').update(req.headers.authorization ?? '').digest();
    return timingSafeEqual(given, expectedAuth);
  }

  function sendJSON(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {}
  ): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(body));
  }

  function sendError(res: http.ServerResponse, dialect: DecisionDialect, status: number, message: string): void {
    sendJSON(res, status, decisionErrorToWire(dialect, status, message));
  }

  /** Read the body, refusing anything over {@link MAX_BODY_BYTES} (the rest is drained, not buffered). */
  async function readBody(req: http.IncomingMessage): Promise<string> {
    const declared = Number(req.headers['content-length']);
    let size = 0;
    let tooLarge = Number.isFinite(declared) && declared > MAX_BODY_BYTES;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
      }
      if (!tooLarge) {
        chunks.push(chunk as Buffer);
      } else if (size > 16 * MAX_BODY_BYTES) {
        break; // stop reading an abusive upload; the response closes the connection
      }
    }
    if (tooLarge) {
      throw new DecisionWireError(`Request body exceeds ${MAX_BODY_BYTES} bytes`, 413);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function handleDecision(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    dialect: DecisionDialect
  ): Promise<void> {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    });

    try {
      const text = await readBody(req);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new DecisionWireError('Request body is not valid JSON');
      }
      const request = wireToDecisionRequest(body, dialect);
      const answered = await bridge.decideFrom(request, { signal: controller.signal });

      // Cost tracking left the call's cost on the response; surface it as `usage.cost`.
      const cost = (answered.metadata.custom?.cost as { totalCost?: number } | undefined)?.totalCost;
      const response: IRDecisionResponse =
        answered.usage && answered.usage.cost === undefined && cost !== undefined
          ? { ...answered, usage: { ...answered.usage, cost } }
          : answered;

      sendJSON(res, 200, decisionResponseToWire(response, request, dialect), decisionEscalationHeaders(response));
    } catch (error) {
      const status = decisionErrorStatus(error);
      if (status >= 500) {
        log(`[error] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      }
      if (!res.headersSent) {
        sendError(res, dialect, status, error instanceof Error ? error.message : String(error));
      }
    }
  }

  async function listModels(): Promise<unknown[]> {
    const data: unknown[] = [];
    for (const [name, adapter] of Object.entries(deps.backends)) {
      const caps = adapter.metadata.capabilities;
      if (caps.decisions === false || typeof adapter.decide !== 'function') {
        continue;
      }
      const ids = new Set<string>(caps.decisionModels ?? []);
      // Ollama knows which decision models are actually installed.
      if (typeof adapter.listModels === 'function') {
        try {
          for (const model of (await adapter.listModels()).models) {
            if (isOllamaDecisionModel(model.id)) {
              ids.add(model.id);
            }
          }
        } catch {
          // unreachable backend: report what it declares
        }
      }
      for (const id of ids.size > 0 ? ids : [name]) {
        data.push({
          id,
          object: 'model',
          owned_by: name,
          kind: 'decision',
          decision_types: caps.decisionTypes ?? ['choice', 'score', 'noul'],
          ...(caps.decisionLimits && { decision_limits: caps.decisionLimits }),
          ...(caps.decisionImages !== undefined && { decision_images: caps.decisionImages }),
        });
      }
    }
    return data;
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? '/', 'http://gateway').pathname;
    const dialect = decisionDialectForPath(pathname);
    const isModels = pathname === '/v1/models';

    if (pathname === '/health' && req.method === 'GET') {
      sendJSON(res, 200, {
        status: 'ok',
        backends: Object.keys(deps.backends),
        ...(deps.fallback && { fallback: deps.fallback.metadata.name }),
      });
      return;
    }

    if ((dialect || isModels) && req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    if (!authorized(req)) {
      const message = 'Missing or invalid bearer token';
      res.setHeader('WWW-Authenticate', 'Bearer');
      if (dialect) {
        sendError(res, dialect, 401, message);
      } else {
        sendJSON(res, 401, { error: { type: 'authentication_error', message } });
      }
      return;
    }

    if (dialect) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST, OPTIONS');
        sendError(res, dialect, 405, `Use POST for ${pathname}`);
        return;
      }
      await handleDecision(req, res, dialect);
      return;
    }

    if (isModels && req.method === 'GET') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      sendJSON(res, 200, { object: 'list', data: await listModels() });
      return;
    }

    await delegate(req, res);
  }

  const handler: http.RequestListener = (req, res) => {
    route(req, res).catch((error: unknown) => {
      log(`[error] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      if (!res.headersSent) {
        sendJSON(res, 500, { error: 'Internal server error' });
      }
    });
  };

  return { handler, bridge, router };
}

// ============================================================================
// Entry point
// ============================================================================

function main(): void {
  const deps = createGatewayDepsFromEnv();
  const { handler } = createGateway(deps);
  const port = Number(process.env.PORT) || 8787;
  const server = http.createServer(handler);
  // A cold decision model on CPU can take minutes; do not cut the socket early.
  server.requestTimeout = 0;
  server.listen(port, () => {
    console.log(`Decision gateway (demo) on http://localhost:${port}`);
    console.log(`  backends: ${Object.keys(deps.backends).join(', ')}`);
    console.log(`  escalation: confidence < ${deps.escalateBelow} -> ${deps.fallback?.metadata.name}`);
    console.log(`  auth: ${deps.apiKey ? 'bearer key required' : 'off (set GATEWAY_API_KEY)'}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Only listen when run directly -- server.test.ts imports createGateway.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
