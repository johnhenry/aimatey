/**
 * Decision wire codec tests (packages/cli/src/decisions.ts).
 *
 * The codec is the server side of the client dialect table
 * (`SYSTEMONE_DIALECTS` + `buildSystemOneRequest` / `parseSystemOneResponse`
 * in the backend package), so most of these tests are round trips through the
 * real client: a request built by the client must parse to the IR it came
 * from, and a response shaped by the codec must parse back to the same answers.
 */

import { describe, it, expect } from 'vitest';
import {
  SYSTEMONE_DIALECTS,
  buildSystemOneRequest,
  parseSystemOneResponse,
} from '@johnhenry/aimatey-backend';
import { RateLimitError, ValidationError, ProviderError } from '@johnhenry/aimatey-errors';
import { ErrorCode } from '@johnhenry/aimatey-types';
import type { IRDecisionRequest, IRDecisionResponse } from '@johnhenry/aimatey-types';
import {
  DECISION_ROUTES,
  DecisionWireError,
  decisionDialectForPath,
  decisionErrorStatus,
  decisionErrorToWire,
  decisionEscalationHeaders,
  decisionResponseToWire,
  wireToDecisionRequest,
  type DecisionDialect,
} from '../../packages/cli/src/decisions.js';

const DIALECTS: DecisionDialect[] = ['systemone', 'openrouter', 'vercel-evaluate'];

const request: IRDecisionRequest = {
  state: 'Subject: Duplicate charge. Please refund me today.',
  questions: {
    team: {
      type: 'choice',
      instructions: 'Which team?',
      criteria: { billing: 'invoices', technical: 'bugs' },
    },
    urgency: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'mid', 'high'] },
    refund: {
      type: 'noul',
      instructions: 'Is a refund requested?',
      criteria: { true: 'asks for money back', false: 'does not' },
    },
    angry: { type: 'noul', instructions: 'Is the customer angry?' },
  },
  parameters: { model: 'tev1:0.8b', custom: { keepAlive: '5m' } },
  metadata: { requestId: 'r1', timestamp: 1 },
};

const response: IRDecisionResponse = {
  answers: {
    team: { type: 'choice', value: 'billing', probabilities: { billing: 0.8, technical: 0.2 }, confidence: 0.8 },
    urgency: { type: 'score', value: 2, probabilities: [0.1, 0.2, 0.7], confidence: 0.7 },
    refund: { type: 'noul', value: 0.93 },
    angry: { type: 'noul', value: 0.12, confidence: 0.88 },
  },
  model: 'tev1:0.8b',
  usage: { inputTokens: 42, outputTokens: 3, cost: 0.0001 },
  metadata: { requestId: 'r1', timestamp: 1, provenance: { backend: 'ollama-backend' } },
};

describe('decision routes', () => {
  it('maps the documented paths to dialects', () => {
    expect(decisionDialectForPath('/v1/systemone')).toBe('systemone');
    expect(decisionDialectForPath('/typesafe/v1/systemone')).toBe('systemone');
    expect(decisionDialectForPath('/v1/decisions')).toBe('openrouter');
    expect(decisionDialectForPath('/v1/evaluate')).toBe('vercel-evaluate');
  });

  it('does not match chat paths or inherited object keys', () => {
    expect(decisionDialectForPath('/v1/chat/completions')).toBeUndefined();
    expect(decisionDialectForPath('/')).toBeUndefined();
    expect(decisionDialectForPath('constructor')).toBeUndefined();
    expect(Object.values(DECISION_ROUTES).every((d) => d in SYSTEMONE_DIALECTS)).toBe(true);
  });
});

