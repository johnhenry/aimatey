/**
 * Live OpenAI Decisions API tests -- gated on OPENAI_LIVE=1.
 *
 * Runs `Bridge.decide()` against the real `POST /v1/decisions` (preview
 * access required; the model is gpt-6-luna). Skipped unless OPENAI_LIVE=1.
 *
 *   OPENAI_LIVE=1 npx vitest run tests/integration/openai-decisions-live.test.ts
 *
 * Env: OPENAI_API_KEY (required), OPENAI_BASE_URL (default
 * https://api.openai.com/v1), OPENAI_LIVE_CAPTURE=1 to (re)write the replay
 * fixtures `live-*` in fixtures/decisions-openai/ from what the server returned.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend';
import type { IRDecisionRequest, ImageContent } from '@johnhenry/aimatey-types';

const live = process.env.OPENAI_LIVE === '1';
const baseURL = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';

const state =
  'Subject: Duplicate charge. Body: I was billed twice this month, please refund me today.';
const questions: IRDecisionRequest['questions'] = {
  team: {
    type: 'choice',
    instructions: 'Which team should handle this?',
    criteria: {
      billing: 'invoices, refunds, charges',
      technical: 'bugs, outages',
      account: 'logins, profile changes',
    },
  },
  refund: { type: 'noul', instructions: 'Does the customer ask for a refund?' },
  urgency: {
    type: 'score',
    instructions: 'How urgent is this?',
    criteria: ['routine', 'soon', 'urgent'],
  },
};

/** A solid-colour PNG, built here so the test needs no asset file. */
function solidPng(r: number, g: number, b: number, size = 64): ImageContent {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(size).fill([r, g, b]).flat())]);
  const raw = Buffer.concat(Array(size).fill(row));
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return {
    type: 'image',
    source: { type: 'base64', mediaType: 'image/png', data: png.toString('base64') },
  };
}

function makeBridge() {
  const backend = new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY ?? '', baseURL });
  return new Bridge(new OpenAIFrontendAdapter(), backend);
}

/** Wrap fetch so the wire exchange with /decisions can be captured. */
function record() {
  const realFetch = global.fetch;
  const exchange: { providerRequest?: unknown; providerResponse?: unknown } = {};
  global.fetch = (async (url: string, init?: RequestInit) => {
    const res = await realFetch(url, init);
    if (String(url).endsWith('/decisions')) {
      exchange.providerRequest = JSON.parse(String(init?.body));
      exchange.providerResponse = await res.clone().json();
    }
    return res;
  }) as typeof fetch;
  return exchange;
}

async function capture(
  scenario: string,
  description: string,
  request: IRDecisionRequest,
  exchange: ReturnType<typeof record>
) {
  if (process.env.OPENAI_LIVE_CAPTURE !== '1') return;
  const dir = join(process.cwd(), 'fixtures', 'decisions-openai');
  await mkdir(dir, { recursive: true });
  const fixture = {
    metadata: {
      provider: 'decisions-openai',
      scenario,
      model: 'gpt-6-luna',
      apiVersion: 'openai /v1/decisions (preview)',
      capturedAt: new Date().toISOString(),
      description,
      tags: ['decision', 'openai-decisions', 'live-capture'],
    },
    request,
    providerRequest: exchange.providerRequest,
    providerResponse: exchange.providerResponse,
  };
  await writeFile(join(dir, `${scenario}.json`), JSON.stringify(fixture, null, 2) + '\n');
}

