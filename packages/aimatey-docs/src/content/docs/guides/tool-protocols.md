---
title: "Tool Protocols Guide"
description: "How bridge.runTools asks a model to act: native tool calling, a text protocol for models without tool support, and sandboxed JavaScript actions (code mode) with the gate on every call."
---

`bridge.runTools()` runs an agent loop: ask the model, run the tools it picks, feed results back, repeat. The **protocol** decides how the model is asked to act and how its reply is read. Everything else is shared by every protocol: the unknown-tool check, argument validation, the `gate`, `maxIterations`, `parallelToolCalls`, `maxDenials` and step reporting.

| Protocol | How the model acts | Use it when |
|---|---|---|
| `native` (default) | Provider tool calling (`tool_use` blocks) | The model supports tools. |
| `text` | One fenced JSON action in plain text | The model has no native tool support. |
| `code` | One JavaScript snippet against a `tools.*` API, run in a sandbox | You want chained or looping tool use in one model turn, and can run a sandbox. |
| `auto` | `native` if the backend reports `capabilities.tools`, else `text` | You do not know which models you will get. |

```ts
import { textProtocol, autoProtocol, codeProtocol, andboxExecutor } from '@johnhenry/aimatey-tool-protocols';

await bridge.runTools({ prompt, tools });                              // native
await bridge.runTools({ prompt, tools, protocol: autoProtocol() });    // native or text
await bridge.runTools({ prompt, tools, protocol: textProtocol() });
await bridge.runTools({
  prompt,
  tools,
  protocol: codeProtocol({ executor: andboxExecutor() }),
});
```

`auto` never picks `code`: that needs an executor and a sandbox decision.

## Text protocol

Tools are described in a system message (name, description, JSON schema). The model answers with one fenced `json` block, `{"tool": "name", "args": {...}}` (an array when `parallelToolCalls` is on), or with plain text for its final answer. Malformed attempts are fed back to the model as an error and cost an iteration. Expect more format mistakes from small models than from native tool calling.

## Code protocol

The model writes one JavaScript snippet instead of emitting tool calls:

```js
const cities = ['SF', 'NYC', 'Boston'];
const temps = await Promise.all(cities.map((city) => tools.get_temperature({ city })));
console.log(temps);
```

The snippet runs in a fresh sandbox. Only `console.log` output and the returned value go back to the model, so intermediate results stay out of its context. `final(answer)` ends the loop.

**Every `tools.x(...)` call goes through the same validation and gate as a native call.** A denied or invalid call throws inside the snippet (catchable with `try/catch`) and counts toward `maxDenials`. A decision-model gate (`createDecisionGate`) can approve, deny or send each call inside a snippet to review.

### What the sandbox gives you

`andboxExecutor()` uses [`@johnhenry/andbox`](https://github.com/johnhenry/andbox) `mode: 'wasm'`: the snippet runs in QuickJS-ng compiled to WebAssembly. It has no `fetch`, `WebSocket`, timers or `process`; its only way out is the host callback that dispatches to your tools. Fuel, memory, stack and wall-clock limits are enforced (defaults: fuel 20k, 32 MiB, 10 s, 50 tool calls per snippet), and none of them can be caught by the snippet. See andbox's threat model for what wasm mode does and does not protect against; it is not a replacement for OS-level isolation if you run hostile code.

Things to know:

- Tool arguments and results cross the boundary as JSON. `Map`, `Set`, `Date` and typed arrays do not survive.
- Each snippet starts from a fresh scope. State between steps goes through return values and `console.log`.
- Creating and disposing a sandbox costs roughly 100 ms per snippet (measured on this machine; tool calls add almost nothing).
- If a snippet calls `final()`, calls made before it are not listed in `RunToolsStep.toolCalls` (the gate and `denials` still saw them).
- andbox is an **optional peer dependency**. Install it plus the pinned engine (`quickjs-emscripten-core`, `@jitl/quickjs-ng-wasmfile-release-sync`). In a browser, serve the engine module and `.wasm` yourself (see andbox's README).
- Bring your own sandbox by implementing `CodeExecutor` (`run(code, { callTool, toolNames, limits, signal })`).

## MCP tools

`@johnhenry/aimatey-mcp` tools work with every protocol, since they are ordinary `ToolDefinition`s:

```ts
const result = await runMcpTools(bridge.runTools, {
  client: mcpClient,
  prompt: 'Which of my repos has the most open issues?',
  protocol: codeProtocol({ executor: andboxExecutor() }),
});
```

When an MCP tool declares an `outputSchema`, it is carried onto the definition (`ToolDefinition.outputSchema`), the tool returns its `structuredContent` as a value, and the `code` protocol's prompt types the result (`Promise<{ name: string; ... }>`). Tools without one are typed `Promise<unknown>`.

The whole tool interface is placed in the prompt. For servers with very large tool sets, filter with `toolFilter` for now.

## Choosing

Use `native` for models that support it, and `auto` when the model set varies (it falls back to `text`). `code` is the newest and least proven: it keeps large tool results out of the model's context and can chain calls in one turn, but the [benchmark](./tool-protocol-benchmark) did not show it beating `native` or `text` with a small local model (a 3B model, a handful of runs per cell, no hosted models). Try it on your own model and tasks before relying on it, and only if you can accept the sandbox dependency.
