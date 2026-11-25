# @johnhenry/aimatey-tool-protocols

Tool-calling protocols for `bridge.runTools()`: `text` (models without native tool support) and `code` (sandboxed JavaScript actions). Work in progress; see johnhenry/aimatey#237.

## text and auto

`text` lets models with no native tool support use `bridge.runTools()`. Tools are described (name, description, JSON schema) in a system message; the model replies with one fenced JSON block to call a tool, or plain text to answer.

````ts
import { textProtocol, autoProtocol } from '@johnhenry/aimatey-tool-protocols';

await bridge.runTools({ prompt, tools, protocol: textProtocol() });
````

The model is asked to reply with:

````
```json
{"tool": "get_weather", "args": {"city": "Paris"}}
```
````

(an array of such objects when `parallelToolCalls` is on). Parsing is tolerant: prose around the block, a missing fence and trailing commas are accepted. A reply that clearly tried to call a tool but cannot be read (invalid JSON, no `tool` key) is sent back to the model as an error and uses up an iteration. Unknown tools and invalid arguments come back as error results. Every call goes through the same validation, `gate` and `execute` path as native calls. Results return as a user message: `Tool result for add (text-1-0): 5`.

`autoProtocol()` uses native tool calling when the backend advertises it and `text` otherwise; an unknown capability counts as native.

To select by name (`protocol: 'text'` or `'auto'`), register them once:

```ts
import { registerTextProtocols } from '@johnhenry/aimatey-tool-protocols';
registerTextProtocols();
```

`runMcpTools` accepts `protocol` too, so MCP tools work on any model.

## `code` protocol: sandboxed JavaScript actions

The model writes one JavaScript snippet instead of emitting tool calls. The snippet calls your tools as `await tools.name({...})`, prints with `console.log`, and finishes with `return` or `final(answer)`. A reply with no code block is the final answer.

```ts
import { codeProtocol, andboxExecutor } from '@johnhenry/aimatey-tool-protocols';

const result = await bridge.runTools({
  prompt: 'Which of these cities is warmest?',
  tools, // the same ToolDefinition record you use with native calling
  protocol: codeProtocol({
    executor: andboxExecutor(),
    limits: { fuel: 20_000, memoryBytes: 32 * 1024 * 1024, deadlineMs: 10_000, maxToolCalls: 50 },
    maxLogChars: 4000,
  }),
  gate, // sees every call the snippet makes
});
```

`registerCodeProtocol(executor)` registers it so `protocol: 'code'` works. Install the optional peer and its pinned engine (andbox is never a dependency of this package):

```sh
npm install @johnhenry/andbox
npm install --save-exact quickjs-emscripten-core@0.32.0 @jitl/quickjs-ng-wasmfile-release-sync@0.32.0
```

Without them `andboxExecutor()` fails on first use with andbox's `ERR_ANDBOX_ENGINE_MISSING` / an install message. Bring your own sandbox by implementing `CodeExecutor` (`run(code, { callTool, toolNames, limits, signal }) => { logs, result, final, error }`); the interface has no sandbox dependency.

### What the loop guarantees

- Every `tools.name(...)` call goes through `ctx.invoke`: unknown-tool check, argument validation, your `gate`, then `execute`. Denials and validation errors throw inside the snippet (catchable with `try/catch`), and denials count toward `maxDenials`.
- Calls made by a snippet appear in `RunToolsStep.toolCalls` with ids `code-<iteration>-<n>`. (If a snippet calls `final(answer)`, the loop ends with a `final` outcome, which carries no call list; the gate and `denials` still saw every call.)
- Snippet errors (syntax, thrown, fuel, memory, deadline) go back to the model as a readable message and use up an iteration. Output is truncated to `maxLogChars` with a `[truncated N chars]` marker.
- A fresh sandbox per snippet: nothing persists between steps.

### Security model (read this)

`andboxExecutor` uses andbox's `mode: 'wasm'` only. The snippet runs in QuickJS-ng compiled to WebAssembly, inside a worker thread (Node) or Worker (browser). The engine has no `fetch`, timers, `process`, `require` or imports; its only way out is the tool bridge. Fuel, memory, stack and a wall-clock deadline are enforced, so an infinite loop or allocation bomb ends the snippet and the loop carries on.

What it does not give you:

- It is not a containment guarantee against engine bugs. A bug in QuickJS or the host's WebAssembly engine is outside this package's control, and a worker thread shares the process. For hostile code on a server add OS-level isolation. See andbox's [threat model by mode](https://github.com/johnhenry/andbox#threat-model-by-mode).
- The tools are the whole attack surface. A tool that reads any path or fetches any URL is an escape hatch; validate arguments in the tool and use `gate`.
- Arguments and results cross the boundary as JSON: no `Map`, `Set`, `Date`, typed arrays; `bigint` becomes a string, cycles become `"[Circular]"`, `undefined` becomes `null`. Tool results are converted this way automatically rather than failing.
- Time is still observable (`Date.now()`), and fuel/memory/deadline bound one snippet, not how many the model writes (`maxIterations` does that).
- Treat the snippet's return value as untrusted model-influenced input.
- Browsers need the engine module and `.wasm` served by your app (pass `sandboxOptions: { engineURL, wasmURL }`); see andbox's "Installing the engine".
- Each snippet creates a new worker and QuickJS runtime; expect about 100 ms of fixed overhead per snippet on a typical Linux box.
