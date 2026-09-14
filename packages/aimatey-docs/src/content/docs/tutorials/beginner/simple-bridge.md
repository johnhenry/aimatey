---
title: "Tutorial 01: Simple Bridge"
description: "Beginner tutorial: create a minimal Bridge connecting an OpenAI-format frontend to a backend provider."
---

Learn the core concept of aimatey by building your first Bridge.

## What You'll Build

A simple Bridge that lets you write code in OpenAI's format but execute it using Anthropic's Claude API.

## Time Required

⏱️ **10 minutes**

## Prerequisites

- Node.js 18+ installed
- One of these API keys:
  - OpenAI API key, OR
  - Anthropic API key

## What is a Bridge?

A **Bridge** is the core concept of aimatey. It connects a **frontend adapter** (your input format) with a **backend adapter** (the AI provider).

```
Your Code (OpenAI format)
        ↓
Frontend Adapter (OpenAI)
        ↓
Intermediate Representation
        ↓
Backend Adapter (Anthropic)
        ↓
Claude API
```

This lets you write code once and switch providers without changing your application code.

## Step 1: Install Packages

Create a new project and install the required packages:

```bash
mkdir my-first-bridge
cd my-first-bridge
npm init -y
npm install @johnhenry/aimatey-core @johnhenry/aimatey-frontend @johnhenry/aimatey-backend
```

## Step 2: Create Your First Bridge

Create a file called `index.js`:

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend/openai';
import { AnthropicBackendAdapter } from '@johnhenry/aimatey-backend/anthropic';

// Create the bridge
const bridge = new Bridge(
  new OpenAIFrontendAdapter(),  // Input format: OpenAI
  new AnthropicBackendAdapter({ // Output provider: Anthropic
    apiKey: process.env.ANTHROPIC_API_KEY
  })
);

// Make a request using OpenAI format
const response = await bridge.chat({
  model: 'gpt-4',  // Any model name - will be mapped to Claude
  messages: [
    { role: 'user', content: 'What is aimatey?' }
  ]
});

console.log(response.choices[0].message.content);
```

## Step 3: Set Your API Key

Create a `.env` file:

```bash
ANTHROPIC_API_KEY=your_api_key_here
```

## Step 4: Run It

```bash
node index.js
```

You should see Claude's response in OpenAI format!

## Understanding What Happened

1. **You wrote code** using OpenAI's API format (familiar to most developers)
2. **Frontend Adapter** converted your request to the Intermediate Representation (IR)
3. **Backend Adapter** converted the IR to Anthropic's Claude API format
4. **Claude responded**, and the backend adapter converted it back to IR
5. **Frontend Adapter** converted IR back to OpenAI format
6. **You received** an OpenAI-formatted response, even though Claude processed it

## Why Is This Useful?

### 1. Provider Independence

Change providers by only changing the backend:

```typescript
// Switch to OpenAI
const bridge = new Bridge(
  new OpenAIFrontendAdapter(),
  new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY })
);

// Or switch to Google Gemini
const bridge = new Bridge(
  new OpenAIFrontendAdapter(),
  new GeminiBackendAdapter({ apiKey: process.env.GEMINI_API_KEY })
);
```

Your application code stays exactly the same!

### 2. Format Independence

You can also change the input format:

```typescript
// Use Anthropic's format as input
const bridge = new Bridge(
  new AnthropicFrontendAdapter(),
  new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY })
);

// Write in Anthropic format, execute on OpenAI
const response = await bridge.chat({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 100,
  messages: [
    { role: 'user', content: 'Hello!' }
  ]
});
```

### 3. Testing & Development

Use local models for development:

```typescript
import { OllamaBackendAdapter } from '@johnhenry/aimatey-backend/ollama';

const devBridge = new Bridge(
  new OpenAIFrontendAdapter(),
  new OllamaBackendAdapter({
    baseURL: 'http://localhost:11434'
  })
);
```

## Streaming Support

The Bridge also supports streaming responses:

```typescript
const stream = await bridge.chatStream({
  model: 'gpt-4',
  messages: [
    { role: 'user', content: 'Count to 10' }
  ],
  stream: true
});

