/**
 * Decision wire codec
 *
 * Translates between the three System One wire dialects that aimatey's HTTP
 * surfaces speak and the decision IR:
 *
 * - `systemone`       TypeSafe / Ollama:  `POST /v1/systemone`
 * - `openrouter`      OpenRouter alpha:   `POST /v1/decisions`
 * - `vercel-evaluate` Vercel AI Gateway:  `POST /v1/evaluate` (`boolean` for `noul`)
 *
 * This is the server side of `SYSTEMONE_DIALECTS` in
 * `@johnhenry/aimatey-backend`: that table drives how a *client* builds a
 * request and parses a response, and this module uses the same table (reversed)
 * to parse a request and shape a response, so a backend adapter pointed at an
 * aimatey server agrees with it by construction. The proxy (`proxy.ts`) and
 * the demo decision gateway (`examples/decisions/gateway`) both build on it.
 *
 * @module cli/decisions
 */

import { SYSTEMONE_DIALECTS, type SystemOneDialect } from '@johnhenry/aimatey-backend';
import { ErrorCategory, ErrorCode } from '@johnhenry/aimatey-types';
import type {
  IRDecisionAnswer,
  IRDecisionQuestion,
  IRDecisionRequest,
  IRDecisionResponse,
  ImageContent,
} from '@johnhenry/aimatey-types';

// ============================================================================
// Dialects and routes
// ============================================================================

/** The dialects this module serves (a subset of the client-side table). */
export type DecisionDialect = Extract<
  SystemOneDialect,
  'systemone' | 'openrouter' | 'vercel-evaluate'
>;

/** Request path -> dialect. Paths are matched exactly, without a query string. */
export const DECISION_ROUTES: Readonly<Record<string, DecisionDialect>> = {
  '/v1/systemone': 'systemone',
  '/typesafe/v1/systemone': 'systemone',
  '/v1/decisions': 'openrouter',
  '/api/alpha/decisions': 'openrouter',
  '/v1/evaluate': 'vercel-evaluate',
};

/** The dialect a path speaks, or `undefined` when it is not a decision route. */
export function decisionDialectForPath(pathname: string): DecisionDialect | undefined {
  return Object.hasOwn(DECISION_ROUTES, pathname) ? DECISION_ROUTES[pathname] : undefined;
}

/** A malformed decision request body; maps to HTTP 400. */
export class DecisionWireError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'DecisionWireError';
    this.status = status;
  }
}

type QuestionType = IRDecisionQuestion['type'];

/** Wire `type` string -> IR type for a dialect: its own spellings, plus the canonical three. */
function typeLookup(dialect: DecisionDialect): Record<string, QuestionType> {
  const lookup: Record<string, QuestionType> = { choice: 'choice', score: 'score', noul: 'noul' };
  for (const [irType, wireType] of Object.entries(SYSTEMONE_DIALECTS[dialect].wireTypes)) {
    lookup[wireType] = irType as QuestionType;
  }
  return lookup;
}

