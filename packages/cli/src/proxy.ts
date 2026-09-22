#!/usr/bin/env node
/**
 * Aimatey Proxy Server
 *
 * HTTP proxy server that accepts provider-format requests (e.g., OpenAI)
 * and routes them through any ai-matey backend adapter.
 *
 * Usage:
 *   ai-matey proxy --backend ./backend.mjs --port 3000 --format openai
 *
 * This allows you to use ANY backend as a drop-in replacement for OpenAI/Anthropic/etc!
 *
 * @module cli/proxy
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import type { BackendAdapter } from '@johnhenry/aimatey-types';
import type { IRChatRequest } from '@johnhenry/aimatey-types';
import { supportsChat, supportsChatStream } from '@johnhenry/aimatey-utils';
import { AdapterError, ErrorCode } from '@johnhenry/aimatey-errors';
import { loadBackend } from './utils/backend-loader.js';
import { success, error as errorLog, info } from './utils/output-formatter.js';
import {
  toOpenAI as responseToOpenAI,
  toAnthropic as responseToAnthropic,
  toGemini as responseToGemini,
  toOllama as responseToOllama,
  toMistral as responseToMistral,
} from './converters/response-converters.js';

// ============================================================================
// Types
// ============================================================================

interface ProxyOptions {
  backend: string;
  port?: number;
  format?: string;
  host?: string;
  help?: boolean;
  verbose?: boolean;
}

// ============================================================================
// Request Parsing
// ============================================================================

/**
 * Read request body as JSON.
 */
async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  const body = Buffer.concat(chunks).toString('utf-8');
  return JSON.parse(body);
}

/**
 * Convert provider request to IR.
 */
