/**
 * Inception Labs (Mercury) Backend Adapter
 *
 * Adapts Universal IR to Inception Labs API (OpenAI-compatible).
 * Inception Labs offers Mercury, a text diffusion language model with fast generation speeds.
 *
 * @module
 */

import { OpenAIBackendAdapter, type OpenAIRequest, type OpenAIResponse } from './openai.js';
import type {
  BackendAdapter,
  ApiKeyBackendAdapterConfig,
  IRChatRequest,
  IRDecisionRequest,
  IRDecisionResponse,
} from '@johnhenry/aimatey-types';
import { estimateTokens } from '../shared.js';
import {
  buildImageDroppedWarning,
  decideViaSystemOne,
  estimateSystemOneCost,
} from '../decisions/systemone-client.js';

/**
 * Backend adapter for Inception Labs (Mercury) API.
 *
 * Inception Labs provides Mercury, a text diffusion LLM designed for high-speed
 * code generation and text tasks. The API is OpenAI-compatible.
 *
 * @example Basic Usage
 * ```typescript
 * import { InceptionBackendAdapter } from '@johnhenry/aimatey';
 *
 * const adapter = new InceptionBackendAdapter({
 *   apiKey: process.env.INCEPTION_API_KEY,
 * });
 * ```
 *
 * @example With Coding Model
 * ```typescript
 * const adapter = new InceptionBackendAdapter({
 *   apiKey: process.env.INCEPTION_API_KEY,
 * });
 *
 * const response = await adapter.execute({
 *   messages: [{ role: 'user', content: 'Write a function to reverse a string in Python.' }],
 *   parameters: {
 *     model: 'mercury-coder-small', // Fast coding model
 *   },
 * });
 * ```
 *
 * @example Streaming
 * ```typescript
 * const stream = adapter.executeStream({
 *   messages: [{ role: 'user', content: 'Explain recursion.' }],
 *   parameters: {
 *     model: 'mercury-coder',
 *   },
 * });
 *
 * for await (const chunk of stream) {
 *   if (chunk.type === 'content') {
 *     process.stdout.write(chunk.delta);
 *   }
 * }
 * ```
 */
export class InceptionBackendAdapter
  extends OpenAIBackendAdapter
  implements BackendAdapter<OpenAIRequest, OpenAIResponse>
{
  constructor(config: ApiKeyBackendAdapterConfig) {
    const inceptionConfig: ApiKeyBackendAdapterConfig = {
      ...config,
      baseURL: config.baseURL || 'https://api.inceptionlabs.ai/v1',
      defaultModel: config.defaultModel || 'mercury-coder-small',
    };

    super(inceptionConfig, {
      name: 'inception-backend',
      version: '1.0.0',
      provider: 'Inception Labs',
      capabilities: {
        // No verified embeddings endpoint; opt out of the inherited embed()
        embeddings: false,
        streaming: true,
        multiModal: false,
        tools: false,
        structuredOutput: 'native',
        maxContextTokens: 32768,
        systemMessageStrategy: 'in-messages',
        supportsMultipleSystemMessages: false,
        supportsTemperature: true,
        supportsTopP: true,
        supportsTopK: false,
        supportsSeed: false,
        supportsFrequencyPenalty: false,
        supportsPresencePenalty: false,
        maxStopSequences: 4,
        // Typed decisions: native endpoint unverified, see decide().
        decisions: true,
        decisionModels: ['mercury-decide'],
        decisionTypes: ['choice', 'score', 'noul'],
        decisionImages: false,
      },
      config: {
        baseURL: inceptionConfig.baseURL,
      },
    });
  }

  /**
   * Answer a typed-decision request with Mercury Decide.
   *
   * UNVERIFIED: Inception has not published Mercury Decide's native
   * endpoint. This assumes the System One shape at `<baseURL>/systemone`
   * (the same path Jev and Ollama use). The model is known to work through
   * OpenRouter today (`OpenRouterBackendAdapter`, model
   * `inception/mercury-decide`); use that if this path 404s. Images are not
   * supported and are dropped with a warning.
   */
  decide(request: IRDecisionRequest, signal?: AbortSignal): Promise<IRDecisionResponse> {
    return decideViaSystemOne(request, {
      url: `${this.baseURL.replace(/\/+$/, '')}/systemone`,
      dialect: 'systemone',
      model: request.parameters?.model || 'mercury-decide',
      sendImages: false,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        ...this.config.headers,
      },
      signal,
      backendName: this.metadata.name,
      provider: 'inception',
      warnings: buildImageDroppedWarning(request, this.metadata.name, 'Mercury Decide'),
    });
  }

  /** Registry price for `mercury-decide` (free on OpenRouter at launch). */
  estimateDecisionCost(request: IRDecisionRequest): Promise<number | null> {
    return Promise.resolve(
      estimateSystemOneCost(request, request.parameters?.model || 'mercury-decide')
    );
  }

  /**
   * Health check for Inception Labs API.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseURL}/models`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
          ...this.config.headers,
        },
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Estimate cost for Inception Labs.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- BackendAdapter interface is async
  async estimateCost(request: IRChatRequest): Promise<number | null> {
    const pricing: Record<string, { input: number; output: number }> = {
      'mercury-coder-small': { input: 0.25, output: 1.0 },
      'mercury-coder': { input: 1.0, output: 5.0 },
    };

    const model = request.parameters?.model || this.config.defaultModel || '';
    const modelPricing = pricing[model];

    if (!modelPricing) {
      return null;
    }

    const inputTokens = estimateTokens(request);

    const outputTokens = request.parameters?.maxTokens || 1024;

    const inputCost = (inputTokens / 1_000_000) * modelPricing.input;
    const outputCost = (outputTokens / 1_000_000) * modelPricing.output;

    return inputCost + outputCost;
  }
}

/**
 * Create an Inception Labs backend adapter.
 *
 * @param config - Adapter configuration
 * @returns Inception Labs backend adapter
 *
 * @example
 * ```typescript
 * import { createInceptionAdapter } from '@johnhenry/aimatey';
 *
 * const adapter = createInceptionAdapter({
 *   apiKey: process.env.INCEPTION_API_KEY,
 * });
 * ```
 */
export function createInceptionAdapter(
  config: ApiKeyBackendAdapterConfig
): InceptionBackendAdapter {
  return new InceptionBackendAdapter(config);
}