// ============================================================================
// Request: wire -> IR
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseQuestion(name: string, raw: unknown, dialect: DecisionDialect): IRDecisionQuestion {
  if (!isRecord(raw)) {
    throw new DecisionWireError(`questions.${name} must be an object`);
  }
  if (typeof raw.instructions !== 'string' || raw.instructions.trim() === '') {
    throw new DecisionWireError(`questions.${name}.instructions must be a non-empty string`);
  }

  // `type` is optional on the wire (Jev infers it from the shape of `criteria`).
  let type: QuestionType;
  if (raw.type === undefined) {
    type = Array.isArray(raw.criteria) ? 'score' : isRecord(raw.criteria) ? 'choice' : 'noul';
    if (isRecord(raw.criteria) && 'true' in raw.criteria && 'false' in raw.criteria) {
      type = 'noul';
    }
  } else {
    const resolved = typeof raw.type === 'string' ? typeLookup(dialect)[raw.type] : undefined;
    if (!resolved) {
      throw new DecisionWireError(
        `questions.${name}.type must be one of ${Object.values(SYSTEMONE_DIALECTS[dialect].wireTypes).join(', ')}`
      );
    }
    type = resolved;
  }

  if (type === 'choice') {
    if (!isRecord(raw.criteria) || Object.keys(raw.criteria).length === 0) {
      throw new DecisionWireError(
        `questions.${name}.criteria must be an object of option -> description`
      );
    }
    const criteria: Record<string, string> = {};
    for (const [key, description] of Object.entries(raw.criteria)) {
      if (typeof description !== 'string') {
        throw new DecisionWireError(`questions.${name}.criteria.${key} must be a string`);
      }
      criteria[key] = description;
    }
    return { type, instructions: raw.instructions, criteria };
  }

  if (type === 'score') {
    if (!Array.isArray(raw.criteria) || !raw.criteria.every((level) => typeof level === 'string')) {
      throw new DecisionWireError(`questions.${name}.criteria must be an array of level labels`);
    }
    return { type, instructions: raw.instructions, criteria: raw.criteria };
  }

  if (raw.criteria === undefined) {
    return { type, instructions: raw.instructions };
  }
  if (
    !isRecord(raw.criteria) ||
    typeof raw.criteria.true !== 'string' ||
    typeof raw.criteria.false !== 'string'
  ) {
    throw new DecisionWireError(
      `questions.${name}.criteria must be { true: string, false: string }`
    );
  }
  return {
    type,
    instructions: raw.instructions,
    criteria: { true: raw.criteria.true, false: raw.criteria.false },
  };
}

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

function sniffMediaType(base64: string): string {
  if (base64.startsWith('/9j/')) {
    return 'image/jpeg';
  }
  if (base64.startsWith('R0lG')) {
    return 'image/gif';
  }
  if (base64.startsWith('UklG')) {
    return 'image/webp';
  }
  return 'image/png';
}

function parseImage(raw: unknown, index: number): ImageContent {
  if (typeof raw !== 'string' || raw === '') {
    throw new DecisionWireError(`images[${index}] must be a base64 string`);
  }
  const match = DATA_URL.exec(raw);
  const data = match ? match[2]! : raw;
  const mediaType = match ? match[1]! : sniffMediaType(data);
  return { type: 'image', source: { type: 'base64', mediaType, data } };
}

/**
 * Parse a decision request body in a dialect's wire format into the IR.
 *
 * Only shape errors are caught here (`DecisionWireError`, HTTP 400); limits
 * such as option counts are checked by `Bridge.decide()`'s request validation.
 */
export function wireToDecisionRequest(body: unknown, dialect: DecisionDialect): IRDecisionRequest {
  if (!isRecord(body)) {
    throw new DecisionWireError('Request body must be a JSON object');
  }
  if (body.state === undefined || body.state === null) {
    throw new DecisionWireError("'state' is required");
  }
  if (!isRecord(body.questions) || Object.keys(body.questions).length === 0) {
    throw new DecisionWireError("'questions' must be a non-empty object");
  }

  const questions: Record<string, IRDecisionQuestion> = {};
  for (const [name, raw] of Object.entries(body.questions)) {
    questions[name] = parseQuestion(name, raw, dialect);
  }

  let images: ImageContent[] | undefined;
  if (body.images !== undefined) {
    if (!Array.isArray(body.images)) {
      throw new DecisionWireError("'images' must be an array of base64 strings");
    }
    images = body.images.map((image, index) => parseImage(image, index));
  }

  const custom: Record<string, unknown> = {};
  if (body.keep_alive !== undefined) {
    custom.keepAlive = body.keep_alive;
  }
  if (SYSTEMONE_DIALECTS[dialect].routingExtras) {
    if (body.provider !== undefined) {
      custom.provider = body.provider;
    }
    if (body.trace !== undefined) {
      custom.trace = body.trace;
    }
    if (body.session_id !== undefined) {
      custom.sessionId = body.session_id;
    }
    if (body.user !== undefined) {
      custom.user = body.user;
    }
  }
  const model = typeof body.model === 'string' && body.model !== '' ? body.model : undefined;

  return {
    state: body.state,
    questions,
    ...(images && { images }),
    ...((model !== undefined || Object.keys(custom).length > 0) && {
      parameters: {
        ...(model !== undefined && { model }),
        ...(Object.keys(custom).length > 0 && { custom }),
      },
    }),
    metadata: {
      requestId: crypto.randomUUID(),
      timestamp: Date.now(),
      provenance: { frontend: `${dialect}-wire` },
    },
  };
}

