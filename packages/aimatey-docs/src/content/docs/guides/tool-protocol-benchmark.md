---
title: "Tool Protocol Benchmark"
description: "Measured comparison of the native, text and code tool protocols for bridge.runTools on small local models: methodology, results table, and what the data does and does not show."
---

`bridge.runTools()` can drive tools three ways: **native** (the backend's tool-calling API), **text** (tools described in the prompt, the model replies with a JSON block) and **code** (the model writes one JavaScript snippet that calls `tools.name(...)` inside an andbox wasm sandbox). See the [`@johnhenry/aimatey-tool-protocols`](https://github.com/johnhenry/aimatey/tree/main/packages/tool-protocols) readme for how each works. This page reports a first measurement of whether `text` and `code` are worth recommending (issue #241, epic #237).

**Read this first.** The first-run data below is tiny: one 3B model (plus a partial run of a 0.8B model), 1 to 2 repeats per cell, CPU-only inference. One run is a coin flip at this sample size. It says nothing reliable about hosted models, which were **not tested** (no API keys were available). Treat it as a working harness plus a few observations, not a verdict. A follow-up retest of the `code` protocol with typed tool results and a revised prompt (issue #251) is in [Retest](#retest-code-prompt-v2-and-typed-results-issue-251).

## Methodology

Harness: `examples/tools/bench/` (run with `npx tsx examples/tools/bench/run.ts`). Every run builds fresh deterministic fake tools and checks the model's final answer automatically; there is no LLM judge.

| Task | What it needs | Correct when |
|---|---|---|
| single call | one `get_temperature` call | answer contains 58 |
| 3-call chain | `find_user` then `list_orders` then `get_order_total`, each using the previous result | answer contains 284 **and** `get_order_total` was really called with the latest order id |
| fan-out x6 | `get_population` for six cities, then a sum | answer contains 25286 and all six cities were looked up |
| large result aggregate | `list_transactions` returns 200 rows; count and sum of category `travel` | answer contains 34 and 1746 |
| error recovery | `get_balance('1042')` fails with a hint; the retry must use `ACC-1042` | answer contains 731 **and** a valid call succeeded |

- Backend: local Ollama (`localhost:11434`) through the Ollama backend adapter, CPU only, no GPU, on a shared workstation. Temperature 0.3, up to 8 loop iterations, a per-run timeout (360 s for `qwen2.5:3b`, 240 s for `qwen3.5:0.8b`). Ollama's default context window applied; the adapter does not set `num_ctx`.
- Repeats: `qwen2.5:3b` ran tasks 1 to 3 twice and tasks 4 and 5 once (24 runs). `qwen3.5:0.8b` ran tasks 1 to 3 once (9 runs); it was not run on tasks 4 and 5.
- Every task x protocol run is recorded, including wrong answers, errors and timeouts; a failure never stops the benchmark. Results are in `examples/tools/bench/results/*.json`.
- **Steps** are loop iterations; **model calls** are backend requests; **tool calls** are what the fake tools received. **Tokens** are prompt plus completion from the backend's reported usage. When any call in a run lacked usage (typical after a timeout cut a call off) the whole run's count is a characters/4 estimate and the cell is marked `*`.
- `code` extras: the table's "code exec s" is the mean time spent inside the sandbox executor per run, tool time included. **Fuel consumed is not recorded**: the `CodeExecutor` interface does not report it.
- **Cost** is `$0` for local models and was not computed. Hosted backends were not run, so there is no cost or hosted-model data at all.
- Means include failed runs. Averages over a 100%-failing cell (for example 0% success) describe how the failing runs behaved, not how a working run would.

## Results

### qwen2.5:3b (supports native tools)

| task | protocol | runs | success | steps | model calls | tool calls | tokens | wall s | code exec s | timeouts |
|---|---|---|---|---|---|---|---|---|---|---|
| single call | native | 2 | 100% (2/2) | 2.0 | 2.0 | 1.0 | 422 | 26.4 | - | 0 |
| single call | text | 2 | 100% (2/2) | 2.0 | 2.0 | 1.0 | 447 | 16.3 | - | 0 |
| single call | code | 2 | 100% (2/2) | 2.0 | 2.0 | 1.0 | 646 | 25.8 | 0.3 | 0 |
| 3-call chain | native | 2 | 0% (0/2) | 2.0 | 2.0 | 3.0 | 844 | 106.2 | - | 0 |
| 3-call chain | text | 2 | 100% (2/2) | 4.0 | 4.0 | 3.0 | 1630 | 92.3 | - | 0 |
| 3-call chain | code | 2 | 0% (0/2) | 3.5 | 3.5 | 6.0 | 2677* | 324.0 | 0.5 | 1 |
| fan-out x6 | native | 2 | 0% (0/2) | 2.0 | 2.0 | 6.0 | 928 | 113.0 | - | 0 |
| fan-out x6 | text | 2 | 0% (0/2) | 2.0 | 2.0 | 6.0 | 855 | 112.8 | - | 0 |
| fan-out x6 | code | 2 | 0% (0/2) | 1.0 | 1.0 | 6.0 | 383 | 69.7 | 0.2 | 0 |
| large result aggregate | native | 1 | 0% (0/1) | 2.0 | 2.0 | 1.0 | 2678* | 328.7 | - | 0 |
| large result aggregate | text | 1 | 0% (0/1) | 2.0 | 2.0 | 47.0 | 117595* | 360.0 | - | 1 |
| large result aggregate | code | 1 | 0% (0/1) | 1.0 | 1.0 | 1.0 | 384 | 78.8 | 0.2 | 0 |
| error recovery | native | 1 | 0% (0/1) | 2.0 | 2.0 | 1.0 | 476 | 39.0 | - | 0 |
| error recovery | text | 1 | 0% (0/1) | 2.0 | 2.0 | 1.0 | 514 | 37.9 | - | 0 |
| error recovery | code | 1 | 0% (0/1) | 1.0 | 1.0 | 1.0 | 322 | 27.7 | 0.2 | 0 |
| **all tasks** | native | 8 | 25% (2/8) | 2.0 | 2.0 | 2.8 | 943* | 107.4 | - | 0 |
| **all tasks** | text | 8 | 50% (4/8) | 2.5 | 2.5 | 8.5 | 15497* | 105.1 | - | 1 |
| **all tasks** | code | 8 | 25% (2/8) | 1.9 | 1.9 | 3.5 | 1015* | 118.2 | 0.3 | 1 |

`*` tokens include an estimate (characters / 4) for at least one run in the cell. Means are over all runs in the cell, failures included.

### qwen3.5:0.8b (partial: tasks 1 to 3, one repeat)

| task | protocol | runs | success | steps | model calls | tool calls | tokens | wall s | code exec s | timeouts |
|---|---|---|---|---|---|---|---|---|---|---|
| single call | native | 1 | 100% (1/1) | 2.0 | 2.0 | 1.0 | 787 | 30.5 | - | 0 |
| single call | text | 1 | 0% (0/1) | 1.0 | 1.0 | 0.0 | 207* | 240.0 | - | 1 |
| single call | code | 1 | 100% (1/1) | 2.0 | 2.0 | 1.0 | 1444 | 173.5 | 0.7 | 0 |
| 3-call chain | native | 1 | 100% (1/1) | 4.0 | 4.0 | 3.0 | 2391 | 56.0 | - | 0 |
| 3-call chain | text | 1 | 0% (0/1) | 2.0 | 2.0 | 1.0 | 758* | 240.0 | - | 1 |
| 3-call chain | code | 1 | 0% (0/1) | 1.0 | 1.0 | 0.0 | 399* | 240.0 | 0.0 | 1 |
| fan-out x6 | native | 1 | 0% (0/1) | 1.0 | 1.0 | 0.0 | 100* | 240.0 | - | 1 |
| fan-out x6 | text | 1 | 0% (0/1) | 2.0 | 2.0 | 6.0 | 787* | 240.0 | - | 1 |
| fan-out x6 | code | 1 | 0% (0/1) | 1.0 | 1.0 | 0.0 | 314* | 240.0 | 0.0 | 1 |
| **all tasks** | native | 3 | 67% (2/3) | 2.3 | 2.3 | 1.3 | 1093* | 108.8 | - | 1 |
| **all tasks** | text | 3 | 0% (0/3) | 1.7 | 1.7 | 2.3 | 584* | 240.0 | - | 3 |
| **all tasks** | code | 3 | 33% (1/3) | 1.3 | 1.3 | 0.3 | 719* | 217.8 | 0.2 | 2 |

The 0.8B model is a "thinking" model and the Ollama adapter does not turn thinking off, so most of its failures are runs that hit the 240 s timeout while generating. Its numbers mostly measure that, not tool-protocol quality. One run per cell cannot separate protocols.

## What the data shows

- **Nothing here shows `code` beating `native` or `text`.** On `qwen2.5:3b` the pooled success was native 2/8, text 4/8, code 2/8. With cells of one or two runs, those differences are inside noise. The smolagents-style claim that code needs about 30% fewer steps is not supported by this data: `code` used 1.9 model calls per run against native's 2.0 and text's 2.5, but `code` runs also mostly failed, and a failed run can end early.
- **Single call (2 runs each, 3B):** all three protocols succeeded. All three took 2 model calls; `code` used about 50% more tokens (646 vs 422) because its prompt carries a generated TypeScript API, and its wall time was similar to native's here (about 26 s).
- **3-call chain (3B):** `text` was the only protocol that succeeded (2/2). `native` made all three tool calls within 2 model calls, so the later calls cannot have used the earlier results; it answered wrongly both times (once with a wrong total, once claiming alice had no orders). `code` failed both times (one wrong snippet that concluded no orders existed, one timeout). Do not read this as "text is better at chains": it is two runs.
- **Fan-out x6 (3B):** all three failed all runs, and the failures are arithmetic or snippet bugs, not tool use: the `native` and `text` answers listed the six right numbers but added them wrongly (24486, 24686, 24786 instead of 25286), and both `code` runs wrote a sum that concatenated objects (`0[object Object]...`). All six lookups happened in every run (6 tool calls). `code` used one model call where the others used two, which is the structural saving code actions are meant to give (the snippet makes all calls itself), but it did not turn into a correct answer. The failures show a 3B model is the limiting factor.
- **Large result (3B, 1 run each):** all failed. `native` failed with an Ollama `fetch failed` after about 329 s, which is the large prompt being processed too slowly on CPU (so slow-prompt-processing, not a protocol property). `text` made 47 tool calls across just 2 model calls (apparently a runaway array of repeated calls), which put roughly 117k estimated tokens of 200-row results into the next prompt, and timed out. `code` finished quickest (79 s, one model call, about 0.4k tokens) but returned the template placeholder `count=<count> sum=<totalAmount>`, so it was wrong. The cost-side observation is real but narrow: with `code`, the 200 rows never reached the model, so the prompt stayed small. That only matters if the model then gets the aggregate right, which it did not here.
- **Error recovery (3B, 1 run each):** all failed, and none retried. Each protocol surfaced the tool's error hint to the model; the model reported the error (`native`, `code`) or echoed a placeholder (`text`) instead of retrying with `ACC-1042`. This task did not discriminate between protocols.
- **Sandbox overhead:** the executor itself was cheap (mean 0.2 to 0.5 s per run, including tool time). The wall-time cost of `code` came from model generation, not the sandbox.
- **0.8B (partial):** `native` succeeded on 2 of 3 runs; `text` 0 of 3 and `code` 1 of 3, mostly timeouts. See the caveat above.

## Recommendations, and how far they go

These follow from the data plus the protocol designs; they are not proven by the benchmark.

- **If the backend supports native tool calling, use `native` by default.** Nothing measured gave a reason to leave it, and it is the simplest path. The one observed native weakness (3B model batching dependent calls with guessed arguments) is a model behavior, not a protocol bug.
- **If the model has no native tool calling, `text` is the fallback.** It was the only protocol to complete the dependent chain on `qwen2.5:3b`, on two runs. `autoProtocol()` chooses between native and text for you.
- **`code` is not shown to be worth recommending yet.** In the first run it did not win on any task. The retest (below) lifted it to 9/15 with typed results and prompt v2 on a different, larger sample, which is encouraging but not comparable to the native and text baselines. Its theoretical advantages (one model call for a fan-out, large intermediate results kept out of the prompt) were visible in call counts and prompt size, but did not produce more correct answers with a 3B model, and a model that has to write correct JavaScript is a harder ask than one that emits a JSON call. A re-run with a hosted or larger model is the real test.
- **To settle this**, run the harness against a model that is strong at code (it already accepts any Ollama model; adding a hosted backend means constructing it in `run.ts`) with more repeats (10 or more per cell), and add the fuel figure to the executor result so it can be reported.

## Retest: `code` prompt v2 and typed results (issue #251)

The first run left an obvious suspect: the `code` rows measured a minimal prompt, and the bench tools declared no `outputSchema`, so every result was typed `Promise<unknown>`. Several failures looked caused by that (summing objects with `+`, calling `final()` in the same snippet that fetched the data, a literal `count=<count> sum=<totalAmount>` answer). This section fixes those two things in a principled way and re-measures. The tasks and checkers were not changed.

### What changed

- **`outputSchema` on every bench tool** (`examples/tools/bench/tasks.ts`), accurate to what the tool returns (a unit test checks the real results against the schemas). The generated interface now reads, for example, `get_population(input: { city: string }): Promise<{ city: string; thousands: number | null }>`. Tool results are the same values as before; `native` and `text` do not use `outputSchema`, so their first-run numbers remain valid (one native re-run on t1 and t5 behaved the same: t1 correct, t5 failed, two model calls each).
- **Prompt v2** (the new default of `buildCodePrompt`): a worked two-step example (first reply fetches and `console.log`s; the model finishes in a later plain-text reply after reading the output), a rule never to call `final()` in the same snippet as a tool call whose result has not been seen, a rule to read result types from the interface and not guess shapes, and a note that `final(answer)` is optional sugar whose argument is the answer text. `codeProtocol({ systemPrompt })` accepts a custom builder; the old prompt is kept as the `@internal` `buildLegacyCodePrompt` so this ablation is reproducible.

### Experiment

`qwen2.5:3b`, local Ollama, CPU only, temperature 0.3 (unseeded), 360 s timeout, 3 repeats of each of the five tasks per arm (60 runs, `code` protocol only). Arm A is the original configuration re-run with the same harness for comparability. The run took about 1 h 50 min on a shared machine; another heavy job was using the CPU for part of it, so wall times are noisy and some timeouts may be contention.

| arm | outputSchema | prompt | t1 single | t2 chain | t3 fan-out | t4 aggregate | t5 recovery | total | model calls | tokens | wall s | timeouts |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A (original) | no | legacy | 2/3 | 0/3 | 0/3 | 3/3 | 0/3 | 5/15 | 1.6 | 836 | 93 | 2 |
| B | yes | legacy | 3/3 | 0/3 | 2/3 | 2/3 | 0/3 | 7/15 | 1.5 | 681 | 79 | 1 |
| C | no | v2 | 3/3 | 0/3 | 0/3 | 1/3 | 0/3 | 4/15 | 2.5 | 1588 | 145 | 4 |
| D | yes | v2 | 2/3 | 1/3 | 3/3 | 3/3 | 0/3 | 9/15 | 1.9 | 1005 | 123 | 2 |

Model calls, tokens (some estimated, characters / 4) and wall seconds are means per run over all 15 runs, failures included. The full per-cell table (steps, tool calls, code executor time) is in `examples/tools/bench/results/qwen2.5-3b-code-arms.md`; raw runs in `qwen2.5-3b-code-arms.json`. For reference, the first run's pooled `qwen2.5:3b` success was native 2/8, text 4/8, code 2/8 (1 to 2 repeats per cell).

### What the data shows

- **Both changes together helped; neither alone clearly did.** D (typed results plus v2) got 9/15 against A's 5/15, the best arm. Typed results alone (B) got 7/15. The prompt alone (C) got 4/15, no better than the original. That fits the mechanism: the prompt's "read result types from the interface" rule has nothing to read when results are `unknown`, and its log-first rule adds a model call (C averaged 2.5 calls and more timeouts) without the types that make the second look useful.
- **Fan-out is the clearest effect: A 0/3, C 0/3, B 2/3, D 3/3.** Without types (A, C) the answers were again `[object Object][object Object]...` or `0[object Object]...` even under v2, so the prompt alone does not fix it; with typed results the model summed `thousands` fields instead of concatenating objects. In D it did so in one model call (the sum is computed in the snippet), which is the structural saving code actions are meant to give, now with correct answers.
- **t4 aggregate is not evidence of anything.** A scored 3/3 here although the first run's single A run returned the `count=<count> sum=<totalAmount>` placeholder, so that failure is intermittent, not deterministic. B's one miss was the same placeholder answer (`count=<count> sum=<sum>`), i.e. `final()` or a template answered before the data was read. D had 3/3 (each using two model calls: fetch and compute, then answer).
- **Error recovery stays 0/3 in every arm, and prompt v2 did not change that.** Tracing one run of the current default configuration: the model's first snippet calls `get_balance({ accountId: '1042' })`; it receives `Error (Error): Invalid account id '1042': expected the form ACC-NNNN, e.g. ACC-1042`, and then replies in plain text asking the user for the correct id. Replying with plain text is the "I am done" signal in this protocol, and v2's own instruction that plain text is the way to answer likely made that exit more attractive. The retry was never attempted. This is a model-behaviour limit at 3B (all three protocols failed this task in the first run too), not a typing problem.
- **3-call chain is still mostly out of reach: D 1/3, others 0/3.** The failures are two kinds. Arms A and B answered nonsense text (`Processing complete.`, `Operation completed`, `Order total is displayed here`) after one snippet made all three calls without logging the final value (3 tool calls, 1 model call): the same "finish before looking" pattern. With v2 (C and D) the model usually did read output, but runs hit the 360 s timeout (C 3/3, D 2/3 timed out), so some of this is slowness on a loaded CPU. A traced run of D succeeded: one snippet chained the three calls, logged the total, and the next reply answered `284`.
- **Cost.** v2 makes the prompt longer (D averaged about 1000 tokens per run against 836 for A) and adds a model call on tasks where the first snippet used to finish alone. Typed results alone (B) were the cheapest arm: 1.5 model calls and 681 tokens per run.
- **Timeouts and wall time are confounded** by other load on the machine during the run; compare them only roughly.

### Honest reading

With 3 repeats per cell, one 3B model and an unseeded temperature, a difference of one or two runs is noise. What is reasonably supported: the original `code` result was depressed by untyped results (B and D beat A and C on fan-out, the task most about types), and that the prompt rules did not help on their own. What is not supported: that `code` now beats `native` or `text` (the baselines have 1 to 2 repeats, 8 runs each, and were not re-run in full), or that v2 specifically is better than the legacy prompt once results are typed (D 9/15 vs B 7/15 is two runs). The remaining failures (error recovery, the 3-call chain) are about the model not retrying after an error and not reliably chaining and reading values, which this prompt does not fix. A larger or code-tuned model, and 10 or more repeats, remain the real test.

## Limitations

- Sample size: 1 to 2 runs per cell, one 3B model and a partial 0.8B model. No confidence intervals can be drawn.
- Local, CPU-only, small models only. No hosted model was run, so claims about GPT-class or Claude-class models, cost in dollars and fuel usage are untested.
- Timeouts (360 s and 240 s) cut off slow runs; some failures are slowness, not wrong behavior.
- Default Ollama context window; the large-result task may have been truncated for `native` and `text` in ways that depend on that setting.
- Prompts, tool descriptions and the code protocol's generated API are fixed wordings; results can move with prompt changes (the retest shows they do). The retest compared only two prompts and did not tune the tasks or checkers.
- The retest arms were run sequentially on a shared machine, so arm order and background load are confounded with the arm.
- Temperature 0.3 with no seed: repeats are not reproducible run for run.

## Reproduce

```bash
npm install && npx turbo run build --filter=@johnhenry/aimatey-core... \
  --filter=@johnhenry/aimatey-tool-protocols --filter=@johnhenry/aimatey-backend --filter=@johnhenry/aimatey-frontend
npx tsx examples/tools/bench/run.ts --model qwen2.5:3b --repeats 2 --heavy-repeats 1 \
  --out examples/tools/bench/results/qwen2.5-3b.json
npx tsx examples/tools/bench/run.ts --report examples/tools/bench/results/qwen2.5-3b.json
```

The `code` ablation arms (A to D above, `--arms` runs only the `code` protocol and records the arm per run):

```bash
npx tsx examples/tools/bench/run.ts --model qwen2.5:3b --arms D,A,B,C --repeats 3 --heavy-repeats 3 \
  --timeout-s 360 --resume --out examples/tools/bench/results/qwen2.5-3b-code-arms.json
```

See `examples/tools/bench/readme.md` for all flags, including `--resume`.
