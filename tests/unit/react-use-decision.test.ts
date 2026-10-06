// @vitest-environment jsdom
/**
 * useDecision / useDecisionBatch (aimatey-react-hooks).
 *
 * The loading / abort / stale-drop state machine is covered DOM-free in
 * `react-use-decision-runner.test.ts`. This file covers the React binding:
 * the server-render part, and the interactive part (effects, auto-run,
 * unmount), which needs jsdom + @testing-library/react (root devDependencies;
 * jsdom is enabled for this file only, via the docblock above).
 */

import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { renderHook, act, waitFor } from '@testing-library/react';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { createMockDecisionBackend } from '@johnhenry/aimatey-testing';
import {
  useDecision,
  useDecisionBatch,
  DecisionBridgeProvider,
} from '@johnhenry/aimatey-react-hooks';
import type { IRDecisionQuestion, IRDecisionResponse } from '@johnhenry/aimatey-types';

const questions: Record<string, IRDecisionQuestion> = {
  urgent: { type: 'noul', instructions: 'Is this urgent?' },
};

function makeBridge(latencyMs = 0) {
  const backend = createMockDecisionBackend({
    latencyMs,
    handler: (request) => ({
      answers: {
        urgent: { type: 'noul', value: String(request.state).includes('fire') ? 0.95 : 0.1 },
      },
      model: 'mock',
      metadata: request.metadata,
    }),
  });
  return { bridge: new Bridge(new OpenAIFrontendAdapter(), backend), backend };
}

// ============================================================================
// Server render (always runs)
// ============================================================================

describe('useDecision (server render)', () => {
  it('renders the idle state', () => {
    const { bridge } = makeBridge();
    let seen: ReturnType<typeof useDecision> | undefined;
    function Probe() {
      seen = useDecision(questions, { bridge });
      return null;
    }
    renderToString(createElement(Probe));

    expect(seen).toMatchObject({
      answers: undefined,
      response: undefined,
      isLoading: false,
      error: undefined,
    });
    expect(typeof seen!.decide).toBe('function');
    expect(typeof seen!.abort).toBe('function');
    expect(typeof seen!.reset).toBe('function');
  });

  it('takes the bridge from DecisionBridgeProvider', async () => {
    const { bridge, backend } = makeBridge();
    let seen: ReturnType<typeof useDecision> | undefined;
    function Probe() {
      seen = useDecision(questions);
      return null;
    }
    renderToString(createElement(DecisionBridgeProvider, { bridge }, createElement(Probe)));

    await seen!.decide('fire in the kitchen');
    expect(backend.calls).toHaveLength(1);
  });

  it('renders the idle batch state', () => {
    const { bridge } = makeBridge();
    let seen: ReturnType<typeof useDecisionBatch> | undefined;
    function Probe() {
      seen = useDecisionBatch(questions, { bridge });
      return null;
    }
    renderToString(createElement(Probe));
    expect(seen).toMatchObject({
      results: undefined,
      isLoading: false,
      error: undefined,
      progress: { done: 0, total: 0 },
    });
  });
});

// ============================================================================
// Interactive (jsdom + @testing-library/react)
// ============================================================================

