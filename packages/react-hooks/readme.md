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

### Types

- `AssistantMessage`, `Annotation`, `AssistantStatus` - Assistant types
- `UseAssistantOptions`, `UseAssistantReturn` - useAssistant types
- `UseTokenCountOptions`, `UseTokenCountReturn` - useTokenCount types
- `UseStreamOptions`, `UseStreamReturn` - useStream types

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

## License

MIT - see [LICENSE](./LICENSE) for details.
