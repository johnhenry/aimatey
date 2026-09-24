/**
 * Laya Typed-Decision Demo: Ticket Triage Dashboard (GUI)
 *
 * A more complex sibling of `examples/laya/triage-demo.ts`: instead of a
 * one-shot CLI run, this starts a persistent Node HTTP server that loads
 * Laya once and keeps it warm, serves a small browser dashboard, and
 * exposes a JSON API the dashboard calls. Demonstrates the same
 * `Bridge.decide()` typed-decision capability, wired into a real (if
 * minimal) request/response app: single and batch triage, editable
 * questions, and an optional side-by-side comparison against TypeSafe's
 * Jev (a second, unrelated typed-decision backend, sharing the exact same
 * Decision IR) when `TYPESAFE_API_KEY` is set.
 *
 * No frontend framework, no build step -- the dashboard is plain
 * HTML/CSS/JS served as static files from `public/`, matching this
 * repo's `examples/http/node-server.ts`'s use of the bare `node:http`
 * module rather than pulling in a server framework for an example.
 *
 * The request handler is built by `createRequestHandler()`, taking its
 * backends as a parameter rather than reaching for module-level globals
 * -- `server.test.ts` injects a mock bridge so the API's routing,
 * validation, and question-editing logic can be tested without the real
 * ~1.7GB Laya model.
 *
 * Prerequisites: same as triage-demo.ts -- `npm install @receptron/laya`
 * (first run downloads ~1.7GB of ONNX weights, cached after). Optionally
 * `TYPESAFE_API_KEY=... ` to enable compare mode against Jev.
 *
 * Run with:
 *   npx tsx examples/laya/gui-demo/server.ts
 * Then open http://localhost:8080
 *
 * @example
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Bridge } from '@johnhenry/aimatey-core';
import { createGenericFrontend } from '@johnhenry/aimatey-frontend';
import { LayaBackendAdapter } from '@johnhenry/aimatey-native-laya';
import { TypeSafeBackendAdapter } from '@johnhenry/aimatey-backend';
import type { IRDecisionAnswer, IRDecisionQuestion } from '@johnhenry/aimatey-types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 8080;

// ============================================================================
// Triage questions
// ============================================================================

const URGENCY_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
const CATEGORY_KEYS = ['billing', 'technical', 'account', 'other'] as const;
type CategoryKey = (typeof CATEGORY_KEYS)[number];

interface QuestionSet {
  readonly category: {
    readonly type: 'choice';
    readonly instructions: string;
    readonly criteria: Record<CategoryKey, string>;
  };
  readonly urgency: {
    readonly type: 'score';
    readonly instructions: string;
    readonly criteria: typeof URGENCY_LEVELS;
  };
  readonly needsHumanEscalation: {
    readonly type: 'noul';
    readonly instructions: string;
  };
}

export const DEFAULT_QUESTIONS: QuestionSet = {
  category: {
    type: 'choice',
    instructions: 'What is this support ticket primarily about?',
    criteria: {
      billing: 'Payments, charges, refunds, subscriptions, invoices',
      technical: 'Bugs, crashes, errors, broken features',
      account: 'Login, profile, settings, account access',
      other: 'Feedback, questions, or anything not covered above',
    },
  },
  urgency: {
    type: 'score',
    instructions: 'How urgently does this ticket need a response?',
    criteria: URGENCY_LEVELS,
  },
  needsHumanEscalation: {
    type: 'noul',
    instructions:
      'Should this ticket be escalated directly to a human agent rather than handled by an automated response?',
  },
};

/**
 * Only `instructions` and category `criteria` descriptions are editable --
 * the category keys and the four urgency level names stay fixed. Both the
 * client's rendering (bar colors, ordering) and this server's own
 * `criteria` keying are written against those fixed names; making them
 * fully dynamic would need schema-driven rendering throughout, out of
 * scope for this pass (see the demo's readme.md).
 */
interface QuestionOverrides {
  readonly category?: {
    readonly instructions?: string;
    readonly criteria?: Partial<Record<CategoryKey, string>>;
  };
  readonly urgency?: { readonly instructions?: string };
  readonly needsHumanEscalation?: { readonly instructions?: string };
}

