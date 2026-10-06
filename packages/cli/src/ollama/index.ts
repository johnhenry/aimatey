/**
 * Ollama CLI Interface
 *
 * Main entry point for Ollama CLI interface.
 *
 * @module cli/ollama
 */

import { loadBackend } from '../utils/backend-loader.js';
import { loadModelMapping } from '../utils/model-translation.js';
import { setColorsEnabled, error } from '../utils/output-formatter.js';
import { runCommand } from './commands/run.js';
import { listCommand } from './commands/list.js';
import { psCommand } from './commands/ps.js';
import { showCommand } from './commands/show.js';
import { pullCommand } from './commands/pull.js';

/**
 * Parse command line arguments.
 */
function parseArgs(args: string[]): {
  command: string;
  options: Record<string, any>;
  positional: string[];
} {
  const options: Record<string, any> = {};
  const positional: string[] = [];
  let command = 'run'; // default command
  let commandFound = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) {
      continue;
    }

    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];

      if (nextArg && !nextArg.startsWith('--') && !nextArg.startsWith('-')) {
        options[key] = nextArg;
        i++;
      } else {
        options[key] = true;
      }
    } else if (arg.startsWith('-')) {
      const key = arg.slice(1);
      options[key] = true;
    } else {
      // First non-option argument is the command
      if (!commandFound) {
        command = arg;
        commandFound = true;
      } else {
        positional.push(arg);
      }
    }
  }

  return { command, options, positional };
}

/**
 * Show help message.
 */
function showHelp(): void {
  console.log(`
Ollama CLI Emulator

Emulate Ollama CLI interface using any Aimatey backend adapter.

Usage:
  ai-matey emulate-ollama --backend <path> <command> [options]

Commands:
  run <model> [prompt]     Run a model (default command)
  pull <model>             Download GGUF model from Ollama registry
  list                     List available models
  ps                       List running models
  show <model>             Show model information

Global Options:
  --backend <path>         Backend module to load (required for run/list/ps/show)
  --model-map <path>       Model translation mapping JSON file
  --no-color               Disable colored output
  --no-stream              Disable streaming output
  --json                   Output as JSON
  --verbose, -v            Verbose output
  --help, -h               Show this help
  --version                Show version

Run Command Options:
  --system <text>          System message
  --state <text>           Decision models: the state each prompt is judged against
                           (default: the prompt itself)

Decision models (nimble, tev1, kev, ...):
  'run' does not chat. Each prompt is asked as one noul question, "Is the
  following true? <prompt>", and answered as true/false with P(true).

Pull Command Options:
  --output <path>          Output file path (default: ./models/<model>.gguf)
  --insecure               Allow insecure connections

Examples:
  # Download a model
  ai-matey emulate-ollama pull phi3:3.8b
  ai-matey emulate-ollama pull llama3.1:8b --output ./models/my-model.gguf

  # Interactive mode
  ai-matey emulate-ollama --backend ./backend.mjs run llama3.1

  # Single prompt
  ai-matey emulate-ollama --backend ./backend.mjs run llama3.1 "What is 2+2?"

  # Pipe input
  echo "Hello" | ai-matey emulate-ollama --backend ./backend.mjs run llama3.1

  # With model mapping
  ai-matey emulate-ollama --backend ./backend.mjs --model-map ./map.json run llama3.1
`);
}

/**
 * Show version.
 */
function showVersion(): void {
  console.log('ai-matey emulate-ollama v0.1.0');
}

/**
 * Main CLI entry point.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let options: Record<string, any> = {};

  try {
    // Parse arguments
    const parsed = parseArgs(argv);
    options = parsed.options;
    const { command, positional } = parsed;

    // Handle help/version (check before required options)
    if (options.help || options.h) {
      showHelp();
      return;
    }

    if (options.version) {
      showVersion();
      return;
    }

    // Set up colors
    if (options['no-color']) {
      setColorsEnabled(false);
    }

    // Handle pull command (doesn't require backend)
    if (command === 'pull') {
      const model = positional[0];
      if (!model) {
        error('Missing required argument: <model>');
        console.log('\nUsage: ai-matey emulate-ollama pull <model> [options]');
        console.log('Example: ai-matey emulate-ollama pull phi3:3.8b');
        process.exit(1);
      }

      await pullCommand({
        model,
        output: options.output,
        verbose: options.verbose || options.v,
        insecure: options.insecure,
      });
      return;
    }

    // Check for required backend option for other commands
    if (!options.backend) {
      error('Missing required option: --backend <path>');
      console.log('\nRun with --help for usage information');
      process.exit(1);
    }

    // Load backend
    const backend = await loadBackend({ path: options.backend });

    // Load model mapping if specified
    const modelMapping = options['model-map']
      ? await loadModelMapping(options['model-map'])
      : undefined;

    // Dispatch to command
    switch (command) {
      case 'run': {
        const model = positional[0];
        if (!model) {
          error('Missing required argument: <model>');
          console.log('\nUsage: ai-matey emulate-ollama --backend <path> run <model> [prompt]');
          process.exit(1);
        }

        const prompt = positional.slice(1).join(' ') || undefined;

        await runCommand({
          backend,
          model,
          prompt,
          modelMapping,
          json: options.json,
          verbose: options.verbose || options.v,
          system: options.system,
          noStream: options['no-stream'],
          state: typeof options.state === 'string' ? options.state : undefined,
        });
        break;
      }

      case 'list':
        await listCommand({
          backend,
          modelMapping,
          json: options.json,
          verbose: options.verbose || options.v,
        });
        break;

      case 'ps':
        await psCommand({
          backend,
          json: options.json,
          verbose: options.verbose || options.v,
        });
        break;

      case 'show': {
        const model = positional[0];
        if (!model) {
          error('Missing required argument: <model>');
          console.log('\nUsage: ollama-cli-interface --backend <path> show <model>');
          process.exit(1);
        }

        await showCommand({
          backend,
          model,
          modelMapping,
          json: options.json,
          verbose: options.verbose || options.v,
        });
        break;
      }

      default:
        error(`Unknown command: ${command}`);
        console.log('\nRun with --help for available commands');
        process.exit(1);
    }
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    if (options.verbose) {
      console.error(err);
    }
    process.exit(1);
  }
}
