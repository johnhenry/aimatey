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
- A fully dynamic question set -- add, remove, or rename questions, each
  independently Choice/Score/Noul -- rather than a fixed 3-field shape.
  `resolveQuestions()` validates directly against the Decision IR's own
  `IRDecisionQuestion` type instead of a bespoke schema, since a
  client-editable question set and a Decision IR request's `questions`
  field are the same thing once nothing forces a fixed shape.
- A fully dynamic *state* shape too, mirroring the same idea on the input
  side: add, remove, or rename the fields Laya sees per ticket, each
  independently Text/Number/Boolean (see `resolveStateFields()` /
  `resolveStateValues()`). The ticket input form is generated from
  whatever fields are active, not one hardcoded textarea.
- A plain HTML/CSS/vanilla-JS frontend with no build step -- probability
  bars (colors computed as a gradient, not looked up by a fixed level
  name), per-request latency, a raw request/response viewer, and a queue
  of past tickets sorted by a configurable "priority question", exportable
  as JSON or CSV with columns derived from whatever questions were
  actually asked.
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

- **Fully dynamic state fields** -- the "State" panel is the same kind of
  form builder as "Questions" below, but for the input side: add, remove,
  or rename fields, each independently Text/Number/Boolean. The single
  ticket form is generated from whatever fields are active (a textarea
  per Text field, a number input per Number field, a checkbox per Boolean
  field). "Reset to defaults" restores the original single `ticket` text
  field.
- **Single ticket** -- fill in the active state fields, or use one of the
  "Try an example" buttons (populates the first Text field), and triage.
- **Batch** -- switch to Batch mode, one line per ticket, triage them all
  in one request. Only available when exactly one state field is
  configured, of type Text -- "one value per line" is ambiguous once
  there's more than one field, so batch mode is disabled (with an
  explanation) rather than silently guessing which field each line maps
  to. Processed sequentially (a single loaded ONNX session isn't
  necessarily safe for overlapping concurrent calls), so a large batch
  takes proportionally longer -- there's no progress bar beyond the
  status line, by design, to keep this a demo and not a job queue.
- **Compare with TypeSafe (Jev)** -- when `TYPESAFE_API_KEY` is set,
  check the box before triaging a single ticket to see both backends'
  answers side by side, including each one's own latency and raw
  response.
- **Fully dynamic questions** -- the "Questions" panel is a small form
  builder: add or remove questions, rename them, switch each one's type
  (Choice/Score/Noul), and add/remove/rename its options (Choice) or
  levels (Score). Nothing about the question set is fixed -- try replacing
  the defaults with something unrelated to support tickets entirely (a
  "sentiment"/"severity" pair, say) and triage against it; the server
  validates the submitted shape (`resolveQuestions()`: each question needs
  a valid `type`, `choice`/`score` need at least 2 options/levels) and the
  client's bar rendering, colors, and CSV export columns all follow
  whatever questions are actually active, not a hardcoded list. A
  **priority question** (any `score` or `noul` question, selectable in the
  panel) drives the queue's sort order and color-coded dot; with none
  selected, the queue still works, just without sorting or color, since
  there's nothing numeric to rank tickets by. "Reset to defaults" restores
  the original category/urgency/escalation set. Both this panel and
  "State" above autosave on every edit (debounced ~500ms) -- there is no
  Save button; a change that would leave zero named questions/fields is
  skipped rather than sent, so a mid-edit blank row never trips a
  spurious validation error.
- **Latency** -- every result shows the wall-clock time for the
  `bridge.decide()` call itself.
- **Raw request/response** -- "View raw request/response" under any
  result expands the exact `state`/`questions` sent and the backend's
  unmapped wire response (`IRDecisionResponse.raw`).
- **Export** -- "Export JSON" / "Export CSV" in the Queue panel download
  the current queue (JSON: full ticket objects; CSV: a flattened summary,
  one row per ticket, with a column for every state field that appears
  across the exported tickets, plus `priorityValue`/`latencyMs`, plus a
  `<name>`/`<name>.confidence` column pair for every question).

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
public/style.css       Dashboard styling (light theme approximating console.typesafe.ai/playground's look, probability bars, compare layout)
public/app.js           Fetches the API, renders results/queue, handles export
```

No frontend framework, no bundler -- `public/` is served as-is.
