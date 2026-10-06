---
"@johnhenry/aimatey-cli": minor
---

Typed decisions in the CLI. New `ai-matey decide` command asks choice / score / noul questions about a state (`--question name:type:"instructions":options`, `--questions @file.json`, `--state`, `--image`, `--batch @file.jsonl`, table or `--json` output, exit code 2 on a `ValidationError`). The proxy now routes by path: POSTs to `/v1/systemone`, `/v1/decisions` and `/v1/evaluate` go to `backend.decide()` in the TypeSafe, OpenRouter and Vercel dialects (reusing the client dialect table), and it accepts decision-only backends, answering chat paths with a 404 instead of refusing to start. `ai-matey emulate-ollama run` asks a decision model "Is the following true?" as a single noul question. The wire codec (`wireToDecisionRequest`, `decisionResponseToWire`, `decisionErrorToWire`, `decisionEscalationHeaders`) is exported.
