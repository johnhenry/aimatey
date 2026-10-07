/**
 * OpenAIDecisionsFrontendAdapter (#180): the OpenAI Decisions wire shape
 * (`input`, `questions[]`, `answers[]`) round-tripped through
 * `Bridge.decideFrom()` against `createMockDecisionBackend`, and against the
 * live probe fixtures.
 */

import { describe, it, expect } from 'vitest';
import { Bridge } from '@johnhenry/aimatey-core';
import {
  OpenAIDecisionsFrontendAdapter,
  type OpenAIDecisionsRequest,
  type OpenAIDecisionsResponse,
} from '@johnhenry/aimatey-frontend';
import { createMockDecisionBackend, loadFixture } from '@johnhenry/aimatey-testing';
import { supportsDecisionFrontend, supportsChatFrontend } from '@johnhenry/aimatey-utils';
import type { IRDecisionRequest } from '@johnhenry/aimatey-types';

const wireRequest: OpenAIDecisionsRequest = {
  model: 'gpt-6-luna',
  input: 'Subject: Duplicate charge. Body: please refund me today.',
  questions: [
    {
      name: 'team',
      type: 'choice',
      instructions: 'Which team?',
      choices: [
        { value: 'billing', description: 'refunds' },
        { value: 'technical', description: 'outages' },
      ],
    },
    { name: 'refund', type: 'predicate', instructions: 'Wants a refund?' },
    {
      name: 'urgency',
      type: 'score',
      instructions: 'How urgent?',
      levels: [
        { label: 'low', description: 'low' },
        { label: 'mid', description: 'within a week' },
        { label: 'high', description: 'high' },
      ],
    },
  ],
};

