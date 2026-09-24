# Laya Ticket Triage Dashboard

A browser GUI for the same typed-decision triage `../triage-demo.ts` does
from the CLI, wired into a persistent server instead of a one-shot script.

## What it demonstrates

- `Bridge.decide()` called from a long-running Node process that loads
  Laya once and keeps it warm, rather than per-invocation.
- A real (if minimal) JSON API in front of a typed-decision backend, with
  single-ticket triage, batch triage, editable questions, and an optional
  side-by-side comparison against a second, unrelated typed-decision
  backend (TypeSafe's Jev) -- made possible by both sharing the exact same
  Decision IR, so the same client-side rendering code handles either.
- A plain HTML/CSS/vanilla-JS frontend with no build step -- probability
  bars, per-request latency, a raw request/response viewer, and a queue
  of past tickets sorted by urgency, exportable as JSON or CSV.
- A request handler built as a factory (`createRequestHandler(deps)`)
  taking its backends as a parameter, so `server.test.ts` can inject a
  mock backend and test the API's routing/validation logic without
  needing the real ~1.7GB model.

## Prerequisites

Same as `../triage-demo.ts`:

```bash
npm install @receptron/laya
```

First run downloads ~1.7GB of ONNX weights from HuggingFace, cached after.

Optionally, to enable compare mode against TypeSafe's Jev (a real, paid,
hosted API -- unlike Laya, this is not free or on-device):

```bash
export TYPESAFE_API_KEY=...
```

Without it, compare mode is simply unavailable -- the dashboard reports
this via `GET /api/backends` and disables the checkbox accordingly, it
does not error. The compare-mode server code is written directly against
`TypeSafeBackendAdapter`'s verified contract but has not been exercised
against a real TypeSafe account in this environment (no key was
available) -- the not-configured path is what's actually been run.

## Run

```bash
npx tsx examples/laya/gui-demo/server.ts
```

Then open <http://localhost:8080>.

## Features

- **Single ticket** -- paste or type a ticket, or use one of the "Try an
  example" buttons, and triage it.
- **Batch** -- switch to Batch mode, one ticket per line, triage them all
  in one request. Processed sequentially (a single loaded ONNX session
  isn't necessarily safe for overlapping concurrent calls), so a large
  batch takes proportionally longer -- there's no progress bar beyond the
  status line, by design, to keep this a demo and not a job queue.
- **Compare with TypeSafe (Jev)** -- when `TYPESAFE_API_KEY` is set,
  check the box before triaging a single ticket to see both backends'
  answers side by side, including each one's own latency and raw
  response.
- **Editable questions** -- the "Questions" panel lets you edit the
  prompt text and (for category) the criteria descriptions used for every
  subsequent triage call. The category keys
  (billing/technical/account/other) and the four urgency level names
  (low/medium/high/critical) are **not** editable -- both the client's
  rendering (bar colors, ordering) and the server's own `criteria` keying
  are written against those fixed names; making them fully dynamic would
  need schema-driven rendering throughout, which is out of scope for this
  demo. "Reset to defaults" restores the original prompts.
- **Latency** -- every result shows the wall-clock time for the
  `bridge.decide()` call itself.
- **Raw request/response** -- "View raw request/response" under any
  result expands the exact `state`/`questions` sent and the backend's
  unmapped wire response (`IRDecisionResponse.raw`).
- **Export** -- "Export JSON" / "Export CSV" in the Queue panel download
  the current queue (JSON: full ticket objects; CSV: a flattened summary
  -- category, urgency level/score, escalation likelihood, latency, per
  ticket).

Not implemented: persisting the queue across server restarts (in-memory
only, deliberately -- see the top-level dashboard commit history for why).

## Tests

`server.test.ts` covers the API's routing, validation, and question-editing
logic using a mock backend (no real Laya model needed). Deliberately not
wired into this repo's centralized `npm test` (`vitest.workspace.ts` only
looks under `tests/**`) -- run standalone:

```bash
cd examples/laya/gui-demo
npx vitest run
```

## Files

```
server.ts           Request handler factory + entry point: routing, question
                     validation, triage/batch/compare logic, static file serving
server.test.ts       Tests against a mock backend (see "Tests" above)
vitest.config.ts      Standalone vitest config so the tests above run from this dir
public/index.html      Page structure
public/style.css       Dashboard styling (dark theme, probability bars, compare layout)
public/app.js           Fetches the API, renders results/queue, handles export
```

No frontend framework, no bundler -- `public/` is served as-is.
