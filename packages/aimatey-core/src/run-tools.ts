/**
 * Agentic Tool-Execution Loop
 *
 * `createRunTools(bridge)` builds the `bridge.runTools()` method: execute →
 * if the model requests tools, run their handlers → append results →
 * re-execute, until the model answers or `maxIterations` is exhausted.
 *
 * @module
 */

import type {
  IRChatRequest,
  IRChatResponse,
  IRMessage,
  IRTool,
  IRUsage,
  GateDecision,
  RunToolsDenial,
  RunToolsOptions,
  RunToolsResult,
  RunToolsStep,
} from '@johnhenry/aimatey-types';
import { AdapterError, ErrorCode } from '@johnhenry/aimatey-errors';
import {
  extractToolCalls,
  createToolResultMessage,
  validateToolArgs,
  type ToolCallResult,
} from '@johnhenry/aimatey-utils';

/**
 * The subset of Bridge that runTools needs (avoids a circular type import).
 */
export interface RunToolsBridge {
  executeIR(request: IRChatRequest, options?: { signal?: AbortSignal }): Promise<IRChatResponse>;
  readonly frontend: { readonly metadata: { readonly name: string } };
}

/**
 * Create the runTools function for a Bridge.
 */
export function createRunTools(
  bridge: RunToolsBridge
): (options: RunToolsOptions) => Promise<RunToolsResult> {
  return async function runTools(options: RunToolsOptions): Promise<RunToolsResult> {
    const {
      tools,
      maxIterations = 10,
      parallelToolCalls = true,
      validateArguments = true,
      signal,
      gate,
      maxDenials,
    } = options;

    if (!options.prompt && (!options.messages || options.messages.length === 0)) {
      throw new AdapterError({
        code: ErrorCode.INVALID_REQUEST,
        message: 'runTools requires either `prompt` or non-empty `messages`',
        isRetryable: false,
        provenance: {},
      });
    }

    // Record-keyed tools → IR array
    const irTools: IRTool[] = Object.entries(tools).map(([name, definition]) => ({
      name,
      description: definition.description,
      parameters: definition.parameters,
      metadata: definition.metadata,
    }));

    let messages: IRMessage[] = options.messages
      ? [...options.messages]
      : [{ role: 'user', content: options.prompt as string }];

    const steps: RunToolsStep[] = [];
    const denials: RunToolsDenial[] = [];
    let totalUsage: IRUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const request: IRChatRequest = {
        messages,
        parameters: {
          ...options.parameters,
          ...(options.model && { model: options.model }),
        },
        tools: irTools,
        // Only constrain the first round; later rounds must be able to answer
        ...(iteration === 1 && options.toolChoice && { toolChoice: options.toolChoice }),
        metadata: {
          requestId: crypto.randomUUID(),
          timestamp: Date.now(),
          provenance: { frontend: bridge.frontend.metadata.name },
          custom: { runToolsIteration: iteration },
        },
      };

      const response = await bridge.executeIR(request, { signal });

      if (response.usage) {
        totalUsage = {
          promptTokens: totalUsage.promptTokens + response.usage.promptTokens,
          completionTokens: totalUsage.completionTokens + response.usage.completionTokens,
          totalTokens: totalUsage.totalTokens + response.usage.totalTokens,
        };
      }

      const toolCalls = extractToolCalls(response);

      // Model answered without tools: done
      if (toolCalls.length === 0) {
        const step: RunToolsStep = { iteration, response, toolCalls: [], toolResults: [] };
        steps.push(step);
        await options.onStepFinish?.(step);

        return {
          text: extractText(response),
          response,
          messages: [...messages, response.message],
          steps,
          finishReason: response.finishReason,
          totalUsage,
          status: 'completed',
          denials,
        };
      }

      // Append the assistant's tool-call message before executing
      messages = [...messages, response.message];

      // Ask the gate about one call; returns the tool result to feed back when
      // the call was stopped, undefined when it may run.
      const applyGate = async (
        call: (typeof toolCalls)[number],
        iterationNumber: number
      ): Promise<ToolCallResult | undefined> => {
        const context = {
          name: call.name,
          input: call.input,
          iteration: iterationNumber,
          toolCallId: call.id,
          history: messages,
        };

        let decision: GateDecision;
        try {
          decision = await gate!(context);
        } catch (error) {
          // A gate that cannot answer must not let the call through
          signal?.throwIfAborted();
          decision = {
            action: 'deny',
            reason: `gate error: ${error instanceof Error ? error.message : String(error)}`,
          };
        }

        if (decision.action === 'review' && options.onReview) {
          const reviewed = await options.onReview({
            ...context,
            reason: decision.reason,
            decision,
          });
          if (reviewed) {
            decision = reviewed;
          }
        }

        if (decision.action === 'allow') {
          return undefined;
        }

        const reason = decision.reason;
        denials.push({
          iteration: iterationNumber,
          toolCallId: call.id,
          name: call.name,
          input: call.input,
          action: decision.action,
          ...(reason !== undefined && { reason }),
          ...(decision.response && { response: decision.response }),
        });

        const suffix = reason ? `: ${reason}` : '';
        return {
          toolCallId: call.id,
          result:
            decision.action === 'review'
              ? `Tool call requires human review and was not run${suffix}`
              : `Tool call denied${suffix}`,
          isError: true,
        };
      };

      // Execute the requested tools
      const executeOne = async (call: (typeof toolCalls)[number]): Promise<ToolCallResult> => {
        const definition = tools[call.name];
        if (!definition) {
          return {
            toolCallId: call.id,
            result: `Unknown tool: ${call.name}`,
            isError: true,
          };
        }

        if (validateArguments) {
          const validation = validateToolArgs(
            {
              name: call.name,
              description: definition.description,
              parameters: definition.parameters,
            },
            call.input
          );
          if (!validation.valid) {
            // Feed validation failures back to the model so it can retry
            return {
              toolCallId: call.id,
              result: `Invalid arguments: ${validation.errors
                .map((error) => `${error.path}: ${error.message}`)
                .join('; ')}`,
              isError: true,
            };
          }
        }

        if (gate) {
          const denied = await applyGate(call, iteration);
          if (denied) {
            return denied;
          }
        }

        try {
          const result = await definition.execute(call.input, {
            toolCallId: call.id,
            messages,
            signal,
          });
          return { toolCallId: call.id, result };
        } catch (error) {
          return {
            toolCallId: call.id,
            result: error instanceof Error ? error.message : String(error),
            isError: true,
          };
        }
      };

      let toolResults: ToolCallResult[];
      if (parallelToolCalls) {
        toolResults = await Promise.all(toolCalls.map(executeOne));
      } else {
        toolResults = [];
        for (const call of toolCalls) {
          toolResults.push(await executeOne(call));
        }
      }

      messages = [...messages, createToolResultMessage(toolResults)];

      const step: RunToolsStep = {
        iteration,
        response,
        toolCalls: toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          input: call.input,
        })),
        toolResults,
      };
      steps.push(step);
      await options.onStepFinish?.(step);

      if (maxDenials !== undefined && denials.length >= maxDenials) {
        return {
          text: '',
          response,
          messages,
          steps,
          finishReason: response.finishReason,
          totalUsage,
          status: 'max-denials',
          denials,
        };
      }
    }

    throw new AdapterError({
      code: ErrorCode.MAX_TOOL_ITERATIONS_EXCEEDED,
      message: `runTools exceeded ${maxIterations} iterations without a final answer`,
      isRetryable: false,
      provenance: {},
      details: { maxIterations, steps: steps.length },
    });
  };
}

function extractText(response: IRChatResponse): string {
  const content = response.message.content;
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');
}
