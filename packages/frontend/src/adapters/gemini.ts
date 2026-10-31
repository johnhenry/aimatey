/**
 * Gemini Frontend Adapter
 *
 * Adapts the Google Gemini API (`generateContent` / `streamGenerateContent`)
 * to Universal IR and back: `contents`/`parts` (text, inlineData, fileData,
 * functionCall, functionResponse), `systemInstruction`, `tools[].functionDeclarations`,
 * `toolConfig`, `generationConfig` (including structured output), and
 * `GenerateContentResponse` objects with `finishReason` and `usageMetadata`,
 * streamed or not.
 *
 * Gemini's REST API accepts both camelCase and snake_case field names; so does
 * this adapter's `toIR`. Responses are produced in camelCase, as Gemini sends them.
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
  FinishReason,
  ToolResultContent,
  ToolUseContent,
} from '@johnhenry/aimatey-types';
import type { StreamConversionOptions } from '@johnhenry/aimatey-types';
import { resolveServedModel } from '@johnhenry/aimatey-types';
import { AdapterConversionError, ErrorCode } from '@johnhenry/aimatey-errors';

// ============================================================================
// Gemini API Types
// ============================================================================

/** A function call the model asks for (`Part.functionCall`). */
export interface GeminiFunctionCall {
  /** Optional call id; when present the matching `functionResponse` carries it back. */
  id?: string;
  /** Name of the declared function. */
  name: string;
  /** Arguments as a JSON object. */
  args?: Record<string, unknown>;
}

/** The result of a function call, sent back by the client (`Part.functionResponse`). */
export interface GeminiFunctionResponse {
  /** Id of the `functionCall` this answers, when the call had one. */
  id?: string;
  /** Name of the function that was called. */
  name: string;
  /** The function's output as a JSON object (an `error` key reports a failure). */
  response: Record<string, unknown>;
}

/**
 * One part of a Gemini `Content`.
 *
 * @see https://ai.google.dev/api/caching#Part
 */
export type GeminiPart =
  | { text: string; thought?: boolean; thoughtSignature?: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType?: string; fileUri: string } }
  | { functionCall: GeminiFunctionCall; thoughtSignature?: string }
  | { functionResponse: GeminiFunctionResponse };

/**
 * Gemini content structure for messages.
 *
 * Role is `user` or `model` (Gemini's name for the assistant); it may be
 * omitted on requests, where it defaults to `user`.
 *
 * @see https://ai.google.dev/api/caching#Content
 *
 * @example
 * ```typescript
 * const content: GeminiContent = {
 *   role: 'user',
 *   parts: [
 *     { text: 'What is in this image?' },
 *     { inlineData: { mimeType: 'image/jpeg', data: 'base64...' } },
 *   ],
 * };
 * ```
 */
export interface GeminiContent {
  /** Message role - 'user' or 'model' (Gemini's term for assistant) */
  role?: 'user' | 'model';

  /** Content parts */
  parts: GeminiPart[];
}

/** A function the model may call (`Tool.functionDeclarations[]`). */
export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  /** OpenAPI-subset schema of the arguments. */
  parameters?: Record<string, unknown>;
  /** JSON Schema of the arguments (alternative to `parameters`). */
  parametersJsonSchema?: Record<string, unknown>;
}

/** `toolConfig`: how the model may use the declared functions. */
export interface GeminiToolConfig {
  functionCallingConfig?: {
    /** AUTO (default), ANY (must call one), NONE (must not call), VALIDATED */
    mode?: 'AUTO' | 'ANY' | 'NONE' | 'VALIDATED' | 'MODE_UNSPECIFIED';
    /** Limits the functions the model may call (ANY / VALIDATED only). */
    allowedFunctionNames?: string[];
  };
}

