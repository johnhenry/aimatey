---
"@johnhenry/aimatey-backend": patch
"@johnhenry/aimatey-backend-browser": patch
"@johnhenry/aimatey-native-apple": patch
"@johnhenry/aimatey-native-laya": patch
"@johnhenry/aimatey-native-model-runner": patch
"@johnhenry/aimatey-native-node-llamacpp": patch
---

Every shipped adapter now sets `IRProvenance.locality` on the hop it adds (#174). Cloud providers declare `'external'`. The OpenAI-compatible family (including LM Studio and OmniRoute), Ollama and the System One adapters derive it from the resolved base URL: `'same-host'` for loopback or a unix socket, `'external'` otherwise, with `servedBy` set to the URL's `host[:port]`. `native-apple`, `native-laya`, `native-node-llamacpp` and the in-browser adapters declare `'in-process'`; `native-model-runner` stamps `'same-host'` (its runner is a child process) on whatever its subclasses build. The function backend takes an optional `locality` config, since only its author knows what the function does.

Warm-up signals: Ollama reports `MODEL_LOADING` for a 503 "loading model" and for a deadline that expired while `/api/ps` shows the model not resident (also in-band on a stream); `native-model-runner` reports it for a request that arrives while `start()` is still waiting for the process; `native-node-llamacpp` reports it for a request that arrives while another request's load is running, and no longer loads the model twice in that case.
