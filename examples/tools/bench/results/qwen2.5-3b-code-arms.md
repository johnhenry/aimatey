### qwen2.5:3b

| task | protocol | runs | success | steps | model calls | tool calls | tokens | wall s | code exec s | timeouts |
|---|---|---|---|---|---|---|---|---|---|---|
| single call | code (arm A) | 3 | 67% (2/3) | 1.7 | 1.7 | 1.0 | 534 | 25.0 | 0.1 | 0 |
| single call | code (arm B) | 3 | 100% (3/3) | 1.0 | 1.0 | 1.0 | 336 | 56.3 | 0.6 | 0 |
| single call | code (arm C) | 3 | 100% (3/3) | 2.0 | 2.0 | 1.0 | 887 | 38.9 | 0.2 | 0 |
| single call | code (arm D) | 3 | 67% (2/3) | 2.3 | 2.3 | 1.3 | 1083 | 85.2 | 0.8 | 0 |
| 3-call chain | code (arm A) | 3 | 0% (0/3) | 2.0 | 2.0 | 2.3 | 1286* | 187.1 | 0.6 | 1 |
| 3-call chain | code (arm B) | 3 | 0% (0/3) | 1.0 | 1.0 | 3.0 | 526 | 83.6 | 0.3 | 0 |
| 3-call chain | code (arm C) | 3 | 0% (0/3) | 3.3 | 3.3 | 3.0 | 2521* | 360.0 | 1.4 | 3 |
| 3-call chain | code (arm D) | 3 | 33% (1/3) | 2.0 | 2.0 | 1.7 | 1464* | 293.9 | 0.8 | 2 |
| fan-out x6 | code (arm A) | 3 | 0% (0/3) | 2.3 | 2.3 | 12.0 | 1683* | 162.4 | 0.4 | 1 |
| fan-out x6 | code (arm B) | 3 | 67% (2/3) | 2.3 | 2.3 | 12.0 | 1464* | 165.6 | 0.5 | 1 |
| fan-out x6 | code (arm C) | 3 | 0% (0/3) | 3.0 | 3.0 | 16.0 | 2635* | 208.5 | 0.5 | 1 |
| fan-out x6 | code (arm D) | 3 | 100% (3/3) | 1.0 | 1.0 | 6.0 | 523 | 126.0 | 0.7 | 0 |
| large result aggregate | code (arm A) | 3 | 100% (3/3) | 1.0 | 1.0 | 1.0 | 350 | 47.4 | 0.2 | 0 |
| large result aggregate | code (arm B) | 3 | 67% (2/3) | 1.0 | 1.0 | 1.0 | 386 | 46.2 | 0.2 | 0 |
| large result aggregate | code (arm C) | 3 | 33% (1/3) | 2.0 | 2.0 | 1.0 | 989 | 64.4 | 0.2 | 0 |
| large result aggregate | code (arm D) | 3 | 100% (3/3) | 2.0 | 2.0 | 1.0 | 1026 | 80.1 | 0.3 | 0 |
| error recovery | code (arm A) | 3 | 0% (0/3) | 1.0 | 1.0 | 1.0 | 325 | 43.3 | 0.2 | 0 |
| error recovery | code (arm B) | 3 | 0% (0/3) | 2.0 | 2.0 | 1.0 | 693 | 41.0 | 0.2 | 0 |
| error recovery | code (arm C) | 3 | 0% (0/3) | 2.0 | 2.0 | 1.0 | 908 | 50.7 | 0.4 | 0 |
| error recovery | code (arm D) | 3 | 0% (0/3) | 2.0 | 2.0 | 1.0 | 930 | 29.1 | 0.2 | 0 |
| **all tasks** | code (arm A) | 15 | 33% (5/15) | 1.6 | 1.6 | 3.5 | 836* | 93.0 | 0.3 | 2 |
| **all tasks** | code (arm B) | 15 | 47% (7/15) | 1.5 | 1.5 | 3.6 | 681* | 78.5 | 0.3 | 1 |
| **all tasks** | code (arm C) | 15 | 27% (4/15) | 2.5 | 2.5 | 4.4 | 1588* | 144.5 | 0.5 | 4 |
| **all tasks** | code (arm D) | 15 | 60% (9/15) | 1.9 | 1.9 | 2.2 | 1005* | 122.9 | 0.6 | 2 |

`*` token counts include an estimate (characters / 4) because the backend did not report usage for every call.

Means are over all runs in the cell, failures included. "steps" is loop iterations, "model calls" is backend requests, "code exec s" is mean time inside the sandbox executor per run (tool time included).
