/**
 * Ollama `run` Command
 *
 * Run a model interactively or with a single prompt.
 *
 * @module cli/ollama/commands/run
 */

import * as readline from 'node:readline';
import type { BackendAdapter } from '@johnhenry/aimatey-types';
import type { IRMessage } from '@johnhenry/aimatey-types';
import { supportsChat, supportsChatStream } from '@johnhenry/aimatey-utils';
import { AdapterError, ErrorCode } from '@johnhenry/aimatey-errors';
import { translateModel, type ModelMapping } from '../../utils/model-translation.js';
import { colorize, style } from '../../utils/output-formatter.js';
import { stateManager } from '../../utils/state-manager.js';
import { isModelRunner } from '../../utils/backend-loader.js';

/**
 * `execute`/`executeStream` are optional on `BackendAdapter` (a
 * decision-only backend like Jev/Laya has neither) -- the `ollama run`
 * command is chat-only, so fail with a clear message up front rather than
 * mid-response.
 */
function requireChatBackend(backend: BackendAdapter): void {
  if (!supportsChat(backend) || !supportsChatStream(backend)) {
    throw new AdapterError({
      code: ErrorCode.UNSUPPORTED_FEATURE,
      message: `Backend '${backend.metadata.name}' does not support chat -- 'ollama run' requires a chat-capable backend (both execute and executeStream)`,
      isRetryable: false,
      provenance: { backend: backend.metadata.name },
    });
  }
}

export interface RunCommandOptions {
  /**
   * Backend adapter to use.
   */
  backend: BackendAdapter;

  /**
   * Model name to run.
   */
  model: string;

  /**
   * Single prompt (non-interactive mode).
   */
  prompt?: string;

  /**
   * Model mapping for translation.
   */
  modelMapping?: ModelMapping;

  /**
   * Format output as JSON.
   */
  json?: boolean;

  /**
   * Verbose output.
   */
  verbose?: boolean;

  /**
   * System message.
   */
  system?: string;

  /**
   * Disable streaming.
   */
  noStream?: boolean;
}

/**
 * Execute the run command.
 */
export async function runCommand(options: RunCommandOptions): Promise<void> {
  const {
    backend,
    model,
    prompt,
    modelMapping,
    json = false,
    verbose = false,
    system,
    noStream = false,
  } = options;

  // Translate model name
  const translatedModel = translateModel(model, {
    backend,
    mapping: modelMapping,
  });

  if (verbose && translatedModel !== model) {
    console.error(colorize(`Model translated: ${model} → ${translatedModel}`, 'gray'));
  }

  // Start model runner if needed
  if (isModelRunner(backend)) {
    const runner = backend as any;
    if (!runner.isRunning) {
      if (verbose) {
        console.error(colorize('Starting model runner...', 'gray'));
      }
      await runner.start();

      // Track in state
      const stats = runner.getStats();
      stateManager.add({
        name: model,
        backend: backend.metadata.name,
        pid: stats.pid,
        startTime: Date.now(),
        lastActivity: Date.now(),
      });
    }
  }

  // Check if we have a prompt (non-interactive mode)
  if (prompt) {
    await runSinglePrompt({
      backend,
      model: translatedModel,
      prompt,
      system,
      json,
      noStream,
    });
    return;
  }

  // Check for piped input
  if (!process.stdin.isTTY) {
    const input = await readStdin();
    await runSinglePrompt({
      backend,
      model: translatedModel,
      prompt: input,
      system,
      json,
      noStream,
    });
    return;
  }

  // Interactive mode
  await runInteractive({
    backend,
    model: translatedModel,
    originalModel: model,
    system,
    noStream,
  });
}

/**
 * Run a single prompt (non-interactive).
 */
