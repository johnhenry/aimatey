# @johnhenry/aimatey-native-node-llamacpp

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Faimatey-native-node-llamacpp.svg)](https://www.npmjs.com/package/@johnhenry/aimatey-native-node-llamacpp)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Faimatey-native-node-llamacpp.svg)](LICENSE)

> **Note:** Previously published as `aimatey-native.node-llamacpp@0.2.2`.

Run Aimatey against local GGUF models via [node-llama-cpp](https://github.com/withcatai/node-llama-cpp) —
fully offline, GPU-accelerated where available. Part of the
[aimatey](https://github.com/johnhenry/aimatey) monorepo.

## Requirements

- Node.js 18+
- The optional peer dependency: `npm install node-llama-cpp` (prebuilt binaries for most
  platforms; falls back to a local build, which needs a C++ toolchain)
- A GGUF model file (e.g. from [Hugging Face](https://huggingface.co/models?library=gguf))

## Installation

```bash
npm install @johnhenry/aimatey-native-node-llamacpp node-llama-cpp
```

## Quick Start

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { NodeLlamaCppBackend } from '@johnhenry/aimatey-native-node-llamacpp';

const backend = new NodeLlamaCppBackend({
  modelPath: '/models/llama-3.1-8b-instruct.Q4_K_M.gguf',
  contextSize: 8192,
  gpuLayers: 33,     // number of layers to offload to the GPU (0 = CPU only)
  threads: 8,
  temperature: 0.7,
});

const bridge = new Bridge(new OpenAIFrontendAdapter(), backend);

const response = await bridge.chat({
  model: 'llama-3.1-8b', // informational; the loaded GGUF decides
  messages: [{ role: 'user', content: 'Explain what a GGUF file is in one paragraph.' }],
});

console.log(response.choices[0]?.message.content);
```

## Configuration

| Option | Type | Description |
|---|---|---|
| `modelPath` | string | Path to the GGUF model file (required) |
| `contextSize` | number | Context window in tokens |
| `gpuLayers` | number | Layers offloaded to GPU (Metal/CUDA/Vulkan) |
| `threads` | number | CPU threads for inference |
| `batchSize` | number | Prompt evaluation batch size |
| `temperature`, `topP`, `topK` | number | Sampling parameters |

## Tips

- Quantized `Q4_K_M` models are a good speed/quality starting point.
- Watch memory: the model file size approximates RAM/VRAM needed.
- The first request loads the model; keep the backend instance alive between requests.

## License

MIT - see [LICENSE](./LICENSE) for details.
