---
"@johnhenry/aimatey-core": minor
---

`Bridge.runTools` gains tool-call gating: a `gate` option (`{ action: 'allow' | 'deny' | 'review' }` per call), `onReview` for human-in-the-loop approval and `maxDenials` to end the loop with `status: 'max-denials'`. The result now carries `status` and `denials`. New `createDecisionGate(backend, config?)` approves, denies or flags tool calls from a decision model's P(true) (default thresholds 0.8 / 0.3, with the decision response attached for auditing), and `createDecisionTool(backend, questions)` exposes a decision model to a chat agent as a `ToolDefinition`.
