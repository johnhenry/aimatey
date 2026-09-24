/**
 * Laya Typed-Decision Demo: Ticket Triage Dashboard (GUI)
 *
 * A more complex sibling of `examples/laya/triage-demo.ts`: instead of a
 * one-shot CLI run, this starts a persistent Node HTTP server that loads
 * Laya once and keeps it warm, serves a small browser dashboard, and
 * exposes a JSON API the dashboard calls. Demonstrates the same
 * `Bridge.decide()` typed-decision capability, wired into a real (if
 * minimal) request/response app: single and batch triage, a fully dynamic
 * question set (add/remove/rename questions, not just edit prompt text --
 * see `resolveQuestions()`) AND a fully dynamic state shape (add/remove/
 * rename the input fields themselves -- see `resolveStateFields()`), and
 * an optional side-by-side comparison against TypeSafe's Jev (a second,
 * unrelated typed-decision backend, sharing the exact same Decision IR)
 * when `TYPESAFE_API_KEY` is set.
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
// Triage questions -- a genuinely dynamic set (arbitrary names, arbitrary
// count, each independently choice/score/noul), not a fixed 3-field shape.
// This is now just `Record<string, IRDecisionQuestion>` -- the IR's own
// request shape -- rather than a bespoke type, since a client-editable
// question set and a Decision IR request's `questions` field are the same
// thing once the fixed-shape constraint is gone.
// ============================================================================

export type QuestionMap = Record<string, IRDecisionQuestion>;

export const DEFAULT_QUESTIONS: QuestionMap = {
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
    criteria: ['low', 'medium', 'high', 'critical'],
  },
  needsHumanEscalation: {
    type: 'noul',
    instructions:
      'Should this ticket be escalated directly to a human agent rather than handled by an automated response?',
  },
};

/**
 * Which question (if any) drives the queue's sort order and color-coded
 * dot. Only a `score` or `noul` question can drive it -- a `choice`
 * answer has no single natural ordering. `null` means "no priority
 * question configured" -- the queue still works, just without sorting or
 * color, since there's nothing numeric to rank tickets by.
 */
export const DEFAULT_PRIORITY_QUESTION = 'urgency';

class ValidationError extends Error {}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Validates and fully resolves a client-submitted question map (a PUT is a full replacement). */
function resolveQuestions(input: unknown): QuestionMap {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('"questions" must be an object mapping question name -> question');
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) {
    throw new ValidationError('"questions" must include at least one question');
  }

  const resolved: Record<string, IRDecisionQuestion> = {};
  for (const [name, raw] of entries) {
    if (typeof raw !== 'object' || raw === null) {
      throw new ValidationError(`${name} must be an object`);
    }
    const q = raw as { type?: unknown; instructions?: unknown; criteria?: unknown };
    if (!isNonEmptyString(q.instructions)) {
      throw new ValidationError(`${name}.instructions must be a non-empty string`);
    }

    if (q.type === 'choice') {
      if (typeof q.criteria !== 'object' || q.criteria === null || Array.isArray(q.criteria)) {
        throw new ValidationError(`${name}.criteria must be an object mapping option -> description`);
      }
      const criteria = q.criteria as Record<string, unknown>;
      const keys = Object.keys(criteria);
      if (keys.length < 2) {
        throw new ValidationError(`${name}.criteria must have at least 2 options`);
      }
      const resolvedCriteria: Record<string, string> = {};
      for (const key of keys) {
        if (!isNonEmptyString(key) || !isNonEmptyString(criteria[key])) {
          throw new ValidationError(`${name}.criteria has an empty option name or description`);
        }
        resolvedCriteria[key] = criteria[key] as string;
      }
      resolved[name] = { type: 'choice', instructions: q.instructions, criteria: resolvedCriteria };
    } else if (q.type === 'score') {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2) {
        throw new ValidationError(`${name}.criteria must be an array of at least 2 level labels`);
      }
      if (!q.criteria.every(isNonEmptyString)) {
        throw new ValidationError(`${name}.criteria must not contain empty level labels`);
      }
      resolved[name] = { type: 'score', instructions: q.instructions, criteria: q.criteria as string[] };
    } else if (q.type === 'noul') {
      resolved[name] = { type: 'noul', instructions: q.instructions };
    } else {
      throw new ValidationError(`${name}.type must be "choice", "score", or "noul"`);
    }
  }

  return resolved;
}

/** `null`/absent is always valid (no priority question). Otherwise it must name a real score/noul question. */
function resolvePriorityQuestion(input: unknown, questions: QuestionMap): string | null {
  if (input === null || input === undefined) {
    return null;
  }
  if (typeof input !== 'string') {
    throw new ValidationError('"priorityQuestion" must be a string or null');
  }
  const question = questions[input];
  if (!question) {
    throw new ValidationError(`priorityQuestion "${input}" is not one of the submitted questions`);
  }
  if (question.type !== 'score' && question.type !== 'noul') {
    throw new ValidationError(
      `priorityQuestion "${input}" must be a "score" or "noul" question (got "${question.type}")`
    );
  }
  return input;
}

