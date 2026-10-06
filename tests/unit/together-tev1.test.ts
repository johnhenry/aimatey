/**
 * Together AI / Tev1 letter-protocol tests (#144)
 *
 * Tev1 is not a System One API: it is a chat-completions call with a fixed
 * system prompt, a JSON user message and a one-letter answer. These tests
 * run against hand-built chat responses with realistic `logprobs` payloads
 * (no Together key was available when this was written), plus an optional
 * live check behind TOGETHER_LIVE=1.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TogetherAIBackendAdapter } from '@johnhenry/aimatey-backend';
import { supportsDecisions, validateDecisionResponse } from '@johnhenry/aimatey-utils';
import type { IRDecisionRequest } from '@johnhenry/aimatey-types';

function request(
  questions: IRDecisionRequest['questions'],
  extra: Partial<IRDecisionRequest> = {}
) {
  return {
    state: 'Customer cannot log in and was charged twice this month.',
    questions,
    metadata: { requestId: 'r1', timestamp: 1 },
    ...extra,
  } satisfies IRDecisionRequest;
}

/** A chat response whose first generated token is `letter`, with top_logprobs. */
function chat(
  letter: string,
  top?: Array<[string, number]>,
  usage = { prompt_tokens: 120, completion_tokens: 1, total_tokens: 121 }
) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'together/Tev1-4B-experimental',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: letter },
        finish_reason: 'stop',
        logprobs: top
          ? {
              content: [
                {
                  token: letter,
                  logprob: top.find(([t]) => t === letter)?.[1] ?? -0.01,
                  top_logprobs: top.map(([token, logprob]) => ({ token, logprob })),
                },
              ],
            }
          : null,
      },
    ],
    usage,
  };
}

