---
'@johnhenry/aimatey-backend-browser': minor
---

LiteRT-LM adapter: abort and load progress. An abort signal now stops `execute`/`executeStream` during engine load (no more waiting on a multi-GB download/compile), calls `conversation.cancel()` the moment it fires even when the model never yields a chunk, and ends with a `STREAM_CANCELLED` error. New `onProgress` config and `preload({ signal, onProgress })` report `{ stage: 'download' | 'compile' | 'loading' | 'ready', loaded, total? }`. New opt-in `fetchModel` makes the adapter download the bundle itself (same request the runtime makes) so bytes are counted and the download can be cancelled when the last caller aborts; the runtime cannot interrupt compilation, so abort during compile returns immediately and leaves the engine cached for the next call (#208).
