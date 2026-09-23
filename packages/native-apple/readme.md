# @johnhenry/aimatey-native-apple

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Faimatey-native-apple.svg)](https://www.npmjs.com/package/@johnhenry/aimatey-native-apple)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Faimatey-native-apple.svg)](LICENSE)

> **Note:** Previously published as `aimatey-native.apple@0.2.1`.

Run Aimatey against Apple's on-device Foundation Models (Apple Intelligence) — no API key, no
network, no cost. Part of the [aimatey](https://github.com/johnhenry/aimatey) monorepo.

## Requirements

- macOS 26+ with Apple Intelligence enabled (System Settings → Apple
  Intelligence & Siri) -- the `FoundationModels` framework requires macOS
  26; earlier docs in this package said "macOS 15+ (Sequoia)", which was
  wrong (verified live against `apple-foundation-models` on macOS 27)
- Node.js 18+
- The optional native binding: `npm install apple-foundation-models`

## Installation

```bash
npm install @johnhenry/aimatey-native-apple apple-foundation-models
```

## Quick Start

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { AppleBackend } from '@johnhenry/aimatey-native-apple';

const backend = new AppleBackend({
  maximumResponseTokens: 2048,
  temperature: 0.7,
  samplingMode: 'default',
});

// Sessions are created lazily; initialize eagerly to surface platform errors early
await backend.initialize();

const bridge = new Bridge(new OpenAIFrontendAdapter(), backend);

const response = await bridge.chat({
  model: 'default', // model name is metadata only; the system model is used
  messages: [{ role: 'user', content: 'Summarize the plot of Moby Dick in two sentences.' }],
});

console.log(response.choices[0]?.message.content);
```

Streaming works like any other backend:

```typescript
for await (const chunk of bridge.chatStream({
  model: 'default',
  messages: [{ role: 'user', content: 'Write a haiku about tide pools.' }],
  stream: true,
})) {
  process.stdout.write(chunk.choices?.[0]?.delta?.content ?? '');
}
```

## With the CLI

Expose the on-device model as an OpenAI-compatible server or an Ollama-style CLI
(see [examples/cli/apple-backend.mjs](../../examples/cli/apple-backend.mjs)):

```bash
ai-matey proxy --backend ./apple-backend.mjs --port 3000
ai-matey emulate-ollama --backend ./apple-backend.mjs run default "Hello!"
```

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `maximumResponseTokens` | number | model default | Cap on generated tokens |
| `temperature` | number | model default | Sampling temperature |
| `samplingMode` | `'default' \| 'greedy'` | `'default'` | Token sampling mode |
| `instructions` | string | — | System-prompt-style session instructions |

## Behavior notes

- System messages are converted into session instructions.
- Unsupported platforms fail with a descriptive error from `initialize()` / first request —
  check `AppleBackend.isPlatformSupported()` to branch gracefully.
- Tool calling is not currently supported by the underlying framework.

## License

MIT - see [LICENSE](./LICENSE) for details.