/** `generationConfig` */
export interface GeminiGenerationConfig {
  /** Sampling temperature (passed through unmodified) */
  temperature?: number;
  /** Nucleus sampling parameter */
  topP?: number;
  /** Top-K sampling parameter */
  topK?: number;
  /** Maximum tokens to generate */
  maxOutputTokens?: number;
  /** Stop sequences */
  stopSequences?: string[];
  /** Number of candidates (only 1 is supported through IR) */
  candidateCount?: number;
  /** Seed for deterministic sampling */
  seed?: number;
  /** Presence penalty */
  presencePenalty?: number;
  /** Frequency penalty */
  frequencyPenalty?: number;
  /** `application/json` asks for JSON output */
  responseMimeType?: string;
  /** OpenAPI-subset schema of the JSON output */
  responseSchema?: Record<string, unknown>;
  /** JSON Schema of the JSON output (alternative to `responseSchema`) */
  responseJsonSchema?: Record<string, unknown>;
}

/**
 * Google Gemini `generateContent` / `streamGenerateContent` request body.
 *
 * The model is part of Gemini's URL (`models/{model}:generateContent`), not
 * of the body, so it is carried here in the optional `model` field (with or
 * without the `models/` prefix); set it from the URL when serving Gemini's
 * endpoints. Likewise `stream` says whether the call was `streamGenerateContent`.
 *
 * @see https://ai.google.dev/api/generate-content#method:-models.generatecontent
 *
 * @example
 * ```typescript
 * const request: GeminiRequest = {
 *   model: 'gemini-2.5-flash',
 *   contents: [{ role: 'user', parts: [{ text: 'Weather in Paris?' }] }],
 *   systemInstruction: { parts: [{ text: 'Be brief.' }] },
 *   tools: [{ functionDeclarations: [{ name: 'get_weather', parameters: { type: 'object' } }] }],
 *   generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
 * };
 * ```
 */
export interface GeminiRequest {
  /** Model name (from the URL), e.g. `gemini-2.5-flash` or `models/gemini-2.5-flash` */
  model?: string;

  /** Conversation contents (user and model turns) */
  contents: GeminiContent[];

  /** System instruction (separate from contents) */
  systemInstruction?: { role?: string; parts: Array<{ text: string }> } | string;

  /** Tools the model may call */
  tools?: Array<{ functionDeclarations?: GeminiFunctionDeclaration[] }>;

  /** Function calling configuration */
  toolConfig?: GeminiToolConfig;

  /** Generation parameters */
  generationConfig?: GeminiGenerationConfig;

  /** True for `streamGenerateContent` */
  stream?: boolean;
}

/** Why a Gemini candidate stopped. */
export type GeminiFinishReason =
  | 'FINISH_REASON_UNSPECIFIED'
  | 'STOP'
  | 'MAX_TOKENS'
  | 'SAFETY'
  | 'RECITATION'
  | 'LANGUAGE'
  | 'OTHER'
  | 'BLOCKLIST'
  | 'PROHIBITED_CONTENT'
  | 'SPII'
  | 'MALFORMED_FUNCTION_CALL';

/** Gemini `UsageMetadata`. */
export interface GeminiUsageMetadata {
  /** Tokens in the prompt */
  promptTokenCount: number;
  /** Tokens in all candidates */
  candidatesTokenCount: number;
  /** Total tokens (prompt + candidates + thoughts) */
  totalTokenCount: number;
  /** Tokens read from the context cache, when known */
  cachedContentTokenCount?: number;
  /** Thinking tokens, when known */
  thoughtsTokenCount?: number;
}

/**
 * Google Gemini `GenerateContentResponse`. Also the shape of every chunk of
 * `streamGenerateContent`: text arrives in chunks without `finishReason`, and
 * the last chunk carries `finishReason` and `usageMetadata`.
 *
 * @see https://ai.google.dev/api/generate-content#v1beta.GenerateContentResponse
 *
 * @example
 * ```typescript
 * const response: GeminiResponse = {
 *   candidates: [{
 *     content: { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] },
 *     finishReason: 'STOP',
 *     index: 0,
 *   }],
 *   usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 8, totalTokenCount: 23 },
 *   modelVersion: 'gemini-2.5-flash',
 * };
 * ```
 */
export interface GeminiResponse {
  /** Candidate responses (one through IR) */
  candidates: Array<{
    /** Generated content */
    content: GeminiContent;
    /** Why generation stopped; absent on stream chunks before the last */
    finishReason?: GeminiFinishReason;
    /** Candidate index */
    index?: number;
  }>;

