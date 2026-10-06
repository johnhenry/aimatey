/**
 * validateDecisionRequest tests
 *
 * Hard failures throw a ValidationError; soft ones come back as IRWarnings.
 * Capability-dependent checks only run when capabilities are supplied.
 */

import { describe, it, expect } from 'vitest';
import { validateDecisionRequest } from '@johnhenry/aimatey-utils';
import { ValidationError } from '@johnhenry/aimatey-errors';
import type {
  IRCapabilities,
  IRDecisionQuestion,
  IRDecisionRequest,
} from '@johnhenry/aimatey-types';

const metadata = { requestId: 'r', timestamp: 0 };

const choice: IRDecisionQuestion = {
  type: 'choice',
  instructions: 'Which team?',
  criteria: { billing: 'invoices', technical: 'bugs' },
};
const score: IRDecisionQuestion = {
  type: 'score',
  instructions: 'How upset?',
  criteria: ['calm', 'annoyed', 'furious'],
};
const noul: IRDecisionQuestion = { type: 'noul', instructions: 'Wants a refund?' };

function make(
  questions: Record<string, IRDecisionQuestion>,
  extra: Partial<IRDecisionRequest> = {}
): IRDecisionRequest {
  return { state: 'I was charged twice', questions, metadata, ...extra };
}

const caps = (decisionOverrides: Partial<IRCapabilities> = {}): IRCapabilities => ({
  streaming: false,
  multiModal: false,
  tools: false,
  systemMessageStrategy: 'not-supported',
  supportsMultipleSystemMessages: false,
  decisions: true,
  ...decisionOverrides,
});

function catchError(fn: () => unknown): ValidationError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return error as ValidationError;
  }
  throw new Error('expected validateDecisionRequest to throw');
}

const image = {
  type: 'image' as const,
  source: { type: 'base64' as const, mediaType: 'image/png', data: 'AAAA' },
};

describe('validateDecisionRequest: shape checks (no capabilities)', () => {
  it('returns no warnings for a well-formed request', () => {
    expect(validateDecisionRequest(make({ a: choice, b: score, c: noul }))).toEqual([]);
  });

  it('throws on empty questions', () => {
    const error = catchError(() => validateDecisionRequest(make({})));
    expect(error.message).toMatch(/at least one question/);
    expect(error.validationDetails[0].field).toBe('questions');
  });

  it('throws on empty or whitespace instructions', () => {
    const error = catchError(() =>
      validateDecisionRequest(make({ a: { ...noul, instructions: '   ' } }))
    );
    expect(error.validationDetails[0].field).toBe('questions.a.instructions');
  });

  it('throws on a choice with fewer than 2 criteria', () => {
    const error = catchError(() =>
      validateDecisionRequest(make({ a: { ...choice, type: 'choice', criteria: { only: 'x' } } }))
    );
    expect(error.validationDetails[0].field).toBe('questions.a.criteria');
  });

  it('throws on a score with fewer than 2 levels', () => {
    const error = catchError(() =>
      validateDecisionRequest(make({ a: { type: 'score', instructions: 'q', criteria: ['one'] } }))
    );
    expect(error.validationDetails[0].field).toBe('questions.a.criteria');
  });

  it('runs no capability checks when capabilities are omitted', () => {
    const images = [image];
    expect(validateDecisionRequest(make({ a: choice }, { images }))).toEqual([]);
  });
});

