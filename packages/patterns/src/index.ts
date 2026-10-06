/**
 * aimatey-patterns
 *
 * Production integration patterns, extracted from the validated pattern
 * library (docs/PATTERNS.md) into importable utilities.
 *
 * @module
 */

export {
  createComplexityRouter,
  defaultComplexityAnalyzer,
  type ComplexityRouterConfig,
  type ComplexityTier,
} from './complexity-router.js';

export {
  createParallelAggregator,
  type ParallelAggregatorConfig,
  type AggregationStrategy,
} from './parallel-aggregator.js';

export { createFailoverMiddleware, type FailoverConfig } from './failover.js';

export {
  createCostOptimizer,
  type CostOptimizerConfig,
  type CostOptimizer,
} from './cost-optimizer.js';

export {
  createBatchProcessor,
  type BatchProcessorConfig,
  type BatchProcessor,
  type BatchStats,
} from './batch-processor.js';

export {
  createEmulatedDecisionBackend,
  type EmulatedDecisionOptions,
} from './decision-emulation.js';

export * from './decisions/index.js';
