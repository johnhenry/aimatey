/**
 * Tool protocols for `runTools`: the built-in `native` protocol and the
 * registry that resolves `protocol: 'name'` strings.
 *
 * @module
 */

import type {
  IRChatRequest,
  IRChatResponse,
  ToolProtocol,
  ToolProtocolContext,
  ToolProtocolOutcome,
} from '@johnhenry/aimatey-types';
import { AdapterError, ErrorCode } from '@johnhenry/aimatey-errors';
import { extractToolCalls, createToolResultMessage } from '@johnhenry/aimatey-utils';

/**
 * Provider-native tool calling: tools travel in `request.tools`, calls come
 * back as `tool_use` content blocks.
 */
export const nativeToolProtocol: ToolProtocol = {
  name: 'native',

  prepare(request: IRChatRequest): IRChatRequest {
    return request;
  },

  async interpret(
    response: IRChatResponse,
    context: ToolProtocolContext
  ): Promise<ToolProtocolOutcome> {
    const toolCalls = extractToolCalls(response);
    if (toolCalls.length === 0) {
      return { kind: 'final' };
    }

    const calls = toolCalls.map((call) => ({ id: call.id, name: call.name, input: call.input }));
    let results;
    if (context.parallelToolCalls) {
      results = await Promise.all(calls.map(context.invoke));
    } else {
      results = [];
      for (const call of calls) {
        results.push(await context.invoke(call));
      }
    }

    return {
      kind: 'continue',
      calls,
      results,
      messages: [response.message, createToolResultMessage(results)],
    };
  },
};

const registry = new Map<string, ToolProtocol>();

/**
 * Register a protocol so `runTools({ protocol: protocol.name })` resolves it.
 * `@johnhenry/aimatey-tool-protocols` registers `text`, `code` and `auto`
 * through this.
 */
export function registerToolProtocol(protocol: ToolProtocol): void {
  registry.set(protocol.name, protocol);
}

/** Remove every registered protocol (tests). */
export function clearToolProtocols(): void {
  registry.clear();
}

/** Resolve `runTools`' `protocol` option to a protocol. */
export function resolveToolProtocol(protocol: string | ToolProtocol | undefined): ToolProtocol {
  if (protocol === undefined || protocol === 'native') {
    return nativeToolProtocol;
  }
  if (typeof protocol !== 'string') {
    return protocol;
  }
  const found = registry.get(protocol);
  if (found) {
    return found;
  }
  throw new AdapterError({
    code: ErrorCode.INVALID_REQUEST,
    message:
      `Unknown tool protocol '${protocol}'. 'text', 'code' and 'auto' come from ` +
      `@johnhenry/aimatey-tool-protocols: install it and pass the protocol object ` +
      `(or register it with registerToolProtocol).`,
    isRetryable: false,
    provenance: {},
  });
}
