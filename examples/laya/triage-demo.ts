/**
 * Laya Typed-Decision Demo: Support Ticket Triage
 *
 * Demonstrates the typed-decision capability (sibling to chat and
 * embeddings) using ConvAI's Laya model, run entirely on-device via
 * `@johnhenry/aimatey-native-laya` -- no API key, no network call, no
 * per-request cost. This is deliberately not a chat example: a decision
 * request sends a `state` (here, a support ticket's free text) plus a set
 * of typed `questions`, and gets back typed `answers` with calibrated
 * probabilities in one forward pass -- nothing generated, nothing to
 * parse, nothing to hallucinate.
 *
 * Prerequisites:
 * 1. `npm install @receptron/laya` (optional peer dependency, not
 *    installed by default -- see this monorepo's root package.json,
 *    which deliberately does not force-install any native binding)
 * 2. First run downloads ~1.7GB of ONNX weights from HuggingFace,
 *    cached afterward (see `@receptron/laya`'s own `LAYA_CACHE` env var
 *    to override the cache location)
 *
 * Run with:
 *   npx tsx examples/laya/triage-demo.ts
 *   npx tsx examples/laya/triage-demo.ts "Custom ticket text to triage"
 *
 * @example
 */

import { Bridge } from '@johnhenry/aimatey-core';
import { createGenericFrontend } from '@johnhenry/aimatey-frontend';
import { LayaBackendAdapter } from '@johnhenry/aimatey-native-laya';
import type { IRDecisionAnswer } from '@johnhenry/aimatey-types';

// ============================================================================
// Sample tickets (used when no ticket text is passed on the command line)
// ============================================================================

const SAMPLE_TICKETS: readonly string[] = [
  "I was charged twice for my subscription this month and I can't reach anyone. This is the third time this has happened and I want a refund immediately.",
  'How do I change the display name on my profile? I looked in settings but could not find the option.',
  "The app crashes every time I try to export a report. I've lost two hours of work today because of this and I have a client deadline in an hour.",
  'Just wanted to say the new dashboard redesign looks great, nice work!',
];

// ============================================================================
// The typed-decision questions asked of every ticket
// ============================================================================

const TRIAGE_QUESTIONS = {
  category: {
    type: 'choice' as const,
    instructions: 'What is this support ticket primarily about?',
    criteria: {
      billing: 'Payments, charges, refunds, subscriptions, invoices',
      technical: 'Bugs, crashes, errors, broken features',
      account: 'Login, profile, settings, account access',
      other: 'Feedback, questions, or anything not covered above',
    },
  },
  urgency: {
    type: 'score' as const,
    instructions: 'How urgently does this ticket need a response?',
    criteria: ['low', 'medium', 'high', 'critical'],
  },
  needsHumanEscalation: {
    type: 'noul' as const,
    instructions:
      'Should this ticket be escalated directly to a human agent rather than handled by an automated response?',
  },
};

// ============================================================================
// Triage
// ============================================================================

async function triage(
  bridge: Bridge,
  ticketText: string
): Promise<Record<string, IRDecisionAnswer>> {
  const response = await bridge.decide({ ticket: ticketText }, TRIAGE_QUESTIONS);
  return response.answers;
}

// ============================================================================
// Formatting
// ============================================================================

function formatPercent(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

function formatAnswer(name: string, answer: IRDecisionAnswer): string {
  switch (answer.type) {
    case 'choice': {
      const probs = Object.entries(answer.probabilities)
        .sort((a, b) => b[1] - a[1])
        .map(([option, p]) => `${option}: ${formatPercent(p)}`)
        .join(', ');
      return `  ${name}: ${answer.value} (confidence ${formatPercent(answer.confidence)})\n    [${probs}]`;
    }
    case 'score': {
      // `value` is a probability-weighted expected value over the level
      // indices, not necessarily an integer (e.g. 1.1157 for a
      // distribution weighted toward index 1) -- confirmed live, not
      // assumed. Report both the nearest labeled level and the raw score,
      // rather than treating it as a discrete pick.
      const levels = TRIAGE_QUESTIONS.urgency.criteria;
      const nearestLevel = levels[Math.round(answer.value)] ?? String(answer.value);
      const probs = answer.probabilities
        .map((p, i) => `${levels[i] ?? i}: ${formatPercent(p)}`)
        .join(', ');
      return `  ${name}: ~${nearestLevel} (score ${answer.value.toFixed(2)}, confidence ${formatPercent(answer.confidence)})\n    [${probs}]`;
    }
    case 'noul': {
      const confidence = answer.confidence !== undefined ? formatPercent(answer.confidence) : 'n/a';
      return `  ${name}: ${formatPercent(answer.value)} likely (confidence ${confidence})`;
    }
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const customTicket = process.argv[2];
  const tickets = customTicket ? [customTicket] : SAMPLE_TICKETS;

  const backend = new LayaBackendAdapter();

  console.log('Loading Laya (first run downloads ~1.7GB of ONNX weights)...');
  await backend.initialize();
  console.log('Ready.\n');

  const bridge = new Bridge(createGenericFrontend(), backend);

  try {
    for (const [i, ticket] of tickets.entries()) {
      console.log(`--- Ticket ${i + 1} ---`);
      console.log(`"${ticket}"\n`);

      const answers = await triage(bridge, ticket);
      for (const [name, answer] of Object.entries(answers)) {
        console.log(formatAnswer(name, answer));
      }
      console.log('');
    }
  } finally {
    await backend.close();
  }
}

main().catch((error: unknown) => {
  console.error('Triage demo failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
