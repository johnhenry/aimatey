/**
 * AWS Bedrock Backend Adapter
 *
 * Adapts Universal IR to AWS Bedrock Converse API.
 * AWS Bedrock provides unified access to multiple foundation models with AWS SigV4 authentication.
 *
 * @module
 */

import type {
  BackendAdapter,
  BackendAdapterConfig,
  AdapterMetadata,
} from '@johnhenry/aimatey-types';
import type {
  IRChatRequest,
  IRChatResponse,
  IRChatStream,
  IRMessage,
  IRStreamChunk,
  FinishReason,
} from '@johnhenry/aimatey-types';
import {
  NetworkError,
  ProviderError,
  StreamError,
  ErrorCode,
  createErrorFromHttpResponse,
} from '@johnhenry/aimatey-errors';
import { normalizeSystemMessages } from '@johnhenry/aimatey-utils';
import { getEffectiveStreamMode, mergeStreamingConfig } from '@johnhenry/aimatey-utils';
import {
  buildStructuredOutputFallbackMessages,
  extractStructuredOutputJSON,
  buildResponseFormatFallbackWarning,
  estimateTokens,
} from '../shared.js';

// ============================================================================
// AWS Bedrock API Types (Converse API)
// ============================================================================

export type BedrockMessageContent =
  | { text: string }
  | { image: { format: 'png' | 'jpeg' | 'gif' | 'webp'; source: { bytes: string } } };

export interface BedrockMessage {
  role: 'user' | 'assistant';
  content: BedrockMessageContent[];
}

export interface BedrockSystemContent {
  text: string;
}

export interface BedrockInferenceConfig {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stopSequences?: string[];
}

export interface BedrockRequest {
  modelId: string;
  messages: BedrockMessage[];
  system?: BedrockSystemContent[];
  inferenceConfig?: BedrockInferenceConfig;
  // Note: Bedrock Converse API doesn't support streaming in all regions/models
}

export interface BedrockResponse {
  output: {
    message: {
      role: 'assistant';
      content: Array<{ text: string }>;
    };
  };
  stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'content_filtered';
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  metrics?: {
    latencyMs: number;
  };
}

export interface BedrockStreamChunk {
  messageStart?: { role: 'assistant' };
  contentBlockStart?: { contentBlockIndex: number };
  contentBlockDelta?: { delta: { text: string }; contentBlockIndex: number };
  contentBlockStop?: { contentBlockIndex: number };
  messageStop?: { stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'content_filtered' };
  metadata?: {
    usage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };
    metrics?: {
      latencyMs: number;
    };
  };
}

export interface AWSBedrockConfig extends BackendAdapterConfig {
  region?: string; // AWS region (default: 'us-east-1')
  awsAccessKeyId?: string; // AWS credentials
  awsSecretAccessKey?: string;
  awsSessionToken?: string; // Optional session token
}

// ============================================================================
// AWS Signature Version 4 (SigV4) Request Signing
//
// Implements the SigV4 algorithm directly (canonical request, string-to-
// sign, signing-key derivation, signature) on top of the Web Crypto API --
// no AWS SDK dependency needed. See:
// https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
// ============================================================================

/**
 * Input to `signAwsRequestV4`. All fields are the already-resolved values
 * for a single request; the caller is responsible for choosing which
 * headers should be signed (every key in `headers` is included in
 * `SignedHeaders`/`CanonicalHeaders`).
 */
export interface SigV4SignInput {
  /** HTTP method, e.g. 'POST'. */
  readonly method: string;
  /** Absolute request path (e.g. '/model/foo/converse'). Not URI-encoded yet. */
  readonly path: string;
  /** Canonical (already URI-encoded, sorted, '&'-joined) query string, or ''. */
  readonly canonicalQueryString?: string;
  /** Headers to sign, keyed by name (any casing) -> value. Must include at least `host`. */
  readonly headers: Record<string, string>;
  /** Raw request body (empty string if none). */
  readonly body: string;
  /** AWS region, e.g. 'us-east-1'. */
  readonly region: string;
  /** AWS service code, e.g. 'bedrock'. */
  readonly service: string;
  /** AWS access key ID. */
  readonly accessKeyId: string;
  /** AWS secret access key. */
  readonly secretAccessKey: string;
  /** X-Amz-Date value, format YYYYMMDDTHHMMSSZ (must match the `x-amz-date` header, if present). */
  readonly amzDate: string;
}

