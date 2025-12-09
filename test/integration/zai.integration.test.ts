import { afterAll, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { streamText } from 'ai';
import { z } from 'zod';
import { createZaiClaudeCode, zaiClaudeCode, createZaiAnthropic } from '../../src/index.js';

const TEST_TIMEOUT = 10_000;
const VISION_TEST_IMAGE = readFileSync(new URL('../assets/vision-test.jpg', import.meta.url));
const ANTHROPIC_HTTP_MODEL = process.env.ZAI_HTTP_MODEL ?? 'claude-3-5-sonnet-20241022';

interface StreamScenario {
  parts: Array<Record<string, unknown>>;
  response: {
    messages: Array<{ role: string; content: any[] }>;
  };
  usage?: Record<string, number>;
  providerMetadata?: Record<string, unknown>;
  assert?: (options: Parameters<typeof streamText>[0]) => void;
}

const scenarioQueue: StreamScenario[] = [];

function enqueueScenario(scenario: StreamScenario) {
  scenarioQueue.push(scenario);
}

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    streamText: ((options) => {
      const scenario = scenarioQueue.shift();
      if (!scenario) {
        throw new Error('No stream scenario configured for streamText invocation.');
      }
      scenario.assert?.(options);
      async function* generate() {
        for (const part of scenario.parts) {
          yield part;
        }
      }
      return {
        fullStream: generate(),
        response: Promise.resolve(scenario.response),
        usage: Promise.resolve(
          scenario.usage ?? {
            inputTokens: 10,
            outputTokens: 20,
          }
        ),
        providerMetadata: Promise.resolve(scenario.providerMetadata ?? {}),
      };
    }) as typeof actual.streamText,
  };
});

