# @johnhenry/aimatey-core

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Faimatey-core.svg)](https://www.npmjs.com/package/@johnhenry/aimatey-core)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Faimatey-core.svg)](LICENSE)

> **Note:** Previously published as `aimatey-core@0.3.4`.

Core Bridge, Router, and MiddlewareStack implementations

Part of the [aimatey](https://github.com/johnhenry/aimatey) monorepo.

## Installation

```bash
npm install @johnhenry/aimatey-core
```

## Exports

- `Bridge`
- `createBridge`
- `Router`
- `createRouter`
- `MiddlewareStack`
- `createMiddlewareContext`
- `createRunTools`, `RunToolsBridge` (type)

## Usage

```typescript
import { Bridge, createBridge, Router, createRouter, MiddlewareStack, createMiddlewareContext } from '@johnhenry/aimatey-core';
```

## Structured Output

`Bridge.chat()`/`chatStream()` accept a `responseFormat` field on the request for
schema-constrained JSON output - see [`docs/IR-FORMAT.md`](../../docs/IR-FORMAT.md#structured-output)
for the per-backend support matrix.

## Agentic Tool Calling

Every `Bridge` instance exposes `bridge.runTools(options)` (built from `createRunTools`) - an
execute → extract tool calls → run them → append results → re-execute loop that continues until
the model answers or `maxIterations` is reached:

```typescript
const result = await bridge.runTools({
  prompt: 'What is 12 * 47?',
  tools: {
    multiply: {
      description: 'Multiply two numbers',
      parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
      execute: ({ a, b }) => a * b,
    },
  },
});
```

### Gating tool calls with a decision model

`runTools` takes an optional `gate` that is asked about every tool call before it runs (after the
tool is found and its arguments validate). It returns `{ action: 'allow' }`, `{ action: 'deny', reason? }`
or `{ action: 'review', reason? }`:

- `allow` runs the tool.
- `deny` does not run it; `"Tool call denied: <reason>"` goes back to the model as an error tool
  result, so the loop carries on and the model can try something else.
- `review` is "not sure". By default it behaves like `deny` with a distinct message
  (`"Tool call requires human review and was not run"`) and calls `onReview(event)`; return
  `{ action: 'allow' }` (or `'deny'`) from `onReview` to wire in a human approver.
- `maxDenials` ends the loop once that many calls were stopped, with `status: 'max-denials'` on the
  result (instead of an error). `result.denials` lists every stopped call. A gate that throws denies
  the call (fail closed).

`createDecisionGate(backend, config?)` builds a gate from a typed-decision model: one cheap forward
pass asks "is this tool call safe and consistent with the user's request?" (state: tool name, input,
last user message) and maps P(true) to a verdict -- at or above `policy.allowAbove` (0.8) allow, at or
below `policy.denyBelow` (0.3) deny, otherwise review. The decision response is attached to the verdict
(and to `result.denials[i].response`) for auditing. `questions` and `stateBuilder` override the default
question and state; with several `noul` questions the lowest P(true) decides.

```typescript
import { createDecisionGate } from '@johnhenry/aimatey-core';

const result = await bridge.runTools({
  prompt: 'Clean up my temp folder',
  tools,
  gate: createDecisionGate(decisionBackend, { policy: { allowAbove: 0.9, denyBelow: 0.2 } }),
  onReview: (event) => askHuman(event), // optionally return { action: 'allow' }
  maxDenials: 3,
});
result.status; // 'completed' | 'max-denials'
result.denials; // what was stopped, and why
```

The gate calls the backend directly, so decision middleware registered on a `Bridge` does not run
for it. Probabilities from a small model are only as good as its calibration; treat the gate as a
filter in front of, not a replacement for, real permissions.

### A decision model as a tool

`createDecisionTool(backend, questions, { name?, description? })` exposes a decision model to a chat
agent as a `ToolDefinition` (input `{ state }`, output `{ answers, model }` with each answer's value,
probabilities and confidence), so the agent can consult it mid-loop. Register it under `tool.name`
(default `consult_decision_model`):

```typescript
const triage = createDecisionTool(decisionBackend, {
  urgent: { type: 'noul', instructions: 'Is this urgent?' },
});
await bridge.runTools({ prompt, tools: { [triage.name]: triage } });
```

For MCP (Model Context Protocol) tools specifically, see
[`@johnhenry/aimatey-mcp`](../mcp/readme.md), which translates MCP tools into the same `ToolDefinition`
shape this loop consumes.

## Typed Decisions

`Bridge.decide(state, questions, options?)` asks typed questions (`choice`, `score`, `noul`) of a
state in one call and returns typed answers (see `IRDecisionRequest` in `@johnhenry/aimatey-types`).
The backend only needs `decide()` -- it need not support chat.

```typescript
const response = await bridge.decide(
  { subject: 'Charged twice', body: 'Refund me today.' },
  {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: { opt_1: 'billing: invoices, refunds', opt_2: 'technical: bugs, outages' },
    },
    refund: { type: 'noul', instructions: 'Does the user ask for a refund?' },
  }
);
response.answers.department; // { type: 'choice', value: 'opt_1', ... }
```

Every call is checked on the way in and out: `validateDecisionRequest` (from
`@johnhenry/aimatey-utils`) runs against the backend's capabilities before the middleware chain
(throws `ValidationError` for e.g. an unsupported question type, too many options, images the backend
cannot take), and `validateDecisionResponse` checks the answers. Soft findings -- polar-word choice
keys (`yes`/`no`), very long instructions, non-Latin text for an English-only model, malformed
probabilities -- come back in `response.metadata.warnings`. Register decision middleware with
`bridge.useDecision()`.

- `bridge.decideFrom(request, options?)` takes a request in the *frontend's* format (e.g. the
  TypeSafe or Laya frontend adapters) and returns the same shape.
- `bridge.decideBatch(states, questions, options?)` answers the same questions for many states, in
  input order, with bounded concurrency (`concurrency`, default: the backend's
  `decisionLimits.maxConcurrency`, else 4). `onProgress(done, total)` reports progress; `onError`
  is `'throw'` (default: first failure rejects and aborts the rest) or `'collect'` (returns a
  `PromiseSettledResult` per state).

```typescript
const results = await bridge.decideBatch(tickets, questions, {
  concurrency: 8,
  onError: 'collect',
});
```

`router.decide(request, signal?)` works like `router.embed()`: it tries decision-capable backends
in fallback-chain order with circuit breaking, skipping any whose `decisionTypes`,
`decisionLimits` or `decisionImages` cannot serve the request (reported through `onWarning`), and
treats `request.parameters.model` as a hint against each backend's `decisionModels`. A `Router`
can be the backend of a `Bridge`, so `new Bridge(frontend, router).decide(...)` routes too. Chat
routing never selects a backend that has no chat support.

## API Reference

See the TypeScript definitions for detailed API documentation.

## License

MIT - see [LICENSE](./LICENSE) for details.
