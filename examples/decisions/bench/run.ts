/**
 * Runs a dataset against one backend and collects scored answers, latency
 * and cost.
 *
 * Requests go through a real `Bridge`, so `--neutral-keys` and
 * `--temperature` are the same middleware (`createNeutralOptionKeys`,
 * `createTemperatureScaling`) an application would register with
 * `bridge.useDecision()`.
 *
 * @module
 */

import { Bridge } from '@johnhenry/aimatey-core';
import { createGenericFrontend } from '@johnhenry/aimatey-frontend';
import { createNeutralOptionKeys, createTemperatureScaling } from '@johnhenry/aimatey-patterns';
import { nameInvariance as measureNameInvariance } from '@johnhenry/aimatey-testing/decisions';
import type { BackendAdapter, IRDecisionAnswer, IRDecisionRequest } from '@johnhenry/aimatey-types';
import { answerMatchesQuestion, isCorrect, priceFor } from './scoring.js';
import type { BenchItem, GoldValue, ScoredRow } from './types.js';

/** Providers that run on the caller's machine: their calls cost nothing per token. */
const LOCAL_PROVIDERS = new Set(['Ollama', 'ConvAI (Laya)']);

export interface RunOptions {
  readonly backend: BackendAdapter;
  /** Name shown in the report. */
  readonly label: string;
  readonly items: readonly BenchItem[];
  readonly concurrency?: number;
  readonly neutralKeys?: boolean;
  readonly temperature?: number;
  readonly nameInvariance?: boolean;
  /** `parameters.model` on every request. */
  readonly model?: string;
  /** Called after each item finishes, for progress output. */
  readonly onItem?: (result: ItemResult, done: number, total: number) => void;
}

export interface ItemAnswer {
  readonly question: string;
  readonly type: IRDecisionAnswer['type'];
  readonly answer: IRDecisionAnswer;
  readonly gold: GoldValue;
  readonly correct: boolean;
}

export interface ItemResult {
  readonly id: string;
  readonly workflow: string;
  readonly latencyMs: number;
  /** USD, or `null` when the backend reported no usage and the registry has no price. */
  readonly cost: number | null;
  readonly inputTokens?: number;
  readonly model?: string;
  /** Set when the call threw or the response lacked a well-typed answer. */
  readonly error?: string;
  readonly answers: readonly ItemAnswer[];
}

export interface NameInvarianceSummary {
  /** Items the check ran on. */
  readonly items: number;
  /** Items where the check failed (backend error); not in `flipRate`. */
  readonly failed: number;
  /** Mean share of answers that flipped when option-to-definition bindings were rotated. */
  readonly flipRate: number;
  /** Mean share that flipped under neutral keys (`null` when nothing could be tested). */
  readonly neutralFlipRate: number | null;
}

export interface BackendResult {
  readonly label: string;
  /** Model the backend reported, falling back to the label. */
  readonly model: string;
  readonly items: ItemResult[];
  /** Every scored answer, for `summarize()`. */
  readonly rows: ScoredRow[];
  readonly errors: number;
  /** Sum of per-call costs; `null` when no call could be priced. */
  readonly totalCost: number | null;
  readonly wallMs: number;
  readonly nameInvariance?: NameInvarianceSummary;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run every item against `backend`. Never throws on a per-item failure; failures are counted. */
export async function runBench(options: RunOptions): Promise<BackendResult> {
  const { backend, items } = options;
  const declared = backend.metadata.capabilities.decisionLimits?.maxConcurrency;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 1, declared ?? Infinity));

  const local = LOCAL_PROVIDERS.has(backend.metadata.provider ?? '');
  const bridge = new Bridge(createGenericFrontend(), backend);
  if (options.temperature !== undefined) {
    bridge.useDecision(createTemperatureScaling({ default: options.temperature }));
  }
  if (options.neutralKeys) {
    bridge.useDecision(createNeutralOptionKeys());
  }

  const results: ItemResult[] = new Array(items.length);
  let next = 0;
  let done = 0;
  let reportedModel: string | undefined;
  const started = performance.now();

  async function runOne(item: BenchItem): Promise<ItemResult> {
    const t0 = performance.now();
    try {
      const response = await bridge.decide(item.state, item.questions, {
        ...(options.model && { model: options.model }),
      });
      const latencyMs = performance.now() - t0;
      reportedModel ??= response.model;
      const answers: ItemAnswer[] = [];
      for (const [name, question] of Object.entries(item.questions)) {
        const answer = response.answers[name];
        if (!answerMatchesQuestion(question, answer)) {
          throw new Error(
            answer === undefined
              ? `no answer for question '${name}'`
              : `question '${name}' is ${question.type} but the answer is ${answer.type}`
          );
        }
        const gold = item.gold[name]!;
        answers.push({ question: name, type: question.type, answer, gold, correct: isCorrect(answer, gold) });
      }
      return {
        id: item.id,
        workflow: item.workflow,
        latencyMs,
        cost: local ? 0 : priceFor(response.usage, response.model),
        ...(response.usage && { inputTokens: response.usage.inputTokens }),
        model: response.model,
        answers,
      };
    } catch (error) {
      return {
        id: item.id,
        workflow: item.workflow,
        latencyMs: performance.now() - t0,
        cost: null,
        error: errorMessage(error),
        answers: [],
      };
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        const result = await runOne(items[index]!);
        results[index] = result;
        options.onItem?.(result, ++done, items.length);
      }
    })
  );

  const rows: ScoredRow[] = results.flatMap((r) =>
    r.answers.map((a) => ({ type: a.type, answer: a.answer, gold: a.gold }))
  );
  const priced = results.map((r) => r.cost).filter((c): c is number => c !== null);

  const result: BackendResult = {
    label: options.label,
    model: reportedModel ?? options.label,
    items: results,
    rows,
    errors: results.filter((r) => r.error !== undefined).length,
    totalCost: priced.length === 0 ? null : priced.reduce((a, b) => a + b, 0),
    wallMs: performance.now() - started,
  };

  if (options.nameInvariance) {
    return { ...result, nameInvariance: await measureInvariance(backend, items) };
  }
  return result;
}

async function measureInvariance(
  backend: BackendAdapter,
  items: readonly BenchItem[]
): Promise<NameInvarianceSummary> {
  const flips: number[] = [];
  const neutral: number[] = [];
  let failed = 0;
  for (const item of items) {
    const request: IRDecisionRequest = {
      state: item.state,
      questions: item.questions,
      metadata: { requestId: `bench-invariance-${item.id}`, timestamp: Date.now() },
    };
    try {
      const report = await measureNameInvariance(backend, request);
      flips.push(report.flipRate);
      if (report.neutralFlipRate !== null) {
        neutral.push(report.neutralFlipRate);
      }
    } catch {
      failed++;
    }
  }
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    items: flips.length,
    failed,
    flipRate: flips.length === 0 ? Number.NaN : mean(flips),
    neutralFlipRate: neutral.length === 0 ? null : mean(neutral),
  };
}
