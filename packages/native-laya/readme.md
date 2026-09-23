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

const response = await bridge.decide(
  { headline: 'Local sea levels rising faster than predicted' },
  { urgency: { type: 'score', instructions: 'How urgent is this?', criteria: ['low', 'medium', 'high'] } }
);

await backend.close();
```

## License

MIT - see [LICENSE](./LICENSE) for details.
