/**
 * Ollama Frontend Adapter
 *
 * Adapts Ollama's `/api/chat` format to Universal IR and back, including
 * tools (`tools` in, `message.tool_calls` out, `role: 'tool'` results),
 * images, `format` (structured output) and `options`.
 *
 * @module
 */

import type { FrontendAdapter, AdapterMetadata } from '@johnhenry/aimatey-types';
import type {
  IRChatRequest,
  IRChatResponse,
  IRChatStream,
  IRMessage,
  IRTool,
  IRUsage,
  JSONSchema,
  MessageContent,
  ToolUseContent,
} from '@johnhenry/aimatey-types';
import type { StreamConversionOptions } from '@johnhenry/aimatey-types';
import { resolveServedModel } from '@johnhenry/aimatey-types';
import { AdapterConversionError, ErrorCode } from '@johnhenry/aimatey-errors';

// ============================================================================
// Ollama API Types
// ============================================================================

/** A tool call in an assistant message (`message.tool_calls[]`). */
export interface OllamaToolCall {
  /** Call id (recent Ollama versions send one) */
  id?: string;
  function: {
    /** Position of the call in the turn */
    index?: number;
    /** Name of the tool */
    name: string;
    /** Arguments as a JSON object (not a JSON string, unlike OpenAI) */
    arguments?: Record<string, unknown>;
  };
}

/** A tool definition as `/api/chat` accepts it (OpenAI's function-tool shape). */
export interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/**
 * Ollama message structure.
 *
 * @see OllamaRequest
 */
export interface OllamaMessage {
  /** Message role */
  role: 'system' | 'user' | 'assistant' | 'tool';

  /** Text content */
  content: string;

  /** Base64-encoded images (no data: prefix) */
  images?: string[];

  /** Assistant messages: the tool calls the model made */
  tool_calls?: OllamaToolCall[];

  /** `role: 'tool'` messages: the tool the result belongs to */
  tool_name?: string;

  /** `role: 'tool'` messages: the id of the call answered (when calls had ids) */
  tool_call_id?: string;

  /** Assistant messages: the thinking trace, when `think` was on */
  thinking?: string;
}

/**
 * Ollama `/api/chat` request.
 *
 * @see https://docs.ollama.com/api/chat
 *
 * @example
 * ```typescript
 * const request: OllamaRequest = {
 *   model: 'llama3.1:8b',
 *   messages: [{ role: 'user', content: 'Weather in Paris?' }],
 *   tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
 *   options: { temperature: 0.7, num_predict: 256 },
 *   stream: false,
 * };
 * ```
 */
export interface OllamaRequest {
  /** Model name (e.g. 'llama3.1:8b') */
  model: string;

  /** Conversation messages */
  messages: OllamaMessage[];

  /** Tools the model may call */
  tools?: OllamaTool[];

  /** `'json'` or a JSON Schema the output must follow */
  format?: 'json' | Record<string, unknown>;

  /** Model options */
  options?: {
    /** Sampling temperature */
    temperature?: number;

    /** Nucleus sampling parameter */
    top_p?: number;

    /** Top-K sampling parameter */
    top_k?: number;

    /** Maximum tokens to generate */
    num_predict?: number;

    /** Stop sequences */
    stop?: string[] | string;

    /** Seed for deterministic sampling */
    seed?: number;

    /** Frequency penalty */
    frequency_penalty?: number;

    /** Presence penalty */
    presence_penalty?: number;

    /** Ollama's repetition penalty (IR `parameters.custom.repeatPenalty`) */
    repeat_penalty?: number;
  };

  /** Stream the response (Ollama's own default is true) */
  stream?: boolean;
}

/**
 * Ollama `/api/chat` response. Also the shape of each streamed NDJSON line:
 * partial messages with `done: false`, then a last one with `done: true`,
 * `done_reason` and the token counts.
 */
export interface OllamaResponse {
  /** Model that generated the response */
  model: string;

  /** ISO 8601 timestamp */
  created_at: string;

  /** The assistant message (or a partial one, when streaming) */
  message: OllamaMessage;

  /** True on the last (or only) response */
  done: boolean;

  /** Why generation stopped: 'stop', 'length', ... (last response only) */
  done_reason?: string;

  /** Total time in nanoseconds */
  total_duration?: number;

  /** Model load time in nanoseconds */
  load_duration?: number;

  /** Tokens in the prompt */
  prompt_eval_count?: number;

  /** Tokens generated */
  eval_count?: number;
}

/** An in-stream error, as Ollama reports one (`{"error": "..."}`). The stream ends after it. */
export interface OllamaStreamError {
  error: string;
}

/** Anything `OllamaFrontendAdapter.fromIRStream` yields. */
export type OllamaStreamEvent = OllamaResponse | OllamaStreamError;

/** True when a value yielded by `OllamaFrontendAdapter.fromIRStream` is an error. */
export function isOllamaStreamError(event: unknown): event is OllamaStreamError {
  return (
    typeof event === 'object' &&
    event !== null &&
    typeof (event as { error?: unknown }).error === 'string'
  );
}

