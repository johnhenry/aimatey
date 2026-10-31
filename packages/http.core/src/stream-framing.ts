/**
 * Stream Framing
 *
 * Each provider API frames a streamed answer its own way. The frontends
 * yield objects (an OpenAI chunk, an Anthropic event, a Gemini
 * `GenerateContentResponse`, an Ollama response line); this module turns
 * them into the bytes each API's clients expect:
 *
 * | Framing        | Content-Type             | Each chunk                      | End            |
 * | -------------- | ------------------------ | ------------------------------- | -------------- |
 * | `openai`       | `text/event-stream`      | `data: <json>\n\n`              | `data: [DONE]` |
 * | `generic`      | `text/event-stream`      | `data: <json>\n\n`              | `data: [DONE]` |
 * | `anthropic`    | `text/event-stream`      | `event: <type>\ndata: <json>`   | (nothing)      |
 * | `gemini`       | `text/event-stream`      | `data: <json>\r\n\r\n`          | (nothing)      |
 * | `gemini-array` | `application/json`       | a JSON array, element by element| `]`            |
 * | `ollama`       | `application/x-ndjson`   | `<json>\n`                      | (nothing)      |
 *
 * `gemini` is `streamGenerateContent?alt=sse`; without `alt=sse` Gemini
 * streams one JSON array (`gemini-array`).
 *
 * @module
 */

/** How a streamed response is framed on the wire. */
export type StreamFraming =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'gemini-array'
  | 'ollama'
  | 'generic';

/** Turns stream chunks into wire text for one response. Create one per response. */
export interface StreamFramer {
  /** The response's Content-Type. */
  readonly contentType: string;
  /** Wire text for one chunk. */
  frame(chunk: unknown): string;
  /** Wire text that ends the stream (may be empty). */
  end(): string;
}

/** Response headers for a stream with this framing. */
export function streamHeaders(framing: StreamFraming): Record<string, string> {
  return {
    'Content-Type': createStreamFramer(framing).contentType,
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  };
}

/** A framer for one streamed response. */
export function createStreamFramer(framing: StreamFraming = 'generic'): StreamFramer {
  switch (framing) {
    case 'anthropic':
      return {
        contentType: 'text/event-stream',
        frame(chunk) {
          const type =
            typeof chunk === 'object' &&
            chunk !== null &&
            typeof (chunk as { type?: unknown }).type === 'string'
              ? (chunk as { type: string }).type
              : undefined;
          const data = `data: ${JSON.stringify(chunk)}\n\n`;
          return type ? `event: ${type}\n${data}` : data;
        },
        end: () => '',
      };

    case 'gemini':
      return {
        contentType: 'text/event-stream',
        frame: (chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`,
        end: () => '',
      };

    case 'gemini-array': {
      let first = true;
      return {
        contentType: 'application/json',
        frame(chunk) {
          const text = `${first ? '[' : ',\r\n'}${JSON.stringify(chunk)}`;
          first = false;
          return text;
        },
        end: () => (first ? '[]' : ']'),
      };
    }

    case 'ollama':
      return {
        contentType: 'application/x-ndjson',
        frame: (chunk) => `${JSON.stringify(chunk)}\n`,
        end: () => '',
      };

    case 'openai':
    case 'generic':
    default:
      return {
        contentType: 'text/event-stream',
        frame: (chunk) => `data: ${JSON.stringify(chunk)}\n\n`,
        end: () => 'data: [DONE]\n\n',
      };
  }
}

/**
 * The framing a request's path asks for:
 *
 * - `...:streamGenerateContent` / `...:generateContent` -> `gemini` with
 *   `alt=sse` (in the URL or `query`), otherwise `gemini-array`
 * - `/api/chat`, `/api/generate` -> `ollama`
 * - `/chat/completions` -> `openai`
 * - `/messages` -> `anthropic`
 * - anything else -> `generic`
 */
export function detectStreamFraming(
  url: string,
  query?: Record<string, string | string[] | undefined>
): StreamFraming {
  const [path = '', search = ''] = url.split('?', 2);
  if (/:(stream)?generatecontent$/i.test(path)) {
    const alt = query?.alt ?? new URLSearchParams(search).get('alt') ?? undefined;
    return (Array.isArray(alt) ? alt[0] : alt) === 'sse' ? 'gemini' : 'gemini-array';
  }
  if (/\/api\/(chat|generate)\/?$/.test(path)) {
    return 'ollama';
  }
  if (path.includes('/chat/completions')) {
    return 'openai';
  }
  if (path.includes('/messages')) {
    return 'anthropic';
  }
  return 'generic';
}

/** True for a Gemini `:streamGenerateContent` URL, which streams without a `stream` body field. */
export function isGeminiStreamURL(url: string): boolean {
  return /:streamgeneratecontent$/i.test(url.split('?', 1)[0] ?? '');
}

/**
 * The model named in a Gemini URL (`.../models/{model}:generateContent` or
 * `:streamGenerateContent`), or `undefined` for any other URL. Gemini puts
 * the model in the URL, not in the request body.
 */
export function geminiModelFromURL(url: string): string | undefined {
  const path = url.split('?', 1)[0] ?? '';
  const match = /\/models\/([^/:]+):(?:stream)?generatecontent$/i.exec(path);
  if (!match?.[1]) {
    return undefined;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * Whether a request asks for a streamed answer, the way its API decides it:
 *
 * - Gemini: by URL (`:streamGenerateContent`), with no `stream` body field.
 * - Ollama `/api/chat` and `/api/generate`: `stream` defaults to `true`, so
 *   only `stream: false` asks for a single response.
 * - Everything else (OpenAI, Anthropic, ...): `stream: true` in the body.
 */
export function requestWantsStream(url: string, body: unknown): boolean {
  const stream =
    typeof body === 'object' && body !== null ? (body as { stream?: unknown }).stream : undefined;
  if (stream === true || isGeminiStreamURL(url)) {
    return true;
  }
  const path = url.split('?', 1)[0] ?? '';
  return /\/api\/(chat|generate)\/?$/.test(path) && stream !== false;
}
