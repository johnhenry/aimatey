---
'@johnhenry/aimatey-backend': minor
---

Hugging Face adapter moves to the Inference Providers router's OpenAI-compatible chat completions (#216), with native tool calling.

- Requests go to `https://router.huggingface.co/v1/chat/completions` with a `messages` array (the flattened `inputs` prompt and the legacy `api-inference.huggingface.co` text-generation endpoint are gone). Streaming is now real SSE, with usage on the final chunk, instead of one blocking response split in two. Authenticate with a Hugging Face token that has the "Inference Providers" permission.
- `capabilities.tools` is now `true`: `tools` / `toolChoice`, blocking `tool_calls`, streamed tool-call fragments and `tool_use` / `tool_result` history work through the shared OpenAI-compatible helpers. Capabilities also change to `streaming: true`, `supportsSeed`, `supportsFrequencyPenalty`, `supportsPresencePenalty` true (sent natively) and `maxStopSequences: 4`; `topK` is no longer sent.
- Breaking for 0.x: the wire format changed. `temperature: 0` is now sent as-is (the old greedy/`do_sample` mapping and the `repetition_penalty` mapping are removed), and `HuggingFaceRequest` / `HuggingFaceResponse` are now the chat completions shapes.
- Custom `baseURL` migration: `https://api-inference.huggingface.co` is mapped to the router; a bare origin such as a dedicated Inference Endpoint (`https://xyz.endpoints.huggingface.cloud`) gets `/v1` appended (text-generation-inference serves chat completions at `/v1/chat/completions`); a URL that already has a path (`.../v1`) is used as given. Endpoints that only expose the old `/models/<id>` prompt API must stay on the previous release.
