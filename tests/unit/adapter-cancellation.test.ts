/**
 * Forwardable cancellation (#121)
 *
 * `AbortSignal` is the in-process cancellation mechanism and it cannot cross a
 * transport. A proxying backend therefore needs two things the IR did not
 * give it: a name for what to cancel on the far side (`metadata.requestId`,
 * which is stable for a logical request) and a hook through which the Bridge
 * tells it that the caller gave up (`BackendAdapter.cancel`).
 */

import { describe, it, expect, vi } from 'vitest';
import { Bridge } from '@johnhenry/aimatey-core';
import { GenericFrontendAdapter } from '@johnhenry/aimatey-frontend';
import {
  createCancellationRegistry,
  withCancellation,
  withStreamCancellation,
} from '@johnhenry/aimatey-utils';
import type {
  AdapterMetadata,
  BackendAdapter,
  IRCapabilities,
  IRChatRequest,
  IRChatResponse,
  IRStreamChunk,
} from '@johnhenry/aimatey-types';

const metadata: AdapterMetadata = {
  name: 'tunnel',
  version: '1.0.0',
  provider: 'mock',
  capabilities: {
    streaming: true,
    multiModal: false,
    tools: false,
    systemMessageStrategy: 'in-messages' as const,
  } as IRCapabilities,
};

/** A proxy whose far side only learns of cancellation through `cancel()`. */
function createProxy(opts: { cancelThrows?: boolean } = {}) {
  const cancelled: Array<{ requestId: string; reason: unknown }> = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));

  const adapter = {
    metadata,
    async execute(request: IRChatRequest): Promise<IRChatResponse> {
      await gate;
      return {
        message: { role: 'assistant', content: 'late' },
        finishReason: 'stop',
        metadata: { requestId: request.metadata.requestId, timestamp: Date.now() },
      };
    },
    async *executeStream(): AsyncGenerator<IRStreamChunk, void, undefined> {
      yield { type: 'content', sequence: 0, delta: 'a', role: 'assistant' } as IRStreamChunk;
      await gate;
      yield { type: 'content', sequence: 1, delta: 'b', role: 'assistant' } as IRStreamChunk;
    },
    cancel(requestId: string, reason?: unknown) {
      cancelled.push({ requestId, reason });
      if (opts.cancelThrows) {
        throw new Error('far side unreachable');
      }
    },
  } as unknown as BackendAdapter;

  return { adapter, cancelled, release };
}

function request(): IRChatRequest {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    parameters: { model: 'm' },
    metadata: { requestId: 'req-121', timestamp: Date.now(), provenance: {} },
  } as IRChatRequest;
}

describe('withCancellation', () => {
  it('calls adapter.cancel(requestId) once when the signal aborts mid-call', async () => {
    const { adapter, cancelled, release } = createProxy();
    const controller = new AbortController();

    const pending = withCancellation(adapter, 'req-1', controller.signal, () =>
      adapter.execute!(request(), controller.signal)
    );
    controller.abort('user pressed stop');
    controller.abort();
    release();
    await pending;

    expect(cancelled).toEqual([{ requestId: 'req-1', reason: 'user pressed stop' }]);
  });

  it('does not call cancel after the call completed, and detaches its listener', async () => {
    const { adapter, cancelled, release } = createProxy();
    const controller = new AbortController();
    release();

    await withCancellation(adapter, 'req-1', controller.signal, () =>
      adapter.execute!(request(), controller.signal)
    );
    controller.abort();

    expect(cancelled).toEqual([]);
  });

  it('tells the far side when the signal was already aborted before the call started', async () => {
    const { adapter, cancelled, release } = createProxy();
    release();
    const controller = new AbortController();
    controller.abort();

    await withCancellation(adapter, 'req-1', controller.signal, async () => 'ran');

    expect(cancelled).toHaveLength(1);
  });

  it('swallows a failing cancel: the signal is authoritative, cancel is best effort', async () => {
    const { adapter, release } = createProxy({ cancelThrows: true });
    const controller = new AbortController();
    const pending = withCancellation(adapter, 'req-1', controller.signal, () =>
      adapter.execute!(request(), controller.signal)
    );
    controller.abort();
    release();

    await expect(pending).resolves.toBeDefined();
  });

  it('is a no-op for an adapter without cancel() or a call without a signal', async () => {
    const bare = { metadata } as unknown as BackendAdapter;
    await expect(
      withCancellation(bare, 'r', new AbortController().signal, async () => 1)
    ).resolves.toBe(1);
    const { adapter, cancelled } = createProxy();
    await expect(withCancellation(adapter, 'r', undefined, async () => 2)).resolves.toBe(2);
    expect(cancelled).toEqual([]);
  });
});

