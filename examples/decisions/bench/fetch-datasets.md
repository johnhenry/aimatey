# Fetching the public datasets

The harness downloads nothing at build or test time. The built-in set
(`--dataset builtin`) needs no files. To run a public dataset, fetch it
yourself and point `--dataset` at the converted file.

## Typed Decisions

- Source: <https://huggingface.co/datasets/LocalLLaMA/typed-decisions>
  (Apache-2.0). Configs `agent_trace_observability`, `customer_service`,
  `invoice_processing`, `security_incidents` and `all`; splits `train` and
  `test` (100 test cases per workflow). Each row is one state with five typed
  questions.
- The dataset card describes `state`, `questions` and `gold` as JSON strings
  (`state` + `questions` are the body of a `POST /v1/systemone` request), with
  `gold` holding full distributions. The loader accepts that shape directly.

Convert a split to JSONL (needs `pip install datasets`):

```python
import json
from datasets import load_dataset

ds = load_dataset("LocalLLaMA/typed-decisions", "customer_service", split="test")
with open("typed-decisions-customer-service.jsonl", "w") as out:
    for i, row in enumerate(ds):
        out.write(json.dumps({
            "id": f"customer_service-{i}",
            "workflow": "customer_service",
            "state": row["state"],
            "questions": row["questions"],   # JSON string, parsed by the loader
            "gold": row["gold"],             # JSON string, reduced to hard labels
        }) + "\n")
```

Then:

```bash
npx tsx examples/decisions/bench/bench.ts --backend ollama \
  --dataset typed-decisions-customer-service.jsonl --limit 50
```

The dataset's own scoring is against soft gold distributions (KL, Brier); this
harness reduces gold to the most likely label, so its accuracy is comparable
in spirit to the dataset card's accuracy column but not a replacement for it.
The card also notes that gold is the mean of three teacher samples, so a score
measures agreement with that teacher, and that request shape matters (all five
questions in one request, as this harness does).

I verified the column names above against the dataset card, not against
downloaded rows. If a real row differs, `parseDatasetText` names the row and
question it could not read.

## Decision Index

- Source: <https://github.com/apolinario/decision-index> (Decision Index 0.2:
  40 benchmarks, chance-corrected, Brier + ECE).
- JevBench: <https://jevbench.dev/>.

Take a subset as a JSON array or JSONL with one row per (input, question,
label); see "Dataset formats" in `readme.md`. The repository's own file layout
may differ, so convert it to that shape (a few lines of `jq` or Python). This
harness does not reproduce the Index's chance correction.

## Other datasets using the same shape

`tasksource/tasksource-jev-typed-decisions` (2.5M rows, license "other") and
`tasksource/procedural-typed-decisions` are on the Hub too. They were not
checked against this loader.