for await (const chunk of stream) {
  const content = chunk.choices?.[0]?.delta?.content;
  if (content) {
    process.stdout.write(content);
  }
}
```

## Error Handling

Always wrap your Bridge calls in try-catch:

```typescript
try {
  const response = await bridge.chat({
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'Hello!' }]
  });
  console.log(response.choices[0].message.content);
} catch (error) {
  console.error('Error:', error.message);
}
```

## Common Patterns

### Environment-Based Provider Selection

```typescript
const backendAdapter = process.env.NODE_ENV === 'production'
  ? new AnthropicBackendAdapter({ apiKey: process.env.ANTHROPIC_API_KEY })
  : new OllamaBackendAdapter({ baseURL: 'http://localhost:11434' });

const bridge = new Bridge(
  new OpenAIFrontendAdapter(),
  backendAdapter
);
```

### Reusable Bridge Instance

```typescript
// Create once
const bridge = new Bridge(
  new OpenAIFrontendAdapter(),
  new AnthropicBackendAdapter({ apiKey: process.env.ANTHROPIC_API_KEY })
);

// Reuse many times
async function chat(userMessage) {
  return await bridge.chat({
    model: 'gpt-4',
    messages: [{ role: 'user', content: userMessage }]
  });
}

const response1 = await chat('What is AI?');
const response2 = await chat('Explain bridges');
```

## Troubleshooting

### "API key not found"
Make sure your `.env` file has the correct API key and you're using `dotenv`:

```bash
npm install dotenv
```

```typescript
import 'dotenv/config';
import { Bridge } from '@johnhenry/aimatey-core';
// ... rest of code
```

### "Module not found"
Make sure you installed all packages:

```bash
npm install @johnhenry/aimatey-core @johnhenry/aimatey-frontend @johnhenry/aimatey-backend
```

### "Cannot use import statement"
Add `"type": "module"` to your `package.json`:

```json
{
  "name": "my-first-bridge",
  "type": "module",
  "dependencies": {
    "@johnhenry/aimatey-core": "latest",
    "@johnhenry/aimatey-frontend": "latest",
    "@johnhenry/aimatey-backend": "latest"
  }
}
```

## Next Steps

Congratulations! You've built your first Bridge.

**Continue learning:**
- [Tutorial 02: Using Middleware](/tutorials/beginner/using-middleware) - Add logging, caching, and retry
- [Examples on GitHub](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/01-basics)
- [Core Concepts](/getting-started/core-concepts) - Deep dive into architecture

## Full Example Code

Here's the complete working example:

```typescript
// index.js
import 'dotenv/config';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend/openai';
import { AnthropicBackendAdapter } from '@johnhenry/aimatey-backend/anthropic';

async function main() {
  // Create bridge
  const bridge = new Bridge(
    new OpenAIFrontendAdapter(),
    new AnthropicBackendAdapter({
      apiKey: process.env.ANTHROPIC_API_KEY
    })
  );

  try {
    // Non-streaming example
    console.log('Non-streaming response:');
    const response = await bridge.chat({
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Explain aimatey in one sentence' }
      ]
    });
    console.log(response.choices[0].message.content);

    // Streaming example
    console.log('\n\nStreaming response:');
    const stream = await bridge.chatStream({
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Count to 5' }
      ],
      stream: true
    });

    for await (const chunk of stream) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) {
        process.stdout.write(content);
      }
    }
    console.log('\n');
  } catch (error) {
    console.error('Error:', error.message);
  }
}

main();
```

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
```

```json
{
  "name": "my-first-bridge",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@johnhenry/aimatey-core": "latest",
    "@johnhenry/aimatey-frontend": "latest",
    "@johnhenry/aimatey-backend": "latest",
    "dotenv": "^16.0.0"
  }
}
```

Run it:
```bash
npm install
node index.js
```

---

**Ready for the next tutorial?** Learn about [Using Middleware](/tutorials/beginner/using-middleware)
