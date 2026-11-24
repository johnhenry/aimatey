### qwen3.5:0.8b

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

`*` token counts include an estimate (characters / 4) because the backend did not report usage for every call.

Means are over all runs in the cell, failures included. "steps" is loop iterations, "model calls" is backend requests, "code exec s" is mean time inside the sandbox executor per run (tool time included).
