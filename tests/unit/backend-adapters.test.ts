import { describe, it, expect } from 'vitest';
import {
  OpenAIBackendAdapter,
  AnthropicBackendAdapter,
  DeepSeekBackendAdapter,
  GroqBackendAdapter,
  InceptionBackendAdapter,
  MoonshotBackendAdapter,
  SambaNovaBackendAdapter,
  GitHubModelsBackendAdapter,
  DashScopeBackendAdapter,
  OmniRouteBackendAdapter,
} from '@johnhenry/aimatey-backend';
import {
  MockBackendAdapter,
  createEchoBackend,
  createErrorBackend,
  createDelayedBackend,
} from '@johnhenry/aimatey-backend-browser';
import type { IRChatRequest } from '@johnhenry/aimatey-types';

describe('Backend Adapters', () => {
  const mockRequest: IRChatRequest = {
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello!' }],
      },
    ],
    parameters: {
      model: 'test-model',
      temperature: 0.7,
      maxTokens: 100,
    },
    metadata: {
      requestId: 'test-123',
      timestamp: Date.now(),
    },
  };

  describe('OpenAIBackendAdapter', () => {
    it('should create adapter with config', () => {
      const adapter = new OpenAIBackendAdapter({
        apiKey: 'test-key',
        baseURL: 'https://api.openai.com/v1',
      });

      expect(adapter).toBeDefined();
      expect(adapter.metadata.name).toBe('openai-backend');
    });

    it('should provide metadata', () => {
      const adapter = new OpenAIBackendAdapter({ apiKey: 'test-key' });
      const metadata = adapter.metadata;

      expect(metadata.name).toBe('openai-backend');
      expect(metadata.capabilities.streaming).toBe(true);
      expect(metadata.capabilities.tools).toBe(true);
      expect(metadata.capabilities.multiModal).toBe(true);
    });
  });

  describe('AnthropicBackendAdapter', () => {
    it('should create adapter with config', () => {
      const adapter = new AnthropicBackendAdapter({
        apiKey: 'test-key',
      });

      expect(adapter).toBeDefined();
      expect(adapter.metadata.name).toBe('anthropic-backend');
    });

    it('should provide metadata with correct capabilities', () => {
      const adapter = new AnthropicBackendAdapter({ apiKey: 'test-key' });
      const metadata = adapter.metadata;

      expect(metadata.name).toBe('anthropic-backend');
      expect(metadata.capabilities.streaming).toBe(true);
      expect(metadata.capabilities.tools).toBe(true);
      expect(metadata.capabilities.multiModal).toBe(true);
    });

    it('should handle custom base URL', () => {
      const adapter = new AnthropicBackendAdapter({
        apiKey: 'test-key',
        baseURL: 'https://custom.api.com',
      });

      expect(adapter).toBeDefined();
    });
  });

  describe('DeepSeekBackendAdapter', () => {
    it('should create adapter with config', () => {
      const adapter = new DeepSeekBackendAdapter({
        apiKey: 'test-key',
      });

      expect(adapter).toBeDefined();
      expect(adapter.metadata.name).toBe('deepseek-backend');
    });

    it('should provide metadata', () => {
      const adapter = new DeepSeekBackendAdapter({ apiKey: 'test-key' });
      const metadata = adapter.metadata;

      expect(metadata.name).toBe('deepseek-backend');
      expect(metadata.capabilities.streaming).toBe(true);
    });
  });

  describe('GroqBackendAdapter', () => {
    it('should create adapter with config', () => {
      const adapter = new GroqBackendAdapter({
        apiKey: 'test-key',
      });

      expect(adapter).toBeDefined();
      expect(adapter.metadata.name).toBe('groq-backend');
    });

    it('should provide metadata', () => {
      const adapter = new GroqBackendAdapter({ apiKey: 'test-key' });
      const metadata = adapter.metadata;

      expect(metadata.name).toBe('groq-backend');
      expect(metadata.capabilities.streaming).toBe(true);
      expect(metadata.capabilities.tools).toBe(true);
    });
  });

  describe('InceptionBackendAdapter', () => {
    it('should create adapter with config', () => {
      const adapter = new InceptionBackendAdapter({
        apiKey: 'test-key',
      });

      expect(adapter).toBeDefined();
      expect(adapter.metadata.name).toBe('inception-backend');
    });

    it('should provide metadata', () => {
      const adapter = new InceptionBackendAdapter({ apiKey: 'test-key' });
      const metadata = adapter.metadata;

      expect(metadata.name).toBe('inception-backend');
      expect(metadata.provider).toBe('Inception Labs');
      expect(metadata.capabilities.streaming).toBe(true);
      expect(metadata.capabilities.multiModal).toBe(false);
    });

    it('should use default model and base URL', () => {
      const adapter = new InceptionBackendAdapter({ apiKey: 'test-key' });

      expect(adapter.metadata.config?.baseURL).toBe('https://api.inceptionlabs.ai/v1');
    });

    it('should accept custom base URL', () => {
      const adapter = new InceptionBackendAdapter({
        apiKey: 'test-key',
        baseURL: 'https://custom.inception.api/v1',
      });

      expect(adapter).toBeDefined();
    });
  });

  describe('MoonshotBackendAdapter', () => {
    it('should create adapter with config', () => {
      const adapter = new MoonshotBackendAdapter({
        apiKey: 'test-key',
      });

      expect(adapter).toBeDefined();
      expect(adapter.metadata.name).toBe('moonshot-backend');
    });

    it('should provide metadata', () => {
      const adapter = new MoonshotBackendAdapter({ apiKey: 'test-key' });
      const metadata = adapter.metadata;

      expect(metadata.name).toBe('moonshot-backend');
      expect(metadata.provider).toBe('Moonshot AI');
      expect(metadata.capabilities.streaming).toBe(true);
      expect(metadata.capabilities.tools).toBe(true);
      expect(metadata.capabilities.maxContextTokens).toBe(1048576);
    });

    it('should use default base URL', () => {
      const adapter = new MoonshotBackendAdapter({ apiKey: 'test-key' });

      expect(adapter.metadata.config?.baseURL).toBe('https://api.moonshot.cn/v1');
    });

    it('should accept custom base URL', () => {
      const adapter = new MoonshotBackendAdapter({
        apiKey: 'test-key',
        baseURL: 'https://custom.moonshot.api/v1',
      });

      expect(adapter).toBeDefined();
    });
  });

  describe('SambaNovaBackendAdapter', () => {
    it('should create adapter with config', () => {
      const adapter = new SambaNovaBackendAdapter({
        apiKey: 'test-key',
      });

      expect(adapter).toBeDefined();
      expect(adapter.metadata.name).toBe('sambanova-backend');
    });

    it('should provide metadata', () => {
      const adapter = new SambaNovaBackendAdapter({ apiKey: 'test-key' });
      const metadata = adapter.metadata;

      expect(metadata.name).toBe('sambanova-backend');
      expect(metadata.provider).toBe('SambaNova');
      expect(metadata.capabilities.streaming).toBe(true);
      expect(metadata.capabilities.tools).toBe(true);
    });

    it('should use default base URL', () => {
      const adapter = new SambaNovaBackendAdapter({ apiKey: 'test-key' });

      expect(adapter.metadata.config?.baseURL).toBe('https://api.sambanova.ai/v1');
    });

    it('should accept custom base URL', () => {
      const adapter = new SambaNovaBackendAdapter({
        apiKey: 'test-key',
        baseURL: 'https://custom.sambanova.api/v1',
      });

      expect(adapter).toBeDefined();
    });
  });

  describe('GitHubModelsBackendAdapter', () => {
    it('should create adapter with config', () => {
      const adapter = new GitHubModelsBackendAdapter({
        apiKey: 'test-key',
      });

      expect(adapter).toBeDefined();
      expect(adapter.metadata.name).toBe('github-models-backend');
    });

    it('should provide metadata', () => {
      const adapter = new GitHubModelsBackendAdapter({ apiKey: 'test-key' });
      const metadata = adapter.metadata;

      expect(metadata.name).toBe('github-models-backend');
      expect(metadata.provider).toBe('GitHub Models');
      expect(metadata.capabilities.streaming).toBe(true);
      expect(metadata.capabilities.tools).toBe(false);
      expect(metadata.capabilities.multiModal).toBe(true);
    });

    it('should use default base URL', () => {
      const adapter = new GitHubModelsBackendAdapter({ apiKey: 'test-key' });

      expect(adapter.metadata.config?.baseURL).toBe('https://models.github.ai/inference');
    });

    it('should accept custom base URL', () => {
      const adapter = new GitHubModelsBackendAdapter({
        apiKey: 'test-key',
        baseURL: 'https://custom.github-models.api/inference',
      });

      expect(adapter).toBeDefined();
    });

    it('estimateCost returns null (free via Copilot subscription tier)', async () => {
      const adapter = new GitHubModelsBackendAdapter({ apiKey: 'test-key' });

      await expect(adapter.estimateCost(mockRequest)).resolves.toBeNull();
    });
  });

  describe('DashScopeBackendAdapter', () => {
    it('should create adapter with config', () => {
      const adapter = new DashScopeBackendAdapter({
        apiKey: 'test-key',
      });

      expect(adapter).toBeDefined();
      expect(adapter.metadata.name).toBe('dashscope-backend');
    });

    it('should provide metadata', () => {
      const adapter = new DashScopeBackendAdapter({ apiKey: 'test-key' });
      const metadata = adapter.metadata;

      expect(metadata.name).toBe('dashscope-backend');
      expect(metadata.provider).toBe('Alibaba Cloud Model Studio (DashScope)');
      expect(metadata.capabilities.streaming).toBe(true);
      expect(metadata.capabilities.tools).toBe(true);
      expect(metadata.capabilities.multiModal).toBe(true);
    });

    it('should use default (international) base URL', () => {
      const adapter = new DashScopeBackendAdapter({ apiKey: 'test-key' });

      expect(adapter.metadata.config?.baseURL).toBe(
        'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
      );
    });

    it('should accept custom base URL (e.g. mainland China region)', () => {
      const adapter = new DashScopeBackendAdapter({
        apiKey: 'test-key',
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      });

      expect(adapter).toBeDefined();
    });

    it('estimateCost returns null (pricing not consistently published)', async () => {
      const adapter = new DashScopeBackendAdapter({ apiKey: 'test-key' });

      await expect(adapter.estimateCost(mockRequest)).resolves.toBeNull();
    });
  });

  describe('OmniRouteBackendAdapter', () => {
    const noKeyConfig = {} as ConstructorParameters<typeof OmniRouteBackendAdapter>[0];

    it('should create adapter without an API key (local/keyless usage)', () => {
      const adapter = new OmniRouteBackendAdapter(noKeyConfig);

      expect(adapter).toBeDefined();
      expect(adapter.metadata.name).toBe('omniroute-backend');
    });

    it('should provide metadata', () => {
      const adapter = new OmniRouteBackendAdapter(noKeyConfig);
      const metadata = adapter.metadata;

      expect(metadata.name).toBe('omniroute-backend');
      expect(metadata.provider).toBe('OmniRoute');
      expect(metadata.capabilities.streaming).toBe(true);
      expect(metadata.capabilities.tools).toBe(true);
      expect(metadata.capabilities.embeddings).toBe(true);
    });

    it('should use the default local base URL and "auto" model', () => {
      const adapter = new OmniRouteBackendAdapter(noKeyConfig);

      expect(adapter.metadata.config?.baseURL).toBe('http://localhost:20128/v1');
      const req = adapter.fromIR({ ...mockRequest, parameters: undefined });
      expect(req.model).toBe('auto');
    });

    it('should accept a custom base URL and API key', () => {
      const adapter = new OmniRouteBackendAdapter({
        apiKey: 'test-key',
        baseURL: 'http://localhost:8080/v1',
      });

      expect(adapter.metadata.config?.baseURL).toBe('http://localhost:8080/v1');
    });

    it('estimateCost returns null (actual routed provider/cost is unknowable from the request)', async () => {
      const adapter = new OmniRouteBackendAdapter(noKeyConfig);

      await expect(adapter.estimateCost(mockRequest)).resolves.toBeNull();
    });
  });

  describe('MockBackendAdapter', () => {
    it('should create mock adapter', () => {
      const adapter = new MockBackendAdapter();

      expect(adapter).toBeDefined();
      expect(adapter.metadata.name).toBe('mock');
    });

    it('should execute mock request', async () => {
      const adapter = new MockBackendAdapter({
        defaultResponse: 'Test response',
      });

      const response = await adapter.execute(mockRequest);

      expect(response).toBeDefined();
      expect(response.message.role).toBe('assistant');
      expect(response.message.content).toBeDefined();
      expect(response.finishReason).toBe('stop');
    });

    it('should support streaming', async () => {
      const adapter = new MockBackendAdapter({
        defaultResponse: 'Test streaming response',
        simulateStreaming: true,
        streamChunkDelay: 0,
      });

      const stream = adapter.executeStream(mockRequest);
      const chunks = [];

      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].type).toBe('start');
      expect(chunks[chunks.length - 1].type).toBe('done');
    });

    it('should use echo backend', async () => {
      const adapter = createEchoBackend();
      const response = await adapter.execute(mockRequest);

      expect(response.message.content[0].type).toBe('text');
      expect((response.message.content[0] as { text: string }).text).toContain('Echo:');
    });

    it('should use error backend', async () => {
      const adapter = createErrorBackend(new Error('Test error'));

      await expect(adapter.execute(mockRequest)).rejects.toThrow('Test error');
    });

    it('should use delayed backend', async () => {
      const adapter = createDelayedBackend(50);
      const start = Date.now();

      await adapter.execute(mockRequest);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(45); // Allow some timing variance
    });

    it('should support custom response', async () => {
      const adapter = new MockBackendAdapter({
        defaultResponse: {
          content: 'Custom response',
          usage: {
            inputTokens: 10,
            outputTokens: 20,
          },
        },
      });

      const response = await adapter.execute(mockRequest);

      expect((response.message.content[0] as { text: string }).text).toBe('Custom response');
      expect(response.usage?.totalTokens).toBe(30);
    });

    it('should track request history', async () => {
      const adapter = new MockBackendAdapter({
        defaultResponse: 'Test response',
      });

      await adapter.execute(mockRequest);
      await adapter.execute(mockRequest);

      expect(adapter.lastRequest).toEqual(mockRequest);
      expect(adapter.allRequests.length).toBe(2);

      adapter.clearHistory();
      expect(adapter.lastRequest).toBeUndefined();
      expect(adapter.allRequests.length).toBe(0);
    });
  });

  describe('Backend Adapter Common Interface', () => {
    const adapters = [
      { name: 'OpenAI', adapter: new OpenAIBackendAdapter({ apiKey: 'test' }) },
      { name: 'Anthropic', adapter: new AnthropicBackendAdapter({ apiKey: 'test' }) },
      { name: 'DeepSeek', adapter: new DeepSeekBackendAdapter({ apiKey: 'test' }) },
      { name: 'Groq', adapter: new GroqBackendAdapter({ apiKey: 'test' }) },
      { name: 'Inception', adapter: new InceptionBackendAdapter({ apiKey: 'test' }) },
      { name: 'Moonshot', adapter: new MoonshotBackendAdapter({ apiKey: 'test' }) },
      { name: 'SambaNova', adapter: new SambaNovaBackendAdapter({ apiKey: 'test' }) },
      { name: 'Mock', adapter: new MockBackendAdapter() },
    ];

    adapters.forEach(({ name, adapter }) => {
      describe(`${name} Adapter Interface`, () => {
        it('should have required properties', () => {
          expect(adapter.metadata).toBeDefined();
          expect(adapter.metadata.name).toBeDefined();
          expect(typeof adapter.metadata.name).toBe('string');
        });

        it('should have execute method', () => {
          expect(typeof adapter.execute).toBe('function');
        });

        it('should have executeStream method', () => {
          expect(typeof adapter.executeStream).toBe('function');
        });

        it('should have metadata property', () => {
          expect(adapter.metadata).toBeDefined();
          expect(typeof adapter.metadata).toBe('object');
          expect(adapter.metadata.name).toBeDefined();
          expect(adapter.metadata.capabilities).toBeDefined();
        });
      });
    });
  });
});
