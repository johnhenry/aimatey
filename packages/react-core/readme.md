# @johnhenry/aimatey-react-core

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Faimatey-react-core.svg)](https://www.npmjs.com/package/@johnhenry/aimatey-react-core)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Faimatey-react-core.svg)](LICENSE)

> **Note:** Previously published as `aimatey-react.core@0.2.2`.

Core React hooks for AI chat interactions.

Part of the [aimatey](https://github.com/johnhenry/aimatey) monorepo.

## Installation

```bash
npm install @johnhenry/aimatey-react-core
```

## Quick Start

### HTTP Mode (Default)

```tsx
import { useChat } from '@johnhenry/aimatey-react-core';

function ChatComponent() {
  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
    api: '/api/chat',
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
        <button type="submit" disabled={isLoading}>Send</button>
      </form>
    </div>
  );
}
```

### Direct Backend Mode

Use any backend adapter directly without HTTP - great for Electron apps, browser extensions, or when you want to skip the server:

```tsx
import { useChat } from '@johnhenry/aimatey-react-core';
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend/openai';

// Create backend (could also be Anthropic, Gemini, Ollama, etc.)
const backend = new OpenAIBackendAdapter({
  apiKey: process.env.REACT_APP_OPENAI_API_KEY,
});

function ChatComponent() {
  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
    direct: {
      backend,
      systemPrompt: 'You are a helpful assistant.',
    },
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
        <button type="submit" disabled={isLoading}>Send</button>
      </form>
    </div>
  );
}
```

## Exports

### Hooks

- `useChat` - Chat interface with streaming support
- `useCompletion` - Text completion interface
- `useObject` - Structured object generation

### Types

- `Message` - Chat message type
- `ToolCall`, `ToolInvocation`, `Tool` - Tool calling types
- `UseChatOptions`, `UseChatReturn` - useChat types
- `UseCompletionOptions`, `UseCompletionReturn` - useCompletion types
- `UseObjectOptions`, `UseObjectReturn` - useObject types
- `DirectBackend`, `DirectModeOptions`, `DirectToolCallHandler` - Direct mode types

## API Reference

### useChat

React hook for building chat interfaces with streaming support.

Supports two modes:
1. **HTTP Mode** (default): Uses `api` endpoint with fetch
2. **Direct Mode**: Uses `direct.backend` for direct backend access

```tsx
const {
  messages,        // Message[] - Chat history
  input,           // string - Current input value
  setInput,        // (value: string) => void - Set input
  handleInputChange, // (e: ChangeEvent) => void - Input change handler
  handleSubmit,    // (e?: FormEvent) => void - Form submit handler
  append,          // (message: Message | string) => Promise<string | null>
  reload,          // () => Promise<string | null> - Reload last response
  stop,            // () => void - Stop streaming
  setMessages,     // (messages: Message[]) => void
  isLoading,       // boolean - Request in progress
  error,           // Error | undefined
  data,            // unknown[] | undefined - Additional data
} = useChat(options);
```

#### HTTP Mode Options

```tsx
useChat({
  api: '/api/chat',           // API endpoint (default: '/api/chat')
  initialMessages: [],        // Initial messages
  initialInput: '',           // Initial input value
  id: 'chat-1',              // Chat instance ID
  headers: {},               // Request headers
  body: {},                  // Extra request body fields
  onFinish: (message) => {}, // Called when response completes
  onError: (error) => {},    // Called on error
  onResponse: (response) => {}, // Called with fetch response
  streamProtocol: 'data',    // 'data' (SSE) or 'text'
});
```

#### Direct Mode Options

```tsx
useChat({
  direct: {
    // Required: Backend adapter (any aimatey backend or Bridge)
    backend: myBackendAdapter,

    // Optional: System prompt
    systemPrompt: 'You are a helpful assistant.',

    // Optional: Default IR parameters
    defaultParameters: {
      temperature: 0.7,
      maxTokens: 1000,
    },

    // Optional: Available tools
    tools: [
      {
        name: 'get_weather',
        description: 'Get weather for a location',
        parameters: { /* JSON Schema */ },
      },
    ],

    // Optional: Tool call handler
    onToolCall: async (name, input, id) => {
      return 'Tool result';
    },

    // Optional: Auto-execute tools (default: false)
    autoExecuteTools: true,

    // Optional: Max tool rounds (default: 10)
    maxToolRounds: 5,
  },
  // Common options still work
  initialMessages: [],
  onFinish: (message) => {},
  onError: (error) => {},
});
```

### useCompletion

React hook for text completion interfaces.

```tsx
const {
  completion,      // string - Current completion
  input,           // string - Current input
  setInput,        // (value: string) => void
  handleInputChange,
  handleSubmit,
  complete,        // (prompt: string) => Promise<string | null>
  stop,
  isLoading,
  error,
} = useCompletion({
  api: '/api/completion',
  // ... similar options to useChat
});
```

### useObject

React hook for generating structured objects.

```tsx
const {
  object,          // T | undefined - Generated object
  submit,          // (input: string) => void
  isLoading,
  error,
} = useObject<MyType>({
  api: '/api/object',
  schema: myZodSchema, // Zod schema for validation
});
```

## Direct Mode vs HTTP Mode

| Feature | HTTP Mode | Direct Mode |
|---------|-----------|-------------|
| Setup | Requires API endpoint | Just a backend adapter |
| Server needed | Yes | No |
| Use case | Full-stack apps | Electron, browser extensions, testing |
| Streaming | Via SSE | Native async iterators |
| Tool calling | Via API | Built-in with `wrapper-ir` |

## License

MIT - see [LICENSE](./LICENSE) for details.
