# @johnhenry/aimatey-native-onnx

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Faimatey-native-onnx.svg)](https://www.npmjs.com/package/@johnhenry/aimatey-native-onnx)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Faimatey-native-onnx.svg)](LICENSE)

Shared `onnxruntime-node` integration layer for Aimatey's native backends: a
common execution-provider/session/cache config shape, a lazy-load helper for
the optional native binding, and consistent error mapping. Not a backend
itself -- [`@johnhenry/aimatey-native-laya`](../native-laya) is the first
consumer, built on top of it.

Part of the [aimatey](https://github.com/johnhenry/aimatey) monorepo.

## Node only

`onnxruntime-node` is native bindings and cannot run in a browser. A
browser-capable ONNX backend needs `onnxruntime-web` instead (WASM/WebGPU, a
genuinely different runtime and API) -- that would be a separate package,
mirroring how `packages/backend`/`packages/backend-browser` are two packages
rather than one with a flag.

## Installation

```bash
npm install @johnhenry/aimatey-native-onnx onnxruntime-node
```

## Usage

```typescript
import { loadOnnxRuntime, toOnnxProviderError, type OnnxRuntimeConfig } from '@johnhenry/aimatey-native-onnx';

const config: OnnxRuntimeConfig = {
  executionProviders: ['cpu'],
  cacheDir: './.cache/onnx',
};

const ort = await loadOnnxRuntime();
```

## License

MIT - see [LICENSE](./LICENSE) for details.
