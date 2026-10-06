/**
 * System One Client
 *
 * The shared request builder, response parser and POST helper behind every
 * "System One"-compatible decision backend: TypeSafe's Jev, Ollama's
 * `/v1/systemone`, and anything else that takes `{ state, questions }` and
 * returns typed answers (Kev, Strands Decider, `laya[serve]`, Nimble,
 * OpenRouter, Vercel AI Gateway, Cloudflare Clef, ...).
 *
 * Those APIs are one API with small dialect differences, so the differences
 * live in the {@link SYSTEMONE_DIALECTS} table rather than in per-adapter
 * code. An adapter picks a dialect, supplies a URL and headers, and calls
 * {@link decideViaSystemOne} (or the three primitives it is made of).
 *
 * @module
 */

import type {
  IRDecisionAnswer,
  IRDecisionQuestion,
  IRDecisionRequest,
  IRDecisionResponse,
  IRDecisionUsage,
  IRWarning,
} from '@johnhenry/aimatey-types';
import { ProviderError, ErrorCode, createErrorFromHttpResponse } from '@johnhenry/aimatey-errors';
import { validateDecisionResponse } from '@johnhenry/aimatey-utils';

// ============================================================================
// Dialects
// ============================================================================

export type SystemOneDialect =
  | 'systemone'
  | 'openrouter'
  | 'vercel-evaluate'
  | 'openai-decisions'
  | 'cloudflare';

type QuestionType = IRDecisionQuestion['type'];

/** How one dialect differs from the canonical System One wire format. */
export interface SystemOneDialectSpec {
  /**
   * Path appended to a backend's `baseURL` when it does not set its own
   * (Cloudflare's endpoint is model-specific, so its `baseURL` is the whole URL).
   */
  readonly defaultPath: string;
  /** Whether `model` goes in the body (Cloudflare puts it in the URL). */
  readonly modelInBody: boolean;
  /** The response is wrapped as `{ result: { ... } }` (Cloudflare Workers AI). */
  readonly resultWrapper: boolean;
  /** The request carries OpenRouter's `provider` / `trace` / `session_id`. */
  readonly routingExtras: boolean;
  /** IR question type -> the `type` string this dialect uses on the wire. */
  readonly wireTypes: Readonly<Record<QuestionType, string>>;
}

const CANONICAL_TYPES = { choice: 'choice', score: 'score', noul: 'noul' } as const;

/**
 * The dialect table. Keep it small and data-driven: a new difference is a
 * new field here, not a branch in an adapter.
 */
export const SYSTEMONE_DIALECTS: Readonly<Record<SystemOneDialect, SystemOneDialectSpec>> = {
  systemone: {
    defaultPath: '/systemone',
    modelInBody: true,
    resultWrapper: false,
    routingExtras: false,
    wireTypes: CANONICAL_TYPES,
  },
  openrouter: {
    defaultPath: '/systemone',
    modelInBody: true,
    resultWrapper: false,
    routingExtras: true,
    wireTypes: CANONICAL_TYPES,
  },
  // Vercel's `/v1/evaluate` spells noul `boolean` (answers carry `probability`)
  // and reports usage in camelCase -- the latter is handled by the parser,
  // which accepts both spellings in every dialect.
  'vercel-evaluate': {
    defaultPath: '/evaluate',
    modelInBody: true,
    resultWrapper: false,
    routingExtras: false,
    wireTypes: { ...CANONICAL_TYPES, noul: 'boolean' },
  },
  // UNVERIFIED: OpenAI's Decisions API is invite-only (announced 2026-09-29)
  // and has no public schema yet. `predicate` / `rubric` are the names from the
  // announcement; the rest of the wire format is assumed to match System One.
  // Treat this entry as a placeholder to be corrected against the real docs.
  'openai-decisions': {
    defaultPath: '/decisions',
    modelInBody: true,
    resultWrapper: false,
    routingExtras: false,
    wireTypes: { ...CANONICAL_TYPES, noul: 'predicate', score: 'rubric' },
  },
  // Workers AI: `/ai/run/@cf/cloudflare/clef[-flash]`, model in the URL.
  cloudflare: {
    defaultPath: '',
    modelInBody: false,
    resultWrapper: true,
    routingExtras: false,
    wireTypes: CANONICAL_TYPES,
  },
};

