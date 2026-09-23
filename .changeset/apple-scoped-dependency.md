---
"@johnhenry/aimatey-native-apple": patch
---

Update `AppleBackend`'s optional native binding from the unscoped `apple-foundation-models` to `@johnhenry/apple-foundation-models`, following that package's own adoption into the `@johnhenry` npm scope. The import specifier, install instructions, and error/log messages all now point at the scoped name.

Live-verified: symlinked the built package under its new scoped name and ran a real `AppleBackend.initialize()`/`execute()` call through it successfully.

Note: `@johnhenry/apple-foundation-models` has not been published to npm yet (blocked on a scope-capable `NPM_TOKEN` on that repo) -- this change is correct and forward-looking, but `npm install @johnhenry/apple-foundation-models` will 404 until that release goes out.