describe('wireToDecisionRequest', () => {
  it.each(DIALECTS)('parses what the %s client builds back to the IR questions', (dialect) => {
    const wire = buildSystemOneRequest(request, { dialect });
    const parsed = wireToDecisionRequest(wire, dialect);
    expect(parsed.state).toBe(request.state);
    expect(parsed.questions).toEqual(request.questions);
    expect(parsed.parameters?.model).toBe('tev1:0.8b');
    expect(parsed.parameters?.custom?.keepAlive).toBe('5m');
  });

  it("reads vercel's 'boolean' as noul, per SYSTEMONE_DIALECTS", () => {
    expect(SYSTEMONE_DIALECTS['vercel-evaluate'].wireTypes.noul).toBe('boolean');
    const parsed = wireToDecisionRequest(
      { state: 's', questions: { q: { type: 'boolean', instructions: 'ok?' } } },
      'vercel-evaluate'
    );
    expect(parsed.questions.q).toEqual({ type: 'noul', instructions: 'ok?' });
  });

  it('infers the type from criteria when `type` is omitted', () => {
    const parsed = wireToDecisionRequest(
      {
        state: 's',
        questions: {
          a: { instructions: 'i', criteria: { x: 'x', y: 'y' } },
          b: { instructions: 'i', criteria: ['lo', 'hi'] },
          c: { instructions: 'i' },
          d: { instructions: 'i', criteria: { true: 'yes', false: 'no' } },
        },
      },
      'systemone'
    );
    expect(Object.values(parsed.questions).map((q) => q.type)).toEqual(['choice', 'score', 'noul', 'noul']);
  });

  it('accepts structured (non-string) state', () => {
    const parsed = wireToDecisionRequest(
      { state: { amount: 5 }, questions: { q: { type: 'noul', instructions: 'big?' } } },
      'systemone'
    );
    expect(parsed.state).toEqual({ amount: 5 });
  });

  it('decodes bare base64 and data-URL images', () => {
    const parsed = wireToDecisionRequest(
      {
        state: 's',
        images: ['/9j/AAAA', 'data:image/webp;base64,UklGAAAA', 'iVBORw0KGgo='],
        questions: { q: { type: 'noul', instructions: 'i' } },
      },
      'systemone'
    );
    expect(parsed.images?.map((i) => (i.source.type === 'base64' ? i.source.mediaType : 'url'))).toEqual([
      'image/jpeg',
      'image/webp',
      'image/png',
    ]);
    const second = parsed.images?.[1]?.source;
    expect(second?.type === 'base64' && second.data).toBe('UklGAAAA');
  });

  it('only reads openrouter routing extras in the openrouter dialect', () => {
    const body = {
      state: 's',
      provider: { order: ['x'] },
      trace: { a: 1 },
      session_id: 'sess',
      user: 'u1',
      questions: { q: { type: 'noul', instructions: 'i' } },
    };
    expect(wireToDecisionRequest(body, 'openrouter').parameters?.custom).toEqual({
      provider: { order: ['x'] },
      trace: { a: 1 },
      sessionId: 'sess',
      user: 'u1',
    });
    expect(wireToDecisionRequest(body, 'systemone').parameters).toBeUndefined();
  });

  it.each([
    ['a non-object body', 'x', /JSON object/],
    ['missing state', { questions: { q: { type: 'noul', instructions: 'i' } } }, /'state'/],
    ['no questions', { state: 's', questions: {} }, /'questions'/],
    ['a non-object question', { state: 's', questions: { q: 5 } }, /questions\.q must be an object/],
    ['empty instructions', { state: 's', questions: { q: { type: 'noul', instructions: ' ' } } }, /instructions/],
    ['an unknown type', { state: 's', questions: { q: { type: 'rank', instructions: 'i' } } }, /type must be one of/],
    ['choice without criteria', { state: 's', questions: { q: { type: 'choice', instructions: 'i' } } }, /criteria/],
    ['score with non-string levels', { state: 's', questions: { q: { type: 'score', instructions: 'i', criteria: [1] } } }, /level labels/],
    ['noul with bad criteria', { state: 's', questions: { q: { type: 'noul', instructions: 'i', criteria: { true: 'a' } } } }, /true: string/],
    ['non-array images', { state: 's', images: 'x', questions: { q: { type: 'noul', instructions: 'i' } } }, /images/],
    ['a non-string image', { state: 's', images: [3], questions: { q: { type: 'noul', instructions: 'i' } } }, /images\[0\]/],
  ])('rejects %s with a 400 DecisionWireError', (_label, body, message) => {
    try {
      wireToDecisionRequest(body, 'systemone');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DecisionWireError);
      expect((error as DecisionWireError).status).toBe(400);
      expect((error as Error).message).toMatch(message);
    }
  });

  it("rejects vercel's 'noul' spelling only when the dialect forbids it (canonical accepted everywhere)", () => {
    expect(() =>
      wireToDecisionRequest(
        { state: 's', questions: { q: { type: 'noul', instructions: 'i' } } },
        'vercel-evaluate'
      )
    ).not.toThrow();
  });
});