describe('withStreamCancellation', () => {
  it('cancels when the signal aborts while the stream is being consumed', async () => {
    const { adapter, cancelled, release } = createProxy();
    const controller = new AbortController();
    const stream = withStreamCancellation(
      adapter,
      'req-2',
      controller.signal,
      adapter.executeStream!(request(), controller.signal)
    );

    const first = await stream.next();
    expect((first.value as IRStreamChunk).type).toBe('content');
    controller.abort();
    release();
    for await (const _ of stream) {
      // drain
    }

    expect(cancelled.map((c) => c.requestId)).toEqual(['req-2']);
  });

  it('detaches once the stream ends so a later abort cancels nothing', async () => {
    const { adapter, cancelled, release } = createProxy();
    release();
    const controller = new AbortController();
    for await (const _ of withStreamCancellation(
      adapter,
      'req-2',
      controller.signal,
      adapter.executeStream!(request(), controller.signal)
    )) {
      // drain
    }
    controller.abort();

    expect(cancelled).toEqual([]);
  });
});

describe('Bridge wires signal.abort to BackendAdapter.cancel', () => {
  it('executeIR: the far side is told the request id the Bridge stamped', async () => {
    const { adapter, cancelled, release } = createProxy();
    const bridge = new Bridge(new GenericFrontendAdapter(), adapter);
    const controller = new AbortController();

    const pending = bridge.executeIR(request(), { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    release();
    await pending;

    expect(cancelled.map((c) => c.requestId)).toEqual(['req-121']);
  });

  it('executeIRStream: the far side is told when the consumer aborts', async () => {
    const { adapter, cancelled, release } = createProxy();
    const bridge = new Bridge(new GenericFrontendAdapter(), adapter);
    const controller = new AbortController();

    const stream = bridge.executeIRStream(request(), { signal: controller.signal });
    await stream.next();
    controller.abort();
    release();
    for await (const _ of stream) {
      // drain
    }

    expect(cancelled.map((c) => c.requestId)).toEqual(['req-121']);
  });
});

describe('createCancellationRegistry (the far side of a transport)', () => {
  it('aborts the in-flight request registered under the id, and only it', () => {
    const registry = createCancellationRegistry();
    const a = registry.register('a');
    const b = registry.register('b');

    expect(registry.cancel('a', 'stop')).toBe(true);

    expect(a.signal.aborted).toBe(true);
    expect(a.signal.reason).toBe('stop');
    expect(b.signal.aborted).toBe(false);
  });

  it('reports a cancel for a request that already finished as a no-op', () => {
    const registry = createCancellationRegistry();
    const a = registry.register('a');
    a.release();

    expect(registry.cancel('a')).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('does not remember a cancel that arrives before the request, by default', () => {
    const registry = createCancellationRegistry();
    registry.cancel('early');

    expect(registry.register('early').signal.aborted).toBe(false);
  });

  it('with tombstoneMs, a cancel that beat the request to the far side is honoured once', () => {
    vi.useFakeTimers();
    try {
      const registry = createCancellationRegistry({ tombstoneMs: 1000 });
      registry.cancel('early');

      expect(registry.register('early').signal.aborted).toBe(true);
      expect(registry.register('early').signal.aborted).toBe(false);

      registry.cancel('late');
      vi.advanceTimersByTime(1001);
      expect(registry.register('late').signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a retry under the same id replaces the registration and cancel reaches the live attempt', () => {
    const registry = createCancellationRegistry();
    const first = registry.register('r');
    const second = registry.register('r');

    registry.cancel('r');

    expect(second.signal.aborted).toBe(true);
    expect(first.signal.aborted).toBe(true);
  });
});
