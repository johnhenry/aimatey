---
"@johnhenry/aimatey-native-apple": patch
---

Fix `AppleBackend`'s `samplingMode: 'default'` silently mapping to `ai.SamplingMode.Default`, which doesn't exist on `apple-foundation-models`'s real `SamplingMode` enum (`Greedy` | `Random` only, verified against the installed package's `dist/types.d.ts`). `AppleConfig.samplingMode` is now `'random' | 'greedy'`.

Also corrects this package's documented minimum OS requirement from "macOS 15+ (Sequoia)" to macOS 26+ -- the `FoundationModels` framework requires macOS 26; the Sequoia claim was simply wrong. Verified live: installed `apple-foundation-models`, built its Swift wrapper, and ran real `SystemLanguageModel`/`LanguageModelSession` calls (including the fixed sampling-mode path) through `AppleBackend.execute()`/`executeStream()` on macOS 27.
