# Laya Ticket Triage Dashboard

A browser GUI for the same typed-decision triage `../triage-demo.ts` does
from the CLI, wired into a persistent server instead of a one-shot script.

## What it demonstrates

- `Bridge.decide()` / `LayaBackendAdapter` called from a long-running Node
  process that loads Laya once and keeps it warm, rather than per-invocation.
- A real (if minimal) JSON API in front of a typed-decision backend:
  `POST /api/triage`, `GET /api/tickets`, `DELETE /api/tickets`.
- A plain HTML/CSS/vanilla-JS frontend with no build step -- probability
  bars for `category` and `urgency`, an escalation-likelihood bar, and a
  queue of past tickets sorted by urgency.

## Prerequisites

Same as `../triage-demo.ts`:

```bash
npm install @receptron/laya
```

First run downloads ~1.7GB of ONNX weights from HuggingFace, cached after.

## Run

```bash
npx tsx examples/laya/gui-demo/server.ts
```

Then open <http://localhost:8080>. Use the "Try an example" buttons for a
quick demo, or paste your own ticket text.

## Files

```
server.ts          Node HTTP server: loads Laya, serves public/, exposes the API
public/index.html  Page structure
public/style.css   Dashboard styling (dark theme, probability bars)
public/app.js      Fetches the API, renders results and the queue
```

No frontend framework, no bundler -- `public/` is served as-is.
