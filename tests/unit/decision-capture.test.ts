/**
 * Decision dataset capture: createDecisionCapture, loadDecisionDataset,
 * toCalibrationRuns (aimatey-testing).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import {
  createDecisionCapture,
  createMemoryDecisionSink,
  loadDecisionDataset,
  toCalibrationRuns,
  createMockDecisionBackend,
} from '@johnhenry/aimatey-testing';
import type { IRDecisionQuestion } from '@johnhenry/aimatey-types';

const questions: Record<string, IRDecisionQuestion> = {
  urgent: { type: 'noul', instructions: 'Is this urgent?' },
  team: {
    type: 'choice',
    instructions: 'Which team?',
    criteria: { billing: 'invoices', technical: 'bugs' },
  },
};

function makeBridge() {
  const backend = createMockDecisionBackend({
    answers: {
      urgent: { type: 'noul', value: 0.9 },
      team: { type: 'choice', value: 'billing', probabilities: { billing: 0.8, technical: 0.2 } },
    },
  });
  return new Bridge(new OpenAIFrontendAdapter(), backend);
}

let dir: string | undefined;
afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

async function tempPath(name = 'decisions.jsonl'): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'decision-capture-'));
  return join(dir, name);
}

describe('createDecisionCapture', () => {
  it('records each decision through the middleware (in-memory sink)', async () => {
    const sink = createMemoryDecisionSink();
    const capture = createDecisionCapture({ sink });
    const bridge = makeBridge().useDecision(capture.middleware);

    const response = await bridge.decide({ subject: 'Refund' }, questions, { model: 'm1' });
    await capture.flush();

    const records = await capture.records();
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.requestId).toBe(response.metadata.requestId);
    expect(record.timestamp).toEqual(expect.any(Number));
    expect(record.backend).toBe('mock-decision');
    expect(record.model).toBe('mock-decision-model');
    expect(record.state).toEqual({ subject: 'Refund' });
    expect(record.questions).toEqual(questions);
    expect(record.answers).toEqual(response.answers);
    expect(record.outcome).toBeUndefined();
    expect(sink.lines).toHaveLength(1);
  });

  it('records usage and warnings when the response has them', async () => {
    const backend = createMockDecisionBackend({
      handler: (request) => ({
        answers: { urgent: { type: 'noul', value: 0.5 } },
        model: 'm',
        usage: { inputTokens: 12, cost: 0.001 },
        metadata: {
          ...request.metadata,
          warnings: [{ category: 'parameter-normalized', severity: 'info', message: 'w' }],
        },
      }),
    });
    const capture = createDecisionCapture({ sink: createMemoryDecisionSink() });
    const bridge = new Bridge(new OpenAIFrontendAdapter(), backend).useDecision(capture.middleware);

    await bridge.decide('x', { urgent: questions.urgent! });
    const [record] = await capture.records();
    expect(record!.usage).toEqual({ inputTokens: 12, cost: 0.001 });
    expect(record!.warnings?.[0]?.message).toBe('w');
  });

  it('omits state with includeState: false', async () => {
    const capture = createDecisionCapture({ sink: createMemoryDecisionSink(), includeState: false });
    await makeBridge().useDecision(capture.middleware).decide('secret', questions);
    const [record] = await capture.records();
    expect(record).not.toHaveProperty('state');
  });

  it('redacts state before it is written', async () => {
    const sink = createMemoryDecisionSink();
    const capture = createDecisionCapture({
      sink,
      redact: (state) => ({ ...(state as object), email: '[redacted]' }),
    });
    await makeBridge()
      .useDecision(capture.middleware)
      .decide({ subject: 'Hi', email: 'a@b.c' }, questions);

    expect(JSON.stringify(sink.lines)).not.toContain('a@b.c');
    const [record] = await capture.records();
    expect(record!.state).toEqual({ subject: 'Hi', email: '[redacted]' });
  });

  it('does not record a failed decision and does not change the result', async () => {
    const capture = createDecisionCapture({ sink: createMemoryDecisionSink() });
    const bridge = new Bridge(
      new OpenAIFrontendAdapter(),
      createMockDecisionBackend({ error: new Error('boom') })
    ).useDecision(capture.middleware);

    await expect(bridge.decide('x', questions)).rejects.toThrow('boom');
    expect(await capture.records()).toEqual([]);
  });

  it('never fails the decision when the sink fails; reports via onError', async () => {
    const errors: unknown[] = [];
    const capture = createDecisionCapture({
      sink: {
        write: () => {
          throw new Error('disk full');
        },
      },
      onError: (error) => errors.push(error),
    });
    const response = await makeBridge().useDecision(capture.middleware).decide('x', questions);
    await capture.flush();

    expect(response.answers.urgent).toBeDefined();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('disk full');
  });

  it('joins outcomes to decisions by requestId, append-only', async () => {
    const sink = createMemoryDecisionSink();
    const capture = createDecisionCapture({ sink });
    const bridge = makeBridge().useDecision(capture.middleware);

    const first = await bridge.decide('a', questions);
    const second = await bridge.decide('b', questions);
    await capture.recordOutcome(first.metadata.requestId, { urgent: true }, { labeler: 'human' });
    await capture.recordOutcome(first.metadata.requestId, { team: 'billing' });

    // decisions and outcomes are separate lines; nothing is rewritten
    expect(sink.lines).toHaveLength(4);
    expect(sink.lines[2]).toMatchObject({
      requestId: first.metadata.requestId,
      outcome: { urgent: true },
      meta: { labeler: 'human' },
    });

    const records = await capture.records();
    expect(records).toHaveLength(2);
    expect(records[0]!.outcome).toEqual({ urgent: true, team: 'billing' });
    expect(records[0]!.meta).toEqual({ labeler: 'human' });
    expect(records[1]!.requestId).toBe(second.metadata.requestId);
    expect(records[1]!.outcome).toBeUndefined();
  });
});

describe('file sink', () => {
  it('round-trips JSONL, one object per line, through loadDecisionDataset', async () => {
    const path = await tempPath();
    const capture = createDecisionCapture({ sink: path });
    const bridge = makeBridge().useDecision(capture.middleware);

    const a = await bridge.decide('a', questions);
    await bridge.decide('b', questions);
    await capture.recordOutcome(a.metadata.requestId, { urgent: false });
    await capture.flush();

    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }

    const loaded = await loadDecisionDataset(path);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]!.outcome).toEqual({ urgent: false });
    expect(loaded).toEqual(await capture.records());
  });

  it('appends to an existing file and tolerates blank lines', async () => {
    const path = await tempPath();
    const one = createDecisionCapture({ sink: path });
    await makeBridge().useDecision(one.middleware).decide('a', questions);
    await one.flush();

    const two = createDecisionCapture({ sink: path });
    await makeBridge().useDecision(two.middleware).decide('b', questions);
    await two.flush();

    expect(await loadDecisionDataset(path)).toHaveLength(2);
  });

  it('names the line of a malformed record', async () => {
    const path = await tempPath();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{"requestId":"r","answers":{},"questions":{}}\nnot json\n');
    await expect(loadDecisionDataset(path)).rejects.toThrow(/line 2/);
  });
});

describe('toCalibrationRuns', () => {
  it('pairs each answer with its recorded truth, per question', async () => {
    const capture = createDecisionCapture({ sink: createMemoryDecisionSink() });
    const bridge = makeBridge().useDecision(capture.middleware);

    const a = await bridge.decide('a', questions);
    const b = await bridge.decide('b', questions);
    await bridge.decide('c (no outcome)', questions);
    await capture.recordOutcome(a.metadata.requestId, { urgent: true, team: 'technical' });
    await capture.recordOutcome(b.metadata.requestId, { urgent: false });

    const runs = toCalibrationRuns(await capture.records());

    expect(Object.keys(runs).sort()).toEqual(['team', 'urgent']);
    expect(runs.urgent).toEqual([
      { answer: { type: 'noul', value: 0.9 }, truth: true },
      { answer: { type: 'noul', value: 0.9 }, truth: false },
    ]);
    expect(runs.team).toHaveLength(1);
    expect(runs.team![0]!.truth).toBe('technical');
    expect(runs.team![0]!.answer.type).toBe('choice');
  });
});