export interface SigV4SignResult {
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly credentialScope: string;
  readonly signedHeaders: string;
  readonly signature: string;
  readonly authorizationHeader: string;
}

/**
 * URI-encode a single path/query segment per the SigV4 spec: every byte is
 * percent-encoded except the unreserved characters `A-Z a-z 0-9 - . _ ~`,
 * using uppercase hex. (`encodeURIComponent` leaves `! ' ( ) *` unencoded,
 * which AWS requires to be encoded too, so those are fixed up afterward.)
 */
function sigV4UriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** URI-encode an absolute path, segment by segment, preserving '/'. */
function canonicalUri(path: string): string {
  if (!path) {
    return '/';
  }
  return path
    .split('/')
    .map((segment) => sigV4UriEncode(segment))
    .join('/');
}

/**
 * Resolve the Web Crypto `SubtleCrypto` implementation.
 *
 * SigV4 needs genuine SHA-256 and HMAC-SHA256, so -- unlike the cache-key
 * hashing in `@johnhenry/aimatey-middleware`, which is only an index and uses
 * a pure-JS FNV-1a -- this cannot be substituted with a non-cryptographic
 * stand-in. It uses Web Crypto rather than `node:crypto` so that the module
 * graph stays browser-safe: `packages/backend/src/index.ts` re-exports this
 * file, so a bare `node:crypto` import here breaks *every* consumer of
 * `@johnhenry/aimatey-backend` in browsers, webviews, Capacitor/Electron
 * renderers and edge runtimes, where bundlers externalize `crypto` and
 * `createHmac` is `undefined` at runtime. `globalThis.crypto.subtle` is
 * available in Node 18+, browsers, Deno, Bun and edge runtimes alike.
 */
function getSubtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new ProviderError({
      code: ErrorCode.PROVIDER_ERROR,
      message:
        'AWS Bedrock SigV4 signing requires the Web Crypto API ' +
        '(globalThis.crypto.subtle), which is unavailable in this runtime. ' +
        'It is present in Node 18+, browsers, Deno, Bun and edge runtimes.',
      isRetryable: false,
      provenance: { backend: 'aws-bedrock-backend' },
    });
  }
  return subtle;
}

const sigV4TextEncoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await getSubtleCrypto().digest('SHA-256', sigV4TextEncoder.encode(data));
  return toHex(new Uint8Array(digest));
}

// `Uint8Array<ArrayBuffer>` (not the default `Uint8Array<ArrayBufferLike>`)
// because TypeScript 5.7+ made Uint8Array generic over its backing buffer and
// `SubtleCrypto` only accepts a non-shared `ArrayBuffer`.
async function hmac(key: Uint8Array<ArrayBuffer>, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const subtle = getSubtleCrypto();
  const cryptoKey = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return new Uint8Array(await subtle.sign('HMAC', cryptoKey, sigV4TextEncoder.encode(data)));
}

