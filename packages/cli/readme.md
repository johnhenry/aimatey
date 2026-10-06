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
| `proxy` | Start an HTTP proxy server that speaks a provider's wire format and routes through any backend adapter; also serves the typed-decision routes |
| `decide` | Ask typed questions (choice / score / noul) about a state through any decision backend |
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

A backend that can only `decide()` (Jev, Laya, Ollama's decision models)
is accepted too: it serves the decision routes below and answers chat
paths with a 404 naming the routes it does serve.

Request bodies are parsed per `--format` into IR (`src/proxy.ts`'s
`providerRequestToIR()`), executed via the backend's `execute()`/
`executeStream()`, and converted back out with the same
`toOpenAI`/`toAnthropic`/`toGemini`/`toOllama`/`toMistral` response
converters this package already exports as library functions -- the
proxy is those converters wired into a live server, not a separate code
path.

#### Decision routes

A POST to one of these paths is a typed-decision request, whatever
`--format` says. It goes to the backend's `decide()` when the backend
supports decisions (a backend with no `decide()` answers 404); every
other POST is the chat proxy described above.

| Path | Dialect | Notes |
| --- | --- | --- |
| `/v1/systemone`, `/typesafe/v1/systemone` | TypeSafe / Ollama | `images`, `keep_alive` accepted |
| `/v1/decisions`, `/api/alpha/decisions` | OpenRouter alpha | `provider`, `trace`, `session_id`, `user` accepted; response adds `id`, `provider`, `usage.cost` |
| `/v1/evaluate` | Vercel AI Gateway | `boolean` for `noul`; `probability` answers; camelCase usage; `providerMetadata.gateway.routing` |

```bash
curl -s localhost:3000/v1/systemone -H 'content-type: application/json' -d '{
  "model": "tev1:0.8b",
  "state": "I was charged twice, please refund me.",
  "questions": {
    "team": { "type": "choice", "instructions": "Which team?",
              "criteria": { "billing": "payments", "technical": "bugs" } },
    "urgent": { "type": "noul", "instructions": "Is this urgent?" }
  }
}'
```

The dialects come from the same table the backend adapters use for
their clients (`SYSTEMONE_DIALECTS` in `@johnhenry/aimatey-backend`),
applied in reverse by `src/decisions.ts`, which this package exports
(`wireToDecisionRequest`, `decisionResponseToWire`, `decisionErrorToWire`,
...). Errors use each dialect's envelope (`{ error: string }`,
`{ error: { code, message } }`, `{ error: { type, message } }`) with
400 for a malformed or invalid request, 404 for an unknown model or
route, 429, 502 for an upstream failure and 500 otherwise. When the
backend's response carries an escalation record (see
`createDecisionEscalation` in `@johnhenry/aimatey-patterns`), the
response also gets `x-aimatey-decision-fallback-*` headers and a
`provider_metadata.gateway.routing.modelAttempts` block. The proxy sets
no body size limit or auth of its own; for a fuller demo see
`examples/decisions/gateway`.

### Typed decisions: `decide`

`ai-matey decide` asks typed questions about a state through any backend
that implements `decide()` and prints the answers.

```bash
ai-matey decide --backend ollama --model tev1:0.8b \
  --state "I was charged twice, please refund me." \
  --question 'team:choice:"Who owns this?":billing=payments and refunds,technical=bugs and outages' \
  --question 'urgency:score:"How urgent is it?":low,medium,high' \
  --question 'refund:noul:"Is a refund requested?"'
```

```text
QUESTION  VALUE          PROBABILITY      CONFIDENCE
team      billing        █████████░ 98%   0.85
urgency   medium (1.33)  ████░░░░░░ 43%   0.11
refund    true           █████████░ 100%  -
model tev1:0.8b · 664 in · 4 out tokens
```

Options:

- `--backend <name|path>` -- `ollama` (`OLLAMA_URL`, or `--url`), `typesafe`
  (`TYPESAFE_API_KEY`), `openrouter` (`OPENROUTER_API_KEY`), `systemone`
  (`--url <base URL>`, `--dialect`, `SYSTEMONE_API_KEY`), or the path of a
  backend module, loaded the way `proxy` loads it
- `--model <model>` -- the decision model
- `--state <text|@file|-|json:...>` -- literal text; `@file` (a `.json` file
  is parsed, anything else is text); `-` reads stdin; `json:{"a":1}` is a
  JSON value
- `--question <spec>` -- repeatable; the grammar is below
- `--questions @file.json` -- questions as JSON,
  `{ "name": { "type": "choice", "instructions": "...", "criteria": { ... } } }`;
  merges with `--question` (a name defined twice is an error)
- `--image <path>` -- repeatable; png, jpg, gif or webp, sent as base64
- `--json` -- print the raw IR response instead of the table
- `--batch @file.jsonl` -- one state per line, answered with
  `Bridge.decideBatch`; a line is JSON (`{"state": ...}` is unwrapped) or,
  if it is not JSON, plain text. Progress goes to stderr; with `--json`
  each line of output is one response. Failed lines are reported and do
  not stop the rest
- `--concurrency <n>`, `--timeout <seconds>`

**`--question` grammar**

```text
name:type:"instructions"[:options]
```

| Type | Options (after the third `:`) | Example |
| --- | --- | --- |
| `choice` | `option=description` pairs, comma-separated, at least 2; a bare `option` describes itself | `team:choice:"Who owns this?":billing=invoices,tech=bugs` |
| `score` | level labels, comma-separated, lowest first, at least 2 | `urgency:score:"How urgent?":low,medium,high` |
| `noul` | none, or `true=<label>,false=<label>` (both) | `spam:noul:"Is this spam?":true=unsolicited,false=wanted` |

`name` is letters, digits, `_ . -`, not starting with a digit.
`boolean` is accepted as an alias of `noul`. Quote the instructions with
`"..."` to put a `:` in them (`\"` for a quote inside); unquoted
instructions work when they contain no `:`. Wrap an option description in
`"..."` to put a `,` in it. Everything after the third `:` is the options
text, so an unquoted description may contain `:`.

In the table, the probability bar is P(chosen option), the chosen level's
probability for a score, and P(true) for a `noul`; `-` means the backend
reported none. Exit codes: `0` success, `1` usage error or backend
failure, `2` a `ValidationError` (the request or an answer failed
validation; in batch mode, if any line did).

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

With a decision model (`nimble`, `tev1`, `kev`, ... on a backend that can
`decide()`), `run` does not chat: each prompt becomes a single `noul`
question, "Is the following true? <prompt>", answered as `true`/`false`
with P(true). `--state <text>` supplies what the prompt is judged against
(default: the prompt itself); in interactive mode `run` asks for the state
first. Chat models and chat-only backends behave exactly as before.

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
