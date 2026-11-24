/**
 * Prompt-side helpers for the `code` protocol: turn tool JSON schemas into a
 * TypeScript-style `declare const tools` block.
 *
 * @module
 */

import type { ToolDefinition } from '@johnhenry/aimatey-types';

type Schema = Record<string, unknown>;

const isObject = (v: unknown): v is Schema => typeof v === 'object' && v !== null;

function literal(value: unknown): string {
  return typeof value === 'string'
    ? `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
    : (JSON.stringify(value) ?? 'unknown');
}

function comment(text: string, indent: string): string {
  const clean = text
    .replace(/\*\//g, '* /')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
  return `${indent}/** ${clean} */\n`;
}

/** Render one JSON-schema node as a TypeScript type expression. */
export function schemaToTs(schema: unknown, indent = '', depth = 0): string {
  if (!isObject(schema) || depth > 8) {
    return 'unknown';
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.map(literal).join(' | ') || 'never';
  }
  if ('const' in schema) {
    return literal(schema.const);
  }
  for (const key of ['anyOf', 'oneOf']) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.length > 0) {
      return branches.map((b) => schemaToTs(b, indent, depth + 1)).join(' | ');
    }
  }
  const type = schema.type;
  if (Array.isArray(type)) {
    return type.map((t) => schemaToTs({ ...schema, type: t }, indent, depth + 1)).join(' | ');
  }
  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const item = schemaToTs(schema.items, indent, depth + 1);
      return /[|&]/.test(item) ? `(${item})[]` : `${item}[]`;
    }
    case 'object':
    case undefined: {
      const props = schema.properties;
      if (!isObject(props)) {
        return type === 'object' ? 'Record<string, unknown>' : 'unknown';
      }
      const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
      const names = Object.keys(props);
      if (names.length === 0) {
        return '{}';
      }
      const inner = `${indent}  `;
      const lines = names.map((name) => {
        const prop = props[name];
        const doc =
          isObject(prop) && typeof prop.description === 'string'
            ? comment(prop.description, inner)
            : '';
        const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
        return `${doc}${inner}${key}${required.has(name) ? '' : '?'}: ${schemaToTs(prop, inner, depth + 1)};`;
      });
      return `{\n${lines.join('\n')}\n${indent}}`;
    }
    default:
      return 'unknown';
  }
}

/**
 * Generate the `declare const tools: { ... }` block shown to the model.
 * Results are typed from a tool's `outputSchema` when it has one, else `unknown`.
 */
export function generateToolsInterface(tools: Readonly<Record<string, ToolDefinition>>): string {
  const entries = Object.entries(tools).map(([name, def]) => {
    const doc = def.description ? comment(def.description, '  ') : '';
    const params = schemaToTs(def.parameters, '  ');
    const optional = params === '{}' || !(def.parameters as Schema | undefined)?.required;
    const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
    const output = def.outputSchema ? schemaToTs(def.outputSchema, '  ') : 'unknown';
    return `${doc}  ${key}(input${optional ? '?' : ''}: ${params}): Promise<${output}>;`;
  });
  return `declare const tools: {\n${entries.join('\n')}\n};\ndeclare function final(answer: unknown): void;`;
}

/** The system prompt that teaches a model the `code` protocol. */
export function buildCodePrompt(tools: Readonly<Record<string, ToolDefinition>>): string {
  return [
    'You act by writing JavaScript. To use tools, reply with exactly ONE fenced code block:',
    '',
    '```js',
    'const r = await tools.name({ arg: 1 });',
    'console.log(r);',
    '```',
    '',
    'Rules:',
    '- Plain JavaScript only: no imports, no require, and no fetch, timers (setTimeout) or process in the sandbox.',
    '- Call tools as `await tools.name({...})`. Arguments and results are JSON. Use Promise.all for independent calls.',
    '- A tool call can throw (denied, invalid arguments, tool failure); use try/catch if you can recover.',
    '- Use console.log to show what you need to see; you will get the printed output and the value you `return` in the next message. Nothing persists between snippets.',
    '- To finish, call `final(answer)` inside the code, or reply with NO code block: that text is your final answer.',
    '',
    'Available tools:',
    '',
    '```ts',
    generateToolsInterface(tools),
    '```',
  ].join('\n');
}
