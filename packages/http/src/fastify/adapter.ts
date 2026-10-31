/**
 * Fastify HTTP Adapter
 *
 * Converts Fastify Request/Reply to GenericRequest/GenericResponse
 *
 * @module
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import type {
  GenericRequest,
  GenericResponse,
  GenericStreamOptions,
} from '@johnhenry/aimatey-http-core';
import { sendSSEHeaders, createStreamFramer } from '@johnhenry/aimatey-http-core';

/**
 * Adapter that converts Fastify Request to GenericRequest
 */
export class FastifyRequestAdapter implements GenericRequest {
  constructor(private request: FastifyRequest) {}

  get method(): string {
    return this.request.method || 'GET';
  }

  get url(): string {
    return this.request.url || '/';
  }

  get headers(): Record<string, string> {
    const headers: Record<string, string> = {};

    for (const [key, value] of Object.entries(this.request.headers)) {
      if (typeof value === 'string') {
        headers[key.toLowerCase()] = value;
      } else if (Array.isArray(value)) {
        headers[key.toLowerCase()] = value.join(', ');
      }
    }

    return headers;
  }

  get body(): any {
    // Fastify automatically parses JSON body
    return this.request.body ?? null;
  }

  get params(): Record<string, string> | undefined {
    return this.request.params as Record<string, string>;
  }

  get query(): Record<string, string> | undefined {
    // Fastify query can have arrays, so we need to stringify them
    const query: Record<string, string> = {};

    for (const [key, value] of Object.entries(this.request.query || {})) {
      if (typeof value === 'string') {
        query[key] = value;
      } else if (Array.isArray(value)) {
        query[key] = value.join(',');
      } else if (value !== undefined) {
        query[key] = String(value);
      }
    }

    return Object.keys(query).length > 0 ? query : undefined;
  }

  get ip(): string | undefined {
    // Fastify provides IP through request.ip
    return this.request.ip || this.request.socket?.remoteAddress;
  }

  /**
   * Get the underlying Fastify request object
   */
  get raw(): FastifyRequest {
    return this.request;
  }
}

/**
 * Adapter that converts GenericResponse methods to Fastify Reply
 */
export class FastifyResponseAdapter implements GenericResponse {
  private _statusCode: number = 200;
  private _headersSent: boolean = false;

  constructor(private reply: FastifyReply) {}

  status(code: number): void {
    this._statusCode = code;
    if (!this._headersSent) {
      this.reply.code(code);
    }
  }

  header(name: string, value: string): void {
    if (!this._headersSent) {
      this.reply.header(name, value);
    }
  }

  send(data: any): void {
    if (!this.canStartResponse()) {
      return;
    }

    this._headersSent = true;

    // Handle empty string (e.g., for CORS preflight 204 responses)
    if (data === '') {
      this.reply.code(this._statusCode).send('');
      return;
    }

    // Fastify automatically JSON-stringifies objects
    this.reply.code(this._statusCode).send(data);
  }

  async stream(
    generator: AsyncGenerator<any, void, undefined>,
    options?: GenericStreamOptions
  ): Promise<void> {
    if (!this.canStartResponse()) {
      return;
    }

    this._headersSent = true;

    // Get the underlying Node.js response for SSE
    const nodeRes = this.reply.raw;

    // Set SSE headers
    const framer = createStreamFramer(options?.framing);
    sendSSEHeaders(nodeRes, { 'Content-Type': framer.contentType });

    try {
      // Stream chunks
      for await (const chunk of generator) {
        if (!this.isWritable()) {
          break;
        }
        nodeRes.write(framer.frame(chunk));
      }

      // End the stream (`data: [DONE]` for OpenAI-style SSE)
      if (this.isWritable()) {
        nodeRes.end(framer.end());
      }
    } catch (error) {
      // If error occurs during streaming, we can't change status code
      // Just log and close
      console.error('Streaming error:', error);

      if (this.isWritable()) {
        nodeRes.end();
      }
    }
  }

  /**
   * Whether a *new* response can still be started.
   *
   * Committing to a response is a pre-flight concern: once Fastify has sent a
   * reply, or once this adapter has flushed SSE headers, a fresh response can
   * no longer begin. That says nothing about whether the socket will take
   * another write -- see isWritable().
   */
  private canStartResponse(): boolean {
    return !this.reply.sent && !this._headersSent && this.isWritable();
  }

  /**
   * Whether the socket can still accept a write.
   *
   * Deliberately does NOT consult `_headersSent`. stream() sets that flag and
   * flushes SSE headers before the first chunk, so during a stream it is the
   * expected state rather than a reason to stop. Folding it in here made the
   * per-chunk guard in stream() false on its very first iteration -- the same
   * defect reported against the Node adapter in #89, which this adapter shares
   * because it drives reply.raw through the same SSE helpers.
   */
  isWritable(): boolean {
    const raw = this.reply.raw;
    return raw.writable && !raw.writableEnded && !raw.destroyed;
  }

  /**
   * Get the underlying Fastify reply object
   */
  get raw(): FastifyReply {
    return this.reply;
  }
}