/**
 * Normalizes an answer to a 0..1 "how urgent/high is this" number for
 * queue sorting and color, regardless of whether the priority question is
 * `score` (raw value is 0..levels-1) or `noul` (already 0..1). Returns
 * `null` when there's no priority question, or the priority question
 * wasn't actually asked/answered on this particular ticket (e.g. a
 * question set edited after older tickets were already triaged).
 */
function computePriorityValue(
  answers: Record<string, IRDecisionAnswer>,
  questions: QuestionMap,
  priorityQuestion: string | null
): number | null {
  if (!priorityQuestion) {
    return null;
  }
  const answer = answers[priorityQuestion];
  const question = questions[priorityQuestion];
  if (!answer || !question) {
    return null;
  }
  if (answer.type === 'score' && question.type === 'score') {
    const levels = question.criteria.length;
    return levels > 1 ? answer.value / (levels - 1) : 0;
  }
  if (answer.type === 'noul') {
    return answer.value;
  }
  return null;
}

// ============================================================================
// State fields -- what the `state` (the ticket-like input) is made of.
// Also dynamic, mirroring questions: multiple named fields, each with a
// display label and a primitive type, rather than a single hardcoded
// "ticket text" string.
// ============================================================================

export type StateFieldType = 'text' | 'number' | 'boolean';

export interface StateFieldDef {
  readonly label: string;
  readonly type: StateFieldType;
}

export type StateFieldMap = Record<string, StateFieldDef>;

export const DEFAULT_STATE_FIELDS: StateFieldMap = {
  ticket: { label: 'Ticket Text', type: 'text' },
};

/** Validates and fully resolves a client-submitted state field map (a PUT is a full replacement). */
function resolveStateFields(input: unknown): StateFieldMap {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('"stateFields" must be an object mapping field name -> field definition');
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) {
    throw new ValidationError('"stateFields" must include at least one field');
  }

  const resolved: StateFieldMap = {};
  for (const [name, raw] of entries) {
    if (typeof raw !== 'object' || raw === null) {
      throw new ValidationError(`${name} must be an object`);
    }
    const f = raw as { label?: unknown; type?: unknown };
    if (!isNonEmptyString(f.label)) {
      throw new ValidationError(`${name}.label must be a non-empty string`);
    }
    if (f.type !== 'text' && f.type !== 'number' && f.type !== 'boolean') {
      throw new ValidationError(`${name}.type must be "text", "number", or "boolean"`);
    }
    resolved[name] = { label: f.label, type: f.type };
  }
  return resolved;
}

/**
 * Coerces and validates a client-submitted `values` object into a real
 * `state` object, per the active field config -- every configured field
 * must have a valid value (unlike question editing, there's no
 * "skip blanks" leniency here: a triage call with a genuinely missing
 * piece of configured context is a real error, not a normal mid-edit
 * state).
 */
function resolveStateValues(input: unknown, stateFields: StateFieldMap): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('"values" must be an object mapping field name -> value');
  }
  const values = input as Record<string, unknown>;
  const state: Record<string, unknown> = {};

  for (const [name, field] of Object.entries(stateFields)) {
    const raw = values[name];
    if (field.type === 'text') {
      if (!isNonEmptyString(raw)) {
        throw new ValidationError(`"${name}" must be a non-empty string`);
      }
      state[name] = raw.trim();
    } else if (field.type === 'number') {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
      if (!Number.isFinite(n)) {
        throw new ValidationError(`"${name}" must be a number`);
      }
      state[name] = n;
    } else {
      if (typeof raw !== 'boolean') {
        throw new ValidationError(`"${name}" must be a boolean`);
      }
      state[name] = raw;
    }
  }

  return state;
}

// ============================================================================
// Tickets
// ============================================================================

