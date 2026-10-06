/**
 * `message` is for developers; `userMessage` is for display (#129).
 *
 * The incident behind it: an application showed an end user
 * "Requested backend 'x' is not registered. Registered backends: ...", because
 * the only text on the error was the developer's. These tests pin the other half
 * of the contract: `toUserMessage` is total, never returns `message`, and cannot
 * be made to leak a provider payload, a secret or a backend name.
 */

import { describe, it, expect } from 'vitest';
import {
  AdapterError,
  AuthenticationError,
  ProviderError,
  RateLimitError,
  RouterError,
  MiddlewareError,
  ValidationError,
  NetworkError,
  StreamError,
  AdapterConversionError,
  AuthorizationError,
  toUserMessage,
  DEFAULT_USER_MESSAGES,
  GENERIC_USER_MESSAGE,
  createErrorFromHttpResponse,
} from '@johnhenry/aimatey-errors';
import { ErrorCode } from '@johnhenry/aimatey-types';
import { Router } from '@johnhenry/aimatey-core';

const SECRET = 'sk-live-ABCDEF0123456789';

describe('AdapterError.userMessage', () => {
  it('is absent unless the thrower supplies one', () => {
    const error = new AdapterError({ code: ErrorCode.ROUTING_FAILED, message: 'dev text' });
    expect(error.userMessage).toBeUndefined();
  });

  it('carries the supplied text through every subclass', () => {
    const userMessage = 'Please try again.';
    const errors: AdapterError[] = [
      new AdapterError({ code: ErrorCode.INTERNAL_ERROR, message: 'm', userMessage }),
      new AuthenticationError({ code: ErrorCode.INVALID_API_KEY, message: 'm', userMessage }),
      new AuthorizationError({
        code: ErrorCode.INSUFFICIENT_PERMISSIONS,
        message: 'm',
        userMessage,
      }),
      new RateLimitError({ message: 'm', userMessage }),
      new ValidationError({
        code: ErrorCode.INVALID_REQUEST,
        message: 'm',
        validationDetails: [],
        userMessage,
      }),
      new ProviderError({ code: ErrorCode.PROVIDER_ERROR, message: 'm', userMessage }),
      new AdapterConversionError({
        code: ErrorCode.ADAPTER_CONVERSION_ERROR,
        message: 'm',
        userMessage,
      }),
      new NetworkError({ code: ErrorCode.NETWORK_ERROR, message: 'm', userMessage }),
      new StreamError({ code: ErrorCode.STREAM_ERROR, message: 'm', userMessage }),
      new RouterError({ code: ErrorCode.ROUTING_FAILED, message: 'm', userMessage }),
      new MiddlewareError({ message: 'm', userMessage }),
    ];

    for (const error of errors) {
      expect(error.userMessage, error.name).toBe(userMessage);
      expect(toUserMessage(error), error.name).toBe(userMessage);
      expect(error.toJSON().userMessage, error.name).toBe(userMessage);
    }
  });
});

