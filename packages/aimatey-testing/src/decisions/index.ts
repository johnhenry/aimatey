/**
 * Decision testing helpers: calibration measurement, the name-invariance
 * check (#147) and dataset capture.
 *
 * Exposed as the `@johnhenry/aimatey-testing/decisions` subpath. Nothing in
 * this directory may import Vitest (directly or transitively): CLIs such as
 * the benchmark harness load this entry outside a test run.
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

export {
  createDecisionCapture,
  createMemoryDecisionSink,
  createFileDecisionSink,
  joinDecisionLines,
  loadDecisionDataset,
  toCalibrationRuns,
  type DecisionOutcome,
  type DecisionLogLine,
  type OutcomeLogLine,
  type DecisionCaptureLine,
  type DecisionRecord,
  type DecisionCaptureSink,
  type MemoryDecisionSink,
  type DecisionCaptureConfig,
  type DecisionCapture,
} from './capture.js';
