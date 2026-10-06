# Feature Guides

Comprehensive guides for advanced aimatey features.

## Table of Contents

- [Parallel Dispatch](#parallel-dispatch)
- [Response Conversion](#response-conversion)
- [CLI Tools](#cli-tools)
- [Typed Decisions](#typed-decisions)

---

## Parallel Dispatch

The Router's `dispatchParallel()` method allows you to query multiple AI backends simultaneously and get all responses as an array. This is perfect for model comparison, A/B testing, consensus voting, and low-latency failover.

### Overview

**Key Benefits:**
- **Model comparison** - See how different models answer the same question
- **A/B testing** - Test different models or configurations
- **Consensus/voting** - Get multiple opinions and aggregate
- **Fallback strategies** - Use fastest response, others as backup
- **Low latency** - Parallel execution is 60%+ faster than sequential

### Quick Start

```typescript
import { createRouter } from '@johnhenry/aimatey-core';

const router = createRouter()
  .register('openai', openaiBackend)
  .register('anthropic', anthropicBackend)
  .register('gemini', geminiBackend);

// Get responses from ALL backends in parallel
const result = await router.dispatchParallel(request, {
  strategy: 'all',
  backends: ['openai', 'anthropic', 'gemini']
});

// Access all responses
result.allResponses.forEach(({ backend, response, latencyMs }) => {
  console.log(`${backend}: ${response.message.content} (${latencyMs}ms)`);
});
```

### Strategies

#### 1. ALL - Get Every Response

Get responses from all backends as an array.

```typescript
const result = await router.dispatchParallel(request, {
  strategy: 'all',
  backends: ['openai', 'anthropic', 'gemini']
});

// Result structure:
{
  response: IRChatResponse,           // Primary (first successful)
  allResponses: [                      // ALL responses!
    { backend: 'openai', response: {...}, latencyMs: 123 },
    { backend: 'anthropic', response: {...}, latencyMs: 156 },
    { backend: 'gemini', response: {...}, latencyMs: 89 }
  ],
  successfulBackends: ['openai', 'anthropic', 'gemini'],
  failedBackends: [],
  totalTimeMs: 156  // Time to get all responses (not sum!)
}
```

**Use cases:**
- Show user multiple model outputs
- Compare model quality
- A/B testing
- Consensus voting

#### 2. FIRST - Fastest Wins

Return the first successful response, cancel others.

```typescript
const result = await router.dispatchParallel(request, {
  strategy: 'first',
  backends: ['fast-model', 'slow-model'],
  cancelOnFirstSuccess: true  // Cancel slower request (save $$)
});

// Gets fastest response, cancels the rest
console.log(`Winner: ${result.successfulBackends[0]}`);
```

**Use cases:**
- Low latency requirements
- Don't care which model responds
- Cost optimization (cancel expensive slow requests)

#### 3. FASTEST - Race with Timeout

Return fastest response with a time limit.

```typescript
const result = await router.dispatchParallel(request, {
  strategy: 'fastest',
  backends: ['model-1', 'model-2', 'model-3'],
  timeout: 5000  // 5 second maximum
});
```

**Use cases:**
- SLA requirements
- User-facing applications
- Time-bounded queries

#### 4. CUSTOM - Your Aggregation Logic

Combine responses however you want.

```typescript
const result = await router.dispatchParallel(request, {
  strategy: 'custom',
  backends: ['model-1', 'model-2', 'model-3'],
  customAggregator: (responses) => {
    // Combine all responses into one message
    const combined = responses.map(({ backend, response }) => ({
      type: 'text',
      text: `[${backend}]: ${response.message.content}`
    }));

    return {
      ...responses[0].response,
      message: {
        role: 'assistant',
        content: combined
      }
    };
  }
});
```

**Use cases:**
- Consensus voting (pick most common answer)
- Merge content from multiple models
- Custom ranking/scoring
- Aggregate fact-checking

### Response Format

Every backend in `allResponses` gets its own entry:

```typescript
interface BackendResponse {
  backend: string;           // Backend name ('openai', 'anthropic', etc.)
  response: IRChatResponse;  // Full IR response from this backend
  latencyMs: number;         // How long this backend took
}
```

### Creating Message Arrays for UI

Perfect for displaying multiple model responses in a chat UI:

```typescript
const result = await router.dispatchParallel(request, {
  strategy: 'all',
  backends: ['gpt-4', 'claude-3', 'gemini-pro']
});

// Create array of messages for UI
const messages = result.allResponses.map(({ backend, response, latencyMs }) => ({
  id: crypto.randomUUID(),
  model: backend,
  content: response.message.content,
  role: response.message.role,
  latencyMs,
  timestamp: Date.now(),
}));

// Display in UI
messages.forEach(msg => {
  addChatMessage({
    avatar: getModelAvatar(msg.model),
    name: msg.model,
    text: msg.content,
    metadata: `${msg.latencyMs}ms`
  });
});
```

### Performance Comparison

**Sequential Execution:**
```
Backend A: 200ms
Backend B: 300ms  (wait for A)
Backend C: 250ms  (wait for A + B)
Total: 750ms ❌
```

**Parallel Execution:**
```
Backend A: 200ms ┐
Backend B: 300ms ├─ All running simultaneously
Backend C: 250ms ┘
Total: 300ms ✅ (60% faster!)
```

### Error Handling

Backends can fail independently without affecting others:

```typescript
const result = await router.dispatchParallel(request, {
  strategy: 'all',
  backends: ['working-model', 'broken-model', 'rate-limited-model']
});

console.log('Successful:', result.successfulBackends);
// ['working-model']

console.log('Failed:', result.failedBackends);
// [
//   { backend: 'broken-model', error: {...} },
//   { backend: 'rate-limited-model', error: {...} }
// ]

// Still get responses from working backends!
console.log('Got', result.allResponses.length, 'responses');
```

### API Reference

```typescript
async dispatchParallel(
  request: IRChatRequest,
  options?: ParallelDispatchOptions,
  signal?: AbortSignal
): Promise<ParallelDispatchResult>
```

**Options:**
```typescript
interface ParallelDispatchOptions {
  backends?: string[];  // Backends to use (defaults to all)
  strategy?: 'all' | 'first' | 'fastest' | 'custom';
  timeout?: number;  // Timeout in milliseconds
  cancelOnFirstSuccess?: boolean;  // For 'first' strategy
  customAggregator?: (responses: BackendResponse[]) => IRChatResponse;
}
```

**Returns:**
```typescript
interface ParallelDispatchResult {
  response: IRChatResponse;  // Primary response
  allResponses?: BackendResponse[];  // All responses ('all' strategy)
  successfulBackends: string[];  // Which backends succeeded
  failedBackends: Array<{
    backend: string;
    error: AdapterError;
  }>;
  totalTimeMs: number;  // Total time for parallel dispatch
}
```

---

## Response Conversion

The conversion utilities provide complete request/response symmetry for debugging and testing. Convert between Universal IR and provider formats programmatically or via CLI.

### Overview

**Two Approaches:**
1. **Standalone Functions** - Use in code for type-safe, programmatic conversions
2. **CLI Tool** - Use in shell scripts and automation for file-based conversions

### Approach 1: Standalone Functions

Simple, type-safe functions for programmatic conversion.

**Before:**
```typescript
// Verbose, required knowing about FrontendAdapter
const adapter = new OpenAIFrontendAdapter();
const openaiFormat = await adapter.fromIR(irResponse);
```

**After:**
```typescript
// Simple, discoverable, one line
const openaiFormat = await toOpenAI(irResponse);
```

**Benefits:**
- 70% less code
- Autocomplete-friendly
- Clear, descriptive names
- Type-safe
- Tree-shakable

#### Quick Start

```typescript
import { toOpenAI, toAnthropic, toGemini, toOllama, toMistral } from '@johnhenry/aimatey-cli';

// Convert to specific format
const openaiResponse = await toOpenAI(irResponse);
const anthropicResponse = await toAnthropic(irResponse);

// Convert to multiple formats for comparison
import { toMultipleFormats } from '@johnhenry/aimatey-cli';
const allFormats = await toMultipleFormats(irResponse, ['openai', 'anthropic', 'gemini']);
```

#### API Reference

**Response Converters:**
```typescript
// Individual format converters
async function toOpenAI(response: IRChatResponse): Promise<OpenAIResponse>
async function toAnthropic(response: IRChatResponse): Promise<AnthropicResponse>
async function toGemini(response: IRChatResponse): Promise<unknown>
async function toOllama(response: IRChatResponse): Promise<unknown>
async function toMistral(response: IRChatResponse): Promise<unknown>

// Streaming converters
async function toOpenAIStream(response: IRChatResponse): Promise<OpenAIStreamChunk[]>
async function toAnthropicStream(response: IRChatResponse): Promise<AnthropicStreamEvent[]>
async function toGeminiStream(response: IRChatResponse): Promise<unknown[]>
async function toMistralStream(response: IRChatResponse): Promise<unknown[]>

// Multi-format converter
async function toMultipleFormats(
  response: IRChatResponse,
  formats: Array<'openai' | 'anthropic' | 'gemini' | 'ollama' | 'mistral'>
): Promise<{
  openai?: OpenAIResponse;
  anthropic?: AnthropicResponse;
  gemini?: unknown;
  ollama?: unknown;
  mistral?: unknown;
}>
```

**Request Converters:**
```typescript
// Individual request converters
function toOpenAIRequest(request: IRChatRequest): OpenAIRequest
function toAnthropicRequest(request: IRChatRequest): AnthropicRequest
function toGeminiRequest(request: IRChatRequest): GeminiRequest
function toOllamaRequest(request: IRChatRequest): OllamaRequest
function toMistralRequest(request: IRChatRequest): MistralRequest

// Multi-format request converter
function toMultipleRequestFormats(
  request: IRChatRequest,
  formats: Array<'openai' | 'anthropic' | 'gemini' | 'ollama' | 'mistral'>
): Promise<Record<string, unknown>>
```

### Approach 2: CLI Tool

Command-line tool for file-based conversion and automation.

**Before:**
```bash
# Had to write a Node.js script
cat > convert.mjs << 'EOF'
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend/openai';
import { readFile, writeFile } from 'fs/promises';

const input = JSON.parse(await readFile('response.json', 'utf-8'));
const adapter = new OpenAIFrontendAdapter();
const output = await adapter.fromIR(input);
await writeFile('output.json', JSON.stringify(output, null, 2));
EOF

node convert.mjs
```

**After:**
```bash
# One command, no code needed
npx ai-matey convert-response -f openai -i response.json -o output.json

# Or with pipes
cat response.json | npx ai-matey convert-response -f openai
```

**Benefits:**
- No code required
- Works in shell pipelines
- Perfect for CI/CD
- Non-programmers can use it
- Integrates with existing tools

#### CLI Usage

```
USAGE:
  npx ai-matey convert-response [OPTIONS]

OPTIONS:
  -f, --format <format>    Target format (openai, anthropic, gemini, ollama, mistral, or 'all')
  -i, --input <file>       Input file (JSON). If omitted, reads from stdin
  -o, --output <file>      Output file. If omitted, writes to stdout
  --no-pretty              Disable pretty-printing
  -h, --help               Show this help message

FORMATS:
  openai       - OpenAI format
  anthropic    - Anthropic format
  gemini       - Gemini format
  ollama       - Ollama format
  mistral      - Mistral format
  all          - Convert to all formats (for debugging)
```

#### CLI Examples

```bash
# Convert from file
npx ai-matey convert-response --format openai --input response.json

# Convert from stdin
cat response.json | npx ai-matey convert-response --format anthropic

# Save to file
npx ai-matey convert-response -f gemini -i response.json -o output.json

# Convert to all formats for debugging
npx ai-matey convert-response -f all -i response.json

# Batch processing
for file in responses/*.json; do
  npx ai-matey convert-response -f openai -i "$file" -o "converted/$(basename $file)"
done

# Integration with other tools
curl https://api.example.com/ir-response | \
  npx ai-matey convert-response -f openai | \
  jq '.choices[0].message.content'
```

### Examples

#### Compare Request Formats

```typescript
import { toMultipleRequestFormats } from '@johnhenry/aimatey-cli';

const allReqFormats = toMultipleRequestFormats(irRequest, [
  'openai',
  'anthropic',
  'gemini'
]);

console.log('OpenAI:', allReqFormats.openai);
console.log('Anthropic:', allReqFormats.anthropic);
console.log('Gemini:', allReqFormats.gemini);
```

#### Compare Response Formats

```typescript
import { toMultipleFormats } from '@johnhenry/aimatey-cli';

const allFormats = await toMultipleFormats(irResponse, [
  'openai',
  'anthropic',
  'gemini',
  'ollama',
  'mistral'
]);

console.log('OpenAI:', JSON.stringify(allFormats.openai, null, 2));
console.log('Anthropic:', JSON.stringify(allFormats.anthropic, null, 2));
```

---

## CLI Tools

aimatey includes powerful command-line tools for various tasks.

### Ollama CLI Emulator

Run Ollama-compatible commands with any backend adapter.

#### Overview

The Ollama CLI interface mimics the original Ollama CLI exactly, accepting the same commands and flags, but routes requests through a pluggable backend. This enables drop-in replacement for Ollama while leveraging aimatey's universal backend system.

**Key Benefits:**
- **Familiar Interface** - Users already know the commands
- **Drop-in Replacement** - Works with existing scripts and workflows
- **Backend Flexibility** - Swap backends without learning new commands
- **Tool-Specific** - Optimized for Ollama's patterns

#### Basic Usage

```bash
# Download GGUF models from Ollama registry
ai-matey emulate-ollama pull phi3:3.8b

# Create a backend adapter
ai-matey create-backend --provider openai

# Run with your backend
ai-matey emulate-ollama --backend ./backend.mjs run llama3.1
ai-matey emulate-ollama --backend ./backend.mjs run llama3.1 "What is 2+2?"

# Other Ollama commands
ai-matey emulate-ollama --backend ./backend.mjs list
ai-matey emulate-ollama --backend ./backend.mjs ps
ai-matey emulate-ollama --backend ./backend.mjs show llama3.1
```

#### Backend Module Format

Create a backend module for use with the CLI:

```javascript
// backend.mjs
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend/openai';

const backend = new OpenAIBackendAdapter({
  apiKey: process.env.OPENAI_API_KEY,
  defaultModel: 'gpt-4o',
});

export default backend;
```

Or with model runner:

```javascript
// llamacpp-backend.mjs
import { NodeLlamaCppBackend } from '@johnhenry/aimatey-native-node-llamacpp';

const backend = new NodeLlamaCppBackend({
  modelPath: './models/llama-3.1-8b.gguf',
  contextSize: 4096,
  gpuLayers: 35,
});

await backend.initialize();
export default backend;
```

#### Supported Commands

##### `run <model>` - Run a model

```bash
ai-matey emulate-ollama run llama3.1
ai-matey emulate-ollama run llama3.1 "What is 2+2?"
echo "Hello" | ai-matey emulate-ollama run llama3.1

Options:
  --verbose, -v        Show verbose output
  --format json        Return response as JSON
```

##### `list` - List models

```bash
ai-matey emulate-ollama list

Output:
NAME              ID              SIZE      MODIFIED
llama3.1:latest   abc123...       4.7GB     2 days ago
codellama:7b      def456...       3.8GB     1 week ago
```

##### `ps` - List running models

```bash
ai-matey emulate-ollama ps

Output:
NAME              ID              SIZE      PROCESSOR    UNTIL
llama3.1:latest   abc123...       4.7GB     100% GPU     4 minutes from now
```

##### `show <model>` - Show model information

```bash
ai-matey emulate-ollama show llama3.1

Output:
Model
  arch            llama
  parameters      8.0B
  quantization    Q4_K_M
  context length  8192
  embedding       true

License
  [License text...]

System Prompt
  [System prompt if set...]
```

##### `pull <model>` - Pull/download a model

```bash
ai-matey emulate-ollama pull llama3.1

Output:
pulling manifest
pulling 8934d96d3f08... 100% ▕████████████████▏ 4.7 GB
pulling 8c17c2ebb0ea... 100% ▕████████████████▏ 7.0 KB
verifying sha256 digest
success
```

#### Model Translation

When using non-Ollama backends, model names are translated:

```javascript
// backend-with-mapping.mjs
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend';

export default new OpenAIBackendAdapter({
  apiKey: process.env.OPENAI_API_KEY,
  defaultModel: 'gpt-4o',
});
```

Supply the translation table as a JSON file (`model-map.json`) and point `--model-map` at it:

```json
{
  "llama3.1": "gpt-4o",
  "llama3.1:8b": "gpt-4o-mini",
  "codellama": "gpt-4o"
}
```

```bash
ai-matey emulate-ollama \
  --backend ./backend-with-mapping.mjs \
  --model-map ./model-map.json \
  run llama3.1
```

Any model name with no entry in the map falls back to the backend's `defaultModel`.

#### Example Workflows

**Local Development:**
```bash
# Use local model for development
cat > local-backend.mjs << 'EOF'
import { NodeLlamaCppBackend } from '@johnhenry/aimatey-native-node-llamacpp';
const backend = new NodeLlamaCppBackend({
  modelPath: './models/llama-3.1-8b.gguf',
  contextSize: 4096,
});
await backend.initialize();
export default backend;
EOF

alias ollama="ai-matey emulate-ollama --backend local-backend.mjs"
ollama run llama3.1 "Test prompt"
```

**Production with OpenAI:**
```bash
# Use OpenAI in production
cat > prod-backend.mjs << 'EOF'
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend/openai';
export default new OpenAIBackendAdapter({
  apiKey: process.env.OPENAI_API_KEY,
  defaultModel: 'gpt-4o',
});
EOF

alias ollama="ai-matey emulate-ollama --backend prod-backend.mjs --model-map ./model-map.json"
ollama run llama3.1 "Production prompt"  # → Uses gpt-4o
```

### Backend Generator

Generate backend adapter templates interactively.

```bash
# Interactive wizard
ai-matey create-backend

# Quick generation
ai-matey create-backend --provider openai --output ./backend.mjs
ai-matey create-backend --provider node-llamacpp --output ./llama-backend.mjs
ai-matey create-backend --provider apple --output ./apple-backend.mjs
```

### Proxy Server

Start an OpenAI-compatible HTTP proxy with any backend.

```bash
# Start proxy server
ai-matey proxy --backend ./backend.mjs --port 3000

# Now you can use it like OpenAI API
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"Hello!"}]}'
```

---

## Additional Resources

- [API Reference](./api.md) - Complete API documentation
- [Examples](../examples/) - Working code examples
- [README](../readme.md) - Getting started and overview

---

## Typed Decisions

Decision ("System One") models answer typed questions about a state in one forward pass, with calibrated probabilities instead of generated text. aimatey exposes them as a third modality beside `chat()` and `embed()`:

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import { createGenericFrontend } from '@johnhenry/aimatey-frontend';
import { OllamaBackendAdapter } from '@johnhenry/aimatey-backend';

const bridge = new Bridge(
  createGenericFrontend(),
  new OllamaBackendAdapter({ defaultModel: 'tev1:0.8b' })
);

const { answers } = await bridge.decide('I was charged twice. Please refund me.', {
  team: {
    type: 'choice',
    instructions: 'Which team should handle this?',
    criteria: { billing: 'charges and refunds', technical: 'bugs and outages' },
  },
  refund: { type: 'noul', instructions: 'Is a refund requested?' },
});
```

The full guide, with every backend and dialect, `Router.decide`, the confidence-control patterns (neutral keys, escalation, ensembles, screening, calibration), `useDecision`, tool-call gating, dataset capture, the demo gateway and the benchmark harness, is the [Decisions guide](../packages/aimatey-docs/src/content/docs/guides/decisions.md). The wire-level types are in the [IR format](./IR-FORMAT.md#decision-ir).

---
