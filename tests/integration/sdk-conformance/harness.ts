/**
 * Shared harness for the official-SDK conformance tests: a real aimatey HTTP
 * server (Node adapter) on a free local port, with one frontend in front of a
 * scripted backend that yields deterministic IR. The official SDKs are pointed
 * at it with `baseURL` and a dummy key; nothing leaves the machine.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NodeHTTPListener } from '@johnhenry/aimatey-http';
import { Bridge } from '@johnhenry/aimatey-core';
import { FunctionBackendAdapter } from '@johnhenry/aimatey-backend-browser';
import { RateLimitError } from '@johnhenry/aimatey-errors';
import type {
  FrontendAdapter,
  IRChatRequest,
  IRChatResponse,
  IRStreamChunk,
} from '@johnhenry/aimatey-types';

/**
 * What the scripted backend does for the next request:
 *
 * - `text`: answers "Hello world" (streamed as "Hello" + " world").
 * - `tool`: calls `get_weather` with `{"city":"Paris"}` (call id `call_abc123`),
 *   streamed as two argument deltas.
 * - `preError`: fails with a rate-limit error before anything is sent.
 * - `midError`: streams "Hel", then fails with an IR error chunk.
 * - `midThrow`: streams "Hel", then throws.
 */
export type Scenario = 'text' | 'tool' | 'preError' | 'midError' | 'midThrow';

export const TOOL_CALL_ID = 'call_abc123';
export const USAGE = { promptTokens: 7, completionTokens: 2, totalTokens: 9 };

export interface Harness {
  /** Base URL of the server, e.g. `http://127.0.0.1:12345`. */
  readonly url: string;
  /** Scenario for the next request. */
  scenario: Scenario;
  /** The last IR request the backend received. */
  lastRequest?: IRChatRequest;
  close(): Promise<void>;
}

function rateLimited(): RateLimitError {
  return new RateLimitError({
    message: 'Rate limit reached for scripted-model',
    statusCode: 429,
    provenance: { backend: 'scripted' },
  });
}

/** Start a server with `frontend` in front of the scripted backend. */
export async function startHarness(frontend: FrontendAdapter): Promise<Harness> {
  let server: Server | undefined;
  const harness: Harness = {
    url: '',
    scenario: 'text',
    async close() {
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((r) => server!.close(() => r()));
      }
    },
  };

  const meta = (req: IRChatRequest) => ({
    requestId: req.metadata.requestId,
    timestamp: 1_700_000_000_000,
    provenance: { backend: 'scripted', model: req.parameters?.model ?? 'scripted-model' },
  });

  const backend = new FunctionBackendAdapter({
    metadata: {
      name: 'scripted',
      version: '1.0.0',
      provider: 'scripted',
      capabilities: {
        streaming: true,
        multiModal: false,
        tools: true,
        systemMessageStrategy: 'in-messages',
        supportsMultipleSystemMessages: true,
      },
    } as never,
    execute: async (req): Promise<IRChatResponse> => {
      harness.lastRequest = req;
      switch (harness.scenario) {
        case 'preError':
        case 'midError':
        case 'midThrow':
          throw rateLimited();
        case 'tool':
          return {
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: TOOL_CALL_ID,
                  name: 'get_weather',
                  input: { city: 'Paris' },
                },
              ],
            },
            finishReason: 'tool_calls',
            usage: USAGE,
            metadata: meta(req),
          };
        default:
          return {
            message: { role: 'assistant', content: 'Hello world' },
            finishReason: 'stop',
            usage: USAGE,
            metadata: meta(req),
          };
      }
    },
    executeStream: async function* (req): AsyncGenerator<IRStreamChunk> {
      harness.lastRequest = req;
      const scenario = harness.scenario;
      if (scenario === 'preError') {
        throw rateLimited();
      }
      yield { type: 'start', sequence: 0, metadata: meta(req) };
      if (scenario === 'tool') {
        yield {
          type: 'tool_use',
          sequence: 1,
          id: TOOL_CALL_ID,
          name: 'get_weather',
          inputDelta: '{"city":',
          index: 0,
        } as IRStreamChunk;
        yield {
          type: 'tool_use',
          sequence: 2,
          id: TOOL_CALL_ID,
          name: 'get_weather',
          inputDelta: '"Paris"}',
          index: 0,
        } as IRStreamChunk;
        yield { type: 'done', sequence: 3, finishReason: 'tool_calls', usage: USAGE };
        return;
      }
      if (scenario === 'midError' || scenario === 'midThrow') {
        yield { type: 'content', sequence: 1, delta: 'Hel' };
        if (scenario === 'midThrow') {
          throw new Error('upstream connection reset');
        }
        yield {
          type: 'error',
          sequence: 2,
          error: { code: 'PROVIDER_OVERLOADED', message: 'upstream overloaded' },
        };
        return;
      }
      yield { type: 'content', sequence: 1, delta: 'Hello' };
      yield { type: 'content', sequence: 2, delta: ' world' };
      yield { type: 'done', sequence: 3, finishReason: 'stop', usage: USAGE };
    },
  });

  const bridge = new Bridge(frontend as never, backend as never);
  server = createServer(NodeHTTPListener(bridge, { streaming: true }));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  (harness as { url: string }).url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return harness;
}

/** Collect an async iterable into an array. */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
