/**
 * Decision testing helpers: calibration measurement and the name-invariance
 * check (#147).
 *
 * @module
 */

export {
  calibrationReport,
  fitTemperature,
  type CalibrationRun,
  type CalibrationBucket,
  type CalibrationReport,
  type TemperatureFit,
} from './calibration.js';

export {
  nameInvariance,
  type NameInvarianceOptions,
  type NameInvarianceQuestion,
  type NameInvarianceReport,
} from './name-invariance.js';
