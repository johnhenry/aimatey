---
'@johnhenry/aimatey-http-core': minor
'@johnhenry/aimatey-http': minor
---

Anthropic `/messages` streams through the request handler (Node, Express, Fastify, Koa, Hono, Deno) are now framed as Anthropic's API frames them: named events (`event: message_start`, `content_block_delta`, … `message_stop`) and no trailing `data: [DONE]`. Previously they were bare `data:` lines ending in `data: [DONE]`, which Anthropic's SDKs don't expect. `handleStreamingRequest(…, 'anthropic')` already did this and is unchanged.
