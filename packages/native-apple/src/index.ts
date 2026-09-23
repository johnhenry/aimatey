/**
 * Apple Backend Adapter
 *
 * Backend adapter using Apple's Foundation Models via apple-foundation-models.
 * Only works on macOS 26+ with Apple Intelligence -- the `FoundationModels`
 * framework itself requires macOS 26 (it shipped with the WWDC 2025
 * developer-facing framework, not with Sequoia's Apple Intelligence
 * features); verified live against `apple-foundation-models` on macOS 27,
 * not assumed.
 *
 * Gracefully fails on unsupported platforms (Linux, Windows, older macOS).
 *
 * @example Basic Usage
 * ```typescript
 * import { AppleBackend } from '@johnhenry/aimatey-native-node-llamacpp';
 *
 * const backend = new AppleBackend({
 *   maxTokens: 2048,
 *   temperature: 0.7,
 * });
 *
 * await backend.initialize();
 * const response = await backend.execute(request);
 * ```
 *
 * @module
 */

import type { BackendAdapter, AdapterMetadata } from '@johnhenry/aimatey-types';
import type {
  IRChatRequest,
  IRChatResponse,
  IRChatStream,
  IRStreamChunk,
  IRMessage,
} from '@johnhenry/aimatey-types';
import { AdapterError, ErrorCode, ProviderError } from '@johnhenry/aimatey-errors';
import { platform } from 'node:os';

// Dynamic import to handle apple-foundation-models
let appleAI: any;

/**
 * Check if the current platform supports Apple Foundation Models.
 */
function isPlatformSupported(): boolean {
  // Only works on macOS 26+ with Apple Intelligence. Not version-checked here
  // (`platform() === 'darwin'` is the only gate) -- an unsupported macOS
  // version surfaces as a load/call failure from apple-foundation-models
  // itself rather than a preflight check.
  return platform() === 'darwin';
}

/**
 * Load apple-foundation-models with graceful failure.
 */
async function loadAppleAI() {
  if (!appleAI) {
    // Check platform first
    if (!isPlatformSupported()) {
      throw new AdapterError({
        code: ErrorCode.PROVIDER_ERROR,
        message:
          'Apple Foundation Models are only supported on macOS 26+ with Apple Intelligence. ' +
          `Current platform: ${platform()}`,
      });
    }

    try {
      // @ts-expect-error - Optional peer dependency, may not be installed
      appleAI = await import('apple-foundation-models');
    } catch (error) {
      throw new AdapterError({
        code: ErrorCode.PROVIDER_ERROR,
        message:
          'Failed to load apple-foundation-models. ' +
          'Install it with: npm install apple-foundation-models\n' +
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        cause: error instanceof Error ? error : undefined,
      });
    }
  }
  return appleAI;
}

// ============================================================================
// Configuration
// ============================================================================

export interface AppleConfig {
  /**
   * API key (not used for Apple Foundation Models, but required by base interface).
   */
  apiKey?: string;

  /**
   * System instructions for the model.
   */
  instructions?: string;

  /**
   * Maximum response tokens to generate.
   * @default 2048
   */
  maximumResponseTokens?: number;

  /**
   * Temperature for sampling (0.0-1.0).
   * @default 0.7
   */
  temperature?: number;

  /**
   * Sampling mode: 'random' for creative, 'greedy' for deterministic
   * (always picks the highest-probability token). Matches
   * `apple-foundation-models`'s real `SamplingMode` enum, which has no
   * 'default' member -- verified against the installed package's
   * `dist/types.d.ts`, not assumed.
   * @default 'greedy'
   */
  samplingMode?: 'random' | 'greedy';
}

// ============================================================================
// Apple MLX Backend Adapter
// ============================================================================

/**
 * Backend adapter for Apple MLX Framework.
 */
export class AppleBackend implements BackendAdapter {
  readonly metadata: AdapterMetadata;
  private config: AppleConfig;
  private initialized: boolean = false;

  constructor(config: AppleConfig = {}) {
    this.config = config;

    this.metadata = {
      name: 'apple-backend',
      version: '1.0.0',
      provider: 'Apple Foundation Models',
      capabilities: {
        streaming: true,
        multiModal: false,
        tools: true, // apple-foundation-models supports tools
        maxContextTokens: this.config.maximumResponseTokens || 2048,
        systemMessageStrategy: 'separate-parameter', // Uses Instructions object
        supportsMultipleSystemMessages: false,
        supportsTemperature: true,
        supportsTopP: false,
        supportsTopK: false,
        supportsSeed: false,
        supportsFrequencyPenalty: false,
        supportsPresencePenalty: false,
        maxStopSequences: 0,
      },
      config: {},
    };
  }