  /** Token usage (on the response, or on the last stream chunk) */
  usageMetadata?: GeminiUsageMetadata;

  /** The model that answered */
  modelVersion?: string;

  /** Response id */
  responseId?: string;
}

/**
 * An in-stream error, as Google APIs report one (`google.rpc.Status` under
 * `error`). The stream ends after it.
 */
export interface GeminiStreamError {
  error: {
    /** HTTP status code */
    code: number;
    /** Error message */
    message: string;
    /** Canonical status, e.g. `INTERNAL`, `RESOURCE_EXHAUSTED` */
    status: string;
  };
}

/** Anything `GeminiFrontendAdapter.fromIRStream` yields. */
export type GeminiStreamEvent = GeminiResponse | GeminiStreamError;

/** True when a value yielded by `GeminiFrontendAdapter.fromIRStream` is an error. */
export function isGeminiStreamError(event: unknown): event is GeminiStreamError {
  return (
    typeof event === 'object' &&
    event !== null &&
    'error' in event &&
    typeof (event as { error: unknown }).error === 'object' &&
    (event as { error: unknown }).error !== null
  );
}

// ============================================================================
// Helpers
// ============================================================================

type Loose = Record<string, unknown>;

const isObject = (v: unknown): v is Loose =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A string field's value, or '' when it is missing or not a string. */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Read a field by its camelCase name or its snake_case alias. */
function field<T = unknown>(obj: unknown, camel: string, snake: string): T | undefined {
  if (!isObject(obj)) {
    return undefined;
  }
  return (obj[camel] ?? obj[snake]) as T | undefined;
}

function blockKind(mimeType: string | undefined): 'image' | 'audio' | 'video' | 'document' {
  const mt = mimeType ?? '';
  if (mt.startsWith('image/')) {
    return 'image';
  }
  if (mt.startsWith('audio/')) {
    return 'audio';
  }
  if (mt.startsWith('video/')) {
    return 'video';
  }
  return 'document';
}

const FINISH_TO_GEMINI: Record<FinishReason, GeminiFinishReason> = {
  stop: 'STOP',
  tool_calls: 'STOP', // Gemini reports STOP for a turn that ends in function calls
  length: 'MAX_TOKENS',
  content_filter: 'SAFETY',
  error: 'OTHER',
  cancelled: 'OTHER',
};

/** IR error code -> HTTP status and Google canonical status. */
function googleStatusOf(code: string): { code: number; status: string } {
  switch (code) {
    case ErrorCode.INVALID_API_KEY:
    case ErrorCode.MISSING_API_KEY:
    case ErrorCode.EXPIRED_API_KEY:
    case 'AUTHENTICATION':
      return { code: 401, status: 'UNAUTHENTICATED' };
    case ErrorCode.INSUFFICIENT_PERMISSIONS:
    case 'AUTHORIZATION':
      return { code: 403, status: 'PERMISSION_DENIED' };
    case ErrorCode.RATE_LIMIT_EXCEEDED:
    case ErrorCode.QUOTA_EXCEEDED:
    case 'RATE_LIMIT':
      return { code: 429, status: 'RESOURCE_EXHAUSTED' };
    case ErrorCode.INVALID_REQUEST:
    case ErrorCode.INVALID_MESSAGE_FORMAT:
    case ErrorCode.INVALID_PARAMETERS:
    case ErrorCode.CONTEXT_LENGTH_EXCEEDED:
    case 'VALIDATION':
      return { code: 400, status: 'INVALID_ARGUMENT' };
    case ErrorCode.UNSUPPORTED_MODEL:
      return { code: 404, status: 'NOT_FOUND' };
    case ErrorCode.PROVIDER_UNAVAILABLE:
    case ErrorCode.PROVIDER_OVERLOADED:
    case ErrorCode.MODEL_LOADING:
      return { code: 503, status: 'UNAVAILABLE' };
    case ErrorCode.PROVIDER_TIMEOUT:
    case ErrorCode.CONNECTION_TIMEOUT:
      return { code: 504, status: 'DEADLINE_EXCEEDED' };
    case ErrorCode.STREAM_CANCELLED:
      return { code: 499, status: 'CANCELLED' };
    default:
      return { code: 500, status: 'INTERNAL' };
  }
}

