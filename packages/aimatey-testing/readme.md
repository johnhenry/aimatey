# @johnhenry/aimatey-testing

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Faimatey-testing.svg)](https://www.npmjs.com/package/@johnhenry/aimatey-testing)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Faimatey-testing.svg)](LICENSE)

> **Note:** Previously published as `aimatey-testing@0.2.2`.

Testing utilities, mocks, and fixtures for aimatey

Part of the [aimatey](https://github.com/johnhenry/aimatey) monorepo.

## Installation

```bash
npm install @johnhenry/aimatey-testing
```

## Exports

**Fixture loading** - `loadFixture`, `loadProviderFixtures`, `loadFixtureCollection`,
`findFixtures`, `clearFixtureCache`, `getFixtureCacheStats`, `FIXTURES_DIR`

**Fixture capture** - `captureChat`, `captureStream`, `createCaptureMiddleware`, `bulkCapture`

**Fixture helpers** - `createMockFromFixture`, `createMocksFromFixtures`,
`createConfigurableMock`, `replayStreamWithTiming`, `validateAgainstFixture`,
`extractRequest`, `extractResponse`, `extractChunks`, `collectChunksToResponse`

**Assertions** - `assertValidChatRequest`, `assertValidChatResponse`,
`assertValidStreamChunk`, `assertValidStreamSequence`, `assertValidMessage`,
`assertValidMessageContent`, `assertResponseHasText`, `assertResponseHasToolUse`,
`assertReasonableUsage`

**Builders and extraction** - `buildChatRequest`, `buildMultiTurnRequest`,
`extractTextFromResponse`, `extractToolUsesFromResponse`, `accumulateStreamText`,
`estimateTokens`

**Property-based testing** - `forAll`, `SeededRandom`, `generateChatRequest`,
`generateUserMessage`, `generateAssistantMessage`, `generateSystemMessage`,
`generateTextContent`, `generateParameters`, `shrinkChatRequest`,
`propertyValidRequest`, `propertyMultiTurnAlternates`

**Decision dataset capture** - `createDecisionCapture`, `createMemoryDecisionSink`,
`createFileDecisionSink`, `loadDecisionDataset`, `toCalibrationRuns`, `joinDecisionLines`

**Type guards** - `isChatFixture`, `isStreamingFixture`

## Usage

```typescript
import {
  loadFixture,
  createMockFromFixture,
  extractRequest,
  assertValidChatResponse,
} from '@johnhenry/aimatey-testing';

// Replay a recorded provider exchange instead of calling the network
const fixture = await loadFixture('openai', 'chat-basic');
const backend = createMockFromFixture(fixture);

const response = await backend.execute(extractRequest(fixture));
assertValidChatResponse(response);
```

A general-purpose mock backend (not fixture-driven) lives in a different package:
`MockBackendAdapter` from `@johnhenry/aimatey-backend-browser/mock`.

## Decision dataset capture

`createDecisionCapture` records what a `Bridge` decides -- state, questions, answers with
probabilities, model, usage, warnings -- as JSONL, and lets you attach the ground truth later. That
file is the dataset shape fine-tuning loops start from (Cloudflare's RL platform, where AI Gateway
captures a dataset of requests that rollouts, sandbox scoring and a trainer then use; Laya's RLCD).
aimatey does no training: this is the capture half only.

```typescript
import { createDecisionCapture, loadDecisionDataset, toCalibrationRuns } from '@johnhenry/aimatey-testing';

const capture = createDecisionCapture({
  sink: 'data/triage.jsonl', // a path, or any { write, read? } sink
  includeState: true,        // default; false drops the state entirely
  redact: (state) => scrubEmails(state),
});
bridge.useDecision(capture.middleware);

const response = await bridge.decide(ticket, questions);

// later, when the right answer is known:
await capture.recordOutcome(response.metadata.requestId, { team: 'billing', urgent: true });
await capture.flush();

const records = await loadDecisionDataset('data/triage.jsonl'); // or: await capture.records()
const runs = toCalibrationRuns(records); // { urgent: [{ answer, truth }, ...], team: [...] }
```

The file is append-only, one JSON object per line: a decision is `{ requestId, timestamp, backend,
model, state, questions, answers, usage, warnings }`, an outcome is a separate `{ requestId, outcome,
meta? }` line, and the two are joined on read (repeated outcomes for one request merge). Failed
decisions are not recorded, and a failing sink never fails the decision it observes (see `onError`).
`toCalibrationRuns` returns, per question, the `{ answer, truth }` pairs for decisions that have an
outcome, ready for a calibration report. Captured states are real user data: use `redact` or
`includeState: false` before writing them anywhere.

## API Reference

See the TypeScript definitions for detailed API documentation.

## License

MIT - see [LICENSE](./LICENSE) for details.
