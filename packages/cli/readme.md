# @johnhenry/aimatey-cli

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Faimatey-cli.svg)](https://www.npmjs.com/package/@johnhenry/aimatey-cli)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Faimatey-cli.svg)](LICENSE)

> **Note:** Previously published as `aimatey-cli@0.2.3`.

Command-line interface and conversion utilities

Part of the [aimatey](https://github.com/johnhenry/aimatey) monorepo.

## Installation

```bash
npm install @johnhenry/aimatey-cli
```

## Exports

- `toOpenAIRequest`
- `toAnthropicRequest`
- `toOpenAI`
- `toAnthropic`

## Usage

```typescript
import { toOpenAIRequest, toAnthropicRequest, toOpenAI, toAnthropic } from '@johnhenry/aimatey-cli';
```

The exports above are the library surface (importable from
`@johnhenry/aimatey-cli`). This package also installs an `ai-matey`
binary with its own subcommands -- a proxy server and an Ollama CLI
emulator, in addition to the format converters -- documented below.

## API Reference

See the TypeScript definitions for detailed API documentation.

## CLI Usage

```bash
ai-matey <command> [options]
```

| Command | Purpose |
| --- | --- |
| `convert-response` | Convert Universal IR responses to provider formats (OpenAI, Anthropic, Gemini, Ollama, Mistral) |
| `convert-request` | Convert between Universal IR and provider request formats, bidirectionally |
| `create-backend` | Interactive wizard that generates a backend adapter template (OpenAI, Anthropic, Gemini, Groq, Together AI, and other OpenAI-compatible presets) |
| `proxy` | Start an HTTP proxy server that speaks a provider's wire format and routes through any backend adapter |
| `emulate-ollama` | Emulate the Ollama CLI (`run`/`pull`/`list`/`ps`/`show`) against any backend adapter |

Run `ai-matey <command> --help` for a command's full option list.

### Proxy server

`ai-matey proxy` starts a real Node HTTP server (`node:http`) that
accepts requests in a provider's wire format, converts them to Aimatey's
Universal IR, executes them against a loaded backend adapter, and
converts the response back to that provider's format -- including SSE
streaming and CORS/OPTIONS handling. This makes any backend adapter a
drop-in replacement for the OpenAI/Anthropic/Gemini/Ollama/Mistral HTTP
API shape.

```bash
ai-matey proxy --backend ./groq-backend.mjs --port 3000
```

```typescript
// Point any OpenAI-compatible client at it:
const openai = new OpenAI({ baseURL: 'http://localhost:3000', apiKey: 'any-value' });
```

Options:

- `--backend <path>` (required) -- backend adapter module to load (see `create-backend`)
- `--port <number>` -- default `3000`
- `--host <host>` -- default `localhost`
- `--format <format>` -- wire format to speak: `openai` (default), `anthropic`, `gemini`, `ollama`, `mistral`
- `--verbose`, `-v` -- log each request/response
- `--help`, `-h`

Request bodies are parsed per `--format` into IR (`src/proxy.ts`'s
`providerRequestToIR()`), executed via the backend's `execute()`/
`executeStream()`, and converted back out with the same
`toOpenAI`/`toAnthropic`/`toGemini`/`toOllama`/`toMistral` response
converters this package already exports as library functions -- the
proxy is those converters wired into a live server, not a separate code
path.

### Ollama emulation

`ai-matey emulate-ollama` reproduces the Ollama CLI's own subcommands
(`run`, `pull`, `list`, `ps`, `show`) against any Aimatey backend
adapter, so tools built against the Ollama CLI work unmodified with a
non-Ollama backend.

```bash
# Interactive chat against a backend, Ollama-style
ai-matey emulate-ollama --backend ./groq-backend.mjs run llama3.1

# Single prompt (also accepts piped stdin)
ai-matey emulate-ollama --backend ./groq-backend.mjs run llama3.1 "What is 2+2?"

# List / inspect / show models
ai-matey emulate-ollama --backend ./groq-backend.mjs list
ai-matey emulate-ollama --backend ./groq-backend.mjs ps
ai-matey emulate-ollama --backend ./groq-backend.mjs show llama3.1

# Download a real GGUF model from the Ollama registry (no backend needed)
ai-matey emulate-ollama pull phi3:3.8b --output ./models/phi3.gguf
```

`pull` is a real download against the Ollama model registry
(`src/ollama/commands/pull.ts`) and is the one subcommand that doesn't
need `--backend`; `run`/`list`/`ps`/`show` all load a backend adapter
(`src/utils/backend-loader.ts`) and dispatch to it. `--model-map
<path>` remaps model names through a JSON file (`src/utils/
model-translation.ts`) when your backend's model names don't match
Ollama's; `--json` emits machine-readable output; `--no-color`/
`--no-stream` adjust terminal output.

## License

MIT - see [LICENSE](./LICENSE) for details.
