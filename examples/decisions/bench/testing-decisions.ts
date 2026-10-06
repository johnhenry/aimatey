/**
 * `calibrationReport` and `nameInvariance` from `@johnhenry/aimatey-testing`.
 *
 * The package root also exports Vitest-bound assertion helpers, and
 * importing it outside a Vitest run throws ("Vitest failed to access its
 * internal state"). The CLI is not a test run, so it reaches the decision
 * helpers (which have no Vitest dependency) through the built module
 * directly. Once the package gains a `./decisions` subpath export, replace
 * this file's re-export with an import of that subpath.
 *
 * @module
 */

export {
  calibrationReport,
  nameInvariance,
  type CalibrationReport,
  type NameInvarianceReport,
} from '../../../packages/aimatey-testing/dist/esm/decisions/index.js';