class ValidationError extends Error {}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Validates and fully resolves a client-submitted question set (a PUT is a full replacement). */
function resolveQuestions(input: unknown): QuestionSet {
  if (typeof input !== 'object' || input === null) {
    throw new ValidationError('Request body must be an object');
  }
  const body = input as QuestionOverrides;

  if (!isNonEmptyString(body.category?.instructions)) {
    throw new ValidationError('category.instructions must be a non-empty string');
  }
  const criteria: Partial<Record<CategoryKey, string>> = {};
  for (const key of CATEGORY_KEYS) {
    const value = body.category?.criteria?.[key];
    if (!isNonEmptyString(value)) {
      throw new ValidationError(`category.criteria.${key} must be a non-empty string`);
    }
    criteria[key] = value;
  }
  if (!isNonEmptyString(body.urgency?.instructions)) {
    throw new ValidationError('urgency.instructions must be a non-empty string');
  }
  if (!isNonEmptyString(body.needsHumanEscalation?.instructions)) {
    throw new ValidationError('needsHumanEscalation.instructions must be a non-empty string');
  }

  return {
    category: {
      type: 'choice',
      instructions: body.category!.instructions!,
      criteria: criteria as Record<CategoryKey, string>,
    },
    urgency: { type: 'score', instructions: body.urgency!.instructions!, criteria: URGENCY_LEVELS },
    needsHumanEscalation: {
      type: 'noul',
      instructions: body.needsHumanEscalation!.instructions!,
    },
  };
}

function questionsToIR(questions: QuestionSet): Record<string, IRDecisionQuestion> {
  return {
    category: questions.category,
    urgency: questions.urgency,
    needsHumanEscalation: questions.needsHumanEscalation,
  };
}

// ============================================================================
// Tickets
// ============================================================================

interface TriagedTicket {
  readonly id: string;
  readonly backend: 'laya' | 'typesafe';
  readonly text: string;
  readonly answers: Record<string, IRDecisionAnswer>;
  readonly urgencyScore: number;
  readonly timestamp: number;
  /** Wall-clock time for the bridge.decide() call itself, in milliseconds. */
  readonly latencyMs: number;
  /** Exactly what was sent to the backend: the state + typed questions. */
  readonly request: { readonly state: unknown; readonly questions: Record<string, IRDecisionQuestion> };
  /** The backend's raw wire response, unmapped -- see IRDecisionResponse.raw. */
  readonly rawResponse: unknown;
}

function createTicketStore() {
  const tickets: TriagedTicket[] = [];
  return {
    add(ticket: TriagedTicket): void {
      tickets.unshift(ticket);
    },
    list(): readonly TriagedTicket[] {
      return tickets;
    },
    clear(): void {
      tickets.length = 0;
    },
  };
}

// ============================================================================
// Backends
// ============================================================================

export interface AppDeps {
  readonly layaBridge: Bridge;
  readonly typesafeBridge?: Bridge;
}

async function triageWith(
  bridge: Bridge,
  backend: TriagedTicket['backend'],
  text: string,
  questions: QuestionSet
): Promise<TriagedTicket> {
  const state = { ticket: text };
  const irQuestions = questionsToIR(questions);
  const startedAt = performance.now();
  const response = await bridge.decide(state, irQuestions);
  const latencyMs = performance.now() - startedAt;

  const urgency = response.answers.urgency;
  const urgencyScore = urgency?.type === 'score' ? urgency.value : 0;

  return {
    id: randomUUID(),
    backend,
    text,
    answers: response.answers,
    urgencyScore,
    timestamp: Date.now(),
    latencyMs,
    request: { state, questions: irQuestions },
    rawResponse: response.raw,
  };
}

// ============================================================================
// Static file serving
// ============================================================================

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

async function serveStatic(pathname: string, res: http.ServerResponse): Promise<boolean> {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.join(PUBLIC_DIR, relative);

  // Prevent path traversal outside public/
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    return false;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext];
  if (!contentType) {
    return false;
  }

  const body = await readFile(filePath);
  res.writeHead(200, { 'Content-Type': contentType });
  res.end(body);
  return true;
}

// ============================================================================
// JSON helpers
// ============================================================================