async function runSinglePrompt(options: {
  backend: BackendAdapter;
  model: string;
  prompt: string;
  system?: string;
  json?: boolean;
  noStream?: boolean;
}): Promise<void> {
  const { backend, model, prompt, system, json, noStream } = options;
  requireChatBackend(backend);

  // Build messages
  const messages: IRMessage[] = [];
  if (system) {
    messages.push({ role: 'system', content: system });
  }
  messages.push({ role: 'user', content: prompt });

  try {
    const metadata = {
      requestId: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      timestamp: Date.now(),
    };

    if (noStream || json) {
      // Non-streaming
      // Non-null: requireChatBackend() already verified chat support.
      const response = await backend.execute!({
        messages,
        parameters: { model },
        metadata,
      });

      if (json) {
        console.log(JSON.stringify(response, null, 2));
      } else {
        const content = response.message.content[0];
        if (content && typeof content !== 'string' && content.type === 'text') {
          console.log(content.text);
        }
      }
    } else {
      // Streaming (default for Ollama compatibility)
      // Non-null: requireChatBackend() already verified chat support.
      for await (const chunk of backend.executeStream!({
        messages,
        parameters: { model },
        metadata,
      })) {
        if (chunk.type === 'content' && typeof chunk.delta === 'string') {
          process.stdout.write(chunk.delta);
        }
      }
      process.stdout.write('\n');
    }
  } catch (error) {
    console.error(
      colorize(`Error: ${error instanceof Error ? error.message : String(error)}`, 'red')
    );
    process.exit(1);
  }
}

/**
 * Run interactive mode.
 */
async function runInteractive(options: {
  backend: BackendAdapter;
  model: string;
  originalModel: string;
  system?: string;
  noStream?: boolean;
}): Promise<void> {
  const { backend, model, originalModel, system, noStream } = options;
  requireChatBackend(backend);

  // Conversation history
  const messages: IRMessage[] = [];
  if (system) {
    messages.push({ role: 'system', content: system });
  }

  // Print welcome
  console.log();
  console.log(style('>>> Ollama CLI Interface', 'bold', 'cyan'));
  console.log(
    `Model: ${colorize(originalModel, 'green')}${
      model !== originalModel ? colorize(` (using ${model})`, 'gray') : ''
    }`
  );
  console.log(`Backend: ${colorize(backend.metadata.name, 'blue')}`);
  console.log();
  console.log(colorize('Type your message and press Enter. Use /exit to quit.', 'gray'));
  console.log();

  // Create readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: colorize('>>> ', 'cyan'),
  });

  rl.prompt();

  for await (const line of rl) {
    const trimmed = line.trim();

    // Handle commands
    if (trimmed === '/exit' || trimmed === '/quit') {
      rl.close();
      console.log();
      break;
    }

    if (trimmed === '/clear') {
      messages.length = system ? 1 : 0;
      console.log(colorize('Conversation cleared', 'green'));
      rl.prompt();
      continue;
    }

    if (trimmed === '/help') {
      console.log();
      console.log(style('Available commands:', 'bold'));
      console.log('  /help   - Show this help');
      console.log('  /clear  - Clear conversation history');
      console.log('  /exit   - Exit chat');
      console.log();
      rl.prompt();
      continue;
    }

    if (!trimmed) {
      rl.prompt();
      continue;
    }

    // Add user message
    messages.push({ role: 'user', content: trimmed });

    // Update state activity
    if (isModelRunner(backend)) {
      stateManager.touch(backend.metadata.name, originalModel);
    }

    try {
      const metadata = {
        requestId: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
        timestamp: Date.now(),
      };

      let assistantMessage = '';

      if (noStream) {
        // Non-streaming
        // Non-null: requireChatBackend() already verified chat support.
        const response = await backend.execute!({
          messages,
          parameters: { model },
          metadata,
        });

        const content = response.message.content[0];
        if (content && typeof content !== 'string' && content.type === 'text') {
          assistantMessage = content.text;
          console.log(assistantMessage);
        }
      } else {
        // Streaming
        // Non-null: requireChatBackend() already verified chat support.
        for await (const chunk of backend.executeStream!({
          messages,
          parameters: { model },
          metadata,
        })) {
          if (chunk.type === 'content' && typeof chunk.delta === 'string') {
            process.stdout.write(chunk.delta);
            assistantMessage += chunk.delta;
          }
        }
        console.log();
      }

      // Add assistant message to history
      messages.push({ role: 'assistant', content: assistantMessage });
    } catch (error) {
      console.error(
        colorize(`Error: ${error instanceof Error ? error.message : String(error)}`, 'red')
      );
    }

    console.log();
    rl.prompt();
  }
}

/**
 * Read from stdin.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}
