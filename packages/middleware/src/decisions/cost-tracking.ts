/**
 * Decision Cost Tracking Middleware
 *
 * Track the spend of typed-decision calls. The decision counterpart of
 * `createCostTrackingMiddleware`, sharing its config, ledger
 * (`CostStorage`), thresholds and `onCost` callback, and its pricing lookup
 * (`resolvePricing`, which ends at the shared model registry in
 * `aimatey-utils`). What differs is where the number comes from: decision
 * usage is `{ inputTokens, outputTokens?, cost? }`, not chat's
 * `promptTokens` / `completionTokens` / `totalTokens`.
 *
 * @module
 */

import type { DecisionMiddleware } from '@johnhenry/aimatey-types';
import {
  InMemoryCostStorage,
  recordCost,
  resolvePricing,
  type CostCalculation,
  type CostTrackingConfig,
  type ProviderPricing,
} from '../cost-tracking.js';
import { defaultLogger, type Logger } from '../logging.js';

/**
 * Configuration for decision cost tracking middleware: the chat
 * {@link CostTrackingConfig} plus a logger for the "no price known" warning.
 */
export interface DecisionCostTrackingConfig extends CostTrackingConfig {
  /**
   * Logger for the warning emitted when a call has usage but no price.
   * @default console
   */
  logger?: Logger;
}

/**
 * Where a recorded cost came from, set as `metadata.costSource` on the
 * {@link CostCalculation}:
 * - `'provider'`: `usage.cost`, reported by the API (e.g. OpenRouter)
 * - `'pricing'`: usage tokens x configured / registry pricing
 * - `'none'`: usage was reported but no price could be found; cost is 0
 */
export type DecisionCostSource = 'provider' | 'pricing' | 'none';

/**
 * Create decision cost tracking middleware.
 *
 * Cost is `response.usage.cost` when the provider reports it; otherwise
 * `inputTokens` (and `outputTokens`, if any) x the price for
 * `response.model`, falling back to `request.parameters.model`; otherwise 0
 * with a warning-level log. Pricing is looked up in `models` / `providers`
 * (as for chat), then the model registry -- never the chat providers'
 * representative rate, which would misprice a decision model.
 *
 * Place it inside the caching middleware: a cache hit never reaches it, so
 * a replayed answer is not billed twice.
 *
 * @param config Cost tracking configuration
 * @returns Decision middleware
 *
 * @example
 * ```typescript
 * bridge.useDecision(
 *   createDecisionCostTrackingMiddleware({
 *     onCost: (cost) => console.log(`${cost.model}: $${cost.totalCost.toFixed(6)}`),
 *   })
 * );
 * ```
 */
export function createDecisionCostTrackingMiddleware(
  config: DecisionCostTrackingConfig = {}
): DecisionMiddleware {
  const storage = config.storage || new InMemoryCostStorage();
  const logger = config.logger ?? defaultLogger;

  return async (request, next) => {
    const response = await next(request);
    const usage = response.usage;
    if (!usage) {
      return response;
    }

    const provider =
      response.provider ??
      response.metadata.provenance?.backend ??
      request.metadata.provenance?.backend ??
      'unknown';
    const model = response.model || request.parameters?.model || 'unknown';
    const outputTokens = usage.outputTokens ?? 0;

    let source: DecisionCostSource;
    let inputCost = 0;
    let outputCost = 0;

    if (usage.cost !== undefined) {
      // A provider-reported total cannot be split; it is all booked as input.
      source = 'provider';
      inputCost = usage.cost;
    } else {
      // Try the model the backend says answered, then the one that was asked for.
      let pricing: ProviderPricing | undefined;
      for (const candidate of [model, request.parameters?.model]) {
        if (candidate) {
          pricing = resolvePricing(provider, candidate, config, false);
          if (pricing) {
            break;
          }
        }
      }

      if (pricing) {
        source = 'pricing';
        inputCost = (usage.inputTokens / 1_000_000) * pricing.inputCostPer1M;
        outputCost = (outputTokens / 1_000_000) * pricing.outputCostPer1M;
      } else {
        source = 'none';
        logger.warn(
          `[DecisionCost] No price for model '${model}' (provider '${provider}'): ` +
            `recording ${usage.inputTokens} input tokens at $0. ` +
            'Register the model or pass `models` pricing.'
        );
      }
    }

    const cost: CostCalculation = {
      provider,
      model,
      inputTokens: usage.inputTokens,
      outputTokens,
      totalTokens: usage.inputTokens + outputTokens,
      inputCost,
      outputCost,
      totalCost: inputCost + outputCost,
      timestamp: Date.now(),
      requestId: request.metadata.requestId,
      metadata: {
        ...request.metadata.custom,
        ...(request.metadata.principal !== undefined && { principal: request.metadata.principal }),
        costSource: source,
      },
    };

    await recordCost(cost, config, storage);

    if (config.includeInMetadata) {
      return {
        ...response,
        metadata: {
          ...response.metadata,
          custom: { ...response.metadata.custom, cost },
        },
      };
    }

    return response;
  };
}