/** Derive the SigV4 signing key: HMAC chain over date -> region -> service -> 'aws4_request'. */
async function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string
): Promise<Uint8Array<ArrayBuffer>> {
  const kDate = await hmac(sigV4TextEncoder.encode(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/**
 * Compute an AWS SigV4 `Authorization` header value (and the intermediate
 * canonical request / string-to-sign, for testing) for a single request.
 */
export async function signAwsRequestV4(input: SigV4SignInput): Promise<SigV4SignResult> {
  const { method, path, headers, body, region, service, accessKeyId, secretAccessKey, amzDate } =
    input;
  const canonicalQueryString = input.canonicalQueryString ?? '';
  const dateStamp = amzDate.slice(0, 8);

  // Canonical headers: lowercase name, normalized value, sorted by name.
  //
  // Header *values* keep their case (AWS vector `post-header-value-case`);
  // only the name is lowercased. Values are trimmed and any run of internal
  // whitespace is collapsed to a single space, which the spec requires
  // ("trim any leading or trailing spaces / convert sequential spaces to a
  // single space") and AWS's own vectors exercise: `get-header-value-trim`
  // canonicalizes `"a   b   c"` to `"a b c"` -- note the collapsing applies
  // inside quoted strings too -- and `get-header-value-multiline` folds a
  // continuation-line value down to `value1 value2 value3`.
  const headerEntries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const canonicalHeaders = headerEntries.map(([name, value]) => `${name}:${value}\n`).join('');
  const signedHeaders = headerEntries.map(([name]) => name).join(';');
  const hashedPayload = await sha256Hex(body);

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(path),
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    hashedPayload,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = await deriveSigningKey(secretAccessKey, dateStamp, region, service);
  const signature = toHex(await hmac(signingKey, stringToSign));

  const authorizationHeader =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    canonicalRequest,
    stringToSign,
    credentialScope,
    signedHeaders,
    signature,
    authorizationHeader,
  };
}

// ============================================================================
// AWS Bedrock Backend Adapter
// ============================================================================

/**
 * Backend adapter for AWS Bedrock Converse API.
 *
 * Features:
 * - Unified API for multiple foundation models
 * - AWS SigV4 authentication
 * - Vision support (select models)
 * - No function calling in Converse API
 * - Enterprise features (VPC, encryption, compliance)
 * - Pay-per-use pricing
 *
 * Note: This adapter requires AWS credentials. Authentication can be provided via:
 * 1. Config (awsAccessKeyId, awsSecretAccessKey, awsSessionToken)
 * 2. Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
 * 3. IAM roles (when running on AWS infrastructure)
 */
export class AWSBedrockBackendAdapter implements BackendAdapter<BedrockRequest, BedrockResponse> {
  readonly metadata: AdapterMetadata;
  private readonly config: AWSBedrockConfig;
  private readonly region: string;
  private readonly baseURL: string;

  constructor(config: AWSBedrockConfig) {
    this.config = config;
    this.region = config.region || process.env.AWS_REGION || 'us-east-1';

    // Construct base URL from region
    this.baseURL = config.baseURL || `https://bedrock-runtime.${this.region}.amazonaws.com`;

    this.metadata = {
      name: 'aws-bedrock-backend',
      version: '1.0.0',
      provider: 'AWS Bedrock',
      capabilities: {
        streaming: true, // Note: Not supported in all regions/models
        multiModal: true, // Vision supported in some models
        tools: false, // Converse API doesn't support function calling
        structuredOutput: 'fallback',
        maxContextTokens: 200000, // Claude 3 models support 200K
        systemMessageStrategy: 'separate-parameter', // Uses system field
        supportsMultipleSystemMessages: true,
        supportsTemperature: true,
        supportsTopP: true,
        supportsTopK: false,
        supportsSeed: false,
        supportsFrequencyPenalty: false,
        supportsPresencePenalty: false,
        maxStopSequences: 4,
      },
      config: {
        baseURL: this.baseURL,
        region: this.region,
      },
    };
  }

  /**
   * Convert IR to Bedrock format.
   */
  public fromIR(request: IRChatRequest): BedrockRequest {
    const { messages, systemParameter } = normalizeSystemMessages(
      buildStructuredOutputFallbackMessages(request.messages, request.responseFormat),
      this.metadata.capabilities.systemMessageStrategy,
      this.metadata.capabilities.supportsMultipleSystemMessages
    );

    const bedrockMessages: BedrockMessage[] = messages.map((msg) => {
      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      const content: BedrockMessageContent[] =
        typeof msg.content === 'string'
          ? [{ text: msg.content }]
          : msg.content.map((block) => {
              if (block.type === 'text') {
                return { text: block.text };
              } else if (block.type === 'image') {
                // Convert base64 data or URL to bytes
                const bytes = block.source.type === 'base64' ? block.source.data : ''; // Simplified: should decode base64
                return {
                  image: {
                    format: 'png' as const, // Simplified: should detect format
                    source: { bytes },
                  },
                };
              }
              return { text: JSON.stringify(block) };
            });

      return { role, content };
    });

    const bedrockRequest: BedrockRequest = {
      modelId:
        // Claude Haiku 4.5 has no on-demand throughput on Bedrock - the bare
        // 'anthropic.claude-haiku-4-5-...' model ID 400s with "on-demand
        // throughput isn't supported for this model". It must be invoked
        // through the 'global.' cross-region inference profile instead.
        request.parameters?.model ||
        this.config.defaultModel ||
        'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      messages: bedrockMessages,
      inferenceConfig: {
        temperature: request.parameters?.temperature,
        maxTokens: request.parameters?.maxTokens,
        topP: request.parameters?.topP,
        stopSequences: request.parameters?.stopSequences
          ? [...request.parameters.stopSequences]
          : undefined,
      },
    };

    // Add system messages
    if (systemParameter) {
      if (typeof systemParameter === 'string') {
        bedrockRequest.system = [{ text: systemParameter }];
      } else {
        bedrockRequest.system = (systemParameter as any[]).map((msg: any) => ({
          text: typeof msg === 'string' ? msg : msg.text || JSON.stringify(msg),
        }));
      }
    }

    return bedrockRequest;
  }

  /**
   * Convert Bedrock response to IR.
   */
  public toIR(
    response: BedrockResponse,
    originalRequest: IRChatRequest,
    latencyMs: number
  ): IRChatResponse {
    const rawContent = response.output.message.content.map((c) => c.text).join('');

    const message: IRMessage = {
      role: 'assistant',
      content: originalRequest.responseFormat
        ? extractStructuredOutputJSON(rawContent)
        : rawContent,
    };

    const finishReasonMap: Record<string, FinishReason> = {
      end_turn: 'stop',
      max_tokens: 'length',
      stop_sequence: 'stop',
      content_filtered: 'stop',
    };

    return {
      message,
      finishReason: finishReasonMap[response.stopReason] || 'stop',
      usage: {
        promptTokens: response.usage.inputTokens,
        completionTokens: response.usage.outputTokens,
        totalTokens: response.usage.totalTokens,
      },
      metadata: {
        ...originalRequest.metadata,
        providerResponseId: '', // Bedrock doesn't provide a unique ID in Converse API
        provenance: {
          ...originalRequest.metadata.provenance,
          backend: this.metadata.name,
          locality: 'external',
          // This provider does not report a served model. Setting it explicitly
          // stops an upstream hop's value, spread in above, from being
          // re-attributed to this backend — absent is acceptable, wrong is not.
          servedModel: undefined,
        },
        custom: {
          ...originalRequest.metadata.custom,
          latencyMs: response.metrics?.latencyMs || latencyMs,
          ...(originalRequest.responseFormat ? { responseFormatEnforced: false } : {}),
        },
        warnings: originalRequest.responseFormat
          ? [
              ...(originalRequest.metadata.warnings ?? []),
              buildResponseFormatFallbackWarning(this.metadata.name),
            ]
          : originalRequest.metadata.warnings,
      },
      raw: response as unknown as Record<string, unknown>,
    };
  }

  /**
   * Execute non-streaming request.
   */
  async execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse> {
    try {
      const bedrockRequest = this.fromIR(request);

      const startTime = Date.now();
      const response = await fetch(`${this.baseURL}/model/${bedrockRequest.modelId}/converse`, {
        method: 'POST',
        headers: await this.getHeaders(
          'POST',
          `/model/${bedrockRequest.modelId}/converse`,
          JSON.stringify(bedrockRequest)
        ),
        body: JSON.stringify(bedrockRequest),
        signal,
      });

      if (!response.ok) {
        throw createErrorFromHttpResponse(
          response.status,
          response.statusText,
          await response.text(),
          { backend: this.metadata.name }
        );
      }

      const data = (await response.json()) as BedrockResponse;
      return this.toIR(data, request, Date.now() - startTime);
    } catch (error) {
      if (error instanceof NetworkError || error instanceof ProviderError) {
        throw error;
      }

      throw new ProviderError({
        code: ErrorCode.PROVIDER_ERROR,
        message: `AWS Bedrock request failed: ${error instanceof Error ? error.message : String(error)}`,
        isRetryable: true,
        provenance: { backend: this.metadata.name },
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Execute streaming request.
   * Note: Streaming support varies by model and region.
   */
  async *executeStream(request: IRChatRequest, signal?: AbortSignal): IRChatStream {
    let sequence = 0;
    try {
      const bedrockRequest = this.fromIR(request);

      const streamingConfig = mergeStreamingConfig(this.config.streaming);
      const effectiveMode = getEffectiveStreamMode(request.streamMode, undefined, streamingConfig);
      const includeBoth = streamingConfig.includeBoth || effectiveMode === 'accumulated';

      const response = await fetch(
        `${this.baseURL}/model/${bedrockRequest.modelId}/converse-stream`,
        {
          method: 'POST',
          headers: await this.getHeaders(
            'POST',
            `/model/${bedrockRequest.modelId}/converse-stream`,
            JSON.stringify(bedrockRequest)
          ),
          body: JSON.stringify(bedrockRequest),
          signal,
        }
      );

      if (!response.ok) {
        throw createErrorFromHttpResponse(
          response.status,
          response.statusText,
          await response.text(),
          { backend: this.metadata.name }
        );
      }

      if (!response.body) {
        throw new StreamError({
          code: ErrorCode.STREAM_ERROR,
          message: 'No response body',
          provenance: { backend: this.metadata.name },
        });
      }
      let contentBuffer = '';

      yield {
        type: 'start',
        sequence: sequence++,
        metadata: {
          ...request.metadata,
          provenance: {
            ...request.metadata.provenance,
            backend: this.metadata.name,
            locality: 'external',
          },
        },
      } as IRStreamChunk;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });

          // AWS event stream format is binary, but for simplicity we'll parse as JSON lines
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) {
              continue;
            }

            try {
              const chunk = JSON.parse(line) as BedrockStreamChunk;

              if (chunk.contentBlockDelta?.delta?.text) {
                const delta = chunk.contentBlockDelta.delta.text;
                contentBuffer += delta;

                const contentChunk: IRStreamChunk = {
                  type: 'content',
                  sequence: sequence++,
                  delta: delta,
                  role: 'assistant',
                };

                if (includeBoth) {
                  (contentChunk as any).accumulated = contentBuffer;
                }

                yield contentChunk;
              }

              if (chunk.messageStop) {
                const finishReasonMap: Record<string, FinishReason> = {
                  end_turn: 'stop',
                  max_tokens: 'length',
                  stop_sequence: 'stop',
                  content_filtered: 'stop',
                };

                const doneChunk: IRStreamChunk = {
                  type: 'done',
                  sequence: sequence++,
                  finishReason: finishReasonMap[chunk.messageStop.stopReason] || 'stop',
                  message: { role: 'assistant', content: contentBuffer },
                };

                // Include usage if present
                if (chunk.metadata?.usage) {
                  (doneChunk as any).usage = {
                    promptTokens: chunk.metadata.usage.inputTokens,
                    completionTokens: chunk.metadata.usage.outputTokens,
                    totalTokens: chunk.metadata.usage.totalTokens,
                  };
                }

                yield doneChunk;
              }
            } catch (parseError) {
              console.warn('Failed to parse Bedrock stream chunk:', line, parseError);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
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
   * Get HTTP headers with real AWS SigV4 signing (see `signAwsRequestV4`
   * above). Computes an actual canonical request / string-to-sign /
   * signature using `awsAccessKeyId` + `awsSecretAccessKey`, rather than a
   * placeholder `Authorization` header.
   *
   * Header precedence is, lowest to highest:
   *
   * 1. transport defaults (`Content-Type`, `Accept`)
   * 2. `config.headers` supplied by the caller
   * 3. the computed SigV4 material
   *
   * The last step is the point of #103. `config.headers` used to be spread
   * last, so a caller could replace `Authorization`, `X-Amz-Date` or
   * `X-Amz-Security-Token` after signing. The signature is computed over
   * specific values, so substituting one produced a generic AWS signature
   * error that pointed nowhere near `config.headers`. Auth must not fail open.
   *
   * Caller headers still win over the transport defaults, which is deliberate:
   * the reported defect is about auth, and demoting `config.headers` below
   * *everything* would silently take away overrides that work today and are
   * none of signing's business.
   */
  private async getHeaders(
    method: string,
    path: string,
    body: string
  ): Promise<Record<string, string>> {
    const defaultHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    // Kept separate from the defaults so it can be applied *after* the caller's
    // headers rather than before them.
    const authHeaders: Record<string, string> = {};

    // If AWS credentials are provided in config, sign the request with SigV4.
    if (this.config.awsAccessKeyId && this.config.awsSecretAccessKey) {
      const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
      const host = new URL(this.baseURL).host;

      const signedHeaders: Record<string, string> = {
        host,
        'x-amz-date': amzDate,
      };
      if (this.config.awsSessionToken) {
        signedHeaders['x-amz-security-token'] = this.config.awsSessionToken;
      }

      const { authorizationHeader } = await signAwsRequestV4({
        method,
        path,
        headers: signedHeaders,
        body,
        region: this.region,
        service: 'bedrock',
        accessKeyId: this.config.awsAccessKeyId,
        secretAccessKey: this.config.awsSecretAccessKey,
        amzDate,
      });

      authHeaders['Authorization'] = authorizationHeader;
      authHeaders['X-Amz-Date'] = amzDate;

      if (this.config.awsSessionToken) {
        authHeaders['X-Amz-Security-Token'] = this.config.awsSessionToken;
      }
    }

    // When no credentials are configured `authHeaders` is empty, so a caller
    // supplying their own `Authorization` (fronting proxy, sidecar signer)
    // still gets it through. There is no signature to protect in that case.
    return { ...defaultHeaders, ...this.config.headers, ...authHeaders };
  }

  /**
   * Health check.
   */
  healthCheck(): Promise<boolean> {
    try {
      // Bedrock doesn't have a dedicated health endpoint
      // We'll attempt a minimal request
      return Promise.resolve(true); // Simplified: should actually test connectivity
    } catch {
      return Promise.resolve(false);
    }
  }

  /**
   * Estimate cost.
   * AWS Bedrock pricing varies by model and region.
   */
  estimateCost(request: IRChatRequest): Promise<number | null> {
    const pricing: Record<string, { input: number; output: number }> = {
      'anthropic.claude-3-haiku-20240307-v1:0': { input: 0.25, output: 1.25 },
      'anthropic.claude-3-sonnet-20240229-v1:0': { input: 3.0, output: 15.0 },
      'anthropic.claude-3-opus-20240229-v1:0': { input: 15.0, output: 75.0 },
      'meta.llama3-1-8b-instruct-v1:0': { input: 0.3, output: 0.6 },
      'meta.llama3-1-70b-instruct-v1:0': { input: 1.0, output: 2.0 },
    };

    const model = request.parameters?.model || this.config.defaultModel || '';
    const modelPricing = pricing[model];

    if (!modelPricing) {
      return Promise.resolve(null);
    }

    const inputTokens = estimateTokens(request);

    const outputTokens = request.parameters?.maxTokens || 1024;

    const inputCost = (inputTokens / 1_000_000) * modelPricing.input;
    const outputCost = (outputTokens / 1_000_000) * modelPricing.output;

    return Promise.resolve(inputCost + outputCost);
  }
}