function toGeminiUsage(usage: Partial<IRUsage> | undefined): GeminiUsageMetadata | undefined {
  if (!usage) {
    return undefined;
  }
  const prompt = usage.promptTokens ?? 0;
  const completion = usage.completionTokens ?? 0;
  return {
    promptTokenCount: prompt,
    candidatesTokenCount: completion,
    totalTokenCount: usage.totalTokens ?? prompt + completion,
  };
}

/** A `functionCall` part for an IR tool_use block, keeping Gemini's own id and thought signature. */
function functionCallPart(
  block: Pick<ToolUseContent, 'id' | 'name' | 'input' | 'providerMetadata'>
): GeminiPart {
  const meta = (block.providerMetadata?.gemini ?? {}) as {
    thoughtSignature?: string;
    callId?: string;
  };
  return {
    functionCall: { id: meta.callId ?? block.id, name: block.name, args: block.input ?? {} },
    ...(meta.thoughtSignature ? { thoughtSignature: meta.thoughtSignature } : {}),
  };
}

// ============================================================================
// Gemini Frontend Adapter
// ============================================================================

export class GeminiFrontendAdapter implements FrontendAdapter<
  GeminiRequest,
  GeminiResponse,
  GeminiStreamEvent
> {
  readonly metadata: AdapterMetadata = {
    name: 'gemini-frontend',
    version: '1.0.0',
    provider: 'Google Gemini',
    capabilities: {
      streaming: true,
      multiModal: true,
      tools: true,
      systemMessageStrategy: 'separate-parameter',
      supportsMultipleSystemMessages: false,
      supportsTemperature: true,
      supportsTopP: true,
      supportsTopK: true,
    },
  };

  /**
   * Convert a Gemini `generateContent` request to Universal IR.
   *
   * - `model` (from the URL, `models/` prefix optional) becomes `parameters.model`.
   * - `systemInstruction` becomes a leading system message.
   * - `functionCall` parts become `tool_use` blocks (call id and `thoughtSignature`
   *   kept in `providerMetadata.gemini`); `functionResponse` parts become a `tool`
   *   message of `tool_result` blocks, matched to their call by id, or by name in
   *   call order when Gemini sent no ids.
   * - `fileData` parts become URL sources; `inlineData` parts base64 sources.
   * - `tools[].functionDeclarations` become IR tools; `toolConfig` becomes `toolChoice`.
   * - `generationConfig` maps onto IR parameters; `responseSchema` /
   *   `responseJsonSchema` / `responseMimeType: application/json` onto `responseFormat`.
   *
   * Temperature is passed through unmodified, like every other frontend adapter.
   */
  toIR(request: GeminiRequest): Promise<IRChatRequest> {
    try {
      const raw = request as unknown as Loose;
      if (!Array.isArray(raw.contents)) {
        throw new Error('a Gemini request needs a contents array');
      }

      const messages: IRMessage[] = [];

      const sys = field<GeminiRequest['systemInstruction']>(
        raw,
        'systemInstruction',
        'system_instruction'
      );
      if (sys) {
        const text =
          typeof sys === 'string'
            ? sys
            : (sys.parts ?? []).map((p) => (typeof p.text === 'string' ? p.text : '')).join('');
        messages.push({ role: 'system', content: text });
      }

      // function name -> ids of its calls not yet answered (for responses without ids)
      const pendingByName = new Map<string, string[]>();
      let callCounter = 0;

      for (const content of raw.contents as unknown[]) {
        if (!isObject(content) || !Array.isArray(content.parts)) {
          throw new Error('every content needs a parts array');
        }
        const role = content.role === 'model' ? 'assistant' : 'user';
        const blocks: MessageContent[] = [];
        const results: ToolResultContent[] = [];

        for (const part of content.parts as unknown[]) {
          if (!isObject(part)) {
            throw new Error('every part must be an object');
          }
          const inline = field<Loose>(part, 'inlineData', 'inline_data');
          const file = field<Loose>(part, 'fileData', 'file_data');
          const call = field<Loose>(part, 'functionCall', 'function_call');
          const reply = field<Loose>(part, 'functionResponse', 'function_response');

          if (typeof part.text === 'string') {
            // Thought summaries are the model's own reasoning, not conversation text.
            if (part.thought === true) {
              continue;
            }
            blocks.push({ type: 'text', text: part.text });
          } else if (inline) {
            const mediaType = str(field(inline, 'mimeType', 'mime_type'));
            blocks.push({
              type: blockKind(mediaType),
              source: { type: 'base64', mediaType, data: str(inline.data) },
            } as MessageContent);
          } else if (file) {
            const mediaType = field<string>(file, 'mimeType', 'mime_type');
            blocks.push({
              type: blockKind(mediaType),
              source: { type: 'url', url: str(field(file, 'fileUri', 'file_uri')) },
            } as MessageContent);
          } else if (call) {
            const name = str(call.name);
            const nativeId = typeof call.id === 'string' && call.id ? call.id : undefined;
            const id = nativeId ?? `call_${callCounter++}`;
            pendingByName.set(name, [...(pendingByName.get(name) ?? []), id]);
            const signature = field<string>(part, 'thoughtSignature', 'thought_signature');
            const gemini = {
              ...(signature ? { thoughtSignature: signature } : {}),
              ...(nativeId ? { callId: nativeId } : {}),
            };
            blocks.push({
              type: 'tool_use',
              id,
              name,
              input: isObject(call.args) ? call.args : {},
              ...(Object.keys(gemini).length > 0 ? { providerMetadata: { gemini } } : {}),
            });
          } else if (reply) {
            const name = str(reply.name);
            const replyId = typeof reply.id === 'string' && reply.id ? reply.id : undefined;
            const queue = pendingByName.get(name);
            let toolUseId: string;
            if (replyId) {
              toolUseId = replyId;
              if (queue) {
                const at = queue.indexOf(replyId);
                if (at >= 0) {
                  queue.splice(at, 1);
                }
              }
            } else {
              toolUseId = queue?.shift() ?? `call_${name}`;
            }
            const response = isObject(reply.response) ? reply.response : {};
            const keys = Object.keys(response);
            results.push({
              type: 'tool_result',
              toolUseId,
              content: JSON.stringify(response),
              ...(keys.length === 1 && keys[0] === 'error' ? { isError: true } : {}),
            });
          } else {
            throw new Error(
              'a part needs text, inlineData, fileData, functionCall or functionResponse'
            );
          }
        }

        if (results.length > 0) {
          messages.push({ role: 'tool', content: results });
        }
        if (blocks.length > 0) {
          const allText = blocks.every((b) => b.type === 'text');
          messages.push({
            role,
            content: allText
              ? blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
              : blocks,
          });
        }
      }

      // Tools
      const declarations = ((raw.tools as unknown[] | undefined) ?? []).flatMap(
        (t) =>
          field<GeminiFunctionDeclaration[]>(t, 'functionDeclarations', 'function_declarations') ??
          []
      );
      const tools: IRTool[] = declarations.map((f) => ({
        name: f.name,
        description: f.description ?? '',
        parameters: (f.parametersJsonSchema ??
          (f as unknown as Loose).parameters_json_schema ??
          f.parameters ?? { type: 'object', properties: {} }) as unknown as JSONSchema,
      }));

      // Tool choice
      const fcc = field<Loose>(
        field(raw, 'toolConfig', 'tool_config'),
        'functionCallingConfig',
        'function_calling_config'
      );
      const mode = str(fcc?.mode).toUpperCase();
      const allowed = field<string[]>(fcc, 'allowedFunctionNames', 'allowed_function_names');
      let toolChoice: IRChatRequest['toolChoice'];
      if (mode === 'NONE') {
        toolChoice = 'none';
      } else if (mode === 'ANY' || mode === 'VALIDATED') {
        toolChoice = allowed?.length === 1 ? { name: allowed[0]! } : 'required';
      } else if (mode === 'AUTO') {
        toolChoice = 'auto';
      }

      // Generation config
      const g = field<Loose>(raw, 'generationConfig', 'generation_config') ?? {};
      const schema =
        field<Loose>(g, 'responseJsonSchema', 'response_json_schema') ??
        field<Loose>(g, 'responseSchema', 'response_schema') ??
        (field(g, 'responseMimeType', 'response_mime_type') === 'application/json'
          ? { type: 'object' }
          : undefined);

      const modelName =
        typeof raw.model === 'string' ? raw.model.replace(/^models\//, '') : undefined;

      const parameters: Record<string, unknown> = {
        model: modelName,
        // Pass temperature through unmodified, like every other frontend
        // adapter -- do not rescale it (an explicit 0 must survive).
        temperature: g.temperature,
        topP: field(g, 'topP', 'top_p'),
        topK: field(g, 'topK', 'top_k'),
        maxTokens: field(g, 'maxOutputTokens', 'max_output_tokens'),
        stopSequences: field(g, 'stopSequences', 'stop_sequences'),
        seed: g.seed,
        presencePenalty: field(g, 'presencePenalty', 'presence_penalty'),
        frequencyPenalty: field(g, 'frequencyPenalty', 'frequency_penalty'),
      };

      return Promise.resolve({
        messages,
        ...(tools.length > 0 ? { tools } : {}),
        ...(toolChoice ? { toolChoice } : {}),
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
        stream: request.stream ?? false,
        metadata: {
          requestId: 'gemini-' + crypto.randomUUID(),
          timestamp: Date.now(),
          provenance: { frontend: this.metadata.name },
        },
      });
    } catch (error) {
      return Promise.reject(
        new AdapterConversionError({
          code: ErrorCode.ADAPTER_CONVERSION_ERROR,
          message: `Failed to convert Gemini request to IR: ${error instanceof Error ? error.message : String(error)}`,
          provenance: { frontend: this.metadata.name },
          cause: error instanceof Error ? error : undefined,
        })
      );
    }
  }

  /**
   * Convert a Universal IR response to a Gemini `GenerateContentResponse`.
   *
   * Text becomes text parts, `tool_use` blocks become `functionCall` parts
   * (with their call id and `thoughtSignature`), media becomes `inlineData` /
   * `fileData`; `finishReason`, `usageMetadata`, `modelVersion` and `responseId`
   * are filled from the IR response.
   */
  fromIR(response: IRChatResponse): Promise<GeminiResponse> {
    const parts = this.partsFromIR(response.message.content);
    return Promise.resolve({
      candidates: [
        {
          content: { role: 'model', parts },
          finishReason: FINISH_TO_GEMINI[response.finishReason] ?? 'OTHER',
          index: 0,
        },
      ],
      ...(response.usage ? { usageMetadata: toGeminiUsage(response.usage) } : {}),
      ...this.modelVersionOf(response.metadata.provenance),
      responseId: response.metadata.providerResponseId ?? response.metadata.requestId,
    });
  }

  /**
   * Convert a Universal IR stream to `streamGenerateContent` chunks.
   *
   * Yields one `GenerateContentResponse` object per text delta; function
   * calls are gathered and sent whole (as Gemini does) in the final chunk,
   * which also carries `finishReason` and `usageMetadata`. A failed stream
   * yields a final {@link GeminiStreamError} and ends. Framing (SSE
   * `data: ` lines for `?alt=sse`, or a JSON array) is the transport's job.
   */
  async *fromIRStream(
    stream: IRChatStream,
    _options?: StreamConversionOptions
  ): AsyncGenerator<GeminiStreamEvent, void, undefined> {
    let modelVersion: { modelVersion?: string } = {};
    let responseId: string | undefined;
    let usage: Partial<IRUsage> | undefined;
    const calls = new Map<
      string,
      {
        id: string;
        name: string;
        args: string;
        providerMetadata?: Readonly<Record<string, unknown>>;
      }
    >();

    const meta = () => ({ ...modelVersion, ...(responseId ? { responseId } : {}) });

    try {
      for await (const chunk of stream) {
        switch (chunk.type) {
          case 'start':
            modelVersion = this.modelVersionOf(chunk.metadata.provenance);
            responseId = chunk.metadata.providerResponseId ?? chunk.metadata.requestId;
            break;

          case 'content':
            if (chunk.delta) {
              yield {
                candidates: [
                  { content: { role: 'model', parts: [{ text: chunk.delta }] }, index: 0 },
                ],
                ...meta(),
              };
            }
            break;

          case 'tool_use': {
            const call = calls.get(chunk.id) ?? { id: chunk.id, name: chunk.name, args: '' };
            call.args += chunk.inputDelta ?? '';
            if (chunk.providerMetadata) {
              call.providerMetadata = chunk.providerMetadata;
            }
            calls.set(chunk.id, call);
            break;
          }

          case 'metadata':
            if (chunk.usage) {
              usage = { ...usage, ...chunk.usage };
            }
            if (chunk.metadata?.provenance) {
              modelVersion = { ...modelVersion, ...this.modelVersionOf(chunk.metadata.provenance) };
            }
            break;

          case 'done': {
            const toolUses: ToolUseContent[] = [];
            if (calls.size > 0) {
              for (const c of calls.values()) {
                let input: Record<string, unknown> = {};
                try {
                  const parsed: unknown = c.args ? JSON.parse(c.args) : {};
                  if (isObject(parsed)) {
                    input = parsed;
                  }
                } catch {
                  // Unparseable arguments: send the call with empty args rather than drop it.
                }
                toolUses.push({
                  type: 'tool_use',
                  id: c.id,
                  name: c.name,
                  input,
                  ...(c.providerMetadata ? { providerMetadata: c.providerMetadata } : {}),
                });
              }
            } else if (chunk.message && typeof chunk.message.content !== 'string') {
              for (const b of chunk.message.content) {
                if (b.type === 'tool_use') {
                  toolUses.push(b);
                }
              }
            }
            const parts: GeminiPart[] =
              toolUses.length > 0 ? toolUses.map((t) => functionCallPart(t)) : [{ text: '' }];
            const finalUsage = chunk.usage ?? usage;
            yield {
              candidates: [
                {
                  content: { role: 'model', parts },
                  finishReason: FINISH_TO_GEMINI[chunk.finishReason] ?? 'OTHER',
                  index: 0,
                },
              ],
              ...(finalUsage ? { usageMetadata: toGeminiUsage(finalUsage) } : {}),
              ...meta(),
            };
            break;
          }

          case 'error': {
            const { code, status } = googleStatusOf(chunk.error.code);
            yield { error: { code, message: chunk.error.message, status } };
            return;
          }
        }
      }
    } catch (error) {
      yield {
        error: {
          code: 500,
          message: error instanceof Error ? error.message : String(error),
          status: 'INTERNAL',
        },
      };
    }
  }

  // ==========================================================================
  // Private Helper Methods
  // ==========================================================================

  private modelVersionOf(provenance: IRChatResponse['metadata']['provenance']): {
    modelVersion?: string;
  } {
    const served = resolveServedModel(provenance);
    return served ? { modelVersion: served } : {};
  }

  private partsFromIR(content: string | readonly MessageContent[]): GeminiPart[] {
    if (typeof content === 'string') {
      return [{ text: content }];
    }
    const parts: GeminiPart[] = [];
    for (const block of content) {
      switch (block.type) {
        case 'text':
          parts.push({ text: block.text });
          break;
        case 'tool_use':
          parts.push(functionCallPart(block));
          break;
        case 'image':
        case 'audio':
        case 'video':
        case 'document': {
          const source = block.source as
            | { type: 'base64'; mediaType: string; data: string }
            | { type: 'url'; url: string; mediaType?: string }
            | { type: string };
          if (source.type === 'base64' && 'data' in source) {
            parts.push({ inlineData: { mimeType: source.mediaType, data: source.data } });
          } else if (source.type === 'url' && 'url' in source) {
            parts.push({
              fileData: {
                ...(source.mediaType ? { mimeType: source.mediaType } : {}),
                fileUri: source.url,
              },
            });
          }
          break;
        }
        default:
          // tool_result blocks do not appear in model output; anything else is dropped.
          break;
      }
    }
    return parts.length > 0 ? parts : [{ text: '' }];
  }
}