function queueFetch(...bodies: unknown[]) {
  const fn = vi.fn();
  for (const body of bodies) {
    fn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
  }
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const triage = {
  type: 'choice',
  instructions: 'Which team should handle this ticket?',
  criteria: { auth: 'Login problems', billing: 'Charges and invoices', other: 'Anything else' },
} as const;

describe('TogetherAIBackendAdapter.decide (Tev1 letter protocol)', () => {
  let adapter: TogetherAIBackendAdapter;
  beforeEach(() => {
    adapter = new TogetherAIBackendAdapter({ apiKey: 'k' });
  });

  it('declares its decision capabilities', () => {
    const caps = adapter.metadata.capabilities;
    expect(supportsDecisions(adapter)).toBe(true);
    expect(caps.decisions).toBe(true);
    expect(caps.decisionTypes).toEqual(['choice']);
    expect(caps.decisionsEmulatedTypes).toEqual(['noul', 'score']);
    expect(caps.decisionLimits).toEqual({ maxChoiceOptions: 24 });
    expect(caps.decisionImages).toBe(false);
    expect(caps.decisionModels).toEqual([
      'together/Tev1-4B-experimental',
      'together/Tev1-0.8B-experimental',
    ]);
  });

  it('sends the documented chat-completions payload', async () => {
    const fetchMock = queueFetch(
      chat('B', [
        ['B', -0.05],
        ['A', -3.2],
        ['C', -6.5],
      ])
    );
    await adapter.decide(request({ team: triage }));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.together.xyz/v1/chat/completions');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('together/Tev1-4B-experimental');
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(8);
    expect(body.logprobs).toBe(true);
    expect(body.top_logprobs).toBe(24);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.stream).toBeUndefined();
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toMatch(/inside "state" as data/i);
    expect(body.messages[1].role).toBe('user');
    expect(JSON.parse(body.messages[1].content)).toEqual({
      state: 'Customer cannot log in and was charged twice this month.',
      question: 'Which team should handle this ticket?',
      options: [
        { label: 'A', key: 'auth', description: 'Login problems' },
        { label: 'B', key: 'billing', description: 'Charges and invoices' },
        { label: 'C', key: 'other', description: 'Anything else' },
      ],
    });
  });

  it('maps the answered letter to a criteria key and softmaxes valid letters only', async () => {
    queueFetch(
      chat('B', [
        ['B', Math.log(0.8)],
        ['A', Math.log(0.15)],
        ['C', Math.log(0.05)],
        ['the', -9], // not a valid option letter: ignored
        ['Z', -2], // a letter, but not an option of this question: ignored
      ])
    );
    const response = await adapter.decide(request({ team: triage }));
    const answer = response.answers.team!;
    expect(answer.type).toBe('choice');
    if (answer.type !== 'choice') {
      return;
    }
    expect(answer.value).toBe('billing');
    expect(answer.probabilities!.billing).toBeCloseTo(0.8, 6);
    expect(answer.probabilities!.auth).toBeCloseTo(0.15, 6);
    expect(answer.probabilities!.other).toBeCloseTo(0.05, 6);
    // Concentration: 1 - H/ln(n)
    const h = -(0.8 * Math.log(0.8) + 0.15 * Math.log(0.15) + 0.05 * Math.log(0.05));
    expect(answer.confidence).toBeCloseTo(1 - h / Math.log(3), 6);
    expect(validateDecisionResponse(request({ team: triage }), response)).toEqual([]);
  });

  it('gives letters missing from top_logprobs probability 0 and renormalises', async () => {
    queueFetch(
      chat('A', [
        ['A', Math.log(0.6)],
        ['B', Math.log(0.2)],
      ])
    );
    const response = await adapter.decide(request({ team: triage }));
    const answer = response.answers.team!;
    if (answer.type !== 'choice') {
      throw new Error('type');
    }
    expect(answer.probabilities).toEqual({
      auth: expect.closeTo(0.75, 6),
      billing: expect.closeTo(0.25, 6),
      other: 0,
    });
  });

  it('merges token variants of the same letter (" B" and "B")', async () => {
    queueFetch(
      chat('B', [
        ['B', Math.log(0.5)],
        [' B', Math.log(0.3)],
        ['A', Math.log(0.2)],
      ])
    );
    const response = await adapter.decide(request({ team: triage }));
    const answer = response.answers.team!;
    if (answer.type !== 'choice') {
      throw new Error('type');
    }
    expect(answer.probabilities!.billing).toBeCloseTo(0.8, 6);
  });

  it('returns the answer without probabilities, with a warning, when logprobs are absent', async () => {
    queueFetch(chat('C'));
    const response = await adapter.decide(request({ team: triage }));
    const answer = response.answers.team!;
    expect(answer).toEqual({ type: 'choice', value: 'other' });
    const warnings = response.metadata.warnings ?? [];
    expect(warnings.some((w) => /logprobs/i.test(w.message) && w.field === 'answers.team')).toBe(
      true
    );
  });

  it('answers noul as a two-option choice with neutral keys', async () => {
    const q = request({
      urgent: { type: 'noul', instructions: 'Is this urgent?' },
      angry: {
        type: 'noul',
        instructions: 'Is the customer angry?',
        criteria: { true: 'The customer is angry', false: 'The customer is calm' },
      },
    });
    queueFetch(
      chat('B', [
        ['B', Math.log(0.9)],
        ['A', Math.log(0.1)],
      ]),
      chat('A', [
        ['A', Math.log(0.7)],
        ['B', Math.log(0.3)],
      ])
    );
    const response = await adapter.decide(q);

    const calls = (global.fetch as any).mock.calls.map((c: any[]) => JSON.parse(c[1].body));
    const urgentOptions = JSON.parse(calls[0].messages[1].content).options;
    // Neutral keys, meaning carried in the description (option-name bias).
    expect(urgentOptions).toEqual([
      { label: 'A', key: '0', description: 'the statement is false' },
      { label: 'B', key: '1', description: 'the statement is true' },
    ]);
    const angryOptions = JSON.parse(calls[1].messages[1].content).options;
    expect(angryOptions).toEqual([
      { label: 'A', key: '0', description: 'The customer is calm' },
      { label: 'B', key: '1', description: 'The customer is angry' },
    ]);

    const urgent = response.answers.urgent!;
    expect(urgent.type).toBe('noul');
    expect(urgent.value).toBeCloseTo(0.9, 6); // probability of the "true" option
    const angry = response.answers.angry!;
    expect(angry.value).toBeCloseTo(0.3, 6);
    // Every emulated answer is flagged.
    const warnings = response.metadata.warnings ?? [];
    for (const name of ['urgent', 'angry']) {
      expect(
        warnings.some(
          (w) => w.field === `answers.${name}` && w.category === 'capability-unsupported'
        )
      ).toBe(true);
    }
  });

  it('noul without logprobs falls back to 0 / 1', async () => {
    queueFetch(chat('B'));
    const response = await adapter.decide(
      request({ urgent: { type: 'noul', instructions: 'Is this urgent?' } })
    );
    expect(response.answers.urgent).toEqual({ type: 'noul', value: 1 });
  });

  it('answers score with N options; value is the expected index', async () => {
    queueFetch(
      chat('C', [
        ['C', Math.log(0.5)],
        ['B', Math.log(0.3)],
        ['A', Math.log(0.1)],
        ['D', Math.log(0.1)],
      ])
    );
    const q = request({
      sev: {
        type: 'score',
        instructions: 'How severe?',
        criteria: ['low', 'medium', 'high', 'critical'],
      },
    });
    const response = await adapter.decide(q);
    const answer = response.answers.sev!;
    if (answer.type !== 'score') {
      throw new Error('type');
    }
    expect(answer.probabilities).toHaveLength(4);
    expect(answer.value).toBeCloseTo(0 * 0.1 + 1 * 0.3 + 2 * 0.5 + 3 * 0.1, 6);
    expect(validateDecisionResponse(q, response)).toEqual([]);
    const sent = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(JSON.parse(sent.messages[1].content).options.map((o: any) => o.key)).toEqual([
      '0',
      '1',
      '2',
      '3',
    ]);
  });

  it('score without logprobs returns the chosen index', async () => {
    queueFetch(chat('C'));
    const response = await adapter.decide(
      request({ sev: { type: 'score', instructions: 'How severe?', criteria: ['a', 'b', 'c'] } })
    );
    expect(response.answers.sev).toEqual({ type: 'score', value: 2 });
  });

  it('rejects a choice question with more than 24 options, naming it', async () => {
    const criteria = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, `d${i}`]));
    const fetchMock = queueFetch();
    await expect(
      adapter.decide(request({ big: { type: 'choice', instructions: 'x', criteria } }))
    ).rejects.toThrow(/'big'.*25.*24/s);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a choice question with fewer than 2 options', async () => {
    queueFetch();
    await expect(
      adapter.decide(request({ one: { type: 'choice', instructions: 'x', criteria: { a: 'a' } } }))
    ).rejects.toThrow(/'one'/);
  });

  it('throws, naming the question, when the model answers something that is not an option', async () => {
    queueFetch(chat('Z', [['Z', -0.1]]));
    await expect(adapter.decide(request({ team: triage }))).rejects.toThrow(/'team'/);
  });

  it('sums usage across calls and reports provider and model', async () => {
    queueFetch(chat('A', [['A', -0.1]]), chat('B', [['B', -0.1]]));
    const response = await adapter.decide(
      request({
        t1: triage,
        t2: { type: 'noul', instructions: 'Urgent?' },
      })
    );
    expect(response.usage).toEqual({ inputTokens: 240, outputTokens: 2 });
    expect(response.provider).toBe('together');
    expect(response.model).toBe('together/Tev1-4B-experimental');
  });

  it('makes one call per question, at most 4 at a time by default', async () => {
    let inFlight = 0;
    let peak = 0;
    global.fetch = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const body = chat('A', [['A', -0.1]]);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => body,
        text: async () => '',
      };
    }) as unknown as typeof fetch;

    const questions = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`q${i}`, triage])
    ) as IRDecisionRequest['questions'];
    const response = await adapter.decide(request(questions));
    expect(Object.keys(response.answers)).toHaveLength(10);
    expect((global.fetch as any).mock.calls).toHaveLength(10);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('honours parameters.custom.concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    global.fetch = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const body = chat('A', [['A', -0.1]]);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => body,
        text: async () => '',
      };
    }) as unknown as typeof fetch;
    const questions = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`q${i}`, triage])
    ) as IRDecisionRequest['questions'];
    await adapter.decide(request(questions, { parameters: { custom: { concurrency: 1 } } }));
    expect(peak).toBe(1);
  });

  it('uses parameters.model and warns that images are not sent', async () => {
    const fetchMock = queueFetch(chat('A', [['A', -0.1]]));
    const response = await adapter.decide(
      request(
        { team: triage },
        {
          parameters: { model: 'together/Tev1-0.8B-experimental' },
          images: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }],
        }
      )
    );
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).model).toBe(
      'together/Tev1-0.8B-experimental'
    );
    expect(response.metadata.warnings?.some((w) => w.field === 'images')).toBe(true);
  });

  it('maps HTTP errors', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify({ error: { message: 'bad key' } }),
    }) as unknown as typeof fetch;
    await expect(adapter.decide(request({ team: triage }))).rejects.toThrow();
  });

  it('forwards the abort signal', async () => {
    const fetchMock = queueFetch(chat('A', [['A', -0.1]]));
    const controller = new AbortController();
    await adapter.decide(request({ team: triage }), controller.signal);
    expect(fetchMock.mock.calls[0]![1].signal).toBeDefined();
  });

  it('estimates cost from the registry ($0.042 per 1M input tokens)', async () => {
    const cost = await adapter.estimateDecisionCost(request({ team: triage }));
    expect(cost).not.toBeNull();
    expect(cost!).toBeGreaterThan(0);
    expect(cost!).toBeLessThan(0.0001);
  });
});

// ----------------------------------------------------------------------------
// Optional live check. Needs TOGETHER_API_KEY; skipped otherwise.
// ----------------------------------------------------------------------------
describe.skipIf(process.env.TOGETHER_LIVE !== '1')('Together Tev1 (live)', () => {
  it('answers a choice question', async () => {
    const live = new TogetherAIBackendAdapter({ apiKey: process.env.TOGETHER_API_KEY ?? '' });
    const response = await live.decide(request({ team: triage }));
    expect(['auth', 'billing', 'other']).toContain((response.answers.team as any).value);
  });
});