interface TriagedTicket {
  readonly id: string;
  readonly backend: 'laya' | 'typesafe';
  readonly answers: Record<string, IRDecisionAnswer>;
  /** 0..1, normalized from whichever question was the priority question at
   * triage time -- see computePriorityValue(). `null` when no priority
   * question was configured. */
  readonly priorityValue: number | null;
  readonly timestamp: number;
  /** Wall-clock time for the bridge.decide() call itself, in milliseconds. */
  readonly latencyMs: number;
  /** Exactly what was sent to the backend: the state + typed questions. */
  readonly request: { readonly state: unknown; readonly questions: QuestionMap };
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
  state: unknown,
  questions: QuestionMap,
  priorityQuestion: string | null
): Promise<TriagedTicket> {
  const startedAt = performance.now();
  const response = await bridge.decide(state, questions);
  const latencyMs = performance.now() - startedAt;

  return {
    id: randomUUID(),
    backend,
    answers: response.answers,
    priorityValue: computePriorityValue(response.answers, questions, priorityQuestion),
    timestamp: Date.now(),
    latencyMs,
    request: { state, questions },
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
  let activeQuestions: QuestionMap = DEFAULT_QUESTIONS;
  let activePriorityQuestion: string | null = DEFAULT_PRIORITY_QUESTION;
  let activeStateFields: StateFieldMap = DEFAULT_STATE_FIELDS;

  function questionsPayload() {
    return { questions: activeQuestions, priorityQuestion: activePriorityQuestion };
  }

  function stateFieldsPayload() {
    return { stateFields: activeStateFields };
  }

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
      sendJSON(res, 200, questionsPayload());
      return true;
    }

    if (pathname === '/api/questions' && req.method === 'PUT') {
      try {
        const body = (await readJSONBody(req)) as { questions?: unknown; priorityQuestion?: unknown };
        const questions = resolveQuestions(body.questions);
        const priorityQuestion = resolvePriorityQuestion(body.priorityQuestion, questions);
        activeQuestions = questions;
        activePriorityQuestion = priorityQuestion;
        sendJSON(res, 200, questionsPayload());
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
      activePriorityQuestion = DEFAULT_PRIORITY_QUESTION;
      sendJSON(res, 200, questionsPayload());
      return true;
    }

    if (pathname === '/api/state-fields' && req.method === 'GET') {
      sendJSON(res, 200, stateFieldsPayload());
      return true;
    }

    if (pathname === '/api/state-fields' && req.method === 'PUT') {
      try {
        const body = (await readJSONBody(req)) as { stateFields?: unknown };
        activeStateFields = resolveStateFields(body.stateFields);
        sendJSON(res, 200, stateFieldsPayload());
      } catch (error) {
        if (error instanceof ValidationError) {
          sendJSON(res, 400, { error: error.message });
        } else {
          sendJSON(res, 400, { error: 'Invalid JSON body' });
        }
      }
      return true;
    }

    if (pathname === '/api/state-fields/reset' && req.method === 'POST') {
      activeStateFields = DEFAULT_STATE_FIELDS;
      sendJSON(res, 200, stateFieldsPayload());
      return true;
    }

    if (pathname === '/api/triage' && req.method === 'POST') {
      try {
        const body = (await readJSONBody(req)) as { values?: unknown };
        const state = resolveStateValues(body.values, activeStateFields);
        const ticket = await triageWith(deps.layaBridge, 'laya', state, activeQuestions, activePriorityQuestion);
        store.add(ticket);
        sendJSON(res, 200, ticket);
      } catch (error) {
        if (error instanceof ValidationError) {
          sendJSON(res, 400, { error: error.message });
        } else {
          sendJSON(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      return true;
    }

    if (pathname === '/api/triage/batch' && req.method === 'POST') {
      try {
        const fieldNames = Object.keys(activeStateFields);
        const soleField = fieldNames.length === 1 ? activeStateFields[fieldNames[0]] : undefined;
        if (!soleField || soleField.type !== 'text') {
          sendJSON(res, 400, {
            error:
              'Batch mode requires exactly one state field, of type "text" -- ' +
              '"one value per line" is ambiguous across multiple fields.',
          });
          return true;
        }
        const fieldName = fieldNames[0];

        const body = (await readJSONBody(req)) as { lines?: unknown };
        if (!Array.isArray(body.lines) || body.lines.length === 0) {
          sendJSON(res, 400, { error: 'Request body must include non-empty "lines" array' });
          return true;
        }
        const lines = body.lines.filter(isNonEmptyString).map((t) => t.trim());
        if (lines.length === 0) {
          sendJSON(res, 400, { error: 'No valid (non-empty) lines found in "lines"' });
          return true;
        }
        // Sequential, not parallel: a single loaded ONNX session isn't
        // necessarily safe for overlapping concurrent calls, and this is
        // a demo, not a throughput benchmark.
        const results: TriagedTicket[] = [];
        for (const line of lines) {
          const state = resolveStateValues({ [fieldName]: line }, activeStateFields);
          const ticket = await triageWith(deps.layaBridge, 'laya', state, activeQuestions, activePriorityQuestion);
          store.add(ticket);
          results.push(ticket);
        }
        sendJSON(res, 200, { results });
      } catch (error) {
        if (error instanceof ValidationError) {
          sendJSON(res, 400, { error: error.message });
        } else {
          sendJSON(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      return true;
    }

    if (pathname === '/api/triage/compare' && req.method === 'POST') {
      try {
        const body = (await readJSONBody(req)) as { values?: unknown };
        const state = resolveStateValues(body.values, activeStateFields);
        const laya = await triageWith(deps.layaBridge, 'laya', state, activeQuestions, activePriorityQuestion);
        store.add(laya);

        let typesafe: TriagedTicket | null = null;
        let typesafeError: string | undefined;
        if (deps.typesafeBridge) {
          try {
            typesafe = await triageWith(
              deps.typesafeBridge,
              'typesafe',
              state,
              activeQuestions,
              activePriorityQuestion
            );
          } catch (error) {
            typesafeError = error instanceof Error ? error.message : String(error);
          }
        } else {
          typesafeError = 'TYPESAFE_API_KEY not set on the server';
        }

        sendJSON(res, 200, { laya, typesafe, typesafeError });
      } catch (error) {
        if (error instanceof ValidationError) {
          sendJSON(res, 400, { error: error.message });
        } else {
          sendJSON(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
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
