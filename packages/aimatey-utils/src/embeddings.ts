/**
 * Embedding Utilities
 *
 * Shared helpers for embedding support: batch chunking, dimension
 * normalization, similarity, capability detection, and OpenAI wire-format
 * conversion (used by the HTTP layer's /v1/embeddings route).
 *
 * @module
 */

import type {
  BackendAdapter,
  IRCapabilities,
  IREmbedRequest,
  IREmbedResponse,
  IRMetadata,
} from '@johnhenry/aimatey-types';

// ============================================================================
// Capability Detection
// ============================================================================

/**
 * Type guard: does this backend implement embeddings?
 *
 * Reads the adapter's static `metadata.capabilities` unless `capabilities` is
 * given -- pass the result of `resolveCapabilities()` to judge a backend by
 * what its far side currently offers.
 */
export function supportsEmbeddings(
  adapter: BackendAdapter,
  capabilities: IRCapabilities = adapter.metadata.capabilities
): adapter is BackendAdapter & Required<Pick<BackendAdapter, 'embed'>> {
  // An inherited embed() can be explicitly opted out of via the capability
  // flag (e.g. providers subclassing the OpenAI adapter without an
  // embeddings endpoint set `capabilities.embeddings: false`)
  return typeof adapter.embed === 'function' && capabilities.embeddings !== false;
}

// ============================================================================
// Batch Chunking
// ============================================================================

/**
 * Split embedding inputs into provider-sized batches.
 *
 * @param inputs - Input strings
 * @param options - maxBatchSize: max inputs per request; maxTokensPerBatch:
 *   optional token budget per batch using estimateTokens (default ~4 chars
 *   per token)
 * @returns Batches in original order
 */
export function chunkEmbedInputs(
  inputs: readonly string[],
  options: {
    maxBatchSize: number;
    maxTokensPerBatch?: number;
    estimateTokens?: (text: string) => number;
  }
): string[][] {
  const { maxBatchSize, maxTokensPerBatch, estimateTokens } = options;
  const tokensOf = estimateTokens ?? ((text: string) => Math.ceil(text.length / 4));

  const batches: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const input of inputs) {
    const inputTokens = maxTokensPerBatch ? tokensOf(input) : 0;
    const wouldOverflow =
      current.length >= maxBatchSize ||
      (maxTokensPerBatch !== undefined &&
        current.length > 0 &&
        currentTokens + inputTokens > maxTokensPerBatch);

    if (wouldOverflow) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(input);
    currentTokens += inputTokens;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

// ============================================================================
// Dimension Normalization
// ============================================================================

/**
 * Normalize a vector to a target dimensionality.
 *
 * - `truncate` (default): drop trailing components and re-normalize to unit
 *   length (valid for Matryoshka-trained models; approximate otherwise)
 * - `pad`: zero-pad to the target length
 *
 * @param vector - Source vector
 * @param dimensions - Target dimensionality
 * @param strategy - 'truncate' | 'pad'
 */
export function normalizeDimensions(
  vector: readonly number[],
  dimensions: number,
  strategy: 'truncate' | 'pad' = 'truncate'
): number[] {
  if (vector.length === dimensions) {
    return [...vector];
  }

  if (vector.length > dimensions) {
    const truncated = vector.slice(0, dimensions);
    const norm = Math.sqrt(truncated.reduce((sum, value) => sum + value * value, 0));
    return norm === 0 ? truncated : truncated.map((value) => value / norm);
  }

  if (strategy === 'pad') {
    return [...vector, ...new Array<number>(dimensions - vector.length).fill(0)];
  }

  // Truncate strategy with a shorter source: return as-is (cannot invent data)
  return [...vector];
}

/**
 * Cosine similarity between two vectors (also the seed primitive for
 * semantic caching).
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

// ============================================================================
// OpenAI Wire-Format Conversion
// ============================================================================

/**
 * OpenAI /v1/embeddings request shape.
 */
export interface OpenAIEmbedWireRequest {
  model: string;
  input: string | string[];
  dimensions?: number;
  encoding_format?: 'float' | 'base64';
  user?: string;
}

/**
 * OpenAI /v1/embeddings response shape.
 */
export interface OpenAIEmbedWireResponse {
  object: 'list';
  data: Array<{
    object: 'embedding';
    index: number;
    embedding: number[];
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

/**
 * Convert an OpenAI-format embeddings request body to IR.
 */
export function openaiEmbedRequestToIR(body: OpenAIEmbedWireRequest): IREmbedRequest {
  return {
    input: body.input,
    parameters: {
      model: body.model,
      dimensions: body.dimensions,
      user: body.user,
    },
    metadata: {
      requestId: crypto.randomUUID(),
      timestamp: Date.now(),
      provenance: { frontend: 'openai-embed' },
    } as IRMetadata,
  };
}

/**
 * Convert an IR embedding response to the OpenAI wire format.
 */
export function irToOpenAIEmbedResponse(response: IREmbedResponse): OpenAIEmbedWireResponse {
  return {
    object: 'list',
    data: response.embeddings.map((embedding) => ({
      object: 'embedding' as const,
      index: embedding.index,
      embedding: [...embedding.vector],
    })),
    model: response.model,
    usage: {
      prompt_tokens: response.usage?.promptTokens ?? 0,
      total_tokens: response.usage?.totalTokens ?? 0,
    },
  };
}
