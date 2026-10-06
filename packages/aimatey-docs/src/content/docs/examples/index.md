---
title: "Examples Overview"
description: "Catalog of runnable aimatey examples, organized from beginner basics to advanced production patterns."
---

Explore **35+ runnable examples** demonstrating every feature of aimatey, organized by complexity from beginner to advanced.

## 🎯 Quick Navigation

### By Skill Level

- **⭐ Beginner** → [01. Basics](#01-basics) | [02. Providers](#02-providers)
- **⭐⭐ Intermediate** → [03. Middleware](#03-middleware) | [04. Routing](#04-routing) | [05. HTTP Servers](#05-http-servers) | [06. SDK Wrappers](#06-sdk-wrappers)
- **⭐⭐⭐ Advanced** → [07. Advanced Patterns](#07-advanced-patterns) | [08. Observability](#08-observability)
- **🎯 Specialized** → [09. React](#09-react) | [10. CLI Tools](#10-cli-tools) | [11. Typed Decisions](#11-typed-decisions)

### By Feature

- **Getting Started** → [Basics](#01-basics)
- **Multiple Providers** → [Providers](#02-providers) | [Routing](#04-routing)
- **Performance** → [Middleware](#03-middleware)
- **Production** → [Advanced Patterns](#07-advanced-patterns)
- **Monitoring** → [Observability](#08-observability)

## 📂 All Examples

### 01. Basics

**Complexity:** ⭐ Beginner
**Time to complete:** 5-10 minutes each

Learn the fundamentals of aimatey with these simple examples.

| Example | Description | Key Concepts |
|---------|-------------|--------------|
| [01-hello-world](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/01-basics/01-hello-world.ts) | Your first bridge | Bridge, Frontend, Backend |
| [02-streaming](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/01-basics/02-streaming.ts) | Real-time responses | Streaming, Async generators |
| [03-error-handling](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/01-basics/03-error-handling.ts) | Handle errors gracefully | Error handling, Validation |
| [04-reverse-bridge](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/01-basics/04-reverse-bridge.ts) | Swap frontend/backend | Adapter flexibility |

**Start here if:** You're new to aimatey or want to understand core concepts.

---

### 02. Providers

**Complexity:** ⭐ Beginner
**Time to complete:** 5-10 minutes each

Work with different AI providers.

| Example | Description | Provider |
|---------|-------------|----------|
| [01-anthropic](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/02-providers/01-anthropic.ts) | Anthropic Claude | Anthropic (Claude 3.5) |
| [02-openai](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/02-providers/02-openai.ts) | OpenAI integration | OpenAI (GPT-4, GPT-3.5) |
| [03-google-gemini](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/02-providers/03-google-gemini.ts) | Google Gemini | Google (Gemini 1.5) |
| [04-local-models](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/02-providers/04-local-models.ts) | Local models | Ollama, LMStudio |
| [05-multiple-providers](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/02-providers/05-multiple-providers.ts) | Multiple providers | Router pattern |
| [06-provider-switching](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/02-providers/06-provider-switching.ts) | Switch providers at runtime | Any provider |

**Start here if:** You want to understand provider-specific features.

---

### 03. Middleware

**Complexity:** ⭐⭐ Intermediate
**Time to complete:** 10-15 minutes each

Add powerful middleware to your pipelines.

| Example | Description | Performance |
|---------|-------------|-------------|
| [01-logging](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/03-middleware/01-logging.ts) | Request/response logging | - |
| [02-caching](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/03-middleware/02-caching.ts) | Response caching | 1000x+ speedup |
| [03-retry](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/03-middleware/03-retry.ts) | Auto retry on failure | Improved reliability |
| [04-transform](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/03-middleware/04-transform.ts) | Modify requests/responses | Custom behavior |
| [05-cost-tracking](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/03-middleware/05-cost-tracking.ts) | Track API costs | Cost visibility |
| [06-middleware-stack](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/03-middleware/06-middleware-stack.ts) | Compose middleware | &lt;10ms overhead |

**Start here if:** You need logging, caching, retry, or cost tracking.

---

### 04. Routing

**Complexity:** ⭐⭐ Intermediate
**Time to complete:** 15-20 minutes each

Intelligently route requests across providers.

| Example | Description | Use Case |
|---------|-------------|----------|
| [01-round-robin](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/04-routing/01-round-robin.ts) | Load balancing | Distribute load |
| [02-fallback](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/04-routing/02-fallback.ts) | Automatic failover | High availability |
| [03-weighted-routing](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/04-routing/03-weighted-routing.ts) | Weighted load distribution | Gradual rollouts |
| [04-cost-based-routing](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/04-routing/04-cost-based-routing.ts) | Choose cheapest provider | Cost optimization |
| [05-custom-strategy](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/04-routing/05-custom-strategy.ts) | Build your own routing logic | Custom strategies |

**Start here if:** You need multi-provider routing or failover.

---

### 05. HTTP Servers

**Complexity:** ⭐⭐ Intermediate
**Time to complete:** 15-20 minutes each

Integrate with web frameworks.

| Example | Description | Framework |
|---------|-------------|-----------|
| [01-express](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/05-http-servers/01-express.ts) | Express.js integration | Express |
| [02-hono](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/05-http-servers/02-hono.ts) | Edge-ready server | Hono |
| [03-node-http](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/05-http-servers/03-node-http.ts) | Native Node.js HTTP | Node.js http |
| [websocket-server](https://github.com/johnhenry/aimatey/tree/main/examples/http/websocket-server.ts) | WebSocket streaming chat | WebSockets |

**Start here if:** You're building an HTTP API.

---

### 06. SDK Wrappers

**Complexity:** ⭐⭐ Intermediate
**Time to complete:** 10-15 minutes each

Drop-in replacements for official SDKs.

| Example | Description | Compatibility |
|---------|-------------|---------------|
| [01-openai-sdk](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/06-sdk-wrappers/01-openai-sdk.ts) | OpenAI SDK wrapper | 100% compatible |
| [02-anthropic-sdk](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/06-sdk-wrappers/02-anthropic-sdk.ts) | Anthropic SDK wrapper | 100% compatible |
| [chrome-ai-wrapper](https://github.com/johnhenry/aimatey/tree/main/examples/chrome-ai-wrapper.js) | Chrome AI compatibility | Chrome AI API |

**Start here if:** You want SDK compatibility.

---

### 07. Advanced Patterns

**Complexity:** ⭐⭐⭐ Advanced
**Time to complete:** 20-30 minutes each

Production-ready patterns for real-world applications.

| Example | Description | Performance |
|---------|-------------|-------------|
| [01-streaming-aggregation](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/07-advanced-patterns/01-streaming-aggregation.ts) | Parallel streaming | Real-time comparison |
| [02-observability](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/07-advanced-patterns/02-observability.ts) | Metrics and tracing | Production monitoring |
| [03-testing](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/07-advanced-patterns/03-testing.ts) | Testing AI integrations | Mock adapters |
| [04-cli-tool](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/07-advanced-patterns/04-cli-tool.ts) | Build a CLI tool | Command-line apps |
| [05-react-integration](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/07-advanced-patterns/05-react-integration.ts) | React patterns | Hooks, streaming UI |
| [06-performance](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/07-advanced-patterns/06-performance.ts) | Performance tuning | Benchmarks |
| [07-production](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/07-advanced-patterns/07-production.ts) | Production deployment | Best practices |
| [08-edge-deployment](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/07-advanced-patterns/08-edge-deployment.ts) | Edge deployment | Workers, Deno |

**Start here if:** You're building production systems.

---

### 08. Observability

**Complexity:** ⭐⭐⭐ Advanced
**Time to complete:** 20-30 minutes each

Monitor and trace your AI requests.

| Example | Description | Platform |
|---------|-------------|----------|
| [basic-jaeger](https://github.com/johnhenry/aimatey/tree/main/examples/opentelemetry/basic-jaeger.ts) | OpenTelemetry + Jaeger | Local (Docker) |
| [honeycomb](https://github.com/johnhenry/aimatey/tree/main/examples/opentelemetry/honeycomb.ts) | Honeycomb integration | SaaS |
| [sampling](https://github.com/johnhenry/aimatey/tree/main/examples/opentelemetry/sampling.ts) | Sampling strategies | Configurable |
| [multi-provider](https://github.com/johnhenry/aimatey/tree/main/examples/opentelemetry/multi-provider.ts) | Multi-provider tracing | All providers |

**Start here if:** You need monitoring and observability.

---

### 09. React

**Complexity:** 🎯 Specialized
**Time to complete:** 15-20 minutes

Frontend integration with React.

| Example | Description | Hooks |
|---------|-------------|-------|
| [react-hooks](https://github.com/johnhenry/aimatey/tree/main/examples/monorepo/07-react-hooks.tsx) | React hooks | useChat, useCompletion, useObject |
| [05-react-integration](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/07-advanced-patterns/05-react-integration.ts) | React integration patterns | Custom hooks, streaming |

**Start here if:** You're building React applications.

---

### 10. CLI Tools

**Complexity:** 🎯 Specialized
**Time to complete:** 10-15 minutes

Command-line utilities.

| Example | Description | Tools |
|---------|-------------|-------|
| [04-cli-tool](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/07-advanced-patterns/04-cli-tool.ts) | CLI tools | Format conversion, interactive prompts |

**Start here if:** You need CLI tooling.

---

### 11. Typed Decisions

**Complexity:** ⭐⭐⭐ Advanced
**Requires:** Node.js; Ollama 0.35 or newer for the live runs

Decision models answer typed questions instead of generating text. See the [Decisions guide](/guides/decisions/).

| Example | Description | Key Concepts |
|---------|-------------|--------------|
| [decisions/gateway](https://github.com/johnhenry/aimatey/tree/main/examples/decisions/gateway) | A demo gateway serving `/v1/systemone`, `/v1/decisions` and `/v1/evaluate` over one Bridge and Router | Router.decide, decision middleware, escalation |
| [decisions/bench](https://github.com/johnhenry/aimatey/tree/main/examples/decisions/bench) | Benchmark harness: accuracy, Brier, ECE, latency and cost per backend | calibrationReport, nameInvariance, neutral keys |
| [laya/triage-demo.ts](https://github.com/johnhenry/aimatey/tree/main/examples/laya/triage-demo.ts) | Support-ticket triage on Laya, on-device | Bridge.decide, native-laya |
| [laya/gui-demo](https://github.com/johnhenry/aimatey/tree/main/examples/laya/gui-demo) | The same triage behind a server and a browser dashboard | decideBatch, dynamic questions |

## 🚀 Running Examples

### Prerequisites

```bash
# Install dependencies
cd /path/to/aimatey
npm install
npm run build

# Set up API keys (create .env file)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=...
```

### Run Any Example

```bash
npx tsx packages/aimatey-docs/examples/01-basics/01-hello-world.ts
npx tsx packages/aimatey-docs/examples/03-middleware/01-logging.ts
npx tsx packages/aimatey-docs/examples/07-advanced-patterns/01-streaming-aggregation.ts
```

## 📚 Learning Paths

### Beginner Path (Recommended for Newcomers)
1. [01-basics/01-hello-world](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/01-basics/01-hello-world.ts)
2. [01-basics/02-streaming](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/01-basics/02-streaming.ts)
3. [02-providers/02-openai](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/02-providers/02-openai.ts)
4. [02-providers/05-multiple-providers](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/02-providers/05-multiple-providers.ts)

### Intermediate Path
1. [03-middleware/01-logging](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/03-middleware/01-logging.ts)
2. [03-middleware/02-caching](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/03-middleware/02-caching.ts)
3. [04-routing/01-round-robin](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/04-routing/01-round-robin.ts)
4. [05-http-servers/01-express](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/05-http-servers/01-express.ts)

### Advanced Path
1. [04-routing/04-cost-based-routing](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/04-routing/04-cost-based-routing.ts)
2. [07-advanced-patterns/01-streaming-aggregation](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/07-advanced-patterns/01-streaming-aggregation.ts)
3. [07-advanced-patterns/07-production](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/07-advanced-patterns/07-production.ts)
4. [opentelemetry/basic-jaeger](https://github.com/johnhenry/aimatey/tree/main/examples/opentelemetry/basic-jaeger.ts)

## 💡 Tips

- **Start Simple**: Begin with `01-hello-world` to understand the basics
- **Read Comments**: Every example has detailed inline comments
- **Experiment**: Modify examples to learn how they work
- **Use Shared Utils**: The `_shared/` directory has helpful utilities
- **Check Prerequisites**: Each example lists what you need to run it

## 🔗 Related Resources

- **[Getting Started](/getting-started/installation)** - Installation and setup
- **[API Reference](/api)** - Complete API documentation
- **[IR Format Guide](/guides/architecture/ir-format)** - In-depth guides
- **[Patterns](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/07-advanced-patterns)** - Production patterns

---

**Ready to start?** Jump to [Hello World](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/01-basics/01-hello-world.ts) or explore examples by category above!
