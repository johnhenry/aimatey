/**
 * AI Matey React Hooks
 *
 * Additional specialized React hooks for AI applications.
 *
 * @packageDocumentation
 */

// Hooks
export { useAssistant } from './use-assistant.js';
export { useTokenCount, getModelTokenLimit, MODEL_TOKEN_LIMITS } from './use-token-count.js';
export { useStream } from './use-stream.js';
export { useDecision, useDecisionBatch, DecisionBridgeProvider } from './use-decision.js';

// Types
export type {
  AssistantMessage,
  Annotation,
  AssistantStatus,
  UseAssistantOptions,
  UseAssistantReturn,
} from './use-assistant.js';

export type { UseTokenCountOptions, UseTokenCountReturn } from './use-token-count.js';

export type { UseStreamOptions, UseStreamReturn } from './use-stream.js';

export type {
  DecisionQuestions,
  DecideCallOptions,
  DecisionHookBridge,
  UseDecisionOptions,
  UseDecisionReturn,
  UseDecisionBatchOptions,
  UseDecisionBatchReturn,
} from './use-decision.js';
