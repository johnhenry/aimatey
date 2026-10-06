# aimatey Examples

Complete working examples demonstrating different features of aimatey.

**For comprehensive documentation of all examples, see [EXAMPLES.md](../EXAMPLES.md) in the project root.**

## Quick Start

```bash
# Install dependencies
npm install
npm run build

# Run any example with tsx
npx tsx examples/basic/simple-bridge.ts

# Set API keys first
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
export GEMINI_API_KEY="AIza..."
```

## Example Categories

### Basic Usage
- `basic/simple-bridge.ts` - Simplest possible example
- `basic/streaming.ts` - Streaming responses
- `basic/reverse-bridge.ts` - Swap frontend/backend

### Middleware
- `middleware/logging.ts` - Request/response logging
- `middleware/retry.ts` - Automatic retry with backoff
- `middleware/caching.ts` - Response caching
- `middleware/transform.ts` - Request/response transformation
- `middleware-demo.ts` - Complete middleware chaining demo

### Routing
- `routing/round-robin.ts` - Load balancing across backends
- `routing/fallback.ts` - Automatic failover

### HTTP Servers
- `http/node-server.ts` - Node.js http server
- `http/express-server.ts` - Express integration
- `http/hono-server.ts` - Hono integration

### SDK Wrappers
- `wrappers/openai-sdk.ts` - OpenAI SDK drop-in replacement
- `wrappers/anthropic-sdk.ts` - Anthropic SDK drop-in replacement

### Browser APIs
- `chrome-ai-wrapper.js` - Chrome AI API compatibility
- `chrome-ai-legacy-wrapper.js` - Legacy Chrome AI API

### Model Runners (Node.js Only)
- `model-runner-llamacpp.ts` - Run local GGUF models via llama.cpp

### Typed Decisions (Node.js Only)
- `laya/triage-demo.ts` - Support-ticket triage using Laya's on-device typed-decision model (`Bridge.decide()`, not chat)
- `laya/gui-demo/` - Same triage capability behind a persistent server + browser dashboard (`server.ts`, plain HTML/CSS/JS in `public/`, no build step) -- see `laya/gui-demo/readme.md`
- `decisions/gateway/` - A demo decision gateway: `/v1/systemone` (TypeSafe/Ollama), `/v1/decisions` (OpenRouter) and `/v1/evaluate` (Vercel) in front of one `Bridge` + `Router`, with caching, cost tracking, logging, validation and confidence-based escalation to an LLM fallback (`npx tsx examples/decisions/gateway/server.ts`) -- see `decisions/gateway/readme.md`
- `decisions/bench/` - Benchmark harness: a 40-item built-in triage set (or the public Typed Decisions / Decision Index data) run across Ollama, TypeSafe, OpenRouter, Cloudflare, any System One server, an LLM-emulated backend or Laya, reporting accuracy per question type, Brier, ECE, p50/p95 latency, cost and optional name-invariance flip rate (`npx tsx examples/decisions/bench/bench.ts --backend ollama --limit 10`) -- see `decisions/bench/readme.md`

## Documentation

See [EXAMPLES.md](../EXAMPLES.md) for:
- Complete code examples
- Usage instructions
- Configuration details
- Browser compatibility guide
- Troubleshooting tips

## Need Help?

- **Full Examples**: [EXAMPLES.md](../EXAMPLES.md)
- **API Reference**: [docs/api.md](../docs/api.md)
- **Feature Guides**: [docs/GUIDES.md](../docs/GUIDES.md)
- **Issues**: [GitHub Issues](https://github.com/johnhenry/aimatey/issues)
