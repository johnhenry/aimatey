/**
 * Express HTTP Adapter
 *
 * Converts Express Request/Response to GenericRequest/GenericResponse
 *
 * @module
 */

import type { Request, Response } from 'express';
import type {
  GenericRequest,
  GenericResponse,
  GenericStreamOptions,
} from '@johnhenry/aimatey-http-core';
import { createStreamFramer } from '@johnhenry/aimatey-http-core';

/**
 * Adapter that converts Express Request to GenericRequest
 */
export class ExpressRequestAdapter implements GenericRequest {
  constructor(private req: Request) {}

  get method(): string {
    return this.req.method || 'GET';
  }

  get url(): string {
    return this.req.originalUrl || this.req.url || '/';
  }

  get headers(): Record<string, string> {
    const headers: Record<string, string> = {};

    for (const [key, value] of Object.entries(this.req.headers)) {
      if (typeof value === 'string') {
        headers[key.toLowerCase()] = value;
      } else if (Array.isArray(value)) {
        headers[key.toLowerCase()] = value.join(', ');
      }
    }

    return headers;
  }

  get body(): any {
    // Express body is already parsed if body-parser middleware is used
    return this.req.body ?? null;
  }

  get params(): Record<string, string> | undefined {
    return this.req.params;
  }

  get query(): Record<string, string> | undefined {
    // Express query can have arrays, so we need to stringify them
    const query: Record<string, string> = {};

    for (const [key, value] of Object.entries(this.req.query)) {
      if (typeof value === 'string') {
        query[key] = value;
      } else if (Array.isArray(value)) {
        const primitives = value.filter(
          (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
        ) as (string | number | boolean)[];
        query[key] = primitives.map((v) => v.toString()).join(',');
      } else if (value !== undefined && typeof value !== 'object') {
        query[key] = String(value);
      }
    }

    return Object.keys(query).length > 0 ? query : undefined;
  }

  get ip(): string | undefined {
    // Express provides multiple IP sources
    return this.req.ip || this.req.socket?.remoteAddress;
  }

  /**
   * Get the underlying Express request object
   */
  get raw(): Request {
    return this.req;
  }
}

/**
 * Adapter that converts GenericResponse methods to Express Response
 */
export class ExpressResponseAdapter implements GenericResponse {
  private _statusCode: number = 200;
  private _headersSent: boolean = false;

  constructor(private res: Response) {}

  status(code: number): void {
    this._statusCode = code;
    if (!this._headersSent) {
      this.res.status(code);
    }
  }

  header(name: string, value: string): void {
    if (!this._headersSent) {
      this.res.setHeader(name, value);
    }
  }

  send(data: any): void {
    if (!this.isWritable()) {
      return;
    }

    this._headersSent = true;

    // Handle empty string (e.g., for CORS preflight 204 responses)
    if (data === '') {
      this.res.end();
      return;
    }

    // Express has a built-in json() method
    this.res.status(this._statusCode).json(data);
  }

  async stream(
    generator: AsyncGenerator<any, void, undefined>,
    options?: GenericStreamOptions
  ): Promise<void> {
    if (!this.isWritable()) {
      return;
    }

    this._headersSent = true;

    const framer = createStreamFramer(options?.framing);

    // Set up the stream manually for Express compatibility
    this.res.status(200);
    this.res.setHeader('Content-Type', framer.contentType);
    this.res.setHeader('Cache-Control', 'no-cache');
    this.res.setHeader('Connection', 'keep-alive');
    this.res.setHeader('Transfer-Encoding', 'chunked');

    // Flush headers immediately
    this.res.flushHeaders();

    try {
      // Stream chunks
      for await (const chunk of generator) {
        if (!this.res.writable) {
          break;
        }

        this.res.write(framer.frame(chunk));
      }

      // End the stream (`data: [DONE]` for OpenAI-style SSE)
      if (this.res.writable) {
        this.res.end(framer.end());
      }
    } catch {
      // If error occurs during streaming, we can't change status code
      // Just close the connection
      if (this.res.writable) {
        this.res.end();
      }
    }
  }

  isWritable(): boolean {
    return !this.res.headersSent && this.res.writable;
  }

  /**
   * Get the underlying Express response object
   */
  get raw(): Response {
    return this.res;
  }
}
