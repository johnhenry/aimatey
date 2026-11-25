/**
 * The `auto` tool protocol and registration of the text-based protocols.
 *
 * @module
 */

import { nativeToolProtocol, registerToolProtocol } from '@johnhenry/aimatey-core';
import type {
  IRChatRequest,
  IRChatResponse,
  ToolProtocol,
  ToolProtocolContext,
  ToolProtocolOutcome,
} from '@johnhenry/aimatey-types';
import { textProtocol } from './text.js';

/**
 * Pick native tool calling when the backend supports it, else `text`.
 * An unknown capability counts as native, so hosted models are unaffected.
 * Stateless: the choice is made from the context on every call.
 */
export function autoProtocol(): ToolProtocol {
  const text = textProtocol();
  const pick = (context: ToolProtocolContext): ToolProtocol =>
    context.supportsNativeTools === false ? text : nativeToolProtocol;

  return {
    name: 'auto',
    prepare: (request: IRChatRequest, context: ToolProtocolContext) =>
      pick(context).prepare(request, context),
    interpret: (
      response: IRChatResponse,
      context: ToolProtocolContext
    ): Promise<ToolProtocolOutcome> => pick(context).interpret(response, context),
  };
}

/**
 * Register `text` and `auto` so `runTools({ protocol: 'text' | 'auto' })`
 * resolves by name. (`code` is registered by its own module.)
 */
export function registerTextProtocols(): void {
  registerToolProtocol(textProtocol());
  registerToolProtocol(autoProtocol());
}