// ============================================================================
// Helpers
// ============================================================================

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Ollama's images are bare base64: sniff the media type from the first bytes (PNG when unknown). */
function imageMediaType(b64: string): string {
  if (b64.startsWith('/9j/')) {
    return 'image/jpeg';
  }
  if (b64.startsWith('R0lGOD')) {
    return 'image/gif';
  }
  if (b64.startsWith('UklGR')) {
    return 'image/webp';
  }
  return 'image/png';
}

function ollamaUsage(
  usage: Partial<IRUsage> | undefined
): Pick<OllamaResponse, 'prompt_eval_count' | 'eval_count'> {
  if (!usage) {
    return {};
  }
  return {
    ...(usage.promptTokens !== undefined ? { prompt_eval_count: usage.promptTokens } : {}),
    ...(usage.completionTokens !== undefined ? { eval_count: usage.completionTokens } : {}),
  };
}

function doneReason(finishReason: IRChatResponse['finishReason']): string {
  // Ollama reports 'length' when num_predict was hit and 'stop' otherwise,
  // including after tool calls.
  return finishReason === 'length' ? 'length' : 'stop';
}

function toolCallOf(
  block: Pick<ToolUseContent, 'id' | 'name' | 'input'>,
  index: number
): OllamaToolCall {
  return { id: block.id, function: { index, name: block.name, arguments: { ...block.input } } };
}

// ============================================================================
// Ollama Frontend Adapter
// ============================================================================

export class OllamaFrontendAdapter implements FrontendAdapter<
  OllamaRequest,
  OllamaResponse,
  OllamaStreamEvent