describe.skipIf(!live)('live OpenAI Decisions API (OPENAI_LIVE=1)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('answers choice + predicate + score through Bridge.decide()', async () => {
    const exchange = record();
    const response = await makeBridge().decide(state, questions);
    console.log('triage:', JSON.stringify(response.answers), JSON.stringify(response.usage));

    const { team, refund, urgency } = response.answers;
    expect(team).toMatchObject({ type: 'choice', value: 'billing' });
    expect(Object.keys((team as { probabilities: object }).probabilities)).toEqual([
      'billing',
      'technical',
      'account',
    ]);
    expect(refund?.type).toBe('noul');
    expect((refund as { value: number }).value).toBeGreaterThan(0.5);
    expect(urgency?.type).toBe('score');
    const level = (urgency as { value: number }).value;
    expect(level).toBeGreaterThanOrEqual(0);
    expect(level).toBeLessThanOrEqual(2);
    expect((urgency as { probabilities: number[] }).probabilities).toHaveLength(3);
    expect(response.model).toContain('gpt-6-luna');
    expect(response.provider).toBe('openai');
    expect(response.usage?.inputTokens).toBeGreaterThan(0);

    await capture(
      'live-triage',
      'Live POST /v1/decisions through Bridge.decide(): choice + predicate + score.',
      {
        state,
        questions,
        parameters: { model: 'gpt-6-luna' },
        metadata: { requestId: 'fixture-live-triage', timestamp: 0 },
      },
      exchange
    );
  }, 60_000);

  it('answers a question about a base64 image (input_image data URL)', async () => {
    const exchange = record();
    const imageQuestions: IRDecisionRequest['questions'] = {
      red: { type: 'noul', instructions: 'Is the image predominantly red?' },
      colour: {
        type: 'choice',
        instructions: 'What is the dominant colour of the image?',
        criteria: { red: 'red', green: 'green', blue: 'blue' },
      },
    };
    const images = [solidPng(220, 20, 20)];
    const response = await makeBridge().decide('Describe the attached image.', imageQuestions, {
      images,
    });
    console.log('image:', JSON.stringify(response.answers));

    expect((response.answers.red as { value: number }).value).toBeGreaterThan(0.5);
    expect(response.answers.colour).toMatchObject({ type: 'choice', value: 'red' });
    const sent = exchange.providerRequest as { input: Array<{ content: Array<{ type: string }> }> };
    expect(sent.input[0]!.content.map((p) => p.type)).toEqual(['input_text', 'input_image']);

    await capture(
      'live-image',
      'Live POST /v1/decisions with one base64 image sent as an input_image data URL.',
      {
        state: 'Describe the attached image.',
        questions: imageQuestions,
        images: [
          { ...images[0]!, source: { type: 'base64', mediaType: 'image/png', data: '<png>' } },
        ],
        parameters: { model: 'gpt-6-luna' },
        metadata: { requestId: 'fixture-live-image', timestamp: 0 },
      },
      {
        ...exchange,
        providerRequest: JSON.parse(
          JSON.stringify(exchange.providerRequest).replace(/base64,[A-Za-z0-9+/=]+/, 'base64,<png>')
        ),
      }
    );
  }, 60_000);

  it('serializes an object state as JSON text', async () => {
    const response = await makeBridge().decide(
      { subject: 'Duplicate charge', body: 'Please refund me today.' },
      { refund: questions.refund! }
    );
    console.log('object state:', JSON.stringify(response.answers));
    expect((response.answers.refund as { value: number }).value).toBeGreaterThan(0.5);
  }, 60_000);

  it('accepts nine choices (the API allows 2 to 255)', async () => {
    const criteria = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`opt${i}`, `option number ${i}`])
    );
    const response = await makeBridge().decide('My card was charged twice', {
      q: { type: 'choice', instructions: 'Pick the best option.', criteria },
    });
    const answer = response.answers.q as { probabilities: Record<string, number> };
    expect(Object.keys(answer.probabilities)).toHaveLength(9);
  }, 60_000);

  it('surfaces the API validation error for more than 255 choices', async () => {
    const criteria = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, `d${i}`]));
    // Skip client-side validation (maxChoiceOptions is declared) by calling the backend directly.
    const backend = new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY ?? '', baseURL });
    await expect(
      backend.decide({
        state: 'x',
        questions: { q: { type: 'choice', instructions: 'pick', criteria } },
        metadata: { requestId: 'r', timestamp: 0 },
      })
    ).rejects.toThrow();
  }, 60_000);
});
