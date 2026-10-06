# Decision Gateway (demo)

A self-hostable typed-decision gateway. One server speaks three wire
dialects, runs every request through one `Bridge` over a `Router` of
decision backends, and escalates unsure answers to an LLM fallback.

> **Demo, not a product.** No rate limiting, a single optional bearer key,
> an in-memory cache that is lost on restart, one process. It exists to show
> how the library's pieces fit together (the decision IR, `Router.decide`,
> the decision middleware, escalation); it is deliberately built *on top of*
> the library rather than being a feature of `@johnhenry/aimatey-http`.

## What it shows

- **One IR, three dialects.** `POST /v1/systemone` (TypeSafe / Ollama),
  `POST /v1/decisions` (OpenRouter alpha) and `POST /v1/evaluate` (Vercel AI
  Gateway, `boolean` instead of `noul`) are parsed to the same decision IR and
  answered by the same pipeline, so one ticket gets the same answers from any
  URL. The wire mapping is the server side of `SYSTEMONE_DIALECTS`
  (`packages/cli/src/decisions.ts`), so a backend adapter pointed at the
  gateway agrees with it by construction.
- **A `Router` of backends.** Ollama (`tev1:0.8b` by default) plus any of
  TypeSafe, OpenRouter and Cloudflare Clef whose keys are present, tried in
  that order with fallthrough.
- **Decision middleware:** in-memory caching, cost tracking (logged, and
  reported as `usage.cost`), logging (question names and answers; `state` is
  redacted), request/response validation.
- **Escalation.** `createDecisionEscalation({ when: { confidenceBelow }, fallback })`
  reruns the whole request on an LLM-emulated decision backend
  (`createEmulatedDecisionBackend` over an Ollama chat model) when a
  choice/score answer's confidence is under the threshold. Escalation is
  reported the way Vercel does -- `routing.modelAttempts[].triggeredBy` under
  `providerMetadata.gateway` (`/v1/evaluate`) or `provider_metadata.gateway`
  (the others) -- and in `x-aimatey-decision-fallback-*` headers.
  The rule uses `onUnmatchable: 'skip'`, so requests with only `noul`
  questions (nothing a confidence threshold can judge) are never escalated.
- **Delegation.** Anything that is not a decision route goes to
  `@johnhenry/aimatey-http`'s core handler (this gateway has no chat backend,
  so only the core handler's own responses come back).

## Run it

```bash
# from the repo root, after `npm install && npm run build`
ollama pull tev1:0.8b && ollama pull qwen2.5:3b

npx tsx examples/decisions/gateway/server.ts
# Decision gateway (demo) on http://localhost:8787
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Listen port |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama base URL |
| `DECISION_MODEL` | `tev1:0.8b` | Primary decision model on Ollama |
| `EMULATION_MODEL` | `qwen2.5:3b` | Ollama chat model used as the escalation fallback |
| `ESCALATE_BELOW` | `0.6` | Escalate when a choice/score confidence is below this |
| `TYPESAFE_API_KEY` | -- | Adds the hosted Jev backend |
| `OPENROUTER_API_KEY` | -- | Adds OpenRouter's decisions endpoint |
| `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` | -- | Adds Workers AI Clef |
| `GATEWAY_API_KEY` | -- | If set, every route except `/health` needs `Authorization: Bearer <key>` |

On a CPU-only machine `tev1:0.8b` takes several seconds per call (plus a
one-off model load); the server does not cut slow requests off.

## Routes

| Route | |
| --- | --- |
| `POST /v1/systemone`, `POST /typesafe/v1/systemone` | TypeSafe / Ollama dialect; `images` (base64) and `keep_alive` accepted |
| `POST /v1/decisions` | OpenRouter dialect; `provider`, `trace`, `session_id`, `user` accepted; response adds `id`, `provider`, `usage.cost` |
| `POST /v1/evaluate` | Vercel dialect; `boolean` questions and `{ type: "boolean", probability }` answers; camelCase `usage`; `providerMetadata.gateway.routing` |
| `GET /v1/models` | Decision-capable backends and their models |
| `GET /health` | `{ status, backends, fallback }`; never needs the key |

Request bodies are limited to 64 KiB (413). Errors use each dialect's
envelope -- TypeSafe `{ "error": "..." }`, OpenRouter
`{ "error": { "code": 400, "message": "..." } }`, Vercel
`{ "error": { "type": "invalid_request_error", "message": "..." } }` -- with
status 400 (malformed or invalid request), 401 (bad key), 404 (unknown model),
405, 413, 429, 502 (upstream failure) or 500.

## Try it

The same ticket, three dialects:

```bash
STATE='I was charged twice for my subscription this month. Please refund the duplicate charge.'

# TypeSafe / Ollama
curl -s localhost:8787/v1/systemone -H 'content-type: application/json' -d "{
  \"state\": \"$STATE\",
  \"questions\": {
    \"refund\": { \"type\": \"noul\", \"instructions\": \"Is the customer asking for a refund?\" },
    \"team\": { \"type\": \"choice\", \"instructions\": \"Which team should handle this?\",
              \"criteria\": { \"billing\": \"payments, charges, refunds\", \"technical\": \"bugs, outages, errors\" } }
  }
}"

# OpenRouter
curl -s localhost:8787/v1/decisions -H 'content-type: application/json' -d "{
  \"state\": \"$STATE\", \"session_id\": \"demo\",
  \"questions\": {
    \"refund\": { \"type\": \"noul\", \"instructions\": \"Is the customer asking for a refund?\" }
  }
}"

# Vercel (note `boolean`)
curl -s localhost:8787/v1/evaluate -H 'content-type: application/json' -d "{
  \"state\": \"$STATE\",
  \"questions\": {
    \"refund\": { \"type\": \"boolean\", \"instructions\": \"Is the customer asking for a refund?\" }
  }
}"

curl -s localhost:8787/v1/models
curl -s localhost:8787/health
```

To see escalation, raise the bar so a middling answer trips it:

```bash
ESCALATE_BELOW=0.9 npx tsx examples/decisions/gateway/server.ts
# the response now carries provider_metadata (or providerMetadata for /v1/evaluate)
# with modelAttempts[0].triggeredBy, and `curl -i` shows x-aimatey-decision-fallback-*
```

## Tests

```bash
cd examples/decisions/gateway
npx vitest run                  # every route x question type, escalation, errors, auth (mock backends)
OLLAMA_LIVE=1 npx vitest run    # adds a smoke test against a local Ollama (slow on CPU)
```

`createGateway(deps)` takes its backends as a parameter, so the tests inject
mock decision backends and need no Ollama. Like the other demo servers it is
not part of the repo's centralized `npm test`.
