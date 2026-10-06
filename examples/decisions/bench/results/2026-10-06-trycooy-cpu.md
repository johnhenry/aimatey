# Decision benchmark: 2026-10-06

- Dataset: `builtin` (10 items)
- Hardware: trycooy: 4-core CPU, no GPU, shared box; Ollama 0.35.1
- Latency is wall-clock per `decide()` call on this hardware, over successful calls only; it is not comparable to a vendor figure measured elsewhere.

| backend | model | choice | score | noul | overall | Brier | ECE | p50 ms | p95 ms | cost (USD) | name flip | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ollama:tev1:0.8b | tev1:0.8b | 90.0% | 20.0% | 70.0% | 60.0% | 0.419 | 0.183 | 9509 | 13541 | $0 | - | 0/10 |
| emulated:qwen2.5:3b | qwen2.5:3b | 100.0% | 55.6% | 77.8% | 77.8% | 0.222 | 0.222 | 23331 | 27484 | $0 | - | 1/10 |

Accuracy by workflow (all answers):

| backend | invoice-reconciliation | agent-triage | security-alerts | customer-escalation |
|---|---|---|---|---|
| ollama:tev1:0.8b | 55.6% | 44.4% | 83.3% | 66.7% |
| emulated:qwen2.5:3b | 77.8% | 100.0% | 50.0% | 83.3% |

Brier and ECE cover only answers that report a confidence or probabilities; emulated:qwen2.5:3b skipped 18.


## Notes on this run

- Command: `npx tsx examples/decisions/bench/bench.ts --backend ollama:tev1:0.8b --backend emulated:qwen2.5:3b --dataset builtin --limit 10 --hardware "trycooy: 4-core CPU, no GPU, shared box; Ollama 0.35.1"`. `--limit 10` takes the first 10 items of the interleaved built-in set (3 invoice, 3 agent-triage, 2 security, 2 customer).
- Hardware: 4-core CPU, no GPU, a shared machine (load average about 9 when the run started). Latencies are for this box only and include the one-off model load in the first call of each backend.
- Ten items is a smoke test. Each `tev1:0.8b` cell is over 10 answers and each emulated cell over 9 (one item errored), so one answer moves a cell by 10 to 11 points. Do not read a ranking into the table.
- `emulated:qwen2.5:3b` reports no probabilities for `choice` and `score`, so its Brier and ECE come from its 9 `noul` answers only (18 answers skipped).
- The emulated backend's one error (`agent-triage-03`) is a real finding: the model answered the boolean question with the string `"true"` and the emulation backend rejected it rather than coercing it. The whole item is counted as an error and contributes no answers.
- `tev1:0.8b` is the smallest decision model; its `score` accuracy (20 %) is near chance for a 3-level scale. A larger model (`nimble`, about two minutes per call here) was not run.
- Costs are `$0`: both backends run locally.
