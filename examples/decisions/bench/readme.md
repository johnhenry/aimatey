# Decision benchmark

Runs a labeled set of typed-decision questions against one or more backends
through a real `Bridge` and reports, per backend:

- accuracy per question type (`choice`, `score`, `noul`) and overall,
- Brier score and ECE (computed by `calibrationReport` from
  `@johnhenry/aimatey-testing`),
- p50 / p95 latency per `decide()` call,
- cost (the provider's `usage.cost`, else input tokens at the model
  registry's price; `n/a` when neither exists),
- optionally the option-name flip rate (`--name-invariance`, via
  `nameInvariance`).

## Run it

```bash
npm install && npx turbo run build --filter='!@johnhenry/aimatey-docs'

# Local: a decision model through Ollama (0.35 or newer), and a plain chat
# model answering through structured output for comparison
npx tsx examples/decisions/bench/bench.ts \
  --backend ollama:tev1:0.8b --backend emulated:qwen2.5:3b \
  --dataset builtin --limit 10 \
  --hardware "4-core CPU, no GPU" \
  --out results.json --markdown results.md
```

| Flag | Meaning |
|---|---|
| `--backend <spec>` (repeatable) | `ollama[:model]`, `typesafe`, `openrouter[:model]`, `cloudflare[:clef\|clef-flash]`, `systemone:<url>`, `emulated:<chatModel>`, `laya` |
| `--dataset <path\|builtin>` | the built-in set, or a JSON/JSONL file (see below) |
| `--limit N` | first N items (the built-in set interleaves its four workflows) |
| `--concurrency N` | requests in flight per backend; clamped to the backend's declared `maxConcurrency` (Laya runs one at a time) |
| `--out` / `--markdown` | write the JSON / markdown report |
| `--neutral-keys` | wrap with `createNeutralOptionKeys()`: choice keys become `opt_1..n` |
| `--temperature T` | wrap with `createTemperatureScaling({ default: T })` |
| `--name-invariance` | also measure the flip rate (2 to 3 extra calls per item, against the bare backend) |
| `--model`, `--hardware` | `parameters.model` for every request; free-text note for the header |

Credentials come from the environment: `TYPESAFE_API_KEY`,
`OPENROUTER_API_KEY`, `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID`,
`SYSTEMONE_API_KEY` (optional). `OLLAMA_HOST` points the Ollama backends
elsewhere. `emulated:` always wraps an Ollama chat model.

Tests (mock backends only, no network): `cd examples/decisions/bench && npx vitest run`.
`OLLAMA_LIVE=1` adds a two-item run against local Ollama.

## Reading the numbers

- **Accuracy** is agreement with the gold label. For `score`, the answer's
  index is rounded; for `noul`, probability >= 0.5 counts as "yes". An item
  where the backend throws, or omits or mistypes an answer, is counted under
  `errors` and contributes no answers, so check `errors` before comparing
  accuracy.
- **Brier** is the mean squared error of the reported probabilities (lower is
  better, 0 is perfect). **ECE** is the gap between stated confidence and
  actual accuracy, over ten confidence buckets (lower is better). Both cover
  only answers that carry a confidence or probabilities; an emulated backend
  reports none for `choice` and `score`, so its Brier and ECE rest on its
  `noul` answers alone (the report says how many answers were skipped). Small
  runs make both noisy: with 10 items the ECE has few answers per bucket.
- **Name flip** is the share of answers that changed when the same options
  were presented with rotated name-to-definition bindings (a name-biased model
  follows the name). Lower is better; compare against the `--neutral-keys`
  run.
- **Latency** is wall-clock per call, measured by this process, over
  successful calls. **Vendor latency numbers are not comparable with these**:
  a vendor's 33 ms or 524 ms median was measured on their hardware, with their
  batching and network. Cloud rows here include your round trip; local rows
  depend on your CPU or GPU and on whether the model was already loaded (the
  first call to a local model includes the load).
- **Cost** is the run's total in USD. Local backends are `$0`.
- The built-in set is 40 hand-written, unambiguous items. Use it to catch
  regressions and to sanity-check a backend, not to rank models: differences
  of a few points on 10 to 40 items are noise.

Results of past runs live in `results/`.

## Dataset formats

`--dataset` takes `builtin` or a path. JSON (an array, or an object with an
`items` / `data` / `rows` array) and JSONL (one object per line) are both read.
Two row shapes are recognized.

**Typed Decisions**: many questions per state.

```json
{
  "id": "inv-001",
  "workflow": "invoice-reconciliation",
  "state": "Invoice INV-1001: $1,200 ... PO-7781 authorizes $1,200 ...",
  "questions": {
    "match": { "type": "choice", "instructions": "...", "criteria": { "exact_match": "...", "duplicate": "..." } },
    "exposure": { "type": "score", "instructions": "...", "criteria": ["none", "minor", "major"] },
    "hold": { "type": "noul", "instructions": "..." }
  },
  "gold": { "match": "exact_match", "exposure": 0, "hold": false }
}
```

- `state` may be text or any JSON (also accepted as `input` or `text`).
- `questions` and `gold` may be JSON-encoded strings, as in the public
  parquet export. Gold may be under `gold`, `answers` or `labels`.
- Gold per question: `choice` is an option key or a 0-based index; `score` is
  a 0-based level index or a level label; `noul` is `true`/`false`, `1`/`0` or
  `"yes"`/`"no"`. A soft-gold object is reduced to a hard label: `label`,
  else the largest of `probabilities`, else the rounded `score`, else
  `probability_true >= 0.5`.
- `id` defaults to `item-<row number>`; `workflow` (or `benchmark`) is only
  used for the by-workflow table.

**Decision Index subset**: one question per row.

```json
{ "id": "di-1", "benchmark": "spam", "input": "win a prize", "question": { "type": "noul", "instructions": "Is this spam?" }, "label": 1 }
```

The question is asked under the name `answer`.

A row with a missing or unreadable label is rejected with an error naming
the row and question. See `fetch-datasets.md` for where the public data is and
how to convert it.

## Files

| File | Role |
|---|---|
| `bench.ts` | CLI entry point |
| `args.ts`, `backends.ts` | flag parsing; backend specs |
| `datasets.ts`, `datasets/builtin.ts` | loader; the 40 built-in items |
| `run.ts`, `scoring.ts`, `report.ts` | runner; accuracy/Brier/ECE/percentiles/cost; markdown + JSON |
| `testing-decisions.ts` | imports `calibrationReport` and `nameInvariance` from the built testing package (its root export imports Vitest and cannot be loaded by a CLI) |
| `bench.test.ts`, `vitest.config.ts` | tests |