function sendJSON(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function readJSONBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

// ============================================================================
// Request handler (exported for tests -- takes its backends as deps rather
// than reaching for module-level globals, so a test can inject a mock
// bridge instead of loading the real ~1.7GB model)
// ============================================================================

export function createRequestHandler(deps: AppDeps): http.RequestListener {
  const store = createTicketStore();
  let activeQuestions: QuestionSet = DEFAULT_QUESTIONS;

  async function handleApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string
  ): Promise<boolean> {
    if (pathname === '/api/backends' && req.method === 'GET') {
      sendJSON(res, 200, { laya: true, typesafe: Boolean(deps.typesafeBridge) });
      return true;
    }

    if (pathname === '/api/questions' && req.method === 'GET') {
      sendJSON(res, 200, activeQuestions);
      return true;
    }

    if (pathname === '/api/questions' && req.method === 'PUT') {
      try {
        const body = await readJSONBody(req);
        activeQuestions = resolveQuestions(body);
        sendJSON(res, 200, activeQuestions);
      } catch (error) {
        if (error instanceof ValidationError) {
          sendJSON(res, 400, { error: error.message });
        } else {
          sendJSON(res, 400, { error: 'Invalid JSON body' });
        }
      }
      return true;
    }

    if (pathname === '/api/questions/reset' && req.method === 'POST') {
      activeQuestions = DEFAULT_QUESTIONS;
      sendJSON(res, 200, activeQuestions);
      return true;
    }

    if (pathname === '/api/triage' && req.method === 'POST') {
      try {
        const body = (await readJSONBody(req)) as { text?: unknown };
        if (!isNonEmptyString(body.text)) {
          sendJSON(res, 400, { error: 'Request body must include non-empty "text"' });
          return true;
        }
        const ticket = await triageWith(deps.layaBridge, 'laya', body.text.trim(), activeQuestions);
        store.add(ticket);
        sendJSON(res, 200, ticket);
      } catch (error) {
        sendJSON(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }

    if (pathname === '/api/triage/batch' && req.method === 'POST') {
      try {
        const body = (await readJSONBody(req)) as { texts?: unknown };
        if (!Array.isArray(body.texts) || body.texts.length === 0) {
          sendJSON(res, 400, { error: 'Request body must include non-empty "texts" array' });
          return true;
        }
        const texts = body.texts.filter(isNonEmptyString).map((t) => t.trim());
        if (texts.length === 0) {
          sendJSON(res, 400, { error: 'No valid (non-empty) ticket text found in "texts"' });
          return true;
        }
        // Sequential, not parallel: a single loaded ONNX session isn't
        // necessarily safe for overlapping concurrent calls, and this is
        // a demo, not a throughput benchmark.
        const results: TriagedTicket[] = [];
        for (const text of texts) {
          const ticket = await triageWith(deps.layaBridge, 'laya', text, activeQuestions);
          store.add(ticket);
          results.push(ticket);
        }
        sendJSON(res, 200, { results });
      } catch (error) {
        sendJSON(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }

    if (pathname === '/api/triage/compare' && req.method === 'POST') {
      try {
        const body = (await readJSONBody(req)) as { text?: unknown };
        if (!isNonEmptyString(body.text)) {
          sendJSON(res, 400, { error: 'Request body must include non-empty "text"' });
          return true;
        }
        const text = body.text.trim();
        const laya = await triageWith(deps.layaBridge, 'laya', text, activeQuestions);
        store.add(laya);

        let typesafe: TriagedTicket | null = null;
        let typesafeError: string | undefined;
        if (deps.typesafeBridge) {
          try {
            typesafe = await triageWith(deps.typesafeBridge, 'typesafe', text, activeQuestions);
          } catch (error) {
            typesafeError = error instanceof Error ? error.message : String(error);
          }
        } else {
          typesafeError = 'TYPESAFE_API_KEY not set on the server';
        }

        sendJSON(res, 200, { laya, typesafe, typesafeError });
      } catch (error) {
        sendJSON(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }

    if (pathname === '/api/tickets' && req.method === 'GET') {
      sendJSON(res, 200, store.list());
      return true;
    }

    if (pathname === '/api/tickets' && req.method === 'DELETE') {
      store.clear();
      sendJSON(res, 200, { ok: true });
      return true;
    }

    return false;
  }

  return (req, res) => {
    void (async () => {
      const pathname = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname;

      if (pathname.startsWith('/api/')) {
        const handled = await handleApi(req, res, pathname);
        if (!handled) {
          sendJSON(res, 404, { error: 'Not found' });
        }
        return;
      }

      const served = await serveStatic(pathname, res);
      if (!served) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    })().catch((error: unknown) => {
      console.error('Request handler error:', error);
      if (!res.headersSent) {
        sendJSON(res, 500, { error: 'Internal server error' });
      }
    });
  };
}

// ============================================================================
// Entry point
// ============================================================================

async function main(): Promise<void> {
  const layaBackend = new LayaBackendAdapter();
  console.log('Loading Laya (first run downloads ~1.7GB of ONNX weights)...');
  await layaBackend.initialize();
  console.log('Laya ready.');

  const typesafeBridge = process.env.TYPESAFE_API_KEY
    ? new Bridge(
        createGenericFrontend(),
        new TypeSafeBackendAdapter({ apiKey: process.env.TYPESAFE_API_KEY })
      )
    : undefined;

  const deps: AppDeps = {
    layaBridge: new Bridge(createGenericFrontend(), layaBackend),
    typesafeBridge,
  };

  if (typesafeBridge) {
    console.log('TYPESAFE_API_KEY set -- compare mode against Jev enabled.');
  } else {
    console.log('TYPESAFE_API_KEY not set -- compare mode disabled (Laya only).');
  }

  const server = http.createServer(createRequestHandler(deps));

  server.listen(PORT, () => {
    console.log(`Ticket triage dashboard running at http://localhost:${PORT}`);
  });

  const shutdown = () => {
    console.log('\nShutting down...');
    server.close(() => {
      void layaBackend.close().then(() => process.exit(0));
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Only run the server when executed directly -- server.test.ts imports
// createRequestHandler without wanting a real Laya load.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('Server failed to start:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
