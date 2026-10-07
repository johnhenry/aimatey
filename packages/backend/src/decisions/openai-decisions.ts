/**
 * OpenAI Decisions client
 *
 * Request builder and response parser for OpenAI's Decisions API,
 * `POST /v1/decisions`. It is NOT System One-shaped, so it does not go
 * through the dialect table in `systemone-client.ts`:
 *
 * - the document is `input` (a string, or a list of `message` items for
 *   images), not `state`;
 * - `questions` is an array of `{ name, type, instructions, ... }`, and the
 *   types are `choice` / `predicate` / `score`;
 * - `choice` takes `choices: [{ value, description }]`, `score` takes
 *   `levels: [{ label, description }]`;
 * - `answers` comes back as an array matched by `name`, with `probabilities`
 *   as arrays of `{ value, probability }`.
 *
 * Every field was verified live on 2026-10-06 (fixtures/decisions-openai/).
 * What the API enforces: 2 to 255 choices, 2 to 10 levels, at most 200
 * questions, images only as `data:` URLs, `input` a string or a list of
 * `user` messages (a raw object is rejected, so object state travels as JSON
 * text), and no `system` role.
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
  ProvenanceLocality,
} from '@johnhenry/aimatey-types';
import { ProviderError, ErrorCode } from '@johnhenry/aimatey-errors';
import { validateDecisionResponse, rejectBlobRef } from '@johnhenry/aimatey-utils';

// ============================================================================
// Wire types
// ============================================================================

export type OpenAIDecisionsInputPart =
  | { readonly type: 'input_text'; readonly text: string }
  | { readonly type: 'input_image'; readonly image_url: string };

export interface OpenAIDecisionsInputMessage {
  readonly type: 'message';
  readonly role: 'user';
  readonly content: readonly OpenAIDecisionsInputPart[];
}

export type OpenAIDecisionsWireQuestion =
  | {
      readonly name: string;
      readonly type: 'choice';
      readonly instructions: string;
      readonly choices: ReadonlyArray<{ readonly value: string; readonly description: string }>;
    }
  | { readonly name: string; readonly type: 'predicate'; readonly instructions: string }
  | {
      readonly name: string;
      readonly type: 'score';
      readonly instructions: string;
      readonly levels: ReadonlyArray<{ readonly label: string; readonly description: string }>;
    };

/** A `POST /v1/decisions` body. */
export interface OpenAIDecisionsWireRequest {
  readonly model: string;
  readonly input: string | readonly OpenAIDecisionsInputMessage[];
  readonly questions: readonly OpenAIDecisionsWireQuestion[];
}

// ============================================================================
// Request
// ============================================================================

export interface BuildOpenAIDecisionsRequestOptions {
  readonly model: string;
  /** Names the backend in errors raised while building. */
  readonly backendName?: string;
}

function stateText(state: unknown): string {
  if (typeof state === 'string') {
    return state;
  }
  return state === undefined ? '' : (JSON.stringify(state) ?? '');
}

/** `'label: description'` splits on the first `': '`; a bare string is both. */
function toLevel(level: string): { label: string; description: string } {
  const at = level.indexOf(': ');
  if (at > 0) {
    return { label: level.slice(0, at), description: level.slice(at + 2) };
  }
  return { label: level, description: level };
}

function toWireQuestion(name: string, question: IRDecisionQuestion): OpenAIDecisionsWireQuestion {
  switch (question.type) {
    case 'choice':
      return {
        name,
        type: 'choice',
        instructions: question.instructions,
        choices: Object.entries(question.criteria).map(([value, description]) => ({
          value,
          description,
        })),
      };
    case 'noul': {
      // The wire has no per-side labels, so fold them into the instructions.
      const sides = question.criteria
        ? ` (true: ${question.criteria.true}; false: ${question.criteria.false})`
        : '';
      return { name, type: 'predicate', instructions: question.instructions + sides };
    }
    case 'score':
      return {
        name,
        type: 'score',
        instructions: question.instructions,
        levels: question.criteria.map(toLevel),
      };
  }
}

/**
 * Build the wire body for a decision request.
 *
 * A string `state` becomes `input`; an object or array becomes its JSON text.
 * With `images`, `input` is one `user` message of `input_text` plus
 * `input_image` parts. The API accepts only `data:` image URLs, so a `url`
 * image source throws; fetch it and pass it as base64.
 */
export function buildOpenAIDecisionsRequest(
  ir: IRDecisionRequest,
  opts: BuildOpenAIDecisionsRequestOptions
): OpenAIDecisionsWireRequest {
  const backend = opts.backendName ?? 'openai-backend';
  const text = stateText(ir.state);

  let input: OpenAIDecisionsWireRequest['input'] = text;
  if (ir.images?.length) {
    const parts: OpenAIDecisionsInputPart[] = [{ type: 'input_text', text }];
    for (const image of ir.images) {
      rejectBlobRef(image.source, backend);
      if (image.source.type !== 'base64') {
        throw new ProviderError({
          code: ErrorCode.PROVIDER_ERROR,
          message: `OpenAI Decisions accepts only data: image URLs (base64); got a '${image.source.type}' image source. Fetch it and pass it as base64 instead.`,
          isRetryable: false,
          provenance: { backend },
        });
      }
      parts.push({
        type: 'input_image',
        image_url: `data:${image.source.mediaType};base64,${image.source.data}`,
      });
    }
    input = [{ type: 'message', role: 'user', content: parts }];
  }

  return {
    model: opts.model,
    input,
    questions: Object.entries(ir.questions).map(([name, q]) => toWireQuestion(name, q)),
  };
}

