/**
 * OpenAI Decisions Frontend Adapter
 *
 * Translates OpenAI's Decisions API (`POST /v1/decisions`) request/response
 * shapes into the Universal Decision IR, so a client written for that API can
 * be served by any decision backend. Like `TypeSafeFrontendAdapter`, it
 * implements `FrontendAdapter` through its decision hooks only; drive it with
 * `Bridge.decideFrom()`.
 *
 * The wire shape (verified live 2026-10-06) is not System One's:
 *
 * - Request: `input` is a string or a list of `user` messages whose content
 *   parts are `input_text` / `input_image` (`data:` URLs only); `questions`
 *   is an array of named `choice` / `predicate` / `score` questions, with
 *   `choices[{ value, description }]` and `levels[{ label, description }]`.
 * - Response: `answers` is an array matched by `name`; probabilities are
 *   arrays of `{ value, probability }` (score entries also carry `label`);
 *   `usage` carries `input_tokens_details` / `output_tokens_details`.
 *
 * The mapping mirrors `packages/backend/src/decisions/openai-decisions.ts`
 * (the frontend must not depend on the backend package, so it is copied --
 * keep the two in step). IR score levels are bare strings: a level whose
 * label and description differ is written `'label: description'`.
 *
 * @module
 */

import type {
  AdapterMetadata,
  FrontendAdapter,
  IRDecisionRequest,
  IRDecisionResponse,
  IRDecisionQuestion,
  IRDecisionAnswer,
  ImageContent,
} from '@johnhenry/aimatey-types';
import { AdapterConversionError, ErrorCode } from '@johnhenry/aimatey-errors';

// ============================================================================
// OpenAI Decisions wire types
// ============================================================================

export type OpenAIDecisionsInputPart =
  | { readonly type: 'input_text'; readonly text: string }
  | { readonly type: 'input_image'; readonly image_url: string };

export interface OpenAIDecisionsInputMessage {
  readonly type: 'message';
  readonly role: 'user';
  readonly content: string | readonly OpenAIDecisionsInputPart[];
}

export type OpenAIDecisionsQuestion =
  | {
      readonly name: string;
      readonly type: 'choice';
      readonly instructions: string;
      readonly choices: ReadonlyArray<{ readonly value: string; readonly description?: string }>;
    }
  | { readonly name: string; readonly type: 'predicate'; readonly instructions: string }
  | {
      readonly name: string;
      readonly type: 'score';
      readonly instructions: string;
      readonly levels: ReadonlyArray<{ readonly label: string; readonly description?: string }>;
    };

/** Shape of a `POST /v1/decisions` body. */
export interface OpenAIDecisionsRequest {
  readonly model: string;
  readonly input: string | readonly OpenAIDecisionsInputMessage[];
  readonly questions: readonly OpenAIDecisionsQuestion[];
}

/** A single answer, as the Decisions API returns it. */
export type OpenAIDecisionsAnswer =
  | {
      readonly type: 'choice';
      readonly name: string;
      readonly choice: string;
      readonly probabilities?: ReadonlyArray<{
        readonly value: string;
        readonly probability: number;
      }>;
      readonly confidence?: number;
    }
  | {
      readonly type: 'predicate';
      readonly name: string;
      readonly probability: number;
      readonly confidence?: number;
    }
  | {
      readonly type: 'score';
      readonly name: string;
      readonly score: number;
      readonly probabilities?: ReadonlyArray<{
        readonly value: number;
        readonly label: string;
        readonly probability: number;
      }>;
      readonly confidence?: number;
    };

/** Shape of a `POST /v1/decisions` response. */
export interface OpenAIDecisionsResponse {
  readonly id?: string;
  readonly model: string;
  readonly answers: readonly OpenAIDecisionsAnswer[];
  readonly usage?: {
    readonly input_tokens: number;
    readonly input_tokens_details: Record<string, number>;
    readonly output_tokens: number;
    readonly output_tokens_details: Record<string, number>;
    readonly total_tokens: number;
  };
}

// ============================================================================
// Adapter
// ============================================================================

export class OpenAIDecisionsFrontendAdapter implements FrontendAdapter<
  OpenAIDecisionsRequest,
  OpenAIDecisionsResponse
