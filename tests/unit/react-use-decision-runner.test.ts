/**
 * The latest-wins async runner behind useDecision / useDecisionBatch.
 *
 * All of the hooks' loading / abort / stale-drop behaviour lives here, so it
 * is tested without a DOM; `react-use-decision.test.ts` covers the React
 * binding on top.
 */

import { describe, it, expect, vi } from 'vitest';
import { createLatestRunner } from '../../packages/react-hooks/src/latest-runner.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createLatestRunner', () => {
  it('starts idle', () => {
    const runner = createLatestRunner<string>();
    expect(runner.getSnapshot()).toEqual({
      data: undefined,
      isLoading: false,
      error: undefined,
      progress: { done: 0, total: 0 },
    });
  });

  it('moves loading -> data and notifies subscribers', async () => {
    const runner = createLatestRunner<string>();
    const listener = vi.fn();
    runner.subscribe(listener);

    const gate = deferred<string>();
    const run = runner.run(() => gate.promise);
    expect(runner.getSnapshot().isLoading).toBe(true);

    gate.resolve('hello');
    await expect(run).resolves.toBe('hello');
    expect(runner.getSnapshot()).toMatchObject({ data: 'hello', isLoading: false });
    expect(listener).toHaveBeenCalled();
  });

  it('keeps a stable snapshot object between changes', () => {
    const runner = createLatestRunner<string>();
    expect(runner.getSnapshot()).toBe(runner.getSnapshot());
  });

  it('records an error and keeps the previous data', async () => {
    const runner = createLatestRunner<string>();
    await runner.run(() => Promise.resolve('first'));
    await expect(runner.run(() => Promise.reject(new Error('boom')))).resolves.toBeUndefined();

    const snapshot = runner.getSnapshot();
    expect(snapshot.error?.message).toBe('boom');
    expect(snapshot.isLoading).toBe(false);
    expect(snapshot.data).toBe('first');
  });

  it('wraps non-Error rejections', async () => {
    const runner = createLatestRunner<string>();
    await runner.run(() => Promise.reject('plain'));
    expect(runner.getSnapshot().error).toBeInstanceOf(Error);
    expect(runner.getSnapshot().error?.message).toBe('plain');
  });

  it('clears the previous error when a new run starts', async () => {
    const runner = createLatestRunner<string>();
    await runner.run(() => Promise.reject(new Error('boom')));
    const gate = deferred<string>();
    void runner.run(() => gate.promise);
    expect(runner.getSnapshot().error).toBeUndefined();
    gate.resolve('x');
  });

  it('aborts the in-flight call when a new one starts and drops its result', async () => {
    const runner = createLatestRunner<string>();
    const signals: AbortSignal[] = [];
    const first = deferred<string>();
    const second = deferred<string>();

    const firstRun = runner.run((signal) => {
      signals.push(signal);
      return first.promise;
    });
    const secondRun = runner.run((signal) => {
      signals.push(signal);
      return second.promise;
    });

    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);

    // The superseded call finishes late, with data: it must not land.
    second.resolve('second');
    await secondRun;
    first.resolve('first');
    await expect(firstRun).resolves.toBeUndefined();

    expect(runner.getSnapshot().data).toBe('second');
  });

  it('drops a superseded call that fails late', async () => {
    const runner = createLatestRunner<string>();
    const first = deferred<string>();
    const firstRun = runner.run(() => first.promise);
    await runner.run(() => Promise.resolve('second'));

    first.reject(new Error('late failure'));
    await firstRun;
    expect(runner.getSnapshot().error).toBeUndefined();
    expect(runner.getSnapshot().data).toBe('second');
  });

  it('abort() cancels the call, ends loading, and drops the result', async () => {
    const runner = createLatestRunner<string>();
    let seen: AbortSignal | undefined;
    const gate = deferred<string>();
    const run = runner.run((signal) => {
      seen = signal;
      return gate.promise;
    });

    runner.abort();
    expect(seen!.aborted).toBe(true);
    expect(runner.getSnapshot().isLoading).toBe(false);

    gate.resolve('too late');
    await expect(run).resolves.toBeUndefined();
    expect(runner.getSnapshot().data).toBeUndefined();
    expect(runner.getSnapshot().error).toBeUndefined();
  });

  it('does not treat an abort rejection as an error', async () => {
    const runner = createLatestRunner<string>();
    const run = runner.run(
      (signal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        })
    );
    runner.abort();
    await run;
    expect(runner.getSnapshot().error).toBeUndefined();
  });

  it('reset() aborts and returns to idle', async () => {
    const runner = createLatestRunner<string>();
    await runner.run(() => Promise.resolve('x'));
    runner.reset();
    expect(runner.getSnapshot()).toMatchObject({ data: undefined, isLoading: false, error: undefined });
  });

  it('reports progress, which a new run resets', async () => {
    const runner = createLatestRunner<string>();
    const gate = deferred<string>();
    const run = runner.run((_signal, setProgress) => {
      setProgress(1, 3);
      setProgress(2, 3);
      return gate.promise;
    });
    expect(runner.getSnapshot().progress).toEqual({ done: 2, total: 3 });
    gate.resolve('x');
    await run;
    expect(runner.getSnapshot().progress).toEqual({ done: 2, total: 3 });

    void runner.run(() => new Promise<string>(() => {}));
    expect(runner.getSnapshot().progress).toEqual({ done: 0, total: 0 });
  });

  it('ignores progress from a superseded run', () => {
    const runner = createLatestRunner<string>();
    let stale!: (done: number, total: number) => void;
    void runner.run((_s, setProgress) => {
      stale = setProgress;
      return new Promise<string>(() => {});
    });
    void runner.run(() => new Promise<string>(() => {}));
    stale(5, 5);
    expect(runner.getSnapshot().progress).toEqual({ done: 0, total: 0 });
  });

  it('calls onSuccess / onError only for the live run', async () => {
    const runner = createLatestRunner<string>();
    const onSuccess = vi.fn();
    const onError = vi.fn();

    const first = deferred<string>();
    const staleRun = runner.run(() => first.promise, { onSuccess, onError });
    await runner.run(() => Promise.resolve('b'), { onSuccess, onError });
    first.resolve('a');
    await staleRun;
    expect(onSuccess.mock.calls).toEqual([['b']]);

    await runner.run(() => Promise.reject(new Error('x')), { onSuccess, onError });
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe('x');
  });

  it('can run again after abort (React strict-mode remount)', async () => {
    const runner = createLatestRunner<string>();
    runner.abort();
    await expect(runner.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('unsubscribes', async () => {
    const runner = createLatestRunner<string>();
    const listener = vi.fn();
    const off = runner.subscribe(listener);
    off();
    await runner.run(() => Promise.resolve('x'));
    expect(listener).not.toHaveBeenCalled();
  });
});
