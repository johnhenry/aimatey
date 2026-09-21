# @johnhenry/aimatey-utils

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Faimatey-utils.svg)](https://www.npmjs.com/package/@johnhenry/aimatey-utils)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Faimatey-utils.svg)](LICENSE)

> **Note:** Previously published as `aimatey-utils@0.5.0`.

Shared utility functions for streaming, validation, and conversions.

Part of the [aimatey](https://github.com/johnhenry/aimatey) monorepo.

## Contents

- [Installation](#installation)
- [Stream Utilities](#stream-utilities)
- [Stream Accumulator](#stream-accumulator)
- [Content Utilities](#content-utilities)
- [Stream Splitting](#stream-splitting)
- [Model Registry](#model-registry)
- [Schema & Validation Utilities](#schema-validation-utilities)
- [Types](#types)
- [API Reference](#api-reference)
- [License](#license)

## Installation

```bash
npm install @johnhenry/aimatey-utils
```

## Stream Utilities

Comprehensive utilities for working with IR chat streams.

### Basic Stream Operations

```typescript
import {
  collectStream,        // Collect chunks into array
  collectStreamFull,    // Collect with rich metadata
  streamToText,         // Get accumulated text
  streamToResponse,     // Convert to IR response
} from '@johnhenry/aimatey-utils';

// Collect all chunks
const chunks = await collectStream(stream);

// Collect with full metadata
const result = await collectStreamFull(stream);
console.log(result.content);      // Full text
console.log(result.message);      // IR message
console.log(result.finishReason); // 'stop', 'length', etc.
console.log(result.usage);        // Token counts

// Get just the text
const text = await streamToText(stream);
```

### Processing Streams

```typescript
import { processStream, streamToLines, streamToTextIterator } from '@johnhenry/aimatey-utils';

// Process with callbacks
const result = await processStream(stream, {
  onStart: (requestId) => console.log('Started:', requestId),
  onContent: (delta, accumulated) => process.stdout.write(delta),
  onDone: (result) => console.log('\nTokens:', result.usage?.totalTokens),
  onError: (error) => console.error('Error:', error),
});

// Iterate over text chunks
for await (const text of streamToTextIterator(stream)) {
  process.stdout.write(text);
}

// Buffer and yield complete lines
for await (const line of streamToLines(stream)) {
  console.log('Line:', line);
}
```

### Transforming Streams

```typescript
import {
  transformStream,
  filterStream,
  mapStream,
  tapStream,
} from '@johnhenry/aimatey-utils';

// Transform chunks
const transformed = transformStream(stream, (chunk) => ({
  ...chunk,
  delta: chunk.type === 'content' ? chunk.delta.toUpperCase() : chunk.delta,
}));

// Filter chunks
const contentOnly = filterStream(stream, (chunk) => chunk.type === 'content');

// Map chunks
const textOnly = mapStream(stream, (chunk) =>
  chunk.type === 'content' ? chunk.delta : ''
);

// Tap for side effects (logging, etc.)
const logged = tapStream(stream, (chunk) => console.log('Chunk:', chunk.type));
```

### Stream Control

```typescript
import {
  throttleStream,
  rateLimitStream,
  teeStream,
  splitStream,
} from '@johnhenry/aimatey-utils';

// Throttle updates (batches content chunks)
// Great for limiting UI update frequency
for await (const chunk of throttleStream(stream, 50)) {
  updateUI(chunk); // Max every 50ms
}

// Rate limit (delays chunks to max N/second)
const limited = rateLimitStream(stream, 10); // Max 10 chunks/second

// Split stream for parallel processing
const [stream1, stream2] = teeStream(stream, 2);

await Promise.all([
  processStream(stream1, { onContent: (d) => logger.log(d) }),
  processStream(stream2, { onContent: (d) => ui.append(d) }),
]);
```

### Stream Validation

```typescript
import { validateStream, validateChunkSequence } from '@johnhenry/aimatey-utils';

// Validate stream structure
const validated = validateStream(stream, {
  requireStart: true,
  requireDone: true,
  requireContent: true,
});

// Check if chunk sequence is valid
const chunks = await collectStream(stream);
const isValid = validateChunkSequence(chunks);
```

### Error Handling

```typescript
import { catchStreamErrors, streamWithTimeout, createStreamError } from '@johnhenry/aimatey-utils';

// Catch and handle errors
const safe = catchStreamErrors(stream, (error) => {
  console.error('Stream error:', error);
});

// Add timeout
const withTimeout = streamWithTimeout(stream, 30000); // 30s timeout

// Create error chunks
const errorChunk = createStreamError(new Error('Something went wrong'));
```

## Stream Accumulator

Build responses incrementally from chunks:

```typescript
import {
  createStreamAccumulator,
  accumulateChunk,
  accumulatorToMessage,
  accumulatorToResponse,
} from '@johnhenry/aimatey-utils';

const accumulator = createStreamAccumulator();

for await (const chunk of stream) {
  accumulateChunk(accumulator, chunk);
  console.log('Current text:', accumulator.content);
}

const message = accumulatorToMessage(accumulator);
const response = accumulatorToResponse(accumulator);
```

## Content Utilities

```typescript
import { getContentDeltas, isContentChunk, isDoneChunk, isErrorChunk } from '@johnhenry/aimatey-utils';

// Get just the text deltas
for await (const delta of getContentDeltas(stream)) {
  process.stdout.write(delta);
}

// Type guards
for await (const chunk of stream) {
  if (isContentChunk(chunk)) {
    console.log('Content:', chunk.delta);
  } else if (isDoneChunk(chunk)) {
    console.log('Done:', chunk.finishReason);
  } else if (isErrorChunk(chunk)) {
    console.error('Error:', chunk.error);
  }
}
```

## Stream Splitting

```typescript
import { splitStream, teeStream } from '@johnhenry/aimatey-utils';

// Fan one stream out to several independent consumers
const [forDisplay, forLogging] = teeStream(stream);

// Or split into an explicit number of consumers
const consumers = splitStream(stream, 3);
```

## Model Registry

Single source of truth for model metadata (pricing, context windows, capabilities,
quality/latency heuristics), seeded from a built-in `MODEL_REGISTRY_SEED` and extensible at
runtime so consumers aren't blocked by stale built-in data:

```typescript
import { registerModels, getModelEntry, getModelPricingInfo } from '@johnhenry/aimatey-utils';

registerModels([
  { id: 'gpt-6-preview', provider: 'openai', family: 'gpt-6', pricing: { inputPer1M: 2.0, outputPer1M: 16.0 } },
]);

getModelEntry('gpt-6-preview');
getModelPricingInfo('claude-sonnet-5');
```

Lookup resolves exact ids first, then aliases, then the longest matching id/alias prefix - so
an unrecognized dated snapshot still resolves to its family entry instead of returning nothing.

## Schema & Validation Utilities

`schemaToToolDefinition`, `validateWithSchema`, and PII/prompt-injection detection helpers
(`DEFAULT_PII_PATTERNS`, `DEFAULT_INJECTION_PATTERNS`) for building and validating tool schemas.
The Zod -> JSON Schema conversion covers unions, records, dates, literals, tuples,
intersections, nullable/optional/default modifiers and nested or recursive objects; a type with
no JSON Schema representation converts to `{}` and is reported on `ToolDefinition.warnings` as
an `IRWarning` rather than being silently degraded to `{ type: 'string' }`.
Note: this is separate from `IRResponseFormat`/`responseFormat` (schema-constrained *model
output*, defined in `@johnhenry/aimatey-types` and mapped per-backend in `@johnhenry/aimatey-backend` - see
[`docs/IR-FORMAT.md`](../../docs/IR-FORMAT.md#structured-output)); these utilities are about
tool/function schemas and input validation instead.

## Types

```typescript
import type {
  CollectedStream,      // Rich result from collectStreamFull
  ProcessStreamOptions, // Options for processStream
  StreamValidationOptions,
} from '@johnhenry/aimatey-utils';
```

## API Reference

### Collection Functions

| Function | Description |
|----------|-------------|
| `collectStream(stream)` | Collect chunks into array |
| `collectStreamFull(stream)` | Collect with rich metadata |
| `streamToText(stream)` | Get accumulated text |
| `streamToResponse(stream)` | Convert to IR response |

### Processing Functions

| Function | Description |
|----------|-------------|
| `processStream(stream, options)` | Process with callbacks |
| `streamToLines(stream)` | Yield complete lines |
| `streamToTextIterator(stream)` | Yield text deltas |
| `getContentDeltas(stream)` | Yield only content |

### Transform Functions

| Function | Description |
|----------|-------------|
| `transformStream(stream, fn)` | Transform each chunk |
| `filterStream(stream, predicate)` | Filter chunks |
| `mapStream(stream, fn)` | Map chunks to new values |
| `tapStream(stream, fn)` | Side effects without modification |

### Control Functions

| Function | Description |
|----------|-------------|
| `throttleStream(stream, ms)` | Batch chunks by time interval |
| `rateLimitStream(stream, rate)` | Limit chunks per second |
| `teeStream(stream, count)` | Split into multiple streams |
| `splitStream(stream, count)` | Split into multiple streams |

### Validation Functions

| Function | Description |
|----------|-------------|
| `validateStream(stream, options)` | Validate stream structure |
| `validateChunkSequence(chunks)` | Check sequence validity |

### Error Functions

| Function | Description |
|----------|-------------|
| `catchStreamErrors(stream, handler)` | Handle errors gracefully |
| `streamWithTimeout(stream, ms)` | Add timeout |
| `createStreamError(error)` | Create error chunk |

## License

MIT - see [LICENSE](./LICENSE) for details.
