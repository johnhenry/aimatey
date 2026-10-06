/**
 * Testing utilities and fixtures
 */

// Types
export type {
  FixtureMetadata,
  ChatFixture,
  StreamingFixture,
  Fixture,
  FixtureCollection,
  FixtureQuery,
} from './fixture-types.js';

// Type guards
export { isChatFixture, isStreamingFixture } from './fixture-types.js';

// Fixture loading
export {
  FIXTURES_DIR,
  loadFixture,
  loadProviderFixtures,
  findFixtures,
  clearFixtureCache,
  getFixtureCacheStats,
  loadFixtureCollection,
} from './fixture-loader.js';

// Fixture capture
export type { CaptureConfig } from './fixture-capture.js';
export {
  captureChat,
  captureStream,
  createCaptureMiddleware,
  bulkCapture,
} from './fixture-capture.js';

// Fixture helpers
export {
  createMockFromFixture,
  replayStreamWithTiming,
  createMocksFromFixtures,
  validateAgainstFixture,
  extractRequest,
  extractResponse,
  extractChunks,
  collectChunksToResponse,
  createConfigurableMock,
} from './fixture-helpers.js';

// Decision mocks
export type { MockDecisionBackendConfig, MockDecisionBackend } from './decision-mocks.js';
export { createMockDecisionBackend } from './decision-mocks.js';

// Test helpers and assertions
export {
  assertValidChatResponse,
  assertValidStreamChunk,
  assertValidChatRequest,
  assertValidMessage,
  assertValidMessageContent,
  assertResponseHasText,
  assertResponseHasToolUse,
  assertValidStreamSequence,
  buildChatRequest,
  buildMultiTurnRequest,
  extractTextFromResponse,
  extractToolUsesFromResponse,
  accumulateStreamText,
  estimateTokens,
  assertReasonableUsage,
} from './test-helpers.js';

// Property-based testing
export {
  SeededRandom,
  generateTextContent,
  generateUserMessage,
  generateAssistantMessage,
  generateSystemMessage,
  generateParameters,
  generateChatRequest,
  forAll,
  shrinkChatRequest,
  propertyValidRequest,
  propertyMultiTurnAlternates,
} from './property-testing.js';

// Decision calibration and name-invariance helpers
export * from './decisions/index.js';
