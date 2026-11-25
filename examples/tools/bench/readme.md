# Tool-protocol benchmark

Compares the `native`, `text` and `code` tool protocols (`bridge.runTools({ protocol })`)
on five fixed tasks with deterministic fake tools and an automatic checker per task
(issue #241, epic #237). The write-up and results are in the docs guide
`guides/tool-protocol-benchmark`.

| Task | Needs |
|---|---|
| `t1-single` | one call |
| `t2-chain` | 3 sequential calls, each using the previous result |
| `t3-fanout` | 6 independent lookups, then a sum |
| `t4-aggregate` | a 200-row tool result; count and sum of one category |
| `t5-recovery` | the first call fails with a hint; the model must retry correctly |

## Run it

```bash
npm install && npx turbo run build --filter=@johnhenry/aimatey-core... \
  --filter=@johnhenry/aimatey-tool-protocols --filter=@johnhenry/aimatey-backend --filter=@johnhenry/aimatey-frontend

# Ollama on localhost:11434 with the model pulled. One run takes tens of seconds on CPU.
npx tsx examples/tools/bench/run.ts --model qwen2.5:3b --repeats 2 --heavy-repeats 1 \
  --out examples/tools/bench/results/qwen2.5-3b.json

# markdown table from a results file
npx tsx examples/tools/bench/run.ts --report examples/tools/bench/results/qwen2.5-3b.json
```

Flags: `--model` (repeatable), `--repeats N` (tasks 1-3), `--heavy-repeats N` (tasks 4-5),
`--timeout-s` per run (default 300), `--max-iterations` (default 8), `--temperature` (default 0.3),
`--tasks t1,t2`, `--protocols native,text,code`, `--arms D,A,B,C` (`code` ablation: A = no outputSchema + legacy prompt, B = outputSchema + legacy, C = no outputSchema + prompt v2, D = both; implies `--protocols code`), `--resume` (skip runs already in `--out`),
`--markdown <file>` with `--report`, `--base-url`, `--hardware`.

The results file is rewritten after every run, so an interrupted run loses at most one run
and `--resume` continues it. A failed, wrong or timed-out run is recorded, never fatal.

## What is recorded per run

success (checker), steps (loop iterations), model calls (backend requests), tool calls (what
the fake tools received), prompt and completion tokens (from the backend's usage, or a
chars/4 estimate flagged `tokensEstimated`), wall time, and for `code` the snippet count, time
inside the sandbox executor and snippet errors. Fuel consumed is not exposed by the executor
interface, so it is not recorded. Cost is `$0` for local models and not computed.

Hosted backends are untested here: the harness only constructs an Ollama backend.
Unit tests for the pure parts (checkers, runner with a scripted backend, aggregation) are in
`tests/unit/tool-bench.test.ts`.
