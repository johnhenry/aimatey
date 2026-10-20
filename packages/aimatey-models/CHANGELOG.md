# @johnhenry/aimatey-models

## 0.1.0

### Minor Changes

- a05563d: New data-only package `@johnhenry/aimatey-models`: per provider and model status (current, legacy, deprecated, retired with dates and a successor), recommended defaults, capabilities, context and output limits, and pricing with `pricingAsOf`. Includes `mergeLiveModels`, `successorOf`, `isDeprecated`, `recommendedModel` and `limitsFor`, a generator script, staleness and missing-default checks, and a weekly GitHub Action that opens a refresh PR. Anthropic is on the Claude 5 family (Sonnet 5.5 default); OpenAI on GPT-6; Gemini on 4 Argon / 3.8 Flash.
