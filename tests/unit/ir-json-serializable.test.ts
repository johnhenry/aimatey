/**
 * IR is JSON (#118)
 *
 * The IR is JSON-shaped throughout, but its free-form bags are `unknown`. The
 * contract is that those bags hold JSON; `findNonJsonValues()` /
 * `assertJsonSerializable()` give every transport one shared answer, and
 * `JsonValue` is the type a tightened bag will take.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  assertJsonSerializable,
  findNonJsonValues,
  isJsonSerializable,
} from '@johnhenry/aimatey-utils';
import type { IRChatRequest, JsonObject, JsonValue } from '@johnhenry/aimatey-types';

describe('findNonJsonValues', () => {
  it('accepts every JSON value, including nesting', () => {
    expect(
      findNonJsonValues({
        s: 'x',
        n: 1.5,
        b: false,
        nil: null,
        arr: [1, 'a', { deep: [true] }],
        obj: { a: { b: {} } },
      })
    ).toEqual([]);
  });

  it('treats undefined in an object as absent, the same claim as a missing key', () => {
    expect(findNonJsonValues({ servedModel: undefined })).toEqual([]);
    expect(JSON.parse(JSON.stringify({ servedModel: undefined }))).toEqual({});
  });

  it('flags undefined in an array, where JSON turns it into null', () => {
    expect(findNonJsonValues({ a: [1, undefined] }).map((f) => f.path)).toEqual(['value.a[1]']);
  });

  it.each([
    ['a Date', { when: new Date(0) }, 'value.when', 'Date'],
    ['a Map', { m: new Map() }, 'value.m', 'Map'],
    ['a Set', { s: new Set() }, 'value.s', 'Set'],
    ['a typed array', { b: new Uint8Array(2) }, 'value.b', 'Uint8Array'],
    ['a class instance', { c: new (class Foo {})() }, 'value.c', 'Foo'],
    ['a function', { f: () => 1 }, 'value.f', 'function'],
    ['a bigint', { n: 1n }, 'value.n', 'bigint'],
    ['NaN', { n: NaN }, 'value.n', 'NaN'],
    ['Infinity', { n: Infinity }, 'value.n', 'Infinity'],
  ])('flags %s with its path', (_label, input, path, reason) => {
    const found = findNonJsonValues(input);
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toBe(path);
    expect(found[0]!.reason).toContain(reason);
  });

  it('flags a cycle instead of following it', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(findNonJsonValues(a)[0]).toMatchObject({
      path: 'value.self',
      reason: expect.stringContaining('circular'),
    });
  });

  it('allows a shared (non-circular) reference', () => {
    const shared = { x: 1 };
    expect(findNonJsonValues({ a: shared, b: shared })).toEqual([]);
  });

  it('flags a root undefined', () => {
    expect(isJsonSerializable(undefined)).toBe(false);
  });

  it('walks a whole IR request and names the bag that is wrong', () => {
    const request = {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't', name: 'f', input: { at: new Date(0) } }],
        },
      ],
      metadata: { requestId: 'r', timestamp: 0, provenance: {}, custom: { ok: 1 } },
    } as unknown as IRChatRequest;

    const found = findNonJsonValues(request, 'request');
    expect(found.map((f) => f.path)).toEqual(['request.messages[0].content[0].input.at']);
  });
});

describe('assertJsonSerializable', () => {
  it('passes silently for JSON', () => {
    expect(() => assertJsonSerializable({ a: [1, 2, { b: null }] })).not.toThrow();
  });

  it('throws a ValidationError naming every offending path', () => {
    try {
      assertJsonSerializable({ a: new Date(0), b: { c: 1n } }, 'metadata.custom');
      expect.unreachable();
    } catch (error) {
      const e = error as { name: string; message: string; validationDetails: { field: string }[] };
      expect(e.name).toBe('ValidationError');
      expect(e.validationDetails.map((d) => d.field)).toEqual([
        'metadata.custom.a',
        'metadata.custom.b.c',
      ]);
      expect(e.message).toContain('metadata.custom is not JSON-serializable');
    }
  });
});

describe('JsonValue (type level)', () => {
  it('admits exactly the JSON shapes', () => {
    const ok: JsonValue[] = ['s', 1, true, null, [1, 'a'], { a: { b: [null] } }];
    expect(ok).toHaveLength(6);

    expectTypeOf<JsonObject>().toMatchTypeOf<JsonValue>();
    expectTypeOf<string>().toMatchTypeOf<JsonValue>();
    expectTypeOf<Date>().not.toMatchTypeOf<JsonValue>();
    expectTypeOf<undefined>().not.toMatchTypeOf<JsonValue>();
    expectTypeOf<Map<string, string>>().not.toMatchTypeOf<JsonValue>();
    expectTypeOf<() => void>().not.toMatchTypeOf<JsonValue>();
    expectTypeOf<bigint>().not.toMatchTypeOf<JsonValue>();
  });

  it('is not yet imposed on the IR bags: unknown-valued today, JSON by contract', () => {
    // Tightening them is the next major; until then the type must not reject
    // what the ecosystem already stores.
    expectTypeOf<NonNullable<IRChatRequest['metadata']['custom']>>().toEqualTypeOf<
      Record<string, unknown>
    >();
  });
});
