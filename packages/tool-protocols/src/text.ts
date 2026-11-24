/**
 * The `text` tool protocol: tool calling for models with no native tool
 * support. Tools are described in a system message; the model replies with a
 * fenced JSON action block, or a plain-text final answer.
 *
 * @module
 */

import type {
  IRChatRequest,
  IRChatResponse,
  IRMessage,
  ToolDefinition,
  ToolProtocol,
  ToolProtocolCall,
  ToolProtocolContext,
  ToolProtocolOutcome,
  ToolProtocolResult,
} from '@johnhenry/aimatey-types';

/** Options for {@link textProtocol}. */
export interface TextProtocolOptions {
  /** Extra instructions appended to the generated system prompt. */
  readonly instructions?: string;
}

type Action = { readonly tool: string; readonly args: Record<string, unknown> };

type Parsed =
  | { readonly kind: 'none' }
  | { readonly kind: 'actions'; readonly actions: readonly Action[] }
  | { readonly kind: 'error'; readonly message: string };

const FENCE = '```';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Remove trailing commas before `}` or `]`, leaving string contents alone. */
function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[++i] ?? '';
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] ?? '')) {
        j++;
      }
      if (text[j] !== '}' && text[j] !== ']') {
        out += ch;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

/** JSON.parse that also accepts trailing commas. Returns `undefined` on failure. */
function lenientParse(text: string): { readonly value: unknown } | undefined {
  for (const candidate of [text, stripTrailingCommas(text)]) {
    try {
      return { value: JSON.parse(candidate) as unknown };
    } catch {
      // try the next form
    }
  }
  return undefined;
}

/** The balanced `{...}` or `[...]` span starting at `start`, string-aware. */
function balancedSpan(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        i++;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      depth++;
    } else if ((ch === '}' || ch === ']') && --depth === 0) {
      return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function toAction(value: unknown): Action | string {
  if (!isRecord(value)) {
    return 'an action must be a JSON object like {"tool": "name", "args": {...}}';
  }
  const tool = value.tool;
  if (typeof tool !== 'string' || tool.length === 0) {
    return 'the action is missing the "tool" key (a string naming the tool to call)';
  }
  const args = value.args ?? value.arguments ?? value.input ?? {};
  if (!isRecord(args)) {
    return `"args" for tool "${tool}" must be a JSON object`;
  }
  return { tool, args };
}

function toActions(value: unknown): readonly Action[] | string {
  const items = Array.isArray(value) ? value : [value];
  if (items.length === 0) {
    return 'the action array is empty';
  }
  const actions: Action[] = [];
  for (const item of items) {
    const action = toAction(item);
    if (typeof action === 'string') {
      return action;
    }
    actions.push(action);
  }
  return actions;
}

/** Does a parsed value look like an attempted action (as opposed to a JSON answer)? */
function looksLikeAction(value: unknown): boolean {
  const items = Array.isArray(value) ? value : [value];
  return items.length > 0 && items.every((v) => isRecord(v) && ('tool' in v || 'args' in v));
}

const ACTION_START = /[{[]\s*(?:\{\s*)?["']?tool["']?\s*:/g;

/** Read the model's reply: fenced JSON blocks first, then a bare action object. */
function parseReply(text: string): Parsed {
  const actions: Action[] = [];

  const fenceRe = /```([\w-]*)[ \t]*\r?\n?([\s\S]*?)```/g;
  for (const match of text.matchAll(fenceRe)) {
    const lang = (match[1] ?? '').toLowerCase();
    const body = (match[2] ?? '').trim();
    const jsonish =
      lang === 'json' || lang === 'json5' || body.startsWith('{') || body.startsWith('[');
    if (!jsonish) {
      continue;
    }
    const parsed = lenientParse(body);
    if (!parsed) {
      if (lang === 'json' || /["']?tool["']?\s*:/.test(body)) {
        return {
          kind: 'error',
          message: 'your JSON block is not valid JSON and could not be parsed',
        };
      }
      continue;
    }
    if (!looksLikeAction(parsed.value)) {
      continue;
    }
    const found = toActions(parsed.value);
    if (typeof found === 'string') {
      return { kind: 'error', message: found };
    }
    actions.push(...found);
  }
  if (actions.length > 0) {
    return { kind: 'actions', actions };
  }

  if (!text.includes(FENCE)) {
    // No fence: look for a bare {"tool": ...} object (or array of them).
    for (const match of text.matchAll(ACTION_START)) {
      const span = balancedSpan(text, match.index);
      const parsed = span === undefined ? undefined : lenientParse(span);
      if (!parsed) {
        return {
          kind: 'error',
          message: 'your JSON action is not valid JSON and could not be parsed',
        };
      }
      const found = toActions(parsed.value);
      if (typeof found === 'string') {
        return { kind: 'error', message: found };
      }
      return { kind: 'actions', actions: found };
    }
  }
  return { kind: 'none' };
}

function replyText(response: IRChatResponse): string {
  const content = response.message.content;
  if (typeof content === 'string') {
    return content;
  }
  return content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

function describeTools(tools: Readonly<Record<string, ToolDefinition>>): string {
  return Object.entries(tools)
    .map(([name, tool]) => {
      const lines = [`- ${name}${tool.description ? `: ${tool.description}` : ''}`];
      if (tool.parameters) {
        lines.push(`  parameters (JSON schema): ${JSON.stringify(tool.parameters)}`);
      }
      return lines.join('\n');
    })
    .join('\n');
}

function buildSystemPrompt(context: ToolProtocolContext, options: TextProtocolOptions): string {
  const parallel = context.parallelToolCalls;
  const shape = parallel
    ? `an array of such objects, one per call:\n${FENCE}json\n[{"tool": "tool_name", "args": {"param": "value"}}]\n${FENCE}`
    : `${FENCE}json\n{"tool": "tool_name", "args": {"param": "value"}}\n${FENCE}`;
  const lines = [
    'You can use the following tools:',
    describeTools(context.tools),
    '',
    'To call a tool, reply with exactly one fenced JSON block' +
      (parallel ? ' containing ' : ' like this:\n') +
      shape,
    parallel
      ? 'Use one array entry for each tool you want to call now.'
      : 'Call one tool at a time and put nothing else you need in that block.',
    'You will receive the result in the next message, then you can call another tool or answer.',
    'When you have the final answer, reply in plain text with no JSON action block.',
  ];
  if (options.instructions) {
    lines.push('', options.instructions);
  }
  return lines.join('\n');
}

function mergeSystem(messages: readonly IRMessage[], prompt: string): readonly IRMessage[] {
  const first = messages[0];
  if (first?.role !== 'system') {
    return [{ role: 'system', content: prompt }, ...messages];
  }
  const merged: IRMessage =
    typeof first.content === 'string'
      ? { ...first, content: `${first.content}\n\n${prompt}` }
      : { ...first, content: [...first.content, { type: 'text', text: prompt }] };
  return [merged, ...messages.slice(1)];
}

function stringify(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  return JSON.stringify(value) ?? 'null';
}

function resultMessage(
  calls: readonly ToolProtocolCall[],
  results: readonly ToolProtocolResult[]
): IRMessage {
  const names = new Map(calls.map((c) => [c.id, c.name]));
  const text = results
    .map((r) => {
      const name = names.get(r.toolCallId) ?? 'unknown';
      const label = r.isError ? 'Tool error for' : 'Tool result for';
      return `${label} ${name} (${r.toolCallId}): ${stringify(r.result)}`;
    })
    .join('\n');
  return { role: 'user', content: text };
}

/**
 * Tool calling through plain text. Works with any model, including ones with
 * no native tool support.
 *
 * The model is told to reply with one fenced JSON block
 * (`{"tool": "name", "args": {...}}`, or an array when parallel calls are
 * allowed) to call a tool, or with plain text to answer. A reply that tries
 * to call a tool but cannot be read is fed back as an error and uses up an
 * iteration.
 */
export function textProtocol(options: TextProtocolOptions = {}): ToolProtocol {
  return {
    name: 'text',

    prepare(request: IRChatRequest, context: ToolProtocolContext): IRChatRequest {
      const { tools: _tools, toolChoice: _toolChoice, ...rest } = request;
      void _tools;
      void _toolChoice;
      return {
        ...rest,
        messages: mergeSystem(request.messages, buildSystemPrompt(context, options)),
      };
    },

    async interpret(
      response: IRChatResponse,
      context: ToolProtocolContext
    ): Promise<ToolProtocolOutcome> {
      const parsed = parseReply(replyText(response));
      if (parsed.kind === 'none') {
        return { kind: 'final' };
      }

      if (parsed.kind === 'error') {
        return {
          kind: 'continue',
          calls: [],
          results: [],
          messages: [
            response.message,
            {
              role: 'user',
              content:
                `Error: ${parsed.message}. Reply with exactly one fenced json block like ` +
                `{"tool": "name", "args": {...}} to call a tool, or plain text to answer.`,
            },
          ],
        };
      }

      const actions = context.parallelToolCalls ? parsed.actions : parsed.actions.slice(0, 1);
      const calls: ToolProtocolCall[] = actions.map((a, index) => ({
        id: `text-${context.iteration}-${index}`,
        name: a.tool,
        input: a.args,
      }));

      let results: ToolProtocolResult[];
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
        messages: [response.message, resultMessage(calls, results)],
      };
    },
  };
}