// ============================================================================
// Response: IR -> wire
// ============================================================================

/** What `createDecisionEscalation` records on `metadata.custom.escalation`. */
interface EscalationInfo {
  readonly triggeredBy: readonly { readonly question: string; readonly reason: string }[];
  readonly primaryModel: string;
  readonly primaryBackend?: string;
}

function escalationOf(response: IRDecisionResponse): EscalationInfo | undefined {
  const info = response.metadata.custom?.escalation;
  return isRecord(info) && Array.isArray(info.triggeredBy)
    ? (info as unknown as EscalationInfo)
    : undefined;
}

function answerToWire(
  question: IRDecisionQuestion | undefined,
  answer: IRDecisionAnswer,
  dialect: DecisionDialect
): Record<string, unknown> {
  const typed = dialect !== 'systemone';
  const wireType = SYSTEMONE_DIALECTS[dialect].wireTypes[answer.type];
  const common = {
    ...(typed && { type: wireType }),
  };
  const tail = {
    ...(answer.confidence !== undefined && { confidence: answer.confidence }),
    ...(answer.reasoning !== undefined && { reasoning: answer.reasoning }),
  };

  switch (answer.type) {
    case 'choice':
      return {
        ...common,
        choice: answer.value,
        ...(answer.probabilities && { probabilities: answer.probabilities }),
        ...tail,
      };
    case 'score':
      return {
        ...common,
        score: answer.value,
        ...(answer.probabilities && { probabilities: answer.probabilities }),
        ...(question?.type === 'score' && { legend: question.criteria }),
        ...tail,
      };
    case 'noul':
      // Vercel's `boolean` answer carries `probability`; the others `noul`.
      return {
        ...common,
        ...(wireType === 'boolean' ? { probability: answer.value } : { noul: answer.value }),
        ...tail,
      };
  }
}

function usageToWire(
  response: IRDecisionResponse,
  dialect: DecisionDialect
): Record<string, unknown> | undefined {
  const usage = response.usage;
  if (!usage) {
    return undefined;
  }
  if (dialect === 'vercel-evaluate') {
    return {
      inputTokens: usage.inputTokens,
      ...(usage.outputTokens !== undefined && { outputTokens: usage.outputTokens }),
      ...(usage.cost !== undefined && { cost: usage.cost }),
    };
  }
  return {
    input_tokens: usage.inputTokens,
    ...(usage.outputTokens !== undefined && { output_tokens: usage.outputTokens }),
    ...(dialect === 'openrouter' && usage.cost !== undefined && { cost: usage.cost }),
  };
}

/**
 * The routing record Vercel reports as `providerMetadata.gateway.routing`:
 * one `modelAttempts[]` entry per model that ran, the primary carrying the
 * `triggeredBy` reasons when it was escalated.
 */
export function decisionRouting(response: IRDecisionResponse): Record<string, unknown> {
  const escalation = escalationOf(response);
  const backend = response.metadata.provenance?.backend;
  const final = {
    model: response.model,
    ...(response.provider !== undefined && { provider: response.provider }),
    ...(backend !== undefined && { backend }),
    success: true,
  };
  if (!escalation) {
    return { modelAttempts: [final] };
  }
  return {
    modelAttempts: [
      {
        model: escalation.primaryModel,
        ...(escalation.primaryBackend !== undefined && { backend: escalation.primaryBackend }),
        success: true,
        triggeredBy: escalation.triggeredBy.map(({ question, reason }) => ({ question, reason })),
      },
      final,
    ],
  };
}