  /**
   * Initialize the Apple Foundation Models.
   * Must be called before execute().
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // Load the library to verify it's available
      await loadAppleAI();
      this.initialized = true;
    } catch (error) {
      throw new ProviderError({
        code: ErrorCode.PROVIDER_ERROR,
        message: `Failed to initialize Apple Foundation Models: ${error instanceof Error ? error.message : String(error)}`,
        isRetryable: false,
        provenance: {
          backend: this.metadata.name,
        },
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Execute non-streaming chat completion request.
   */
  async execute(request: IRChatRequest, _signal?: AbortSignal): Promise<IRChatResponse> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const ai = await loadAppleAI();

      // Get the default model
      const model = ai.SystemLanguageModel.default;

      // Check if model is available
      if (!model.isAvailable) {
        throw new ProviderError({
          code: ErrorCode.PROVIDER_ERROR,
          message: `Apple Foundation Model is not available. Status: ${model.availability}`,
          isRetryable: false,
          provenance: { backend: this.metadata.name },
        });
      }

      // Extract system message as instructions
      const systemMessages = request.messages.filter((m) => m.role === 'system');
      const instructions =
        systemMessages.length > 0
          ? typeof systemMessages[0]?.content === 'string'
            ? systemMessages[0].content
            : ''
          : this.config.instructions;

      // Create Instructions object if we have instructions
      const instructionsObj = instructions ? new ai.Instructions(instructions) : undefined;

      // Create session with model and instructions
      const session = new ai.LanguageModelSession(
        model,
        undefined, // guardrails (use default)
        [], // tools (empty for now)
        instructionsObj
      );

