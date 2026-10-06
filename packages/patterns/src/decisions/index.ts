/**
 * Decision patterns: escalation, neutral option keys, ensemble, state
 * screening and calibration for typed-decision backends (#147).
 *
 * @module
 */

export {
  createDecisionEscalation,
  evaluateDecisionCondition,
  validateDecisionCondition,
  decisionBands,
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_CHILDREN,
  type DecisionCondition,
  type DecisionTrigger,
  type DecisionConditionResult,
  type DecisionBandThresholds,
  type DecisionEscalationInfo,
  type DecisionEscalationOptions,
} from './escalation.js';

export { createNeutralOptionKeys, type NeutralOptionKeysOptions } from './neutral-keys.js';

export {
  createDecisionEnsemble,
  type DecisionEnsembleOptions,
  type EnsembleAggregate,
} from './ensemble.js';

export { createStateScreening, type StateScreeningOptions } from './screening.js';

export { createTemperatureScaling, type TemperatureScalingOptions } from './calibration.js';