/** `x-aimatey-decision-fallback-*` headers for an escalated response (empty otherwise). */
export function decisionEscalationHeaders(response: IRDecisionResponse): Record<string, string> {
  const escalation = escalationOf(response);
  if (!escalation) {
    return {};
  }
  return {
    'x-aimatey-decision-fallback-triggered': 'true',
    'x-aimatey-decision-fallback-primary-model': escalation.primaryModel,
    'x-aimatey-decision-fallback-model': response.model,
    'x-aimatey-decision-fallback-triggered-by': escalation.triggeredBy
      .map(({ question, reason }) => `${question}:${reason}`)
      .join(','),
  };
}

/**
 * Shape an IR decision response as a dialect's wire response.
 *
 * `request` supplies the question list (score answers carry a `legend`).
 * Dialect extras: OpenRouter adds `id`, `provider` and `usage.cost`; Vercel
 * uses camelCase usage and `providerMetadata.gateway.routing`. An escalated
 * response also reports its routing as `provider_metadata` (all other
 * dialects) so no client has to read headers to learn the fallback ran.
 */
export function decisionResponseToWire(
  response: IRDecisionResponse,
  request: IRDecisionRequest,
  dialect: DecisionDialect
): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const [name, answer] of Object.entries(response.answers)) {
    answers[name] = answerToWire(request.questions[name], answer, dialect);
  }
  const usage = usageToWire(response, dialect);
  const routing = decisionRouting(response);
  const escalated = escalationOf(response) !== undefined;

  return {
    ...(dialect === 'openrouter' && {
      id: response.id ?? response.metadata.requestId,
      ...(response.provider !== undefined && { provider: response.provider }),
    }),
    model: response.model,
    answers,
    ...(usage && { usage }),
    ...(dialect === 'vercel-evaluate'
      ? { providerMetadata: { gateway: { routing } } }
      : escalated && { provider_metadata: { gateway: { routing } } }),
  };
}

// ============================================================================
// Errors
// ============================================================================

/**
 * HTTP status for a thrown error: 400 validation / bad request, 404 unknown
 * model, 413 oversize body, 429 rate limit, 502 upstream failure (provider,
 * network, auth to the upstream, no backend), 500 anything else.
 */
export function decisionErrorStatus(error: unknown): number {
  if (error instanceof DecisionWireError) {
    return error.status;
  }
  const { code, category } = error as { code?: ErrorCode; category?: string };
  if (code === ErrorCode.UNSUPPORTED_MODEL) {
    return 404;
  }
  switch (category) {
    case ErrorCategory.VALIDATION:
      return 400;
    case ErrorCategory.RATE_LIMIT:
      return 429;
    case ErrorCategory.AUTHENTICATION:
    case ErrorCategory.AUTHORIZATION:
    case ErrorCategory.PROVIDER:
    case ErrorCategory.NETWORK:
    case ErrorCategory.ROUTING:
      return 502;
    default:
      return 500;
  }
}

const ERROR_TYPES: Readonly<Record<number, string>> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  404: 'not_found_error',
  405: 'method_not_allowed',
  413: 'payload_too_large',
  429: 'rate_limit_error',
  500: 'internal_error',
  502: 'upstream_error',
};

/**
 * A dialect's documented error envelope: OpenRouter `{ error: { code, message } }`,
 * TypeSafe / Ollama `{ error: string }`, Vercel `{ error: { type, message } }`.
 */
export function decisionErrorToWire(
  dialect: DecisionDialect,
  status: number,
  message: string
): Record<string, unknown> {
  switch (dialect) {
    case 'openrouter':
      return { error: { code: status, message } };
    case 'vercel-evaluate':
      return { error: { type: ERROR_TYPES[status] ?? 'error', message } };
    default:
      return { error: message };
  }
}