/** Wire answer `type` spellings -> IR question type. */
const WIRE_TYPE_ALIASES: Readonly<Record<string, QuestionType>> = {
  choice: 'choice',
  score: 'score',
  rubric: 'score',
  noul: 'noul',
  boolean: 'noul',
  predicate: 'noul',
};

// ============================================================================
// Request
// ============================================================================

export interface BuildSystemOneRequestOptions {
  /** Overrides `ir.parameters.model`. */
  readonly model?: string;
  readonly dialect: SystemOneDialect;
  /** Send `type` on every question (default true); `false` leaves it to the server to infer. */
  readonly includeType?: boolean;
  /**
   * Send `ir.images` (default false). Only backends that take images should
   * set this; the rest drop them with {@link buildImageDroppedWarning}.
   */
  readonly sendImages?: boolean;
  /** Names the backend in errors raised while building. */
  readonly backendName?: string;
}

/** A System One request body, as sent on the wire. */
export type SystemOneWireRequest = Record<string, unknown> & {
  readonly state: unknown;
  readonly questions: Record<string, Record<string, unknown>>;
  readonly model?: string;
  readonly images?: readonly string[];
};

/**
 * Build the wire request body for a decision request.
 *
 * Images are sent as bare base64 strings (Ollama's and Clef's `images[]`
 * format); a `url` image source throws, since no System One server fetches
 * URLs on the caller's behalf.
 */
export function buildSystemOneRequest(
  ir: IRDecisionRequest,
  opts: BuildSystemOneRequestOptions
): SystemOneWireRequest {
  const spec = SYSTEMONE_DIALECTS[opts.dialect];
  const includeType = opts.includeType ?? true;
  const custom = ir.parameters?.custom;

  const questions: Record<string, Record<string, unknown>> = {};
  for (const [name, question] of Object.entries(ir.questions)) {
    const { type, ...rest } = question;
    questions[name] = includeType ? { type: spec.wireTypes[type], ...rest } : { ...rest };
  }

  const model = opts.model ?? ir.parameters?.model;
  const body: Record<string, unknown> = {
    ...(spec.modelInBody && model !== undefined && { model }),
    state: ir.state,
    questions,
  };

  if (opts.sendImages && ir.images?.length) {
    body.images = ir.images.map((image) => {
      if (image.source.type !== 'base64') {
        throw new ProviderError({
          code: ErrorCode.PROVIDER_ERROR,
          message: `${opts.backendName ?? 'System One'} accepts only base64 images; got a 'url' image source. Fetch it and pass it as base64 instead.`,
          isRetryable: false,
          provenance: { backend: opts.backendName ?? 'systemone' },
        });
      }
      return image.source.data;
    });
  }

  if (custom?.keepAlive !== undefined) {
    body.keep_alive = custom.keepAlive;
  }

  if (spec.routingExtras) {
    if (custom?.provider !== undefined) {
      body.provider = custom.provider;
    }
    if (custom?.trace !== undefined) {
      body.trace = custom.trace;
    }
    const sessionId = custom?.sessionId ?? custom?.session_id;
    if (sessionId !== undefined) {
      body.session_id = sessionId;
    }
  }

  return body as SystemOneWireRequest;
}

/** The `capability-unsupported` warning for a backend that drops request images. */
export function buildImageDroppedWarning(
  ir: IRDecisionRequest,
  backendName: string,
  modelLabel: string
): IRWarning[] {
  if (!ir.images?.length) {
    return [];
  }
  return [
    {
      category: 'capability-unsupported',
      severity: 'warning',
      message: `${modelLabel} takes no images; ${ir.images.length} image(s) were not sent.`,
      field: 'images',
      source: backendName,
    },
  ];
}

// ============================================================================
// Response
// ============================================================================

