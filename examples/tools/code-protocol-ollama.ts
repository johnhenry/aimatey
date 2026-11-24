/**
 * Code protocol: a small local model with native tool calling OFF writes
 * JavaScript that calls your tools inside an andbox wasm sandbox.
 *
 * Run: npx tsx examples/tools/code-protocol-ollama.ts
 * Needs: Ollama with qwen2.5:3b, and the optional peers
 *   npm i @johnhenry/andbox && npm i --save-exact quickjs-emscripten-core@0.32.0 \
 *     @jitl/quickjs-ng-wasmfile-release-sync@0.32.0
 */

import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { OllamaBackendAdapter } from '@johnhenry/aimatey-backend/ollama';
import { codeProtocol, andboxExecutor } from '@johnhenry/aimatey-tool-protocols';

const bridge = new Bridge(
  new OpenAIFrontendAdapter(),
  new OllamaBackendAdapter({ baseURL: 'http://localhost:11434' })
);

const temps: Record<string, number> = { 'San Francisco': 64, 'New York': 78, Boston: 58 };

const result = await bridge.runTools({
  model: 'qwen2.5:3b',
  prompt: 'Which is warmest: San Francisco, New York or Boston? Use the tools, then answer.',
  maxIterations: 6,
  protocol: codeProtocol({ executor: andboxExecutor() }),
  tools: {
    get_temperature: {
      description: 'Current temperature in Fahrenheit for a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City name' } },
        required: ['city'],
      },
      execute: ({ city }) => ({ city, fahrenheit: temps[city as string] ?? null }),
    },
  },
  gate: (call) => {
    console.log('gate saw:', call.name, JSON.stringify(call.input));
    return { action: 'allow' };
  },
  onStepFinish: (s) => console.log(`step ${s.iteration}: ${s.toolCalls.length} tool call(s)`),
});

console.log('\nAnswer:', result.text);