describe('validateDecisionRequest: capability checks', () => {
  it('throws when the backend excludes a question type', () => {
    const error = catchError(() =>
      validateDecisionRequest(make({ a: choice, b: noul }), caps({ decisionTypes: ['choice'] }))
    );
    expect(error.validationDetails[0].field).toBe('questions.b.type');
    expect(error.message).toMatch(/noul/);
  });

  it('accepts every type when decisionTypes is omitted', () => {
    expect(validateDecisionRequest(make({ a: choice, b: score, c: noul }), caps())).toEqual([]);
  });

  it('throws when a choice exceeds maxChoiceOptions', () => {
    const error = catchError(() =>
      validateDecisionRequest(
        make({ a: choice }),
        caps({ decisionLimits: { maxChoiceOptions: 1 } })
      )
    );
    expect(error.validationDetails[0].field).toBe('questions.a.criteria');
  });

  it('accepts a choice at maxChoiceOptions', () => {
    expect(
      validateDecisionRequest(
        make({ a: choice }),
        caps({ decisionLimits: { maxChoiceOptions: 2 } })
      )
    ).toEqual([]);
  });

  it('throws when a score exceeds maxScoreLevels', () => {
    const error = catchError(() =>
      validateDecisionRequest(make({ a: score }), caps({ decisionLimits: { maxScoreLevels: 2 } }))
    );
    expect(error.validationDetails[0].field).toBe('questions.a.criteria');
  });

  it('throws when the question count exceeds maxQuestions', () => {
    const error = catchError(() =>
      validateDecisionRequest(
        make({ a: choice, b: score, c: noul }),
        caps({ decisionLimits: { maxQuestions: 2 } })
      )
    );
    expect(error.validationDetails[0].field).toBe('questions');
  });

  it('throws on images when the backend does not accept them', () => {
    const request = make({ a: choice }, { images: [image] });
    expect(
      catchError(() => validateDecisionRequest(request, caps())).validationDetails[0].field
    ).toBe('images');
    expect(() => validateDecisionRequest(request, caps({ decisionImages: false }))).toThrow(
      ValidationError
    );
  });

  it('accepts images when decisionImages is true', () => {
    expect(
      validateDecisionRequest(
        make({ a: choice }, { images: [image] }),
        caps({ decisionImages: true })
      )
    ).toEqual([]);
  });

  it('throws when images exceed maxImages', () => {
    const error = catchError(() =>
      validateDecisionRequest(
        make({ a: choice }, { images: [image, image] }),
        caps({ decisionImages: true, decisionLimits: { maxImages: 1 } })
      )
    );
    expect(error.validationDetails[0].field).toBe('images');
  });

  it('ignores an empty images array', () => {
    expect(validateDecisionRequest(make({ a: choice }, { images: [] }), caps())).toEqual([]);
  });
});

describe('validateDecisionRequest: soft warnings', () => {
  it('warns on instructions longer than 2000 characters', () => {
    const long = { ...noul, instructions: 'x'.repeat(2001) };
    const warnings = validateDecisionRequest(make({ a: long }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].field).toBe('questions.a.instructions');
    expect(
      validateDecisionRequest(make({ a: { ...noul, instructions: 'x'.repeat(2000) } }))
    ).toEqual([]);
  });

  it('warns on polar-word choice keys, citing option-name bias', () => {
    const polar: IRDecisionQuestion = {
      type: 'choice',
      instructions: 'Is it safe?',
      criteria: { Yes: 'it is safe', NO: 'it is not' },
    };
    const warnings = validateDecisionRequest(make({ a: polar }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].field).toBe('questions.a.criteria');
    expect(warnings[0].message).toContain('2609.26758');
    expect(warnings[0].message).toMatch(/neutral/);
    expect(warnings[0].message).toContain('Yes');
  });

  it('does not warn on neutral or non-polar keys', () => {
    const neutral: IRDecisionQuestion = {
      type: 'choice',
      instructions: 'Which?',
      criteria: { opt_1: 'a', opt_2: 'b' },
    };
    expect(validateDecisionRequest(make({ a: neutral }))).toEqual([]);
  });

  it('warns on predominantly non-Latin state for an English-only model', () => {
    const request = make(
      { a: noul },
      { state: 'これは日本語のテキストです。請求が二重になっています' }
    );
    const warnings = validateDecisionRequest(request, caps({ decisionModels: ['english'] }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].category).toBe('capability-unsupported');
    expect(warnings[0].field).toBe('state');
  });

  it('measures structured state by its serialized text', () => {
    const request = make({ a: noul }, { state: { body: 'это русский текст о счёте' } });
    expect(validateDecisionRequest(request, caps({ decisionModels: ['en-v1'] }))).toHaveLength(1);
  });

  it('does not warn when the state is Latin, mostly Latin, or has no letters', () => {
    const eng = caps({ decisionModels: ['english'] });
    expect(validateDecisionRequest(make({ a: noul }), eng)).toEqual([]);
    expect(validateDecisionRequest(make({ a: noul }, { state: 'billing 請求' }), eng)).toEqual([]);
    expect(validateDecisionRequest(make({ a: noul }, { state: '1234 !!' }), eng)).toEqual([]);
  });

  it('does not warn when a model is multilingual or models are undeclared', () => {
    const state = 'これは日本語のテキストです';
    expect(
      validateDecisionRequest(
        make({ a: noul }, { state }),
        caps({ decisionModels: ['english', 'multilingual'] })
      )
    ).toEqual([]);
    expect(validateDecisionRequest(make({ a: noul }, { state }), caps())).toEqual([]);
    expect(validateDecisionRequest(make({ a: noul }, { state }))).toEqual([]);
  });
});
