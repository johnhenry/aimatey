/**
 * Tool calling on a model with no native tool support, via the text protocol.
 *
 * Run: npx tsx examples/tools/text-protocol-ollama.ts
 * Requires Ollama on localhost:11434 with a small model (default qwen2.5:3b).
 */

import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { OllamaBackendAdapter } from '@johnhenry/aimatey-backend';
import { textProtocol } from '@johnhenry/aimatey-tool-protocols';

const bridge = new Bridge(
  new OpenAIFrontendAdapter(),
  new OllamaBackendAdapter({ defaultModel: process.env.OLLAMA_MODEL ?? 'qwen2.5:3b' })
);

const result = await bridge.runTools({
  prompt: 'What is the temperature in Paris plus the temperature in Rome? Use the tools.',
  protocol: textProtocol(),
  maxIterations: 6,
  tools: {
    get_temperature: {
      description: 'Get the current temperature in Celsius for a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City name' } },
        required: ['city'],
      },
      execute: ({ city }) => ({ city, celsius: city === 'Paris' ? 12 : 20 }),
    },
    add: {
      description: 'Add two numbers',
      parameters: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
      execute: ({ a, b }) => (a as number) + (b as number),
    },
  },
});

console.log(result.text);
for (const step of result.steps) {
  console.log(
    `step ${step.iteration}:`,
    step.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.input)})`).join(', ') || '(no call)'
  );
}
