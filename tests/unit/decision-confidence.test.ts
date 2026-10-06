/**
 * decisionConfidence / noulConfidence (#162): the one confidence definition.
 */

import { describe, it, expect } from 'vitest';
import { decisionConfidence, noulConfidence } from '@johnhenry/aimatey-utils';

describe('decisionConfidence', () => {
  it('is 1 for a one-hot distribution and 0 for a uniform one', () => {
    expect(decisionConfidence([1, 0, 0])).toBe(1);
    expect(decisionConfidence([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(0, 12);
  });

  it('is 1 for fewer than two options (nothing to be unsure about)', () => {
    expect(decisionConfidence([1])).toBe(1);
    expect(decisionConfidence([])).toBe(1);
  });

  it('is 1 - H(p)/ln(n)', () => {
    // H([0.5, 0.25, 0.25]) = 1.5 ln 2; ln 3 = 1.0986
    expect(decisionConfidence([0.5, 0.25, 0.25])).toBeCloseTo(
      1 - (1.5 * Math.LN2) / Math.log(3),
      10
    );
  });

  it('is a concentration measure, not winner mass (Jev/Ollama nimble numbers)', () => {
    // nimble: top probability 0.987 -> confidence ~0.93
    expect(decisionConfidence([0.987, 0.0065, 0.0065])).toBeCloseTo(0.93, 2);
    // nimble: probabilities [0.42, 0.42, 0.16] -> confidence ~0.069
    expect(decisionConfidence([0.42, 0.42, 0.16])).toBeCloseTo(0.069, 2);
  });

  it('is clamped to [0, 1] and tolerates unnormalized rounding noise', () => {
    const c = decisionConfidence([0.5000001, 0.5000001]);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  });
});

describe('noulConfidence', () => {
  it('is the two-option concentration of [p, 1 - p]', () => {
    expect(noulConfidence(0.5)).toBeCloseTo(0, 12);
    expect(noulConfidence(0)).toBe(1);
    expect(noulConfidence(1)).toBe(1);
    expect(noulConfidence(0.8)).toBeCloseTo(decisionConfidence([0.8, 0.2]), 12);
    expect(noulConfidence(0.8)).toBeCloseTo(0.278, 3);
  });

  it('is symmetric around 0.5', () => {
    expect(noulConfidence(0.1)).toBeCloseTo(noulConfidence(0.9), 12);
  });
});
