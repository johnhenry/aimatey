### qwen2.5:3b

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

`*` token counts include an estimate (characters / 4) because the backend did not report usage for every call.

Means are over all runs in the cell, failures included. "steps" is loop iterations, "model calls" is backend requests, "code exec s" is mean time inside the sandbox executor per run (tool time included).