describe('useDecision (rendered)', () => {
  it('goes idle -> loading -> answers', async () => {
    const { bridge } = makeBridge(20);
    const { result } = renderHook(() => useDecision(questions, { bridge }));

    expect(result.current.isLoading).toBe(false);
    let pending!: Promise<IRDecisionResponse | undefined>;
    act(() => {
      pending = result.current.decide('fire in the kitchen');
    });
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      await pending;
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.answers?.urgent).toEqual({ type: 'noul', value: 0.95 });
    expect(result.current.response?.model).toBe('mock');
  });

  it('calls onAnswers and onError', async () => {
    const onAnswers = vi.fn();
    const onError = vi.fn();
    const ok = makeBridge();
    const { result, rerender } = renderHook(
      ({ bridge }) => useDecision(questions, { bridge, onAnswers, onError }),
      { initialProps: { bridge: ok.bridge } }
    );

    await act(async () => {
      await result.current.decide('fire');
    });
    expect(onAnswers).toHaveBeenCalledTimes(1);
    expect(onAnswers.mock.calls[0]![0]).toHaveProperty('urgent');

    const failing = new Bridge(
      new OpenAIFrontendAdapter(),
      createMockDecisionBackend({ error: new Error('model down') })
    );
    rerender({ bridge: failing });
    await act(async () => {
      await result.current.decide('fire');
    });
    expect(result.current.error?.message).toBe('model down');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('drops the response of a superseded decide()', async () => {
    const { bridge } = makeBridge(30);
    const { result } = renderHook(() => useDecision(questions, { bridge }));

    await act(async () => {
      const first = result.current.decide('fire (first)');
      const second = result.current.decide('calm (second)');
      await Promise.all([first, second]);
    });
    expect(result.current.answers?.urgent).toEqual({ type: 'noul', value: 0.1 });
  });

  it('abort() stops loading and nothing lands', async () => {
    const { bridge } = makeBridge(30);
    const { result } = renderHook(() => useDecision(questions, { bridge }));

    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.decide('fire');
    });
    act(() => result.current.abort());
    expect(result.current.isLoading).toBe(false);

    await act(async () => {
      await pending;
    });
    expect(result.current.answers).toBeUndefined();
    expect(result.current.error).toBeUndefined();
  });

  it('reports a missing bridge as error state', async () => {
    const { result } = renderHook(() => useDecision(questions));
    await act(async () => {
      await result.current.decide('x');
    });
    expect(result.current.error?.message).toMatch(/no bridge/);
  });

  it('reset() clears answers', async () => {
    const { bridge } = makeBridge();
    const { result } = renderHook(() => useDecision(questions, { bridge }));
    await act(async () => {
      await result.current.decide('fire');
    });
    act(() => result.current.reset());
    expect(result.current.answers).toBeUndefined();
  });

  it('runs on mount with auto + initialState', async () => {
    const { bridge, backend } = makeBridge();
    const { result } = renderHook(() =>
      useDecision(questions, { bridge, auto: true, initialState: 'fire!' })
    );
    await waitFor(() => expect(result.current.answers).toBeDefined());
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]!.state).toBe('fire!');
  });

  it('does not run on mount without auto', async () => {
    const { bridge, backend } = makeBridge();
    renderHook(() => useDecision(questions, { bridge, initialState: 'fire!' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(backend.calls).toHaveLength(0);
  });

  it('does not refetch when only the questions identity changes', async () => {
    const { bridge, backend } = makeBridge();
    const { result, rerender } = renderHook(() =>
      useDecision({ urgent: { type: 'noul', instructions: 'Is this urgent?' } }, { bridge })
    );
    await act(async () => {
      await result.current.decide('fire');
    });
    rerender();
    rerender();
    expect(backend.calls).toHaveLength(1);
  });

  it('auto does not loop on inline question literals, but reruns when they change in content', async () => {
    const { bridge, backend } = makeBridge();
    const { rerender } = renderHook(
      ({ text }) =>
        useDecision(
          { urgent: { type: 'noul', instructions: text } },
          { bridge, auto: true, initialState: 'fire' }
        ),
      { initialProps: { text: 'Is this urgent?' } }
    );
    await waitFor(() => expect(backend.calls).toHaveLength(1));
    rerender({ text: 'Is this urgent?' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(backend.calls).toHaveLength(1);

    rerender({ text: 'Is this an emergency?' });
    await waitFor(() => expect(backend.calls).toHaveLength(2));
  });

  it('aborts the in-flight call on unmount', async () => {
    const { bridge, backend } = makeBridge(50);
    let signal: AbortSignal | undefined;
    const original = backend.decide.bind(backend);
    backend.decide = (request, s) => {
      signal = s;
      return original(request, s);
    };
    const { result, unmount } = renderHook(() => useDecision(questions, { bridge }));
    act(() => {
      void result.current.decide('fire');
    });
    await waitFor(() => expect(signal).toBeDefined());
    unmount();
    expect(signal!.aborted).toBe(true);
  });
});

describe('useDecisionBatch (rendered)', () => {
  it('runs every state, reporting progress', async () => {
    const { bridge } = makeBridge(5);
    const { result } = renderHook(() => useDecisionBatch(questions, { bridge, concurrency: 1 }));

    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.run(['fire', 'calm', 'fire again']);
    });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.progress.total).toBe(3);

    await act(async () => {
      await pending;
    });

    expect(result.current.progress).toEqual({ done: 3, total: 3 });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.results).toHaveLength(3);
    expect(
      result.current.results!.map((r) =>
        r.status === 'fulfilled' ? (r.value.answers.urgent as { value: number }).value : null
      )
    ).toEqual([0.95, 0.1, 0.95]);
  });

  it('collects per-item failures instead of failing the batch', async () => {
    const backend = createMockDecisionBackend({
      handler: (request) => {
        if (request.state === 'bad') {
          throw new Error('bad state');
        }
        return {
          answers: { urgent: { type: 'noul', value: 0.5 } },
          model: 'mock',
          metadata: request.metadata,
        };
      },
    });
    const bridge = new Bridge(new OpenAIFrontendAdapter(), backend);
    const { result } = renderHook(() => useDecisionBatch(questions, { bridge }));

    await act(async () => {
      await result.current.run(['ok', 'bad']);
    });
    expect(result.current.results!.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(result.current.error).toBeUndefined();
  });

  it('abort() ends the batch and drops its results', async () => {
    const { bridge } = makeBridge(30);
    const { result } = renderHook(() => useDecisionBatch(questions, { bridge, concurrency: 1 }));
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.run(['a', 'b', 'c']);
    });
    act(() => result.current.abort());
    await act(async () => {
      await pending;
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.results).toBeUndefined();
  });
});
