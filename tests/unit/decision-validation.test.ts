/**
 * validateDecisionResponse tests
 *
 * Hard failures throw a ValidationError; soft ones come back as IRWarnings.
 */

import { describe, it, expect } from 'vitest';
import { validateDecisionResponse } from '@johnhenry/aimatey-utils';
import { ValidationError } from '@johnhenry/aimatey-errors';
import type { IRDecisionRequest, IRDecisionResponse } from '@johnhenry/aimatey-types';

const metadata = { requestId: 'r', timestamp: 0 };

const request: IRDecisionRequest = {
  state: 'I was charged twice',
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team?',
      criteria: { billing: 'invoices', technical: 'bugs' },
    },
    mood: { type: 'score', instructions: 'How upset?', criteria: ['calm', 'annoyed', 'furious'] },
    refund: { type: 'noul', instructions: 'Wants a refund?' },
  },
  metadata,
};

function respond(answers: IRDecisionResponse['answers']): IRDecisionResponse {
  return { answers, model: 'm', metadata };
}

const valid = (): IRDecisionResponse['answers'] => ({
  department: {
    type: 'choice',
    value: 'billing',
    probabilities: { billing: 0.9, technical: 0.1 },
    confidence: 0.9,
  },
  mood: { type: 'score', value: 1.2, probabilities: [0.1, 0.3, 0.6], confidence: 0.6 },
  refund: { type: 'noul', value: 0.98 },
});

function catchError(response: IRDecisionResponse, req = request): ValidationError {
  try {
    validateDecisionResponse(req, response);
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return error as ValidationError;
  }
  throw new Error('expected validateDecisionResponse to throw');
}

describe('validateDecisionResponse', () => {
  it('returns no warnings for a well-formed response', () => {
    expect(validateDecisionResponse(request, respond(valid()))).toEqual([]);
  });

  it('accepts answers without probabilities or confidence', () => {
    const answers = {
      department: { type: 'choice' as const, value: 'billing' },
      mood: { type: 'score' as const, value: 2 },
      refund: { type: 'noul' as const, value: 0.5 },
    };
    expect(validateDecisionResponse(request, respond(answers as never))).toEqual([]);
  });

  it('throws naming the question when it is unanswered', () => {
    const answers = valid();
    delete (answers as Record<string, unknown>).mood;
    const error = catchError(respond(answers));
    expect(error.message).toMatch(/mood/);
    expect(error.validationDetails[0]?.field).toBe('answers.mood');
  });

  it('throws when the answer type differs from the question type', () => {
    const answers = { ...valid(), department: { type: 'noul' as const, value: 0.5 } };
    const error = catchError(respond(answers));
    expect(error.message).toMatch(/department/);
    expect(error.message).toMatch(/noul/);
  });

  it('throws when a choice value is not a criteria key', () => {
    const answers = {
      ...valid(),
      department: { type: 'choice' as const, value: 'legal', probabilities: {}, confidence: 1 },
    };
    expect(catchError(respond(answers)).message).toMatch(/legal/);
  });

  it('throws when a score is below zero or above levels - 1', () => {
    for (const value of [-0.1, 2.01]) {
      const answers = { ...valid(), mood: { type: 'score' as const, value } };
      expect(catchError(respond(answers as never)).message).toMatch(/mood/);
    }
  });

  it('accepts score values on the boundaries', () => {
    for (const value of [0, 2]) {
      const answers = { ...valid(), mood: { type: 'score' as const, value } };
      expect(validateDecisionResponse(request, respond(answers as never))).toEqual([]);
    }
  });

  it('throws when a noul value is outside [0, 1]', () => {
    for (const value of [-0.01, 1.01]) {
      const answers = { ...valid(), refund: { type: 'noul' as const, value } };
      expect(catchError(respond(answers)).message).toMatch(/refund/);
    }
  });

  it('throws on non-finite numbers anywhere in an answer', () => {
    const cases: IRDecisionResponse['answers'][] = [
      { ...valid(), refund: { type: 'noul', value: NaN } },
      { ...valid(), mood: { type: 'score', value: Infinity } },
      { ...valid(), refund: { type: 'noul', value: 0.5, confidence: NaN } },
      {
        ...valid(),
        department: { type: 'choice', value: 'billing', probabilities: { billing: NaN }, confidence: 1 },
      },
      { ...valid(), mood: { type: 'score', value: 1, probabilities: [0.5, Infinity, 0], confidence: 1 } },
      {
        ...valid(),
        department: { type: 'choice', value: 'billing', probabilities: { billing: 1 }, confidence: Infinity },
      },
    ];
    for (const answers of cases) {
      expect(() => validateDecisionResponse(request, respond(answers))).toThrow(ValidationError);
    }
  });

  it('warns when probabilities do not sum to 1 within tolerance', () => {
    const answers = {
      ...valid(),
      department: {
        type: 'choice' as const,
        value: 'billing',
        probabilities: { billing: 0.5, technical: 0.1 },
        confidence: 0.5,
      },
    };
    const warnings = validateDecisionResponse(request, respond(answers));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ severity: 'warning', field: 'answers.department.probabilities' });
  });

  it('does not warn when the sum is within 0.02 of 1', () => {
    const answers = {
      ...valid(),
      department: {
        type: 'choice' as const,
        value: 'billing',
        probabilities: { billing: 0.9, technical: 0.11 },
        confidence: 0.9,
      },
    };
    expect(validateDecisionResponse(request, respond(answers))).toEqual([]);
  });

  it('warns on score probabilities that do not sum to 1', () => {
    const answers = {
      ...valid(),
      mood: { type: 'score' as const, value: 1, probabilities: [0.1, 0.1, 0.1], confidence: 0.1 },
    };
    expect(validateDecisionResponse(request, respond(answers))[0]?.field).toBe('answers.mood.probabilities');
  });

  it('warns when choice probability keys differ from the criteria keys', () => {
    const answers = {
      ...valid(),
      department: {
        type: 'choice' as const,
        value: 'billing',
        probabilities: { billing: 0.5, other: 0.5 },
        confidence: 0.5,
      },
    };
    const warnings = validateDecisionResponse(request, respond(answers));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toMatch(/keys/);
  });

  it('warns when score probabilities have the wrong length', () => {
    const answers = {
      ...valid(),
      mood: { type: 'score' as const, value: 1, probabilities: [0.5, 0.5], confidence: 0.5 },
    };
    const warnings = validateDecisionResponse(request, respond(answers));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toMatch(/length|levels/);
  });

  it('ignores extra answers the request never asked for', () => {
    const answers = { ...valid(), extra: { type: 'noul' as const, value: 0.5 } };
    expect(validateDecisionResponse(request, respond(answers))).toEqual([]);
  });

  it('skips the probability checks when probabilities is empty (LLM-emulated answers)', () => {
    const answers = {
      ...valid(),
      department: { type: 'choice' as const, value: 'billing', probabilities: {}, confidence: 1 },
    };
    expect(validateDecisionResponse(request, respond(answers))).toEqual([]);
  });
});
