/**
 * Hono HTTP Adapter
 *
 * Converts Hono Context to GenericRequest/GenericResponse
 *
 * @module
 */

import type { Context } from 'hono';
import type {
  GenericRequest,
  GenericResponse,
  GenericStreamOptions,
} from '@johnhenry/aimatey-http-core';
import { createStreamFramer } from '@johnhenry/aimatey-http-core';

/**
 * Adapter that converts Hono Context to GenericRequest
 */
export class HonoRequestAdapter implements GenericRequest {
  constructor(private c: Context) {}

  get method(): string {
    return this.c.req.method || 'GET';
  }

  get url(): string {
    return this.c.req.url || '/';
  }

  get headers(): Record<string, string> {
    const headers: Record<string, string> = {};

    // Hono headers is a Headers object
    this.c.req.raw.headers.forEach((value: string, key: string) => {
      headers[key.toLowerCase()] = value;
    });

    return headers;
  }

  get body(): any {
    // Hono doesn't automatically parse body - it must be done with middleware
    // Access the parsed body from context if available
    return (this.c as any).body ?? null;
  }

  get params(): Record<string, string> | undefined {
    // Hono params are available via c.req.param()
    const params = this.c.req.param();
    return Object.keys(params).length > 0 ? params : undefined;
  }

  get query(): Record<string, string> | undefined {
    // Hono query is available via c.req.query()
    const query: Record<string, string> = {};
    const queryParams = this.c.req.query();

    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== undefined) {
        query[key] = String(value);
      }
    }

    return Object.keys(query).length > 0 ? query : undefined;
  }

  get ip(): string | undefined {
    // Try to get IP from various headers
    const forwarded = this.c.req.header('x-forwarded-for');
    if (forwarded) {
      return forwarded.split(',')[0]?.trim();
    }

    const realIp = this.c.req.header('x-real-ip');
    if (realIp) {
      return realIp;
    }

    // Fallback to undefined as we can't access socket in all Hono runtimes
    return undefined;
  }

  /**
   * Get the underlying Hono context object
   */
  get raw(): Context {
    return this.c;
  }
}

/**
 * Adapter that converts GenericResponse methods to Hono Context
 */
export class HonoResponseAdapter implements GenericResponse {
  private _statusCode: number = 200;
  private _headers: Map<string, string> = new Map();
  private _sent: boolean = false;

  constructor(private c: Context) {}

  status(code: number): void {
    if (!this._sent) {
      this._statusCode = code;
    }
  }

  header(name: string, value: string): void {
    if (!this._sent) {
      this._headers.set(name, value);
    }
  }

  send(data: any): void {
    if (this._sent) {
      return;
    }

    this._sent = true;

    // Collect headers for response
    const headers = new Headers();
    for (const [name, value] of this._headers.entries()) {
      headers.set(name, value);
    }

    // Handle empty string (e.g., for CORS preflight 204 responses)
    if (data === '') {
      // 204 No Content responses cannot have a body (not even empty string)
      // Use null for 204, empty string for other status codes
      this.c.res = new Response(this._statusCode === 204 ? null : '', {
        status: this._statusCode,
        headers,
      });
      return;
    }

    // Send JSON response
    headers.set('Content-Type', 'application/json');
    this.c.res = new Response(JSON.stringify(data), {
      status: this._statusCode,
      headers,
    });
  }

  stream(
    generator: AsyncGenerator<any, void, undefined>,
    options?: GenericStreamOptions
  ): Promise<void> {
    if (this._sent) {
      return Promise.resolve();
    }

    this._sent = true;

    // Set all headers
    for (const [name, value] of this._headers.entries()) {
      this.c.header(name, value);
    }

    const framer = createStreamFramer(options?.framing);
    const encoder = new TextEncoder();

    // Create the stream (SSE, JSON array or NDJSON, per the framing)
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of generator) {
            controller.enqueue(encoder.encode(framer.frame(chunk)));
          }

          // End the stream (`data: [DONE]` for OpenAI-style SSE)
          const end = framer.end();
          if (end) {
            controller.enqueue(encoder.encode(end));
          }

          controller.close();
        } catch (error) {
          console.error('Streaming error:', error);
          controller.error(error);
        }
      },
    });

    // Set SSE headers and return stream
    this.c.header('Content-Type', framer.contentType);
    this.c.header('Cache-Control', 'no-cache');
    this.c.header('Connection', 'keep-alive');

    this.c.res = new Response(stream, {
      status: this._statusCode,
      headers: this.c.res?.headers,
    });

    return Promise.resolve();
  }

  isWritable(): boolean {
    return !this._sent;
  }

  /**
   * Get the underlying Hono context object
   */
  get raw(): Context {
    return this.c;
  }
}