> {
  readonly metadata: AdapterMetadata = {
    name: 'openai-decisions-frontend',
    version: '1.0.0',
    provider: 'OpenAI',
    capabilities: {
      streaming: false,
      multiModal: true,
      tools: false,
      systemMessageStrategy: 'not-supported',
      supportsMultipleSystemMessages: false,
      decisions: true,
      decisionImages: true,
    },
  };

  /** Convert a `/v1/decisions` body into a Universal Decision IR request. */
  decisionToIR(request: OpenAIDecisionsRequest): Promise<IRDecisionRequest> {
    // A bad image URL throws; inside the executor that becomes a rejection.
    return new Promise((resolve) => {
      const { text, images } = readInput(request.input);

      const questions: Record<string, IRDecisionQuestion> = {};
      request.questions.forEach((question, i) => {
        questions[question.name || `question_${i}`] = toIRQuestion(question);
      });

      resolve({
        state: text,
        questions,
        ...(images.length > 0 && { images }),
        parameters: { model: request.model },
        metadata: {
          requestId: 'openai-decisions-' + Date.now(),
          timestamp: Date.now(),
          provenance: { frontend: this.metadata.name },
        },
      });
    });
  }

  /**
   * Convert a Universal Decision IR response into a `/v1/decisions` response.
   * `originalRequest` supplies the `score` questions' level labels for
   * `probabilities[].label`; without it the label falls back to the level index.
   */
  decisionFromIR(
    response: IRDecisionResponse,
    originalRequest?: IRDecisionRequest
  ): Promise<OpenAIDecisionsResponse> {
    const answers = Object.entries(response.answers).map(([name, answer]) =>
      toWireAnswer(name, answer, originalRequest?.questions[name])
    );

    const details = response.usage?.details;
    const usage = {
      input_tokens: response.usage?.inputTokens ?? 0,
      input_tokens_details: (details?.input_tokens_details as
        | Record<string, number>
        | undefined) ?? {
        cached_tokens: 0,
        cache_write_tokens: 0,
      },
      output_tokens: response.usage?.outputTokens ?? 0,
      output_tokens_details: (details?.output_tokens_details as
        | Record<string, number>
        | undefined) ?? { reasoning_tokens: 0 },
      total_tokens: (response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0),
    };

    return Promise.resolve({
      ...(response.id !== undefined && { id: response.id }),
      model: response.model,
      answers,
      usage,
    });
  }
}

// ============================================================================
// Request mapping
// ============================================================================

function fail(message: string): AdapterConversionError {
  return new AdapterConversionError({
    code: ErrorCode.ADAPTER_CONVERSION_ERROR,
    message,
    provenance: { frontend: 'openai-decisions-frontend' },
  });
}

function readInput(input: OpenAIDecisionsRequest['input']): {
  text: string;
  images: ImageContent[];
} {
  if (typeof input === 'string') {
    return { text: input, images: [] };
  }
  const texts: string[] = [];
  const images: ImageContent[] = [];
  for (const message of input) {
    if (typeof message.content === 'string') {
      texts.push(message.content);
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'input_text') {
        texts.push(part.text);
        continue;
      }
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(part.image_url);
      if (!match) {
        throw fail(
          'OpenAI Decisions accepts only data: image URLs (data:<type>;base64,...); got a different image_url'
        );
      }
      images.push({
        type: 'image',
        source: { type: 'base64', mediaType: match[1]!, data: match[2]! },
      });
    }
  }
  return { text: texts.join('\n'), images };
}

function toIRQuestion(question: OpenAIDecisionsQuestion): IRDecisionQuestion {
  switch (question.type) {
    case 'choice':
      return {
        type: 'choice',
        instructions: question.instructions,
        criteria: Object.fromEntries(question.choices.map((c) => [c.value, c.description ?? ''])),
      };
    case 'predicate':
      return { type: 'noul', instructions: question.instructions };
    case 'score':
      return {
        type: 'score',
        instructions: question.instructions,
        criteria: question.levels.map((level) =>
          level.description === undefined || level.description === level.label
            ? level.label
            : `${level.label}: ${level.description}`
        ),
      };
  }
}

// ============================================================================
// Response mapping
// ============================================================================

/** The label half of an IR score level (`'label: description'` or bare). */
function levelLabel(level: string): string {
  const at = level.indexOf(': ');
  return at > 0 ? level.slice(0, at) : level;
}

function toWireAnswer(
  name: string,
  answer: IRDecisionAnswer,
  question?: IRDecisionQuestion
): OpenAIDecisionsAnswer {
  const confidence = answer.confidence !== undefined ? { confidence: answer.confidence } : {};
  switch (answer.type) {
    case 'choice':
      return {
        type: 'choice',
        name,
        choice: answer.value,
        ...(answer.probabilities && {
          probabilities: Object.entries(answer.probabilities).map(([value, probability]) => ({
            value,
            probability,
          })),
        }),
        ...confidence,
      };
    case 'score': {
      const levels = question?.type === 'score' ? question.criteria : undefined;
      return {
        type: 'score',
        name,
        score: answer.value,
        ...(answer.probabilities && {
          probabilities: answer.probabilities.map((probability, i) => ({
            value: i,
            label: levels?.[i] !== undefined ? levelLabel(levels[i]) : String(i),
            probability,
          })),
        }),
        ...confidence,
      };
    }
    case 'noul':
      return { type: 'predicate', name, probability: answer.value, ...confidence };
  }
}