// ============================================================================
// Response
// ============================================================================

export interface ParseOpenAIDecisionsResponseOptions {
  readonly backendName: string;
  /** Warnings the caller already knows about; appended after the request's own. */
  readonly warnings?: readonly IRWarning[];
  /** `IRProvenance.locality` for the hop the adapter crossed. */
  readonly locality?: ProvenanceLocality;
  /** `IRProvenance.servedBy`: the server's `host[:port]`. */
  readonly servedBy?: string;
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

const WIRE_TYPES: Readonly<Record<string, IRDecisionQuestion['type']>> = {
  choice: 'choice',
  score: 'score',
  predicate: 'noul',
};

function withOptional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function toIRAnswer(
  question: IRDecisionQuestion,
  raw: Record<string, unknown>,
  name: string,
  backend: string
): IRDecisionAnswer {
  const mismatch = () =>
    malformed(
      backend,
      `${backend} answered question '${name}' (type '${question.type}') with a response shape that doesn't match: ${JSON.stringify(raw)}`
    );
  if (typeof raw.type !== 'string' || WIRE_TYPES[raw.type] !== question.type) {
    throw mismatch();
  }
  const confidence = num(raw.confidence);
  const probs = Array.isArray(raw.probabilities) ? raw.probabilities.filter(isRecord) : undefined;

  if (question.type === 'choice') {
    if (typeof raw.choice !== 'string') {
      throw mismatch();
    }
    const probabilities = probs
      ? Object.fromEntries(
          probs
            .filter((p) => typeof p.value === 'string' && typeof p.probability === 'number')
            .map((p) => [p.value as string, p.probability as number])
        )
      : undefined;
    return {
      type: 'choice',
      value: raw.choice,
      ...withOptional('probabilities', probabilities),
      ...withOptional('confidence', confidence),
    };
  }

  if (question.type === 'score') {
    const value = num(raw.score);
    if (value === undefined) {
      throw mismatch();
    }
    const probabilities = probs
      ? probs
          .filter((p) => typeof p.value === 'number' && typeof p.probability === 'number')
          .sort((a, b) => (a.value as number) - (b.value as number))
          .map((p) => p.probability as number)
      : undefined;
    return {
      type: 'score',
      value,
      ...withOptional('probabilities', probabilities),
      ...withOptional('confidence', confidence),
    };
  }

  const value = num(raw.probability);
  if (value === undefined) {
    throw mismatch();
  }
  // No confidence is derived for a predicate: the API reports none.
  return { type: 'noul', value, ...withOptional('confidence', confidence) };
}

function parseUsage(raw: unknown): IRDecisionUsage | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const details: Record<string, unknown> = {};
  if (isRecord(raw.input_tokens_details)) {
    details.input_tokens_details = raw.input_tokens_details;
  }
  if (isRecord(raw.output_tokens_details)) {
    details.output_tokens_details = raw.output_tokens_details;
  }
  return {
    inputTokens: num(raw.input_tokens) ?? 0,
    ...withOptional('outputTokens', num(raw.output_tokens)),
    ...(Object.keys(details).length > 0 && { details }),
  };
}

/**
 * Parse a `POST /v1/decisions` response into the IR.
 *
 * Answers are matched to questions by `name`; a question the response does
 * not answer, or answers with the wrong type, throws a `ProviderError` naming
 * it. `validateDecisionResponse` findings land on `metadata.warnings`.
 */
export function parseOpenAIDecisionsResponse(
  body: unknown,
  ir: IRDecisionRequest,
  opts: ParseOpenAIDecisionsResponseOptions
): IRDecisionResponse {
  const backend = opts.backendName;
  if (!isRecord(body) || !Array.isArray(body.answers)) {
    throw malformed(backend, `${backend} response has no 'answers' array`);
  }

  const byName = new Map<string, Record<string, unknown>>();
  for (const answer of body.answers) {
    if (isRecord(answer) && typeof answer.name === 'string') {
      byName.set(answer.name, answer);
    }
  }

  const answers: Record<string, IRDecisionAnswer> = {};
  for (const [name, question] of Object.entries(ir.questions)) {
    const raw = byName.get(name);
    if (!raw) {
      throw malformed(backend, `${backend} response is missing an answer for question '${name}'`);
    }
    answers[name] = toIRAnswer(question, raw, name, backend);
  }

  const usage = parseUsage(body.usage);
  const response: IRDecisionResponse = {
    ...(typeof body.id === 'string' && { id: body.id }),
    provider: 'openai',
    answers,
    model: (typeof body.model === 'string' ? body.model : undefined) ?? ir.parameters?.model ?? '',
    ...(usage && { usage }),
    metadata: {
      ...ir.metadata,
      provenance: {
        ...ir.metadata.provenance,
        backend,
        ...(opts.locality !== undefined && { locality: opts.locality }),
        ...(opts.servedBy !== undefined && { servedBy: opts.servedBy }),
      },
    },
    raw: body,
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
