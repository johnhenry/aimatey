/**
 * Laya Typed-Decision Demo: Ticket Triage Dashboard (GUI)
 *
 * A more complex sibling of `examples/laya/triage-demo.ts`: instead of a
 * one-shot CLI run, this starts a persistent Node HTTP server that loads
 * Laya once and keeps it warm, serves a small browser dashboard, and
 * exposes a JSON API the dashboard calls. Demonstrates the same
 * `Bridge.decide()` / `LayaBackendAdapter` typed-decision capability,
 * just wired into a real (if minimal) request/response app instead of a
 * single call.
 *
 * No frontend framework, no build step -- the dashboard is plain
 * HTML/CSS/JS served as static files from `public/`, matching this
 * repo's `examples/http/node-server.ts`'s use of the bare `node:http`
 * module rather than pulling in a server framework for an example.
 *
 * Prerequisites: same as triage-demo.ts -- `npm install @receptron/laya`
 * (first run downloads ~1.7GB of ONNX weights, cached after).
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
import type { IRDecisionAnswer } from '@johnhenry/aimatey-types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 8080;

// ============================================================================
// Triage questions (same three as triage-demo.ts)
// ============================================================================

const URGENCY_LEVELS = ['low', 'medium', 'high', 'critical'] as const;

const TRIAGE_QUESTIONS = {
  category: {
    type: 'choice' as const,
    instructions: 'What is this support ticket primarily about?',
    criteria: {
      billing: 'Payments, charges, refunds, subscriptions, invoices',
      technical: 'Bugs, crashes, errors, broken features',
      account: 'Login, profile, settings, account access',
      other: 'Feedback, questions, or anything not covered above',
    },
  },
  urgency: {
    type: 'score' as const,
    instructions: 'How urgently does this ticket need a response?',
    criteria: URGENCY_LEVELS,
  },
  needsHumanEscalation: {
    type: 'noul' as const,
    instructions:
      'Should this ticket be escalated directly to a human agent rather than handled by an automated response?',
  },
};

// ============================================================================
// In-memory ticket queue (this is a demo -- a real app would use real
// storage; the point here is the typed-decision call, not persistence)
// ============================================================================

interface TriagedTicket {
  readonly id: string;
  readonly text: string;
  readonly answers: Record<string, IRDecisionAnswer>;
  readonly urgencyScore: number;
  readonly timestamp: number;
}

const tickets: TriagedTicket[] = [];

// ============================================================================
// Laya backend -- loaded once, kept warm for the life of the server
// ============================================================================

const backend = new LayaBackendAdapter();
const bridge = new Bridge(createGenericFrontend(), backend);

async function triageTicket(text: string): Promise<TriagedTicket> {
  const response = await bridge.decide({ ticket: text }, TRIAGE_QUESTIONS);
  const urgency = response.answers.urgency;
  const urgencyScore = urgency?.type === 'score' ? urgency.value : 0;

  const ticket: TriagedTicket = {
    id: randomUUID(),
    text,
    answers: response.answers,
    urgencyScore,
    timestamp: Date.now(),
  };
  tickets.unshift(ticket);
  return ticket;
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
// JSON API
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

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string
): Promise<boolean> {
  if (pathname === '/api/triage' && req.method === 'POST') {
    try {
      const body = (await readJSONBody(req)) as { text?: unknown };
      if (typeof body.text !== 'string' || body.text.trim().length === 0) {
        sendJSON(res, 400, { error: 'Request body must include non-empty "text"' });
        return true;
      }
      const ticket = await triageTicket(body.text.trim());
      sendJSON(res, 200, ticket);
    } catch (error) {
      sendJSON(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (pathname === '/api/tickets' && req.method === 'GET') {
    sendJSON(res, 200, tickets);
    return true;
  }

  if (pathname === '/api/tickets' && req.method === 'DELETE') {
    tickets.length = 0;
    sendJSON(res, 200, { ok: true });
    return true;
  }

  return false;
}

// ============================================================================
// Server
// ============================================================================

async function main(): Promise<void> {
  console.log('Loading Laya (first run downloads ~1.7GB of ONNX weights)...');
  await backend.initialize();
  console.log('Laya ready.');

  const server = http.createServer((req, res) => {
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
  });

  server.listen(PORT, () => {
    console.log(`Ticket triage dashboard running at http://localhost:${PORT}`);
  });

  const shutdown = () => {
    console.log('\nShutting down...');
    server.close(() => {
      void backend.close().then(() => process.exit(0));
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error('Server failed to start:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
