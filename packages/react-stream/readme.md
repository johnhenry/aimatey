# @johnhenry/aimatey-react-stream

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Faimatey-react-stream.svg)](https://www.npmjs.com/package/@johnhenry/aimatey-react-stream)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Faimatey-react-stream.svg)](LICENSE)

> **Note:** Previously published as `aimatey-react.stream@0.2.2`.

React components and utilities for streaming AI responses.

Part of the [aimatey](https://github.com/johnhenry/aimatey) monorepo.

## Installation

```bash
npm install @johnhenry/aimatey-react-stream
```

## Quick Start

```tsx
import { StreamProvider, useStreamContext, StreamText } from '@johnhenry/aimatey-react-stream';

// Wrap your app with StreamProvider
function App() {
  return (
    <StreamProvider maxStreams={10}>
      <ChatComponent />
    </StreamProvider>
  );
}

// Use streaming in components
function ChatComponent() {
  const { startStream, appendToStream, completeStream, getStream } = useStreamContext();
  const [streamId, setStreamId] = useState<string | null>(null);

  const handleSend = async () => {
    const id = `msg-${Date.now()}`;
    setStreamId(id);
    startStream(id);

    const response = await fetch('/api/chat', { method: 'POST' });
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      appendToStream(id, decoder.decode(value));
    }

    completeStream(id);
  };

  const stream = streamId ? getStream(streamId) : null;

  return (
    <div>
      {stream && (
        <StreamText
          text={stream.text}
          isStreaming={stream.isStreaming}
          showCursor={true}
        />
      )}
      <button onClick={handleSend}>Send</button>
    </div>
  );
}
```

## Exports

### Components

- `StreamProvider` - Context provider for stream state management
- `StreamText` - Display streaming text with cursor
- `TypeWriter` - Typewriter effect for static text

### Hooks

- `useStreamContext` - Access stream management functions
- `useStreamState` - Get state for a specific stream

### Utilities

- `createTextStream` - Create controlled text stream from fetch response
- `parseSSEStream` - Parse Server-Sent Events
- `transformStream` - Transform stream data
- `mergeStreams` - Merge multiple streams
- `fromAsyncIterable` - Convert async iterable to stream
- `toAsyncIterable` - Convert stream to async iterable

### Types

- `StreamState`, `StreamContextValue`, `StreamProviderProps`
- `StreamTextProps`, `TypeWriterProps`
- `CreateTextStreamOptions`, `SSEEvent`

## API Reference

### StreamProvider

Context provider for managing multiple concurrent streams.

```tsx
<StreamProvider maxStreams={100}>
  {children}
</StreamProvider>
```

**Props:**
- `maxStreams` - Maximum streams to keep (default: 100, oldest completed removed when exceeded)

### useStreamContext

Access stream management functions.

```tsx
const {
  streams,          // Map<string, StreamState> - All streams
  getStream,        // (id: string) => StreamState | undefined
  startStream,      // (id: string, metadata?: object) => void
  updateStream,     // (id: string, text: string) => void - Replace text
  appendToStream,   // (id: string, chunk: string) => void - Append text
  completeStream,   // (id: string) => void - Mark complete
  setStreamError,   // (id: string, error: Error) => void
  removeStream,     // (id: string) => void
  clearAllStreams,  // () => void
} = useStreamContext();
```

### useStreamState

Get state for a specific stream by ID.

```tsx
const stream = useStreamState('message-1');
// stream: { id, text, isStreaming, error, metadata } | undefined
```

### StreamText

Display streaming text with optional blinking cursor.

```tsx
<StreamText
  text="Hello world"
  isStreaming={true}
  showCursor={true}           // Show cursor while streaming
  cursor="▋"                  // Cursor character
  cursorBlinkInterval={500}   // Blink speed in ms
  className="my-class"
  renderText={(text) => <Markdown>{text}</Markdown>}
/>
```

### TypeWriter

Simulate typing effect for non-streaming text.

```tsx
<TypeWriter
  text="Welcome to Aimatey!"
  speed={30}                  // ms per character
  delay={500}                 // ms before starting
  showCursor={true}
  cursor="▋"
  onComplete={() => console.log('Done!')}
/>
```

### Stream Utilities

```tsx
import {
  createTextStream,
  parseSSEStream,
  fromAsyncIterable,
} from '@johnhenry/aimatey-react-stream';

// Create text stream from fetch response
const text = await createTextStream(response, {
  onChunk: (chunk) => console.log(chunk),
  onComplete: (fullText) => console.log('Done:', fullText),
  signal: abortController.signal,
});

// Parse SSE events
for await (const event of parseSSEStream(response)) {
  console.log(event.data); // { type: 'data' | 'event', data: string }
}
```

## License

MIT - see [LICENSE](./LICENSE) for details.
