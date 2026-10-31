/**
 * Node.js HTTP Adapter
 *
 * Converts Node.js IncomingMessage/ServerResponse to GenericRequest/GenericResponse
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  GenericRequest,
  GenericResponse,
  GenericStreamOptions,
} from '@johnhenry/aimatey-http-core';
import {
  parseRequest,
  sendSSEHeaders,
  createStreamFramer,
  sendJSON,
} from '@johnhenry/aimatey-http-core';

/**
 * Adapter that converts Node.js IncomingMessage to GenericRequest
 */
export class NodeRequestAdapter implements GenericRequest {
  private _parsed: Awaited<ReturnType<typeof parseRequest>> | null = null;
  private _parsePromise: Promise<void> | null = null;

  constructor(
    private req: IncomingMessage,
    private maxBodySize: number = 10 * 1024 * 1024
  ) {}

  /**
   * Parse the request body if not already parsed
   */
  private async ensureParsed(): Promise<void> {
    if (this._parsed) {
      return;
    }

    // Avoid multiple simultaneous parse calls
    if (this._parsePromise) {
      await this._parsePromise;
      return;
    }

    this._parsePromise = (async () => {
      this._parsed = await parseRequest(this.req, this.maxBodySize);
    })();

    await this._parsePromise;
  }

  get method(): string {
    return this.req.method || 'GET';
  }

  get url(): string {
    return this.req.url || '/';
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
    // Return parsed body if available, null otherwise
    return this._parsed?.body ?? null;
  }

  get params(): Record<string, string> | undefined {
    // ParsedRequest doesn't have params, so return undefined
    return undefined;
  }

  get query(): Record<string, string> | undefined {
    return this._parsed?.query;
  }

  get ip(): string | undefined {
    // Try various sources for IP address
    const forwarded = this.req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0]?.trim();
    }

    const realIp = this.req.headers['x-real-ip'];
    if (typeof realIp === 'string') {
      return realIp;
    }

    const socket = this.req.socket as any;
    return socket?.remoteAddress;
  }

  /**
   * Get the underlying Node.js request object
   */
  get raw(): IncomingMessage {
    return this.req;
  }

  /**
   * Parse the request body (called by core handler before accessing body)
   */
  async parse(): Promise<void> {
    await this.ensureParsed();
  }
}

/**
 * Adapter that converts GenericResponse methods to Node.js ServerResponse
 */
export class NodeResponseAdapter implements GenericResponse {
  private _statusCode: number = 200;
  private _headersSent: boolean = false;

  constructor(private res: ServerResponse) {}

  status(code: number): void {
    this._statusCode = code;
    if (!this._headersSent) {
      this.res.statusCode = code;
    }
  }

  header(name: string, value: string): void {
    if (!this._headersSent) {
      this.res.setHeader(name, value);
    }
  }

  send(data: any): void {
    if (!this.canStartResponse()) {
      return;
    }

    this._headersSent = true;

    // Handle empty string (e.g., for CORS preflight 204 responses)
    if (data === '') {
      this.res.end();
      return;
    }

    sendJSON(this.res, data, this._statusCode);
  }

  async stream(
    generator: AsyncGenerator<any, void, undefined>,
    options?: GenericStreamOptions
  ): Promise<void> {
    if (!this.canStartResponse()) {
      return;
    }

    this._headersSent = true;
    const framer = createStreamFramer(options?.framing);

    // Set stream headers (SSE, JSON array or NDJSON, per the framing)
    sendSSEHeaders(this.res, { 'Content-Type': framer.contentType });

    try {
      // Stream chunks
      for await (const chunk of generator) {
        if (!this.isWritable()) {
          break;
        }
        this.res.write(framer.frame(chunk));
      }

      // End the stream (`data: [DONE]` for OpenAI-style SSE)
      if (this.isWritable()) {
        this.res.end(framer.end());
      }
    } catch (error) {
      // If error occurs during streaming, we can't change status code
      // Just log and close
      console.error('Streaming error:', error);

      if (this.isWritable()) {
        this.res.end();
      }
    }
  }

  /**
   * Whether a *new* response can still be started on this socket.
   *
   * `headersSent` belongs here and only here: once the status line is on the
   * wire it can no longer be changed, so a fresh response cannot begin. It is
   * a pre-flight concern, not a per-write one -- see isWritable().
   *
   * Mirrors canStillRespond() in ./listener.ts, which asks the same question
   * of the same socket from the outer error path.
   */
  private canStartResponse(): boolean {
    return this.isWritable() && !this.res.headersSent;
  }

  /**
   * Whether the socket can still accept a write.
   *
   * Deliberately does NOT consult `headersSent`. stream() calls
   * sendSSEHeaders(), which flushes the headers before the first chunk, so
   * during a stream `headersSent` is the expected state rather than a reason
   * to stop. Folding it in here made the per-chunk guard in stream() false on
   * its very first iteration: the loop broke before writing anything, and the
   * break skipped the tail, so res.end() was never reached and the connection
   * hung open (#89).
   */
  isWritable(): boolean {
    return this.res.writable && !this.res.writableEnded && !this.res.destroyed;
  }

  /**
   * Get the underlying Node.js response object
   */
  get raw(): ServerResponse {
    return this.res;
  }
}
