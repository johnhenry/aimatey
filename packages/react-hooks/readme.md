# @johnhenry/aimatey-react-hooks

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Faimatey-react-hooks.svg)](https://www.npmjs.com/package/@johnhenry/aimatey-react-hooks)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Faimatey-react-hooks.svg)](LICENSE)

> **Note:** Previously published as `aimatey-react.hooks@0.2.2`.

Additional specialized React hooks for AI applications.

Part of the [aimatey](https://github.com/johnhenry/aimatey) monorepo.

## Installation

```bash
npm install @johnhenry/aimatey-react-hooks
```

## Quick Start

```tsx
import { useAssistant } from '@johnhenry/aimatey-react-hooks';

function AssistantChat() {
  const { messages, input, handleInputChange, handleSubmit, status } = useAssistant({
    api: '/api/assistant',
    assistantId: 'asst_xxx',
  });

  return (
    <div>
      {messages.map((m) => (
        <div key={m.id}>
          <strong>{m.role}:</strong> {m.content}
        </div>
      ))}
      <form onSubmit={handleSubmit}>
        <input value={input} onChange={handleInputChange} />
        <button type="submit" disabled={status === 'in_progress'}>
          Send
        </button>
      </form>
      <p>Status: {status}</p>
    </div>
  );
}
```

## Exports

### Hooks

- `useAssistant` - OpenAI Assistants API integration with thread management
- `useTokenCount` - Token counting and context window tracking
- `useStream` - Low-level stream consumption hook
- `useDecision`, `useDecisionBatch` - Typed-decision models (`Bridge.decide` / `decideBatch`)
- `DecisionBridgeProvider` - Context that supplies the bridge to the decision hooks

### Types

- `AssistantMessage`, `Annotation`, `AssistantStatus` - Assistant types
- `UseAssistantOptions`, `UseAssistantReturn` - useAssistant types
- `UseTokenCountOptions`, `UseTokenCountReturn` - useTokenCount types
- `UseStreamOptions`, `UseStreamReturn` - useStream types
- `UseDecisionOptions`, `UseDecisionReturn`, `UseDecisionBatchOptions`, `UseDecisionBatchReturn`,
  `DecisionHookBridge`, `DecisionQuestions`, `DecideCallOptions` - decision hook types

## API Reference

### useAssistant

React hook for OpenAI Assistants API with thread and run management.

```tsx
const {
  messages,          // AssistantMessage[] - Chat history with annotations
  input,             // string - Current input
  setInput,          // (value: string) => void
  handleInputChange, // (e: ChangeEvent) => void
  handleSubmit,      // (e?: FormEvent) => void
  append,            // (message: string | Message) => Promise<void>
  threadId,          // string | undefined - Current thread ID
  status,            // AssistantStatus - Run status
  stop,              // () => void - Cancel current run
  setMessages,       // (messages: AssistantMessage[]) => void
  error,             // Error | undefined
} = useAssistant({
  api: '/api/assistant',    // API endpoint
  assistantId: 'asst_xxx',  // OpenAI Assistant ID
  threadId: 'thread_xxx',   // Existing thread to continue
  headers: {},              // Request headers
  body: {},                 // Extra request body
  onStatus: (status) => {}, // Called on status change
  onError: (error) => {},   // Called on error
});
```

**AssistantStatus values:**
- `awaiting_message` - Ready for input
- `in_progress` - Processing request
- `requires_action` - Tool call pending
- `completed` - Run finished
- `failed` - Run failed
- `cancelled` - Run cancelled
- `expired` - Run expired

### useTokenCount

Track token usage and context window limits.

```tsx
const {
  tokenCount,        // number - Current token count
  maxTokens,         // number - Model's max context
  remainingTokens,   // number - Tokens remaining
  isNearLimit,       // boolean - Within 10% of limit
  isOverLimit,       // boolean - Exceeded limit
  updateText,        // (text: string) => void - Update counted text
} = useTokenCount({
  model: 'gpt-4',           // Model name for limits
  text: '',                 // Initial text to count
  warningThreshold: 0.9,    // Threshold for isNearLimit
});
```

**Supported models:**
- `gpt-4`, `gpt-4-turbo`: 128,000 tokens
- `gpt-3.5-turbo`: 16,385 tokens
- `claude-3-opus`, `claude-3-sonnet`: 200,000 tokens
- And more...

### useStream

Low-level hook for consuming async iterables/streams.

```tsx
const {
  data,              // T[] - Accumulated data
  isStreaming,       // boolean
  error,             // Error | undefined
  start,             // (stream: AsyncIterable<T>) => void
  stop,              // () => void
  reset,             // () => void
} = useStream<ChunkType>({
  onChunk: (chunk) => {},   // Called for each chunk
  onComplete: (data) => {}, // Called when done
  onError: (error) => {},   // Called on error
});
```

### useDecision

Ask typed questions (`choice`, `score`, `noul`) about a state and get typed answers back from a
`Bridge`: no streaming, no message list. Needs a bridge whose backend supports decisions, passed as
`bridge` or supplied by `<DecisionBridgeProvider bridge={bridge}>`.

```tsx
import { useDecision } from '@johnhenry/aimatey-react-hooks';

const questions = {
  urgent: { type: 'noul', instructions: 'Is this urgent?' },
} as const;

function Triage({ bridge, ticket }) {
  const { answers, decide, isLoading, error } = useDecision(questions, { bridge });

  return (
    <>
      <button disabled={isLoading} onClick={() => decide(ticket)}>Triage</button>
      {answers?.urgent && <p>P(urgent) = {answers.urgent.value.toFixed(2)}</p>}
      {error && <p>{error.message}</p>}
    </>
  );
}
```

```tsx
const {
  answers,   // Record<string, IRDecisionAnswer> | undefined
  response,  // IRDecisionResponse | undefined (model, usage, warnings)
  decide,    // (state, options?) => Promise<IRDecisionResponse | undefined>
  isLoading, // boolean
  error,     // Error | undefined
  abort,     // () => void
  reset,     // () => void
} = useDecision(questions, {
  bridge,                       // or <DecisionBridgeProvider>
  model: 'tev1:0.8b',
  auto: true,                   // run on mount with initialState...
  initialState: ticket,         // ...and again when the questions' content changes
  onAnswers: (answers, response) => {},
  onError: (error) => {},
});
```

- `decide()` aborts the call in flight (through an `AbortSignal` passed to the bridge) and ignores
  its response if it still arrives, so the latest call always wins.
- Changing the identity of `questions` never refetches; only `auto: true` re-runs, and only when the
  questions' content changes (compared by value, so an inline object literal is safe).
- Unmounting aborts the call in flight.

### useDecisionBatch

The same questions over many states, on `Bridge.decideBatch` with progress.

```tsx
const { run, results, progress, isLoading, abort } = useDecisionBatch(questions, {
  bridge,
  concurrency: 2,
});

// <button onClick={() => run(tickets)}>Triage all</button>
// <progress value={progress.done} max={progress.total} />
// results?.map((r) => (r.status === 'fulfilled' ? r.value.answers : r.reason))
```

`results` holds one `PromiseSettledResult` per state in input order (a failing state is a `rejected`
entry, not a failure of the batch). `error` is for batch-level failures only. `run()` supersedes a
batch in flight; `abort()` drops its results.

## License

MIT - see [LICENSE](./LICENSE) for details.
