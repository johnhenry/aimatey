---
"@johnhenry/aimatey-errors": minor
"@johnhenry/aimatey-types": minor
"@johnhenry/aimatey-http-core": minor
---

`message` is for developers; `userMessage` is for display (#129).

- Every error class accepts an optional `userMessage` (end-user-safe text, shown verbatim) and exposes it as `error.userMessage`; `toJSON()` includes it. It is absent unless the thrower supplies one.
- New `toUserMessage(error)` in `@johnhenry/aimatey-errors`: the error's own `userMessage`, else a fixed default sentence for its `code` (`DEFAULT_USER_MESSAGES`, typed `Record<ErrorCode, string>` so a new code cannot ship without one), else its category's, else `GENERIC_USER_MESSAGE`. Total (accepts anything caught, never throws) and it never returns `error.message`; nothing from the error (message, `details`, `cause`, `provenance`, provider bodies) is interpolated into the defaults.
- `@johnhenry/aimatey-http-core` error bodies (generic, OpenAI and Anthropic shapes) now carry `userMessage`. `message` is unchanged: the existing 5xx/4xx sanitisation stays, so clients that read it keep working. There is no debug flag to gate it behind, so none was added.

Breaking changes: none for callers. `BaseErrorOptions` and the `*ErrorOptions` types gain an optional field; a class that implements the `AdapterError` interface from `@johnhenry/aimatey-types` is unaffected because the new member is optional. Adding an `ErrorCode` remains a compile-time change for anyone who switches on it exhaustively; use `toUserMessage` or `error.category` to be insulated.