describe('toUserMessage', () => {
  it('has a default sentence for every error code', () => {
    for (const code of Object.values(ErrorCode)) {
      const sentence = DEFAULT_USER_MESSAGES[code];
      expect(typeof sentence, code).toBe('string');
      expect(sentence.length, code).toBeGreaterThan(0);
    }
  });

  it('never returns the developer message', () => {
    for (const code of Object.values(ErrorCode)) {
      const error = new AdapterError({ code, message: `DEV-ONLY ${SECRET} backend 'x'` });
      const shown = toUserMessage(error);
      expect(shown, code).not.toContain('DEV-ONLY');
      expect(shown, code).not.toContain(SECRET);
    }
  });

  it('cannot be made to leak provider payloads, details, causes or provenance', () => {
    const error = new ProviderError({
      code: ErrorCode.PROVIDER_ERROR,
      message: `upstream said: ${SECRET}`,
      provenance: { backend: 'secret-backend-name' },
      cause: new Error(`cause ${SECRET}`),
      providerDetails: { provider: 'openai', providerMessage: SECRET },
      httpContext: { statusCode: 500, statusText: 'x', responseBody: { key: SECRET } },
    });

    const shown = toUserMessage(error);
    expect(shown).toBe(DEFAULT_USER_MESSAGES[ErrorCode.PROVIDER_ERROR]);
    expect(shown).not.toContain(SECRET);
    expect(shown).not.toContain('secret-backend-name');
    expect(shown).not.toContain('openai');
  });

  it('is generic for factory-built errors, whose messages quote the provider', () => {
    const error = createErrorFromHttpResponse(401, `Bad key ${SECRET}`, undefined, {});
    expect(toUserMessage(error)).not.toContain(SECRET);
    expect(toUserMessage(error)).toBe(DEFAULT_USER_MESSAGES[ErrorCode.INVALID_API_KEY]);
  });

  it('is generic for the router errors that name backends (the original incident)', () => {
    const router = new Router();
    let thrown: unknown;
    try {
      router.unregister('x');
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toContain("'x'");
    expect(toUserMessage(thrown)).not.toContain("'x'");
    expect(toUserMessage(thrown)).toBe(DEFAULT_USER_MESSAGES[ErrorCode.ROUTING_FAILED]);
  });

  it('gives the open-breaker error a sentence that says to retry shortly', async () => {
    const router = new Router({ enableCircuitBreaker: true });
    router.register('peer', {
      metadata: {
        name: 'peer',
        version: '1',
        provider: 'mock',
        capabilities: { streaming: false, multiModal: false, tools: false, systemMessageStrategy: 'in-messages' },
      },
      fromIR: (r: unknown) => r,
      toIR: (r: unknown) => r,
      execute: async () => {
        throw new Error('unused');
      },
    } as never);
    router.openCircuitBreaker('peer');

    const error = await router
      .execute({
        messages: [{ role: 'user', content: 'hi' }],
        parameters: { model: 'm' },
        metadata: { requestId: 'r', timestamp: 0, custom: { backend: 'peer' } },
      } as never)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const shown = toUserMessage(error);
    expect(shown).not.toContain('peer');
    expect(shown).not.toMatch(/circuit/i);
  });

  it('prefers an explicit userMessage over the default', () => {
    const error = new AdapterError({
      code: ErrorCode.PROVIDER_UNAVAILABLE,
      message: 'dev',
      userMessage: 'Our assistant is resting. Back in a minute.',
    });
    expect(toUserMessage(error)).toBe('Our assistant is resting. Back in a minute.');
  });

  it('ignores an empty or non-string userMessage', () => {
    expect(toUserMessage({ code: ErrorCode.NETWORK_ERROR, userMessage: '   ' })).toBe(
      DEFAULT_USER_MESSAGES[ErrorCode.NETWORK_ERROR]
    );
    expect(toUserMessage({ code: ErrorCode.NETWORK_ERROR, userMessage: 42 })).toBe(
      DEFAULT_USER_MESSAGES[ErrorCode.NETWORK_ERROR]
    );
  });

  it('is total: never throws and never leaks for foreign values', () => {
    expect(toUserMessage(undefined)).toBe(GENERIC_USER_MESSAGE);
    expect(toUserMessage(null)).toBe(GENERIC_USER_MESSAGE);
    expect(toUserMessage('raw string with ' + SECRET)).toBe(GENERIC_USER_MESSAGE);
    expect(toUserMessage(new Error(`plain error ${SECRET}`))).toBe(GENERIC_USER_MESSAGE);
    expect(toUserMessage({ message: SECRET })).toBe(GENERIC_USER_MESSAGE);

    const hostile = {
      get code(): string {
        throw new Error('boom');
      },
    };
    expect(toUserMessage(hostile)).toBe(GENERIC_USER_MESSAGE);
  });

  it('falls back by category, then generically, for a code this copy does not know', () => {
    expect(toUserMessage({ code: 'FUTURE_CODE', category: 'network' })).toBe(
      toUserMessage({ code: ErrorCode.NETWORK_ERROR })
    );
    expect(toUserMessage({ code: 'FUTURE_CODE' })).toBe(GENERIC_USER_MESSAGE);
  });

  it('does not resolve inherited properties as codes', () => {
    expect(toUserMessage({ code: 'constructor' })).toBe(GENERIC_USER_MESSAGE);
    expect(toUserMessage({ code: '__proto__', category: 'toString' })).toBe(GENERIC_USER_MESSAGE);
  });
});