> {
  readonly metadata: AdapterMetadata = {
    name: 'ollama-frontend',
    version: '1.0.0',
    provider: 'Ollama',
    capabilities: {
      streaming: true,
      multiModal: true,
      tools: true,
      systemMessageStrategy: 'in-messages',
      supportsMultipleSystemMessages: false,
    },
  };

  /**
   * Convert an Ollama `/api/chat` request to Universal IR.
   *
   * - `tools` become IR tools.
   * - An assistant message's `tool_calls` become `tool_use` blocks (ids kept,
   *   or generated); a `role: 'tool'` message becomes a `tool_result` matched
   *   by `tool_call_id`, or by `tool_name` in call order.
   * - `images` become base64 image blocks.
   * - `format` (`'json'` or a schema) becomes `responseFormat`.
   * - `options` map onto IR parameters (`repeat_penalty` as `custom.repeatPenalty`).
   */
  toIR(request: OllamaRequest): Promise<IRChatRequest> {
    try {
      if (!Array.isArray(request.messages)) {
        throw new Error('an Ollama chat request needs a messages array');
      }

      // tool name -> ids of its calls not yet answered
      const pendingByName = new Map<string, string[]>();
      let callCounter = 0;
      const messages: IRMessage[] = [];

      for (const msg of request.messages) {
        const text = typeof msg.content === 'string' ? msg.content : '';

        if (msg.role === 'tool') {
          const name = msg.tool_name ?? (msg as { name?: string }).name ?? '';
          let toolUseId: string;
          if (msg.tool_call_id) {
            toolUseId = msg.tool_call_id;
            const queue = pendingByName.get(name);
            const at = queue?.indexOf(msg.tool_call_id) ?? -1;
            if (queue && at >= 0) {
              queue.splice(at, 1);
            }
          } else {
            toolUseId = pendingByName.get(name)?.shift() ?? `call_${name}`;
          }
          messages.push({
            role: 'tool',
            content: [{ type: 'tool_result', toolUseId, content: text }],
          });
          continue;
        }

        const blocks: MessageContent[] = [];
        if (text) {
          blocks.push({ type: 'text', text });
        }
        for (const image of msg.images ?? []) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', mediaType: imageMediaType(image), data: image },
          });
        }
        for (const call of msg.tool_calls ?? []) {
          const name = call.function?.name ?? '';
          const id = call.id ?? `call_${callCounter++}`;
          pendingByName.set(name, [...(pendingByName.get(name) ?? []), id]);
          let input: unknown = call.function?.arguments ?? {};
          if (typeof input === 'string') {
            try {
              input = JSON.parse(input);
            } catch {
              input = {};
            }
          }
          blocks.push({
            type: 'tool_use',
            id,
            name,
            input: isObject(input) ? input : {},
          });
        }

        messages.push({
          role: msg.role,
          content: blocks.every((b) => b.type === 'text') ? text : blocks,
        });
      }

      const tools: IRTool[] = (request.tools ?? []).map(({ function: f }) => ({
        name: f.name,
        description: f.description ?? '',
        parameters: (f.parameters ?? { type: 'object', properties: {} }) as unknown as JSONSchema,
      }));

      const schema =
        request.format === 'json'
          ? { type: 'object' }
          : isObject(request.format)
            ? request.format
            : undefined;

      const o = request.options ?? {};
      const parameters: Record<string, unknown> = {
        model: request.model,
        temperature: o.temperature,
        topP: o.top_p,
        topK: o.top_k,
        maxTokens: o.num_predict,
        stopSequences: typeof o.stop === 'string' ? [o.stop] : o.stop,
        seed: o.seed,
        frequencyPenalty: o.frequency_penalty,
        presencePenalty: o.presence_penalty,
        custom: o.repeat_penalty !== undefined ? { repeatPenalty: o.repeat_penalty } : undefined,
      };

      return Promise.resolve({
        messages,
        ...(tools.length > 0 ? { tools } : {}),
        ...(schema
          ? {
              responseFormat: {
                type: 'json_schema' as const,
                schema: schema as unknown as JSONSchema,
              },
            }
          : {}),
        parameters: Object.fromEntries(
          Object.entries(parameters).filter(([, v]) => v !== undefined)
        ) as IRChatRequest['parameters'],
        metadata: {
          requestId: `ollama-${crypto.randomUUID()}`,
          timestamp: Date.now(),
          provenance: { frontend: this.metadata.name },
        },
        stream: request.stream,
      });
    } catch (error) {
      return Promise.reject(
        new AdapterConversionError({
          code: ErrorCode.ADAPTER_CONVERSION_ERROR,
          message: `Failed to convert Ollama request to IR: ${error instanceof Error ? error.message : String(error)}`,
          provenance: { frontend: this.metadata.name },
          cause: error instanceof Error ? error : undefined,
        })
      );
    }
  }

  /**
   * Convert a Universal IR response to an Ollama `/api/chat` response:
   * text in `message.content`, `tool_use` blocks in `message.tool_calls`
   * (arguments as objects), `done_reason` and the token counts.
   */
  fromIR(response: IRChatResponse): Promise<OllamaResponse> {
    const content = response.message.content;
    const text =
      typeof content === 'string'
        ? content
        : content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const calls =
      typeof content === 'string'
        ? []
        : content.filter((b): b is ToolUseContent => b.type === 'tool_use');

    return Promise.resolve({
      // Was `metadata.custom?.model`, which nothing writes onto an `IRChatResponse` -- a dead
      // read that always took the constant fallback, the same defect class as #112.
      model: resolveServedModel(response.metadata.provenance) ?? 'unknown',
      created_at: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: text,
        ...(calls.length > 0 ? { tool_calls: calls.map((c, i) => toolCallOf(c, i)) } : {}),
      },
      done: true,
      done_reason: doneReason(response.finishReason),
      ...ollamaUsage(response.usage),
    });
  }

  /**
   * Convert a Universal IR stream to Ollama's streamed responses (one object
   * per NDJSON line; serialising them is the transport's job).
   *
   * Text arrives as partial messages with `done: false`; tool calls are
   * gathered and sent whole (as Ollama does) in one partial message just
   * before the last response, which has `done: true`, `done_reason` and the
   * token counts. A failed stream ends with `{ error }`, as Ollama reports it.
   */
  async *fromIRStream(
    stream: IRChatStream,
    _options?: StreamConversionOptions
  ): AsyncGenerator<OllamaStreamEvent, void, undefined> {
    let model = 'unknown';
    let usage: Partial<IRUsage> | undefined;
    const calls = new Map<string, { id: string; name: string; args: string }>();
    const head = () => ({ model, created_at: new Date().toISOString() });

    try {
      for await (const chunk of stream) {
        switch (chunk.type) {
          case 'start':
            model = resolveServedModel(chunk.metadata.provenance) ?? model;
            break;

          case 'content':
            if (chunk.delta) {
              yield {
                ...head(),
                message: { role: 'assistant', content: chunk.delta },
                done: false,
              };
            }
            break;

          case 'tool_use': {
            const call = calls.get(chunk.id) ?? { id: chunk.id, name: chunk.name, args: '' };
            call.args += chunk.inputDelta ?? '';
            calls.set(chunk.id, call);
            break;
          }

          case 'metadata':
            if (chunk.usage) {
              usage = { ...usage, ...chunk.usage };
            }
            break;

          case 'done': {
            const toolUses: Array<Pick<ToolUseContent, 'id' | 'name' | 'input'>> = [];
            if (calls.size > 0) {
              for (const c of calls.values()) {
                let input: Record<string, unknown> = {};
                try {
                  const parsed: unknown = c.args ? JSON.parse(c.args) : {};
                  if (isObject(parsed)) {
                    input = parsed;
                  }
                } catch {
                  // Unparseable arguments: send the call with empty arguments rather than drop it.
                }
                toolUses.push({ id: c.id, name: c.name, input });
              }
            } else if (chunk.message && typeof chunk.message.content !== 'string') {
              for (const b of chunk.message.content) {
                if (b.type === 'tool_use') {
                  toolUses.push(b);
                }
              }
            }
            if (toolUses.length > 0) {
              yield {
                ...head(),
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: toolUses.map((t, i) => toolCallOf(t, i)),
                },
                done: false,
              };
            }
            yield {
              ...head(),
              message: { role: 'assistant', content: '' },
              done: true,
              done_reason: doneReason(chunk.finishReason),
              ...ollamaUsage(chunk.usage ?? usage),
            };
            break;
          }

          case 'error':
            yield { error: chunk.error.message };
            return;
        }
      }
    } catch (error) {
      yield { error: error instanceof Error ? error.message : String(error) };
    }
  }
}
