/**
 * Aimatey Wrappers
 *
 * Consolidated package containing SDK wrappers and IR utilities.
 * These wrappers allow using provider SDK patterns with any backend.
 *
 * @module aimatey-wrapper
 */

// OpenAI SDK Wrapper - namespaced exports
export {
  OpenAI,
  OpenAIClient,
  ChatCompletions,
  ChatCompletions as OpenAIChatCompletions,
  Chat as OpenAIChat,
  Models as OpenAIModels,
} from './openai-sdk.js';

export type {
  OpenAIChatCompletionParams,
  OpenAIChatCompletionChoice,
  OpenAIChatCompletion,
  OpenAIChatCompletionChunk,
  OpenAIModelsPage,
} from './openai-sdk.js';

// Anthropic SDK Wrapper - namespaced exports
export {
  Anthropic,
  AnthropicClient,
  Messages,
  Messages as AnthropicMessages,
  Models as AnthropicModels,
} from './anthropic-sdk.js';

export type {
  AnthropicMessageParams,
  AnthropicMessage,
  AnthropicStreamEvent,
  AnthropicModelsResponse,
} from './anthropic-sdk.js';

// AnyMethod wrapper
export * from './anymethod.js';

// Chrome AI Wrappers
export * from './chrome-ai.js';
export * from './chrome-ai-legacy.js';

// IR Chat utilities (primary Chat export)
export { Chat, createChat } from './chat.js';
export type {
  ChatConfig,
  ChatBackend,
  ToolCallHandler,
  SendOptions,
  StreamOptions,
  ChatResponse,
  ToolCall,
  StreamChunkEvent,
  ConversationState,
  ChatEventType,
  ChatEventListener,
  ChatEvents,
} from './types.js';

// Stream utilities
export {
  collectStream,
  processStream,
  streamToText,
  streamToLines,
  throttleStream,
  teeStream,
} from './stream-utils.js';

export type { CollectedStream, TransformStreamOptions } from './stream-utils.js';

// Decision SDK wrappers
export { createTypeSafeClient } from './typesafe-sdk.js';
export type {
  TypeSafeClient,
  TypeSafeClientOptions,
  TypeSafeCallOptions,
  TypeSafeSDKRequest,
  TypeSafeSDKResponse,
} from './typesafe-sdk.js';
export { createDecide, createDecisionModel } from './ai-sdk-decide.js';
export type {
  DecideOptions,
  DecideParams,
  DecideFunction,
  DecisionModel,
  VercelDecideRequest,
  VercelDecideResponse,
  VercelDecideQuestion,
  VercelDecideAnswer,
} from './ai-sdk-decide.js';
export type { DecisionBridge } from './decision-bridge.js';
