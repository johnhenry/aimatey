#!/usr/bin/env node
/**
 * Aimatey CLI - Main Entry Point
 *
 * Unified CLI with subcommands for various utilities.
 *
 * Usage:
 *   ai-matey <command> [options]
 *
 * Commands:
 *   convert-response     Convert IR responses to provider formats
 *   emulate-ollama       Emulate Ollama CLI interface
 *   (future) emulate-openai, emulate-anthropic, etc.
 *
 * @module cli/main
 */

// ============================================================================
// Help Text
// ============================================================================

function showHelp(): void {
  console.log(`
Aimatey CLI v0.0.0
Universal AI Adapter System - Provider-agnostic interface for AI APIs

USAGE:
  ai-matey <command> [options]

COMMANDS:
  convert-response     Convert Universal IR responses to provider formats
                       (OpenAI, Anthropic, Gemini, Ollama, Mistral)

  convert-request      Convert between Universal IR and provider request formats
                       (bidirectional: IR ↔ OpenAI, Anthropic, etc.)

  emulate-ollama       Emulate Ollama CLI interface using any backend
                       (compatible with Ollama commands: run, list, ps, show)

  create-backend       Generate a backend adapter template for emulate commands
                       (supports OpenAI-compatible APIs, Groq, Together AI, etc.)

  proxy                Start an HTTP proxy server that accepts provider requests
                       and routes them through any backend (OpenAI-compatible!);
                       also serves typed-decision routes (/v1/systemone, ...)

  decide               Ask typed questions (choice / score / noul) about a state
                       through any decision backend; table, JSON or batch output

GLOBAL OPTIONS:
  -h, --help           Show this help message
  -v, --version        Show version number

EXAMPLES:
  # Convert IR response to OpenAI format
  ai-matey convert-response --format openai --input response.json

  # Convert OpenAI request to IR (for migration)
  ai-matey convert-request --from openai --to ir --input openai-req.json

  # Create a backend adapter
  ai-matey create-backend --provider groq --output ./groq-backend.mjs

  # Emulate Ollama CLI with your backend
  ai-matey emulate-ollama --backend ./groq-backend.mjs run llama3-8b-8192

  # Start OpenAI-compatible proxy server
  ai-matey proxy --backend ./groq-backend.mjs --port 3000

  # Ask a decision model typed questions
  ai-matey decide --backend ollama --model tev1:0.8b --state "Refund me today" \\
    --question 'urgent:noul:"Is this urgent?"'

  # Get help for a specific command
  ai-matey convert-response --help
  ai-matey convert-request --help
  ai-matey emulate-ollama --help
  ai-matey create-backend --help
  ai-matey proxy --help
  ai-matey decide --help

Run 'ai-matey <command> --help' for more information on a specific command.
`);
}

function showVersion(): void {
  console.log('ai-matey version 0.0.0');
}

// ============================================================================
// Subcommand Routing
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Handle no arguments
  if (args.length === 0) {
    showHelp();
    process.exit(0);
  }

  const command = args[0];

  // Handle global flags (only if no command or if help/version is the first arg)
  if (command === '--help' || command === '-h') {
    showHelp();
    process.exit(0);
  }

  if (command === '--version' || command === '-v') {
    showVersion();
    process.exit(0);
  }

  // Route to subcommand
  switch (command) {
    case 'convert-response': {
      const { main: convertMain } = await import('./convert-response.js');
      // Remove the command name from args
      process.argv = [process.argv[0] || 'node', process.argv[1] || 'ai-matey', ...args.slice(1)];
      await convertMain();
      break;
    }

    case 'convert-request': {
      const { main: convertRequestMain } = await import('./convert-request.js');
      // Remove the command name from args
      process.argv = [process.argv[0] || 'node', process.argv[1] || 'ai-matey', ...args.slice(1)];
      await convertRequestMain();
      break;
    }

    case 'emulate-ollama': {
      const { main: ollamaMain } = await import('./ollama/index.js');
      // Remove the command name from args
      process.argv = [process.argv[0] || 'node', process.argv[1] || 'ai-matey', ...args.slice(1)];
      await ollamaMain();
      break;
    }

    case 'create-backend': {
      const { main: createBackendMain } = await import('./create-backend.js');
      // Remove the command name from args
      process.argv = [process.argv[0] || 'node', process.argv[1] || 'ai-matey', ...args.slice(1)];
      await createBackendMain();
      break;
    }

    case 'proxy': {
      const { main: proxyMain } = await import('./proxy.js');
      // Remove the command name from args
      process.argv = [process.argv[0] || 'node', process.argv[1] || 'ai-matey', ...args.slice(1)];
      await proxyMain();
      break;
    }

    case 'decide': {
      const { main: decideMain } = await import('./decide.js');
      await decideMain(args.slice(1));
      break;
    }

    default:
      console.error(`Error: Unknown command '${command}'`);
      console.error(`Run 'ai-matey --help' to see available commands.`);
      process.exit(1);
  }
}

// ============================================================================
// Export and Execute
// ============================================================================

export { main };

// Run main when executed directly
main().catch((error: unknown) => {
  console.error('Fatal error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
