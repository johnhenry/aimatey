# @johnhenry/aimatey-models

## 0.3.0

### Minor Changes

- 9c9687e: Add recommended tool-calling models, verified against each provider's own docs, for AI21 (`jamba-mini`), Cerebras (`gpt-oss-120b`), DashScope (`qwen3.7-flash`), DeepInfra (`deepseek-ai/DeepSeek-V4-Flash-0731`), Fireworks (`accounts/fireworks/models/kimi-k2-instruct-0905`), Inception (`mercury-3`), NVIDIA NIM (`meta/llama-3.1-8b-instruct`), SambaNova (`gpt-oss-120b`) and Together AI (`deepseek-ai/DeepSeek-V4-Pro`), with context windows and pricing where published.

## 0.2.0

### Minor Changes

- 4e95e38: Add recommended models for Cohere (`command-a-plus-05-2026`, fast: `command-r7b-12-2024`) and Hugging Face (`Qwen/Qwen3.5-9B`), both tool-calling capable, so consumers no longer show an empty default.

## 0.1.0

### Minor Changes

- a05563d: New data-only package `@johnhenry/aimatey-models`: per provider and model status (current, legacy, deprecated, retired with dates and a successor), recommended defaults, capabilities, context and output limits, and pricing with `pricingAsOf`. Includes `mergeLiveModels`, `successorOf`, `isDeprecated`, `recommendedModel` and `limitsFor`, a generator script, staleness and missing-default checks, and a weekly GitHub Action that opens a refresh PR. Anthropic is on the Claude 5 family (Sonnet 5.5 default); OpenAI on GPT-6; Gemini on 4 Argon / 3.8 Flash.