export function providerRequestToIR(data: any, format: string): IRChatRequest {
  switch (format) {
    case 'openai':
      return {
        messages: data.messages || [],
        parameters: {
          model: data.model,
          temperature: data.temperature,
          maxTokens: data.max_tokens,
          topP: data.top_p,
          frequencyPenalty: data.frequency_penalty,
          presencePenalty: data.presence_penalty,
          stopSequences: Array.isArray(data.stop) ? data.stop : data.stop ? [data.stop] : undefined,
          seed: data.seed,
          user: data.user,
        },
        stream: data.stream,
        metadata: {
          requestId: crypto.randomUUID(),
          timestamp: Date.now(),
          provenance: { frontend: 'openai' },
        },
      };

    case 'anthropic': {
      // Add system message if present
      const messages = data.messages || [];
      if (data.system) {
        messages.unshift({ role: 'system', content: data.system });
      }

      return {
        messages,
        parameters: {
          model: data.model,
          temperature: data.temperature,
          maxTokens: data.max_tokens,
          topP: data.top_p,
          topK: data.top_k,
          stopSequences: data.stop_sequences,
        },
        stream: data.stream,
        metadata: {
          requestId: crypto.randomUUID(),
          timestamp: Date.now(),
          provenance: { frontend: 'anthropic' },
        },
      };
    }

    case 'gemini': {
      const geminiMessages = (data.contents || []).map((content: any) => ({
        role: content.role === 'model' ? 'assistant' : content.role,
        content: content.parts?.map((p: any) => p.text).join('') || '',
      }));

      return {
        messages: geminiMessages,
        parameters: {
          model: data.model,
          temperature: data.generationConfig?.temperature,
          maxTokens: data.generationConfig?.maxOutputTokens,
          topP: data.generationConfig?.topP,
          topK: data.generationConfig?.topK,
          stopSequences: data.generationConfig?.stopSequences,
        },
        metadata: {
          requestId: crypto.randomUUID(),
          timestamp: Date.now(),
          provenance: { frontend: 'gemini' },
        },
      };
    }

    case 'ollama':
      return {
        messages: data.messages || [],
        parameters: {
          model: data.model,
          temperature: data.options?.temperature,
          topP: data.options?.top_p,
          topK: data.options?.top_k,
        },
        stream: data.stream,
        metadata: {
          requestId: crypto.randomUUID(),
          timestamp: Date.now(),
          provenance: { frontend: 'ollama' },
        },
      };

    case 'mistral':
      return {
        messages: data.messages || [],
        parameters: {
          model: data.model,
          temperature: data.temperature,
          maxTokens: data.max_tokens,
          topP: data.top_p,
        },
        stream: data.stream,
        metadata: {
          requestId: crypto.randomUUID(),
          timestamp: Date.now(),
          provenance: { frontend: 'mistral' },
        },
      };

    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}

// ============================================================================
// Request Handler
// ============================================================================

/**
 * Create request handler for the proxy server.
 */
export function createHandler(backend: BackendAdapter, format: string, verbose: boolean) {
  if (!supportsChat(backend) || !supportsChatStream(backend)) {
    throw new AdapterError({
      code: ErrorCode.UNSUPPORTED_FEATURE,
      message: `Backend '${backend.metadata.name}' does not support chat -- the proxy server requires a chat-capable backend (both execute and executeStream)`,
      isRetryable: false,
      provenance: { backend: backend.metadata.name },
    });
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle OPTIONS
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Only handle POST
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    try {
      // Read and parse request body
      const requestBody = await readBody(req);

      if (verbose) {
        console.log(`[${new Date().toISOString()}] Request:`, JSON.stringify(requestBody, null, 2));
      }

      // Convert to IR
      const irRequest = providerRequestToIR(requestBody, format);

      // Check if streaming
      if (irRequest.stream) {
        // Handle streaming
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        // Execute streaming request (non-null: createHandler verified chat support)
        const stream = backend.executeStream(irRequest);

        for await (const chunk of stream) {
          if (chunk.type === 'content') {
            // Format as SSE
            const data = {
              id: chunk.sequence.toString(),
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: irRequest.parameters?.model || 'unknown',
              choices: [
                {
                  index: 0,
                  delta: { content: chunk.delta },
                  finish_reason: null,
                },
              ],
            };

            res.write(`data: ${JSON.stringify(data)}\n\n`);
          } else if (chunk.type === 'done') {
            // Send final chunk
            const data = {
              id: chunk.sequence.toString(),
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: irRequest.parameters?.model || 'unknown',
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: chunk.finishReason || 'stop',
                },
              ],
            };

            res.write(`data: ${JSON.stringify(data)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          } else if (chunk.type === 'error') {
            res.write(`data: ${JSON.stringify({ error: chunk.error })}\n\n`);
            res.end();
          }
        }
      } else {
        // Handle non-streaming (non-null: createHandler verified chat support)
        const irResponse = await backend.execute(irRequest);

        // Convert response back to provider format
        let providerResponse: any;

        switch (format) {
          case 'openai':
            providerResponse = await responseToOpenAI(irResponse);
            break;
          case 'anthropic':
            providerResponse = await responseToAnthropic(irResponse);
            break;
          case 'gemini':
            providerResponse = await responseToGemini(irResponse);
            break;
          case 'ollama':
            providerResponse = await responseToOllama(irResponse);
            break;
          case 'mistral':
            providerResponse = await responseToMistral(irResponse);
            break;
          default:
            throw new Error(`Unsupported format: ${format}`);
        }

        if (verbose) {
          console.log(
            `[${new Date().toISOString()}] Response:`,
            JSON.stringify(providerResponse, null, 2)
          );
        }

        // Send response
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(providerResponse));
      }
    } catch (err) {
      console.error('Request error:', err);

      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message: err instanceof Error ? err.message : String(err),
            type: 'internal_error',
          },
        })
      );
    }
  };
}

// ============================================================================
// CLI
// ============================================================================

function showHelp(): void {
  console.log(`
Aimatey Proxy Server

Start an HTTP proxy server that accepts provider-format requests
and routes them through any ai-matey backend adapter.

Usage:
  ai-matey proxy --backend <path> [options]

Options:
  --backend <path>         Backend module to load (required)
  --port <number>          Port to listen on (default: 3000)
  --host <host>            Host to bind to (default: localhost)
  --format <format>        Provider format to emulate (default: openai)
                           Supported: openai, anthropic, gemini, ollama, mistral
  --verbose, -v            Verbose logging
  --help, -h               Show this help

Examples:
  # Start OpenAI-compatible proxy on port 3000
  ai-matey proxy --backend ./groq-backend.mjs --port 3000

  # Start Anthropic-compatible proxy
  ai-matey proxy --backend ./backend.mjs --format anthropic --port 3001

  # Use with OpenAI client library
  ai-matey proxy --backend ./backend.mjs --port 3000
  # Then in your code:
  # const openai = new OpenAI({ baseURL: 'http://localhost:3000' })

How It Works:
  1. Accepts HTTP requests in the specified provider format (e.g., OpenAI)
  2. Converts the request to Universal IR format
  3. Routes through your backend adapter
  4. Converts the response back to the provider format
  5. Returns to client

  This allows you to use ANY backend as a drop-in replacement for OpenAI,
  Anthropic, or other providers!
`);
}

function parseArgs(args: string[]): ProxyOptions {
  const options: ProxyOptions = {
    backend: '',
    port: 3000,
    host: 'localhost',
    format: 'openai',
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--backend':
        options.backend = args[++i] || '';
        break;
      case '--port':
        options.port = parseInt(args[++i] || '3000', 10);
        break;
      case '--host':
        options.host = args[++i] || 'localhost';
        break;
      case '--format':
        options.format = args[++i] || 'openai';
        break;
      case '--verbose':
      case '-v':
        options.verbose = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
    }
  }

  return options;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);

  if (options.help) {
    showHelp();
    return;
  }

  if (!options.backend) {
    errorLog('Missing required option: --backend <path>');
    console.log('\nRun with --help for usage information');
    process.exit(1);
  }

  try {
    // Load backend
    info(`Loading backend from ${options.backend}...`);
    const backend = await loadBackend({ path: options.backend });

    success(`✓ Backend loaded: ${backend.metadata.name} (${backend.metadata.provider})`);

    // Create server
    const handler = createHandler(backend, options.format || 'openai', options.verbose || false);
    const server = createServer((req, res) => {
      void handler(req, res);
    });

    // Start listening
    server.listen(options.port, options.host, () => {
      console.log('');
      success(`🚀 Proxy server started!`);
      console.log('');
      console.log(`  Format:  ${options.format}`);
      console.log(`  URL:     http://${options.host}:${options.port}`);
      console.log(`  Backend: ${backend.metadata.name}`);
      console.log('');
      console.log('  Press Ctrl+C to stop');
      console.log('');

      if (options.format === 'openai') {
        console.log('  Example usage with OpenAI client:');
        console.log('  ┌────────────────────────────────────────────┐');
        console.log(`  │ const openai = new OpenAI({               │`);
        console.log(`  │   baseURL: 'http://${options.host}:${options.port}',        │`);
        console.log(`  │   apiKey: 'any-value'                     │`);
        console.log(`  │ })                                        │`);
        console.log('  └────────────────────────────────────────────┘');
        console.log('');
      }
    });

    // Handle shutdown
    process.on('SIGINT', () => {
      console.log('\n\nShutting down...');
      server.close(() => {
        console.log('Server closed');
        process.exit(0);
      });
    });
  } catch (err) {
    errorLog(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
