/**
 * http.core error bodies carry `userMessage` beside the developer `message` (#129).
 *
 * `message` stays what it was (scrubbed; status text on 5xx) so existing clients
 * keep working. `userMessage` is the generic sentence a client should display.
 */

import { describe, it, expect } from 'vitest';
import type { ServerResponse } from 'node:http';
import { sendError } from '@johnhenry/aimatey-http-core';
import { AdapterError, DEFAULT_USER_MESSAGES } from '@johnhenry/aimatey-errors';
import { ErrorCode } from '@johnhenry/aimatey-types';

function capture(): { res: ServerResponse; body: () => any } {
  let raw = '';
  const res = {
    statusCode: 200,
    setHeader: () => undefined,
    end: (chunk: string) => {
      raw = chunk;
    },
  } as unknown as ServerResponse;
  return { res, body: () => JSON.parse(raw) };
}

const routingError = () =>
  new AdapterError({
    code: ErrorCode.ROUTING_FAILED,
    message: "Requested backend 'x' is not registered. Registered backends: a, b",
  });

describe('sendError exposes userMessage', () => {
  it.each(['generic', 'openai', 'anthropic'] as const)('in the %s format', (format) => {
    const { res, body } = capture();
    sendError(res, routingError(), 400, format);

    const payload = body();
    const flat = JSON.stringify(payload);
    const userMessage = payload.userMessage ?? payload.error.userMessage;

    expect(userMessage).toBe(DEFAULT_USER_MESSAGES[ErrorCode.ROUTING_FAILED]);
    expect(userMessage).not.toContain('Registered backends');
    // The developer message is still there for logs, as before.
    expect(flat).toContain('is not registered');
  });

  it('honours an explicit userMessage', () => {
    const { res, body } = capture();
    sendError(
      res,
      new AdapterError({
        code: ErrorCode.PROVIDER_UNAVAILABLE,
        message: 'peer down',
        userMessage: 'Back in a minute.',
      }),
      503
    );
    expect(body().error.userMessage).toBe('Back in a minute.');
  });

  it('is generic for a plain Error, whatever it says', () => {
    const { res, body } = capture();
    sendError(res, new Error('db password is hunter2'), 500);
    expect(body().error.userMessage).not.toContain('hunter2');
    expect(body().error.message).toBe('Internal Server Error');
  });
});
