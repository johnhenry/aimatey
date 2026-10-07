/**
 * Streaming Mode Conversion Utilities
 *
 * This module handles conversion between delta and accumulated streaming modes.
 * Use these utilities when you need to transform IR stream chunks between formats.
 *
 * For general stream operations (map, filter, collect), see ./streaming.ts
 *
 * @example Converting stream modes
 * ```typescript
 * import { convertStreamMode, createAccumulatorState } from '@johnhenry/aimatey-utils';
 *
 * const converter = createAccumulatorState();
 * const accumulated = await convertStreamMode(deltaStream, 'accumulated', { converter });
 * ```
 *
 * @module streaming-modes
 */

import type { IRChatStream, StreamContentChunk } from '@johnhenry/aimatey-types';
import type {
  StreamMode,
  StreamConversionOptions,
  StreamingConfig,
} from '@johnhenry/aimatey-types';
import { DEFAULT_CONVERSION_OPTIONS, DEFAULT_STREAMING_CONFIG } from '@johnhenry/aimatey-types';

// ============================================================================
// Stream Accumulator
// ============================================================================

/**
 * Stream accumulator state for tracking accumulated content.
 */
export interface StreamAccumulatorState {
  /**
   * Full accumulated text so far.
   */
  accumulated: string;

  /**
   * Number of chunks processed.
   */
  chunkCount: number;

  /**
   * Last chunk sequence number (for validation).
   */
  lastSequence: number;
}

/**
 * Create a new stream accumulator state.
 */
export function createAccumulatorState(): StreamAccumulatorState {
  return {
    accumulated: '',
    chunkCount: 0,
    lastSequence: -1,
  };
}

// ============================================================================
// Mode Detection
// ============================================================================

/**
 * Detect the streaming mode of a content chunk.
 *
 * @param chunk Content chunk to inspect
 * @returns Detected streaming mode
 */
export function detectChunkMode(chunk: StreamContentChunk): StreamMode {
  // If both delta and accumulated are present, it's providing both
  if (chunk.delta && chunk.accumulated) {
    return 'accumulated'; // Preferred mode when both available
  }

  // If only accumulated, it's accumulated mode
  if (chunk.accumulated) {
    return 'accumulated';
  }

  // Default: delta mode
  return 'delta';
}

/**
 * Check if a chunk needs conversion to target mode.
 *
 * @param chunk Content chunk to check
 * @param targetMode Desired streaming mode
 * @param preserveIfMatch Whether to skip conversion if already in target mode
 * @returns true if conversion is needed
 */
export function needsConversion(
  chunk: StreamContentChunk,
  targetMode: StreamMode,
  preserveIfMatch = true
): boolean {
  if (!preserveIfMatch) {
    return true;
  }

  const currentMode = detectChunkMode(chunk);

  // No conversion needed if already in target mode
  if (currentMode === targetMode) {
    return false;
  }

  // If target is delta and chunk has delta, no conversion needed
  if (targetMode === 'delta' && chunk.delta) {
    return false;
  }

  // If target is accumulated and chunk has accumulated, no conversion needed
  if (targetMode === 'accumulated' && chunk.accumulated) {
    return false;
  }

  return true;
}

// ============================================================================
// Stream Conversion
// ============================================================================

/**
 * Convert IR stream to target streaming mode.
 *
 * This function transforms an IR stream to use the specified streaming mode:
 * - Delta mode: Only incremental deltas
 * - Accumulated mode: Full text in each chunk
 *
 * @param stream Source IR stream
 * @param options Conversion options
 * @returns Converted IR stream
 *
 * @example
 * ```typescript
 * // Convert to accumulated mode
 * const accumulated = convertStreamMode(deltaStream, { mode: 'accumulated' });
 *
 * // Convert to delta mode
 * const delta = convertStreamMode(accumulatedStream, { mode: 'delta' });
 * ```
 */
export async function* convertStreamMode(
  stream: IRChatStream,
  options: StreamConversionOptions = {}
): IRChatStream {
  const {
    mode = DEFAULT_CONVERSION_OPTIONS.mode,
    preserveIfMatch = DEFAULT_CONVERSION_OPTIONS.preserveIfMatch,
    transform,
    validateSequence = DEFAULT_CONVERSION_OPTIONS.validateSequence,
  } = options;

  const state = createAccumulatorState();

  for await (const chunk of stream) {
    // Only convert content chunks
    if (chunk.type !== 'content') {
      yield chunk;
      continue;
    }

    // Validate sequence if requested
    if (validateSequence && chunk.sequence !== undefined) {
      if (chunk.sequence <= state.lastSequence) {
        throw new Error(
          `Out of order chunk: expected sequence > ${state.lastSequence}, got ${chunk.sequence}`
        );
      }
      state.lastSequence = chunk.sequence;
    }

    // Check if conversion is needed
    if (!needsConversion(chunk, mode, preserveIfMatch)) {
      yield chunk;
      continue;
    }

    // Convert chunk to target mode
    const converted = convertChunkMode(chunk, mode, state, transform);
    yield converted;

    state.chunkCount++;
  }
}

