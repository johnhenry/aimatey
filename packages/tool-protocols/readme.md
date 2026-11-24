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
