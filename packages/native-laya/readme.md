# @johnhenry/aimatey-native-laya

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Faimatey-native-laya.svg)](https://www.npmjs.com/package/@johnhenry/aimatey-native-laya)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Faimatey-native-laya.svg)](LICENSE)

Run Aimatey typed-decision requests against ConvAI's Laya model on-device, via
[`@receptron/laya`](https://github.com/receptron/laya) -- a real TypeScript/
ONNX Runtime port, not a hosted-API wrapper. No network call, no API key.

Part of the [aimatey](https://github.com/johnhenry/aimatey) monorepo.

## Requirements

- Node.js 18+ (this package: Node 26+)
- The optional native binding: `npm install @receptron/laya`
- ~1.7GB of ONNX weights, downloaded from HuggingFace on first use and cached
  locally (`cacheDir`, or `@receptron/laya`'s own `LAYA_CACHE` default)

## Installation

```bash
npm install @johnhenry/aimatey-native-laya @receptron/laya
```

## Quick Start

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import { LayaFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { LayaBackendAdapter } from '@johnhenry/aimatey-native-laya';

const backend = new LayaBackendAdapter();

// Sessions are loaded lazily on first decide(); initialize eagerly to
// surface a missing-dependency or download failure early.
await backend.initialize();

const bridge = new Bridge(new LayaFrontendAdapter(), backend);

// IR in, IR out. The frontend is not involved.
const response = await bridge.decide(
  { headline: 'Local sea levels rising faster than predicted' },
  { urgency: { type: 'score', instructions: 'How urgent is this?', criteria: ['low', 'medium', 'high'] } }
);

// Laya's own request/response shapes in and out, via the frontend adapter.
const native = await bridge.decideFrom({
  state: { headline: 'Local sea levels rising faster than predicted' },
  questions: { urgency: { type: 'score', instructions: 'How urgent is this?', criteria: ['low', 'medium', 'high'] } },
});

await backend.close();
```

## What the adapter declares

- `decisionModels`: `english`, `multilingual`, `typed-decisions`
- `decisionTypes`: `choice`, `score`, `noul`
- `decisionLimits`: 20 choice options (Laya is weak beyond that), 10 score
  levels, 512 state tokens (the English checkpoint; multilingual allows 1024),
  no images (`decisionImages: false`; images are dropped with a
  `capability-unsupported` warning)

## Behaviour notes

- `decide(request, signal)` honours `signal` before loading, before running,
  and once the result arrives. An in-flight ONNX run cannot be cancelled.
- The checkpoint is chosen when the session loads (`subfolder`), and
  `@receptron/laya`'s `systemOne()` takes no `task`/`lang`. A
  `parameters.model` that differs from `subfolder`, and
  `parameters.custom.task`/`lang`, are reported as `parameter-unsupported`
  warnings on `response.metadata.warnings` rather than ignored silently.
- Laya's per-answer `rl_agent` sub-object is kept under
  `response.raw.rl_agent`, keyed by question. Convai measured its
  `act_probability` as uninformative, so treat it as diagnostic.
- Laya reports no `confidence` for `noul` answers; the adapter derives
  `max(p, 1 - p)`.

## License

MIT - see [LICENSE](./LICENSE) for details.