export interface ParseSystemOneResponseOptions {
  readonly dialect: SystemOneDialect;
  readonly backendName: string;
  /** `provider` to report when the body names none (a gateway's body does). */
  readonly provider?: string;
  /**
   * Derive a noul answer's `confidence` as `max(p, 1 - p)` when the provider
   * reports none. Off by default: IR v2 lets confidence be absent, and
   * Jev/Ollama report none for noul, so deriving it would fabricate a value
   * the provider never produced.
   */
  readonly deriveNoulConfidence?: boolean;
  /** Warnings the caller already knows about (e.g. dropped images); appended after the request's own. */
  readonly warnings?: readonly IRWarning[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function malformed(backendName: string, message: string): ProviderError {
  return new ProviderError({
    code: ErrorCode.PROVIDER_ERROR,
    message,
    isRetryable: false,
    provenance: { backend: backendName },
  });
}

/**
 * Parse a System One response body into the IR.
 *
 * Throws a `ProviderError` naming the question if one is unanswered or
 * answered with the wrong shape, and a `ValidationError` (from
 * `validateDecisionResponse`) for a structurally impossible answer; the
 * validator's soft findings land on `metadata.warnings`.
 */
export function parseSystemOneResponse(
  body: unknown,
  ir: IRDecisionRequest,
  opts: ParseSystemOneResponseOptions
): IRDecisionResponse {
  const spec = SYSTEMONE_DIALECTS[opts.dialect];
  const label = opts.backendName;

  let data: unknown = body;
  if (spec.resultWrapper && isRecord(body) && isRecord(body.result)) {
    data = body.result;
  }
  if (!isRecord(data) || !isRecord(data.answers)) {
    throw malformed(label, `${label} response has no 'answers' object`);
  }
  const wireAnswers = data.answers;

  const answers: Record<string, IRDecisionAnswer> = {};
  for (const [name, question] of Object.entries(ir.questions)) {
    const raw = wireAnswers[name];
    if (!isRecord(raw)) {
      // Nothing upstream guarantees completeness, so a silently skipped
      // question would reach the caller as `answers[name] === undefined`.
      throw malformed(label, `${label} response is missing an answer for question '${name}'`);
    }
    answers[name] = toIRAnswer(question, raw, name, label, opts.deriveNoulConfidence ?? false);
  }

  const usage = parseUsage(data.usage);
  const provider = typeof data.provider === 'string' ? data.provider : opts.provider;
  const model =
    (typeof data.model === 'string' ? data.model : undefined) ?? ir.parameters?.model ?? '';

  const response: IRDecisionResponse = {
    ...(typeof data.id === 'string' && { id: data.id }),
    ...(provider !== undefined && { provider }),
    answers,
    model,
    ...(usage && { usage }),
    metadata: {
      ...ir.metadata,
      provenance: { ...ir.metadata.provenance, backend: opts.backendName },
    },
    raw: isRecord(body) ? body : data,
  };

  const warnings = [
    ...(ir.metadata.warnings ?? []),
    ...(opts.warnings ?? []),
    ...validateDecisionResponse(ir, response),
  ];
  return warnings.length > 0
    ? { ...response, metadata: { ...response.metadata, warnings } }
    : response;
}

function parseUsage(raw: unknown): IRDecisionUsage | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const cost = num(raw.cost);
  return {
    inputTokens: num(raw.input_tokens) ?? num(raw.inputTokens) ?? 0,
    ...optional('outputTokens', num(raw.output_tokens) ?? num(raw.outputTokens)),
    ...optional('cost', cost),
    // Kept alongside `cost` for one release; read `usage.cost` instead.
    ...(cost !== undefined && { details: { cost } }),
  };
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function toIRAnswer(
  question: IRDecisionQuestion,
  raw: Record<string, unknown>,
  name: string,
  backendName: string,
  deriveNoulConfidence: boolean
): IRDecisionAnswer {
  const mismatch = () =>
    malformed(
      backendName,
      `${backendName} answered question '${name}' (type '${question.type}') with a response shape that doesn't match: ${JSON.stringify(raw)}`
    );

  // `type` is present on most dialects and absent on others (Jev); the
  // question is the authority, so it only has to agree when present.
  if (typeof raw.type === 'string') {
    const declared = WIRE_TYPE_ALIASES[raw.type];
    if (declared !== question.type) {
      throw mismatch();
    }
  }

  const reasoning = typeof raw.reasoning === 'string' ? raw.reasoning : undefined;
  const confidence = num(raw.confidence);

  if (question.type === 'choice') {
    const value = raw.choice ?? raw.value;
    if (typeof value !== 'string') {
      throw mismatch();
    }
    const probabilities = choiceProbabilities(raw.probabilities, question.criteria);
    return {
      type: 'choice',
      value,
      ...optional('probabilities', probabilities),
      ...optional('confidence', confidence),
      ...optional('reasoning', reasoning),
    };
  }

  if (question.type === 'score') {
    const value = num(raw.score) ?? num(raw.value);
    if (value === undefined) {
      throw mismatch();
    }
    const probabilities = scoreProbabilities(raw.probabilities, question.criteria);
    return {
      type: 'score',
      value,
      ...optional('probabilities', probabilities),
      ...optional('confidence', confidence),
      ...optional('reasoning', reasoning),
    };
  }

  const value = num(raw.noul) ?? num(raw.probability) ?? num(raw.value);
  if (value === undefined) {
    throw mismatch();
  }
  return {
    type: 'noul',
    value,
    ...optional(
      'confidence',
      confidence ?? (deriveNoulConfidence ? Math.max(value, 1 - value) : undefined)
    ),
    ...optional('reasoning', reasoning),
  };
}

/** Choice probabilities: an object keyed by option, or an array in criteria order. */
function choiceProbabilities(
  raw: unknown,
  criteria: Record<string, string>
): Record<string, number> | undefined {
  if (Array.isArray(raw)) {
    return Object.fromEntries(Object.keys(criteria).map((key, i) => [key, raw[i] as number]));
  }
  return isRecord(raw) ? (raw as Record<string, number>) : undefined;
}

/**
 * Score probabilities: an array, or an object keyed by level index (Ollama:
 * `{"0": .., "1": ..}` alongside a `legend`), returned as an array ordered by
 * numeric key -- lexical order would put "10" before "2".
 */
function scoreProbabilities(raw: unknown, criteria: readonly string[]): number[] | undefined {
  if (Array.isArray(raw)) {
    return raw as number[];
  }
  if (!isRecord(raw)) {
    return undefined;
  }
  const entries = Object.entries(raw) as [string, number][];
  if (entries.every(([key]) => /^\d+$/.test(key))) {
    return entries.sort(([a], [b]) => Number(a) - Number(b)).map(([, p]) => p);
  }
  // Keyed by level name instead of index: follow the question's own order.
  if (criteria.every((level) => level in raw)) {
    return criteria.map((level) => raw[level] as number);
  }
  return entries.map(([, p]) => p);
}

// ============================================================================
// Transport
// ============================================================================

export interface PostSystemOneOptions {
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly backendName: string;
  /** Test seam; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * POST a System One body and return the parsed JSON.
 *
 * Errors map through `createErrorFromHttpResponse` exactly as in the chat
 * adapters; a transport failure becomes a retryable `ProviderError`, except
 * an abort/timeout, which is rethrown untouched so callers can tell
 * cancellation from failure.
 */
export async function postSystemOne(
  url: string,
  body: unknown,
  opts: PostSystemOneOptions
): Promise<unknown> {
  const doFetch = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw error;
    }
    throw new ProviderError({
      code: ErrorCode.PROVIDER_ERROR,
      message: `${opts.backendName} request failed: ${error instanceof Error ? error.message : String(error)}`,
      isRetryable: true,
      provenance: { backend: opts.backendName },
      cause: error instanceof Error ? error : undefined,
    });
  }

  if (!response.ok) {
    throw createErrorFromHttpResponse(response.status, response.statusText, await response.text(), {
      backend: opts.backendName,
    });
  }

  try {
    return await response.json();
  } catch (error) {
    throw new ProviderError({
      code: ErrorCode.PROVIDER_ERROR,
      message: `${opts.backendName} response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      isRetryable: false,
      provenance: { backend: opts.backendName },
      cause: error instanceof Error ? error : undefined,
    });
  }
}

// ============================================================================
// One call, end to end
// ============================================================================

export interface DecideViaSystemOneOptions
  extends
    BuildSystemOneRequestOptions,
    Omit<ParseSystemOneResponseOptions, 'backendName'>,
    Omit<PostSystemOneOptions, 'backendName'> {
  readonly url: string;
  readonly backendName: string;
}

/** Build, POST and parse: the whole of a System One adapter's `decide()`. */
export async function decideViaSystemOne(
  ir: IRDecisionRequest,
  opts: DecideViaSystemOneOptions
): Promise<IRDecisionResponse> {
  const body = buildSystemOneRequest(ir, opts);
  const json = await postSystemOne(opts.url, body, opts);
  return parseSystemOneResponse(json, ir, opts);
}