/**
 * Convert a single content chunk to target mode.
 *
 * @param chunk Source content chunk
 * @param targetMode Target streaming mode
 * @param state Accumulator state (updated in place)
 * @param transform Optional transform function. Applied to `accumulated` only, so
 *   a transform that changes the text makes `accumulated` stop equalling the sum of
 *   the `delta`s -- which the stream contract (`StreamContentChunk.accumulated`)
 *   forbids. Use it for display-only streams that never reach a contract checker,
 *   or not at all.
 * @returns Converted content chunk
 */
export function convertChunkMode(
  chunk: StreamContentChunk,
  targetMode: StreamMode,
  state: StreamAccumulatorState,
  transform?: (text: string) => string
): StreamContentChunk {
  // Update accumulated state
  state.accumulated += chunk.delta;

  if (targetMode === 'delta') {
    // Delta mode: ensure only delta is present
    return {
      type: 'content',
      sequence: chunk.sequence,
      delta: chunk.delta,
      role: chunk.role,
    };
  } else {
    // Accumulated mode: provide accumulated text
    const accumulated = transform ? transform(state.accumulated) : state.accumulated;

    return {
      type: 'content',
      sequence: chunk.sequence,
      delta: chunk.delta, // Still provide delta for compatibility
      accumulated,
      role: chunk.role,
    };
  }
}

// ============================================================================
// Configuration Helpers
// ============================================================================

/**
 * Get effective streaming mode from cascading configuration.
 *
 * Priority order (highest to lowest):
 * 1. Request-level streamMode
 * 2. Conversion options mode
 * 3. Streaming config mode
 * 4. Default ('delta')
 *
 * @param requestMode Stream mode from request
 * @param conversionMode Stream mode from conversion options
 * @param config Streaming configuration
 * @returns Effective streaming mode
 */
export function getEffectiveStreamMode(
  requestMode?: StreamMode,
  conversionMode?: StreamMode,
  config?: StreamingConfig
): StreamMode {
  return requestMode || conversionMode || config?.mode || DEFAULT_STREAMING_CONFIG.mode;
}

/**
 * Merge streaming configurations with priority.
 *
 * @param configs Configuration objects in priority order (first wins)
 * @returns Merged configuration
 */
export function mergeStreamingConfig(
  ...configs: (StreamingConfig | undefined)[]
): Required<StreamingConfig> {
  const result: Required<StreamingConfig> = { ...DEFAULT_STREAMING_CONFIG };

  // Apply configs in reverse order (last has lowest priority)
  for (let i = configs.length - 1; i >= 0; i--) {
    const config = configs[i];
    if (!config) {
      continue;
    }

    if (config.mode !== undefined) {
      result.mode = config.mode;
    }
    if (config.includeBoth !== undefined) {
      result.includeBoth = config.includeBoth;
    }
    if (config.bufferStrategy !== undefined) {
      result.bufferStrategy = config.bufferStrategy;
    }
  }

  return result;
}

// ============================================================================
// Stream Utilities
// ============================================================================

/**
 * Ensure all chunks in a stream have a specific mode.
 *
 * If chunks don't have the required format, converts them.
 *
 * @param stream Source stream
 * @param mode Required mode
 * @returns Stream with all chunks in required mode
 */
export async function* ensureStreamMode(stream: IRChatStream, mode: StreamMode): IRChatStream {
  yield* convertStreamMode(stream, { mode, preserveIfMatch: true });
}

/**
 * Add accumulated field to all content chunks (dual-mode streaming).
 *
 * Useful for backends that want to provide both delta and accumulated.
 *
 * @param stream Source stream (delta-only)
 * @returns Stream with both delta and accumulated in content chunks
 */
export async function* addAccumulatedToStream(stream: IRChatStream): IRChatStream {
  const state = createAccumulatorState();

  for await (const chunk of stream) {
    if (chunk.type === 'content') {
      state.accumulated += chunk.delta;
      yield {
        ...chunk,
        accumulated: state.accumulated,
      };
      state.chunkCount++;
    } else {
      yield chunk;
    }
  }
}

/**
 * Strip accumulated field from all content chunks (delta-only streaming).
 *
 * Useful for reducing bandwidth when accumulated isn't needed.
 *
 * @param stream Source stream
 * @returns Stream with only delta in content chunks
 */
export async function* stripAccumulatedFromStream(stream: IRChatStream): IRChatStream {
  for await (const chunk of stream) {
    if (chunk.type === 'content') {
      const { accumulated: _accumulated, ...deltaOnly } = chunk;
      yield deltaOnly as StreamContentChunk;
    } else {
      yield chunk;
    }
  }
}