describe('decisionResponseToWire', () => {
  it.each(DIALECTS)('round-trips through the %s client parser', (dialect) => {
    const wire = decisionResponseToWire(response, request, dialect);
    const parsed = parseSystemOneResponse(wire, request, { dialect, backendName: 'gw' });
    expect(parsed.answers).toEqual(response.answers);
    expect(parsed.model).toBe('tev1:0.8b');
    expect(parsed.usage?.inputTokens).toBe(42);
  });

  it('shapes the systemone dialect like TypeSafe / Ollama', () => {
    const wire = decisionResponseToWire(response, request, 'systemone') as any;
    expect(wire.answers.team).toEqual({
      choice: 'billing',
      probabilities: { billing: 0.8, technical: 0.2 },
      confidence: 0.8,
    });
    expect(wire.answers.urgency.legend).toEqual(['low', 'mid', 'high']);
    expect(wire.answers.refund).toEqual({ noul: 0.93 });
    expect(wire.usage).toEqual({ input_tokens: 42, output_tokens: 3 });
    expect(wire.id).toBeUndefined();
    expect(wire.provider_metadata).toBeUndefined();
  });

  it('adds id, provider and usage.cost for openrouter', () => {
    const wire = decisionResponseToWire(
      { ...response, id: 'gen-1', provider: 'ollama' },
      request,
      'openrouter'
    ) as any;
    expect(wire.id).toBe('gen-1');
    expect(wire.provider).toBe('ollama');
    expect(wire.usage.cost).toBe(0.0001);
    expect(wire.answers.refund.type).toBe('noul');
  });

  it("uses 'boolean', 'probability' and camelCase usage for vercel", () => {
    const wire = decisionResponseToWire(response, request, 'vercel-evaluate') as any;
    expect(wire.answers.refund).toEqual({ type: 'boolean', probability: 0.93 });
    expect(wire.answers.team.type).toBe('choice');
    expect(wire.usage).toEqual({ inputTokens: 42, outputTokens: 3, cost: 0.0001 });
    expect(wire.providerMetadata.gateway.routing.modelAttempts).toEqual([
      { model: 'tev1:0.8b', backend: 'ollama-backend', success: true },
    ]);
  });

  describe('escalated responses', () => {
    const escalated: IRDecisionResponse = {
      ...response,
      model: 'qwen2.5:3b',
      metadata: {
        ...response.metadata,
        provenance: { backend: 'ollama-backend-decisions' },
        custom: {
          escalation: {
            triggeredBy: [{ question: 'team', reason: 'confidence_below' }],
            primaryModel: 'tev1:0.8b',
            primaryBackend: 'router',
          },
        },
      },
    };

    it('reports triggeredBy under modelAttempts, in provider_metadata or providerMetadata', () => {
      for (const dialect of DIALECTS) {
        const wire = decisionResponseToWire(escalated, request, dialect) as any;
        const meta = dialect === 'vercel-evaluate' ? wire.providerMetadata : wire.provider_metadata;
        const attempts = meta.gateway.routing.modelAttempts;
        expect(attempts).toHaveLength(2);
        expect(attempts[0]).toMatchObject({
          model: 'tev1:0.8b',
          triggeredBy: [{ question: 'team', reason: 'confidence_below' }],
        });
        expect(attempts[1].model).toBe('qwen2.5:3b');
      }
    });

    it('emits x-aimatey-decision-fallback-* headers only when escalated', () => {
      expect(decisionEscalationHeaders(response)).toEqual({});
      expect(decisionEscalationHeaders(escalated)).toEqual({
        'x-aimatey-decision-fallback-triggered': 'true',
        'x-aimatey-decision-fallback-primary-model': 'tev1:0.8b',
        'x-aimatey-decision-fallback-model': 'qwen2.5:3b',
        'x-aimatey-decision-fallback-triggered-by': 'team:confidence_below',
      });
    });
  });
});

describe('errors', () => {
  it('maps thrown errors to the plan’s statuses', () => {
    expect(decisionErrorStatus(new DecisionWireError('x'))).toBe(400);
    expect(decisionErrorStatus(new DecisionWireError('x', 413))).toBe(413);
    expect(
      decisionErrorStatus(
        new ValidationError({ code: ErrorCode.INVALID_REQUEST, message: 'x', validationDetails: [] })
      )
    ).toBe(400);
    expect(
      decisionErrorStatus(new ValidationError({ code: ErrorCode.UNSUPPORTED_MODEL, message: 'x', validationDetails: [] }))
    ).toBe(404);
    expect(decisionErrorStatus(new RateLimitError({ code: ErrorCode.RATE_LIMIT_EXCEEDED, message: 'x' }))).toBe(429);
    expect(decisionErrorStatus(new ProviderError({ code: ErrorCode.PROVIDER_ERROR, message: 'x' }))).toBe(502);
    expect(decisionErrorStatus(new Error('boom'))).toBe(500);
  });

  it('uses each dialect’s documented envelope', () => {
    expect(decisionErrorToWire('systemone', 400, 'bad')).toEqual({ error: 'bad' });
    expect(decisionErrorToWire('openrouter', 429, 'slow down')).toEqual({
      error: { code: 429, message: 'slow down' },
    });
    expect(decisionErrorToWire('vercel-evaluate', 502, 'upstream')).toEqual({
      error: { type: 'upstream_error', message: 'upstream' },
    });
  });
});