describe('OpenAIDecisionsFrontendAdapter', () => {
  it('implements only the decision hooks', () => {
    const adapter = new OpenAIDecisionsFrontendAdapter();
    expect(supportsDecisionFrontend(adapter)).toBe(true);
    expect(supportsChatFrontend(adapter)).toBe(false);
    expect(adapter.metadata.capabilities.decisions).toBe(true);
  });

  it('maps the request to IR: input to state, questions array to a record', async () => {
    const ir = await new OpenAIDecisionsFrontendAdapter().decisionToIR(wireRequest);
    expect(ir.state).toBe(wireRequest.input);
    expect(ir.parameters?.model).toBe('gpt-6-luna');
    expect(ir.questions.team).toEqual({
      type: 'choice',
      instructions: 'Which team?',
      criteria: { billing: 'refunds', technical: 'outages' },
    });
    expect(ir.questions.refund).toEqual({ type: 'noul', instructions: 'Wants a refund?' });
    expect(ir.questions.urgency).toEqual({
      type: 'score',
      instructions: 'How urgent?',
      // label and description collapse when equal, else 'label: description'
      criteria: ['low', 'mid: within a week', 'high'],
    });
    expect(ir.images).toBeUndefined();
    expect(ir.metadata.provenance?.frontend).toBe('openai-decisions-frontend');
  });

  it('extracts message text and data-URL images into state and images', async () => {
    const ir = await new OpenAIDecisionsFrontendAdapter().decisionToIR({
      ...wireRequest,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Is this a cat?' },
            { type: 'input_image', image_url: 'data:image/png;base64,QUJD' },
            { type: 'input_text', text: 'Look closely.' },
          ],
        },
      ],
    });
    expect(ir.state).toBe('Is this a cat?\nLook closely.');
    expect(ir.images).toEqual([
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'QUJD' } },
    ]);
  });

  it('accepts plain string message content', async () => {
    const ir = await new OpenAIDecisionsFrontendAdapter().decisionToIR({
      ...wireRequest,
      input: [{ type: 'message', role: 'user', content: 'hello there' }],
    });
    expect(ir.state).toBe('hello there');
  });

  it('rejects a non-data image URL (the API does too)', async () => {
    await expect(
      new OpenAIDecisionsFrontendAdapter().decisionToIR({
        ...wireRequest,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_image', image_url: 'https://x.test/a.png' }],
          },
        ],
      })
    ).rejects.toThrow(/data:/);
  });

  it('round-trips every answer type through Bridge.decideFrom()', async () => {
    const backend = createMockDecisionBackend({
      model: 'gpt-6-luna',
      handler: (req: IRDecisionRequest) =>
        Promise.resolve({
          model: 'gpt-6-luna',
          answers: {
            team: {
              type: 'choice',
              value: 'billing',
              probabilities: { billing: 0.9, technical: 0.1 },
              confidence: 0.8,
            },
            refund: { type: 'noul', value: 0.93 },
            urgency: {
              type: 'score',
              value: 1.4,
              probabilities: [0.2, 0.5, 0.3],
              confidence: 0.5,
            },
          },
          usage: {
            inputTokens: 403,
            outputTokens: 0,
            details: {
              input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
          metadata: req.metadata,
        }),
    });
    const res: OpenAIDecisionsResponse = await new Bridge(
      new OpenAIDecisionsFrontendAdapter(),
      backend
    ).decideFrom(wireRequest);

    expect(res).toEqual({
      model: 'gpt-6-luna',
      answers: [
        {
          type: 'choice',
          name: 'team',
          choice: 'billing',
          probabilities: [
            { value: 'billing', probability: 0.9 },
            { value: 'technical', probability: 0.1 },
          ],
          confidence: 0.8,
        },
        { type: 'predicate', name: 'refund', probability: 0.93 },
        {
          type: 'score',
          name: 'urgency',
          score: 1.4,
          probabilities: [
            { value: 0, label: 'low', probability: 0.2 },
            { value: 1, label: 'mid', probability: 0.5 },
            { value: 2, label: 'high', probability: 0.3 },
          ],
          confidence: 0.5,
        },
      ],
      usage: {
        input_tokens: 403,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 403,
      },
    });
    expect(backend.calls[0]!.questions.refund!.type).toBe('noul');
  });

  it('defaults usage details and omits probabilities/confidence the backend did not report', async () => {
    const backend = createMockDecisionBackend({
      answers: {
        team: { type: 'choice', value: 'technical' },
        refund: { type: 'noul', value: 0.5 },
        urgency: { type: 'score', value: 2 },
      },
    });
    const res = await new Bridge(new OpenAIDecisionsFrontendAdapter(), backend).decideFrom(
      wireRequest
    );
    expect(res.answers[0]).toEqual({ type: 'choice', name: 'team', choice: 'technical' });
    expect(res.answers[2]).toEqual({ type: 'score', name: 'urgency', score: 2 });
    expect(res.usage).toEqual({
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    });
  });

  it('passes the images through the IR to the backend', async () => {
    const backend = createMockDecisionBackend({
      answers: { refund: { type: 'noul', value: 0.1 } },
    });
    (backend.metadata.capabilities as { decisionImages?: boolean }).decisionImages = true;
    await new Bridge(new OpenAIDecisionsFrontendAdapter(), backend).decideFrom({
      model: 'gpt-6-luna',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Is this a cat?' },
            { type: 'input_image', image_url: 'data:image/jpeg;base64,QUJD' },
          ],
        },
      ],
      questions: [{ name: 'refund', type: 'predicate', instructions: 'Is this a cat?' }],
    });
    expect(backend.calls[0]!.images).toEqual([
      { type: 'image', source: { type: 'base64', mediaType: 'image/jpeg', data: 'QUJD' } },
    ]);
  });

  it('replays the recorded triage response: wire request in, wire response out', async () => {
    const fixture = (await loadFixture(
      'decisions-openai',
      'triage-choice-predicate-score'
    )) as unknown as {
      providerRequest: OpenAIDecisionsRequest;
      providerResponse: OpenAIDecisionsResponse;
    };
    const adapter = new OpenAIDecisionsFrontendAdapter();
    const ir = await adapter.decisionToIR(fixture.providerRequest);
    // Serve the recorded answers back through the IR, as a backend would.
    const backend = createMockDecisionBackend({
      handler: (req) => {
        const wire = fixture.providerResponse;
        const [team, refund, urgency] = wire.answers as [
          Extract<OpenAIDecisionsResponse['answers'][number], { type: 'choice' }>,
          Extract<OpenAIDecisionsResponse['answers'][number], { type: 'predicate' }>,
          Extract<OpenAIDecisionsResponse['answers'][number], { type: 'score' }>,
        ];
        return Promise.resolve({
          model: wire.model,
          answers: {
            team: {
              type: 'choice' as const,
              value: team.choice,
              probabilities: Object.fromEntries(
                team.probabilities!.map((p) => [p.value, p.probability])
              ),
              confidence: team.confidence!,
            },
            refund: { type: 'noul' as const, value: refund.probability },
            urgency: {
              type: 'score' as const,
              value: urgency.score,
              probabilities: urgency.probabilities!.map((p) => p.probability),
              confidence: urgency.confidence!,
            },
          },
          usage: {
            inputTokens: wire.usage!.input_tokens,
            outputTokens: wire.usage!.output_tokens,
            details: {
              input_tokens_details: wire.usage!.input_tokens_details,
              output_tokens_details: wire.usage!.output_tokens_details,
            },
          },
          metadata: req.metadata,
        });
      },
    });
    expect(ir.questions.urgency).toMatchObject({ criteria: ['routine', 'soon', 'urgent'] });
    const res = await new Bridge(adapter, backend).decideFrom(fixture.providerRequest);
    expect(res).toEqual(fixture.providerResponse);
  });
});
