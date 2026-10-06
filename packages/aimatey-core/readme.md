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
