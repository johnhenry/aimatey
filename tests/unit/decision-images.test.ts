/**
 * Images through Bridge.decide / decideBatch (#161): `DecisionOptions.images`
 * lands on the IR request the backend receives.
 */

import { describe, it, expect } from 'vitest';
import { Bridge } from '@johnhenry/aimatey-core';
import { LayaFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { createMockDecisionBackend } from '@johnhenry/aimatey-testing';
import type { ImageContent } from '@johnhenry/aimatey-types';

const image: ImageContent = {
  type: 'image',
  source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' },
};
const questions = {
  team: { type: 'choice' as const, instructions: 'Which team?', criteria: { a: 'x', b: 'y' } },
};
const answers = { team: { type: 'choice' as const, value: 'a' } };

function imageBackend() {
  const mock = createMockDecisionBackend({ answers });
  return Object.assign(mock, {
    metadata: {
      ...mock.metadata,
      capabilities: { ...mock.metadata.capabilities, decisionImages: true },
    },
  });
}

describe('Bridge.decide images (#161)', () => {
  it('delivers options.images to the backend request', async () => {
    const backend = imageBackend();
    const bridge = new Bridge(new LayaFrontendAdapter(), backend);
    await bridge.decide('look', questions, { images: [image] });
    expect(backend.calls[0].images).toEqual([image]);
  });

  it('omits images when none are given', async () => {
    const backend = imageBackend();
    await new Bridge(new LayaFrontendAdapter(), backend).decide('look', questions);
    expect(backend.calls[0].images).toBeUndefined();
  });

  it('still rejects images for a backend without decisionImages (validation)', async () => {
    const backend = createMockDecisionBackend({ answers });
    const bridge = new Bridge(new LayaFrontendAdapter(), backend);
    await expect(bridge.decide('look', questions, { images: [image] })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it('threads images through decideBatch to every state', async () => {
    const backend = imageBackend();
    const bridge = new Bridge(new LayaFrontendAdapter(), backend);
    await bridge.decideBatch(['a', 'b', 'c'], questions, { images: [image] });
    expect(backend.calls).toHaveLength(3);
    for (const call of backend.calls) expect(call.images).toEqual([image]);
  });
});