      // Convert non-system messages to a single prompt
      const userMessages = request.messages.filter((m) => m.role !== 'system');
      const prompt = userMessages
        .map((msg) => (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)))
        .join('\n\n');

      // Prepare generation options
      const options: any = {};
      if (request.parameters?.temperature !== undefined) {
        options.temperature = request.parameters.temperature;
      } else if (this.config.temperature !== undefined) {
        options.temperature = this.config.temperature;
      }

      if (request.parameters?.maxTokens !== undefined) {
        options.maximumResponseTokens = request.parameters.maxTokens;
      } else if (this.config.maximumResponseTokens !== undefined) {
        options.maximumResponseTokens = this.config.maximumResponseTokens;
      }

      if (this.config.samplingMode) {
        options.sampling =
          this.config.samplingMode === 'random' ? ai.SamplingMode.Random : ai.SamplingMode.Greedy;
      }

      // Generate response
      const response = await session.respond(prompt, options);

      // Close session to cleanup
      await session.close();

      const message: IRMessage = {
        role: 'assistant',
        content: response.content,
      };

      return {
        message,
        finishReason: 'stop',
        metadata: {
          requestId: request.metadata.requestId,
          timestamp: Date.now(),
          provenance: {
            ...request.metadata.provenance,
            backend: this.metadata.name,
          },
        },
      };
    } catch (error) {
      throw new ProviderError({
        code: ErrorCode.PROVIDER_ERROR,
        message: `Apple Foundation Models execution failed: ${error instanceof Error ? error.message : String(error)}`,
        isRetryable: true,
        provenance: {
          backend: this.metadata.name,
        },
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Execute streaming chat completion request using Apple Foundation Models streaming.
   */
  async *executeStream(request: IRChatRequest, _signal?: AbortSignal): IRChatStream {
    if (!this.initialized) {
      await this.initialize();
    }

    let session: any = null;
    let sequence = 0;

    try {
      const ai = await loadAppleAI();

      // Get the default model
      const model = ai.SystemLanguageModel.default;

      // Check if model is available
      if (!model.isAvailable) {
        throw new ProviderError({
          code: ErrorCode.PROVIDER_ERROR,
          message: `Apple Foundation Model is not available. Status: ${model.availability}`,
          isRetryable: false,
          provenance: { backend: this.metadata.name },
        });
      }

      // Extract system message as instructions
      const systemMessages = request.messages.filter((m) => m.role === 'system');
      const instructions =
        systemMessages.length > 0
          ? typeof systemMessages[0]?.content === 'string'
            ? systemMessages[0].content
            : ''
          : this.config.instructions;

      // Create Instructions object if we have instructions
      const instructionsObj = instructions ? new ai.Instructions(instructions) : undefined;

      // Create session with model and instructions
      session = new ai.LanguageModelSession(
        model,
        undefined, // guardrails (use default)
        [], // tools (empty for now)
        instructionsObj
      );

      // Convert non-system messages to a single prompt
      const userMessages = request.messages.filter((m) => m.role !== 'system');
      const prompt = userMessages
        .map((msg) => (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)))
        .join('\n\n');

      // Prepare generation options
      const options: any = {};
      if (request.parameters?.temperature !== undefined) {
        options.temperature = request.parameters.temperature;
      } else if (this.config.temperature !== undefined) {
        options.temperature = this.config.temperature;
      }

      if (request.parameters?.maxTokens !== undefined) {
        options.maximumResponseTokens = request.parameters.maxTokens;
      } else if (this.config.maximumResponseTokens !== undefined) {
        options.maximumResponseTokens = this.config.maximumResponseTokens;
      }

      if (this.config.samplingMode) {
        options.sampling =
          this.config.samplingMode === 'random' ? ai.SamplingMode.Random : ai.SamplingMode.Greedy;
      }

      // Yield start chunk
      yield {
        type: 'start',
        sequence: sequence++,
        metadata: {
          ...request.metadata,
          provenance: {
            ...request.metadata.provenance,
            backend: this.metadata.name,
          },
        },
      } as IRStreamChunk;

      // Stream response using apple-foundation-models streaming API
      const stream = session.streamResponse(prompt, options);
      let fullContent = '';

      for await (const chunk of stream) {
        fullContent += chunk;
        yield {
          type: 'content',
          sequence: sequence++,
          delta: chunk,
          role: 'assistant',
        } as IRStreamChunk;
      }

      // Close session to cleanup
      await session.close();

      // Yield done chunk
      yield {
        type: 'done',
        sequence: sequence,
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: fullContent,
        },
      } as IRStreamChunk;
    } catch (error) {
      // Cleanup session if it was created
      if (session) {
        try {
          await session.close();
        } catch {
          // Ignore cleanup errors
        }
      }

      yield {
        type: 'error',
        sequence: sequence++,
        error: {
          code: error instanceof Error ? error.name : 'UNKNOWN_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      } as IRStreamChunk;
    }
  }

  /**
   * Convert IR request to Apple Foundation Models format.
   */
  fromIR(request: IRChatRequest): {
    prompt: string;
    instructions?: string;
    options: {
      temperature?: number;
      maximumResponseTokens?: number;
      sampling?: 'random' | 'greedy';
    };
  } {
    const systemMessages = request.messages.filter((m) => m.role === 'system');
    const instructions =
      systemMessages.length > 0
        ? typeof systemMessages[0]?.content === 'string'
          ? systemMessages[0].content
          : ''
        : this.config.instructions;

    // Convert non-system messages to prompt
    const userMessages = request.messages.filter((m) => m.role !== 'system');
    const prompt = userMessages
      .map((msg) => (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)))
      .join('\n\n');

    // Build options
    const options: any = {};
    if (request.parameters?.temperature !== undefined) {
      options.temperature = request.parameters.temperature;
    } else if (this.config.temperature !== undefined) {
      options.temperature = this.config.temperature;
    }

    if (request.parameters?.maxTokens !== undefined) {
      options.maximumResponseTokens = request.parameters.maxTokens;
    } else if (this.config.maximumResponseTokens !== undefined) {
      options.maximumResponseTokens = this.config.maximumResponseTokens;
    }

    if (this.config.samplingMode) {
      options.sampling = this.config.samplingMode;
    }

    return {
      prompt,
      instructions,
      options,
    };
  }

  /**
   * Convert Apple Foundation Models response to IR format.
   */
  toIR(response: { content: string }, originalRequest: IRChatRequest): IRChatResponse {
    return {
      message: {
        role: 'assistant',
        content: response.content,
      },
      finishReason: 'stop',
      metadata: {
        requestId: originalRequest.metadata.requestId,
        timestamp: Date.now(),
        provenance: {
          ...originalRequest.metadata.provenance,
          backend: this.metadata.name,
        },
      },
    };
  }

  /**
   * Health check.
   */
  healthCheck(): Promise<boolean> {
    try {
      return Promise.resolve(this.initialized || isPlatformSupported());
    } catch {
      return Promise.resolve(false);
    }
  }
}