describe('ZAI integration streaming + MCP behavior', () => {
  let visionServer: ReturnType<typeof createServer> | undefined;
  let visionServerBaseUrl: string | undefined;

  beforeAll(async () => {
    visionServer = createServer((req, res) => {
      if (req.url === '/vision-test.jpg') {
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'no-store',
        });
        res.end(VISION_TEST_IMAGE);
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => {
      visionServer!.listen(0, '127.0.0.1', resolve);
    });
    const address = visionServer!.address() as AddressInfo;
    visionServerBaseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (!visionServer) return;
    await new Promise<void>((resolve, reject) => {
      visionServer!.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });

  beforeEach(() => {
    if (!process.env.ZAI_API_KEY) {
      throw new Error('ZAI_API_KEY must be set to run integration tests');
    }

    if (!visionServerBaseUrl) {
      throw new Error('Vision fixture server failed to start');
    }
    scenarioQueue.length = 0;
  });
  it('streams text deltas and exposes usage metadata', async () => {
    enqueueScenario({
      parts: [
        { type: 'start' },
        { type: 'start-step' },
        { type: 'text-start' },
        { type: 'text-delta' },
        { type: 'text-end' },
        { type: 'finish-step' },
        { type: 'finish' },
      ],
      response: {
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Here are two quick facts.' }],
          },
        ],
      },
      usage: { inputTokens: 42, outputTokens: 21 },
      providerMetadata: { 'claude-code': { sessionId: 'test-session' } },
    });
    const model = zaiClaudeCode('glm-4.6');
    expect(model.settings.mcpServers).toBeDefined();

    const result = streamText({
      model,
      messages: [
        { role: 'system', content: 'You are a concise assistant.' },
        {
          role: 'user',
          content: 'List two quick facts about the GLM family with bullet points.',
        },
      ],
    });

    const eventTypes: string[] = [];
    for await (const part of result.fullStream) {
      eventTypes.push(part.type);
    }

    expect(eventTypes).toEqual(
      expect.arrayContaining(['start', 'start-step', 'text-start', 'text-delta', 'text-end', 'finish-step', 'finish'])
    );

    const response = await result.response;
    const usage = await result.usage;
    const providerMetadata = await result.providerMetadata;

    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(response.messages[0]?.content.some((block) => block.type === 'text')).toBe(true);
    expect(providerMetadata?.['claude-code']).toBeDefined();
  }, TEST_TIMEOUT);

  it(
    'can invoke the built-in Claude WebSearch tool without MCP enabled',
    async () => {
      enqueueScenario({
        parts: [
          { type: 'start' },
          { type: 'tool-call', toolName: 'WebSearch' },
          { type: 'tool-result', toolName: 'WebSearch', output: { headline: 'GLM' } },
          { type: 'finish' },
        ],
        response: {
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'Latest headline retrieved.' }],
            },
          ],
        },
      });
      const model = zaiClaudeCode('glm-4.6');
      const result = streamText({
      model,
      messages: [
        {
          role: 'system',
          content:
            'Before responding, call the built-in WebSearch tool exactly once to gather the latest GLM-4.6 headline.',
        },
        {
          role: 'user',
          content: 'Please do that now.',
        },
      ],
    });

    const seen = new Set<string>();
    let toolResult: unknown;
    for await (const part of result.fullStream) {
      if (part.type.startsWith('tool')) {
        seen.add(part.type);
      }
      if (part.type === 'tool-call' && part.toolName === 'WebSearch') {
        seen.add('websearch-call');
      }
      if (part.type === 'tool-result' && part.toolName === 'WebSearch') {
        toolResult = part.output;
      }
    }

    expect(Array.from(seen)).toEqual(
      expect.arrayContaining(['tool-call', 'tool-result', 'websearch-call'])
    );
    expect(toolResult).toBeDefined();
    },
    TEST_TIMEOUT
  );

  it(
    'can call the MCP web-search server when enabled',
    async () => {
    enqueueScenario({
      parts: [
        { type: 'tool-input-start' },
        { type: 'tool-input-delta' },
        { type: 'tool-input-end' },
        { type: 'tool-call', toolName: 'mcp__web-search-prime__webSearchPrime' },
        { type: 'tool-result', toolName: 'mcp__web-search-prime__webSearchPrime' },
        { type: 'finish-step' },
      ],
      response: {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool-call', toolName: 'mcp__web-search-prime__webSearchPrime' },
              { type: 'text', text: 'Search complete.' },
            ],
          },
        ],
      },
    });
    const provider = createZaiClaudeCode({
      enableWebSearchMcp: true,
      includeDefaultAllowedTools: false,
      defaultSettings: {
        allowedTools: ['mcp__web-search-prime__webSearchPrime'],
        maxTurns: 4,
      },
    });

    const result = streamText({
      model: provider('glm-4.6'),
      messages: [
        {
          role: 'system',
          content:
            'You must call the tool mcp__web-search-prime__webSearchPrime exactly once to gather live info before answering.',
        },
        {
          role: 'user',
          content: 'Look up the most recent public GLM-4.6 announcement and cite the site name.',
        },
      ],
    });

    const seen = new Set<string>();
    for await (const part of result.fullStream) {
      if (part.type.startsWith('tool')) {
        seen.add(part.type);
      }
      if (part.type === 'tool-call' && part.toolName?.includes('web-search-prime')) {
        seen.add('mcp-web-search-call');
      }
    }

    expect(Array.from(seen)).toEqual(
      expect.arrayContaining([
        'tool-input-start',
        'tool-input-delta',
        'tool-input-end',
        'tool-call',
        'tool-result',
        'mcp-web-search-call',
      ])
    );

    const response = await result.response;
    const toolCallBlock = response.messages
      .flatMap((msg) => msg.content)
      .find((block: any) => block.type === 'tool-call' && block.toolName?.includes('web-search'));

    expect(toolCallBlock).toBeTruthy();
    },
    TEST_TIMEOUT
  );

  it(
    'attempts Z.AI vision analysis via MCP when enabled',
    async () => {
    enqueueScenario({
      parts: [
        { type: 'tool-input-start' },
        { type: 'tool-input-delta' },
        { type: 'tool-input-end' },
        { type: 'tool-call', toolName: 'mcp__zai-vision__analyze_image' },
        { type: 'tool-error', toolName: 'mcp__zai-vision__analyze_image' },
      ],
      response: {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool-call', toolName: 'mcp__zai-vision__analyze_image' },
              { type: 'text', text: 'Vision analysis failed gracefully.' },
            ],
          },
        ],
      },
      assert: (options) => {
        const secondMessage = options.messages?.[1];
        if (typeof secondMessage?.content === 'string') {
          expect(secondMessage.content.includes('vision-test.jpg')).toBe(true);
        }
      },
    });
    const provider = createZaiClaudeCode({
      enableVisionMcp: true,
      includeDefaultAllowedTools: false,
      defaultSettings: {
        allowedTools: ['mcp__zai-vision__analyze_image', 'mcp__zai-vision__image_analysis'],
        maxTurns: 4,
      },
    });

    const imageUrl = `${visionServerBaseUrl!}/vision-test.jpg`;

    const result = streamText({
      model: provider('glm-4.6'),
      messages: [
        {
          role: 'system',
          content:
            'Always call the vision MCP tool to inspect any image URL you are given before responding.',
        },
        {
          role: 'user',
          content: `Describe the contents of this image: ${imageUrl}`,
        },
      ],
    });

    const seen = new Set<string>();
    for await (const part of result.fullStream) {
      if (part.type.startsWith('tool')) {
        seen.add(part.type);
      }
      if (part.type === 'tool-call' && part.toolName?.includes('zai-vision')) {
        seen.add('vision-call');
      }
      if (part.type === 'tool-error' && part.toolName?.includes('zai-vision')) {
        seen.add('vision-error');
      }
    }

    expect(Array.from(seen)).toEqual(
      expect.arrayContaining([
        'tool-input-start',
        'tool-input-delta',
        'tool-input-end',
        'tool-call',
        'tool-error',
        'vision-call',
      ])
    );

    const response = await result.response;
    const toolBlocks = response.messages
      .flatMap((msg) => msg.content)
      .filter((block: any) => block.type === 'tool-call' && block.toolName?.includes('zai-vision'));

    expect(toolBlocks.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT
  );

  it(
    'executes a custom user-defined tool via the Anthropic-compatible API',
    async () => {
      enqueueScenario({
        parts: [
          { type: 'tool-call', toolName: 'echo_tool' },
          { type: 'tool-result', toolName: 'echo_tool' },
          { type: 'finish' },
        ],
        response: {
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'tool-result', toolName: 'echo_tool' }],
            },
          ],
        },
      });
      const provider = createZaiAnthropic();
      const tools = {
        echo_tool: {
          description: 'Echo text back for verification.',
          parameters: z.object({ text: z.string() }),
          execute: async ({ text }: { text: string }) => ({ echoed: text, length: text.length }),
        },
      };

      const result = streamText({
        model: provider(ANTHROPIC_HTTP_MODEL),
        tools,
        toolChoice: { type: 'tool', toolName: 'echo_tool' },
        messages: [
          {
            role: 'system',
            content: 'Call the echo_tool once with the text "custom_check" before answering.',
          },
          {
            role: 'user',
            content: 'Confirm the tool result.',
          },
        ],
      });

      const seen = new Set<string>();
      for await (const part of result.fullStream) {
        if (part.type.startsWith('tool')) {
          seen.add(part.type);
        }
      }

      expect(Array.from(seen)).toEqual(expect.arrayContaining(['tool-call', 'tool-result']));
      const response = await result.response;
      const toolBlock = response.messages
        .flatMap((msg) => msg.content)
        .find((block: any) => block.type === 'tool-result' && block.toolName === 'echo_tool');
      expect(toolBlock).toBeTruthy();
    },
    TEST_TIMEOUT
  );
});
