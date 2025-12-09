import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createZaiAnthropic, createZaiClaudeCode, zaiClaudeCode } from '../src/index.js';

const ORIGINAL_KEY = process.env.ZAI_API_KEY;

beforeEach(() => {
  process.env.ZAI_API_KEY = ORIGINAL_KEY;
});

afterEach(() => {
  process.env.ZAI_API_KEY = ORIGINAL_KEY;
  vi.restoreAllMocks();
});

describe('createZaiClaudeCode', () => {
  it('throws when API key is missing', () => {
    const original = process.env.ZAI_API_KEY;
    delete process.env.ZAI_API_KEY;
    expect(() => createZaiClaudeCode()).toThrow(/ZAI_API_KEY/);
    if (original) process.env.ZAI_API_KEY = original;
  });

  it('injects env overrides without MCP servers by default', () => {
    const provider = createZaiClaudeCode({
      apiKey: 'unit-key',
    });

    const model = provider('glm-4.6');
    const env = model.settings.env!;

    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('unit-key');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-4.6');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-4.6');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-4.5-air');

    expect(model.settings.allowedTools).toEqual(
      expect.arrayContaining([
        'mcp__web-search-prime__webSearchPrime',
        'mcp__web-reader__webReader',
        'WebFetch',
        'mcp__zai-vision__analyze_image',
      ])
    );
    expect(model.settings.mcpServers).toMatchObject({
      'web-search-prime': expect.any(Object),
      'web-reader': expect.any(Object),
      'zai-vision': expect.any(Object),
    });
  });

  it('prefers explicit apiKey option over ZAI_API_KEY env var', () => {
    process.env.ZAI_API_KEY = 'env-key';
    const provider = createZaiClaudeCode({
      apiKey: 'override-key',
    });
    const model = provider('glm-4.6');
    expect(model.settings.env?.ANTHROPIC_AUTH_TOKEN).toBe('override-key');
  });

  it('merges user overrides without clobbering defaults', () => {
    const provider = createZaiClaudeCode({
      apiKey: 'unit-key',
      anthropicBaseUrl: 'https://example.test/v1',
      timeoutMs: 42_000,
      modelMappings: { opus: 'glm-custom' },
      defaultSettings: {
        allowedTools: ['CustomTool'],
        env: {
          EXTRA_FLAG: 'true',
        },
        mcpServers: {
          'web-search-prime': {
            type: 'http',
            url: 'https://override',
          },
        },
      },
    });

    const model = provider('glm-custom');
    const env = model.settings.env!;

    expect(env.ANTHROPIC_BASE_URL).toBe('https://example.test/v1');
    expect(env.API_TIMEOUT_MS).toBe('42000');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-custom');
    expect(env.EXTRA_FLAG).toBe('true');

    expect(model.settings.allowedTools).toContain('CustomTool');
    expect(model.settings.mcpServers?.['web-search-prime']).toEqual({
      type: 'http',
      url: 'https://override',
    });
    expect(model.modelId).toBe('opus');
  });

  it('throws when requesting an unmapped model id', () => {
    const provider = createZaiClaudeCode({
      apiKey: 'unit-key',
    });
    expect(() => provider('glm-unknown' as string)).toThrow(/Unsupported model/);
  });

  it('supports disabling baked-in defaults', () => {
    const provider = createZaiClaudeCode({
      apiKey: 'unit-key',
      includeDefaultAllowedTools: false,
      enableWebReaderMcp: false,
      enableWebSearchMcp: false,
      enableVisionMcp: false,
      defaultSettings: {
        allowedTools: ['CustomTool'],
      },
    });

    const model = provider('glm-4.6');
    expect(model.settings.allowedTools).toEqual(['CustomTool']);
    expect(model.settings.mcpServers).toBeUndefined();
  });

  it('supports enabling MCP servers and custom vision command wiring', () => {
    const provider = createZaiClaudeCode({
      apiKey: 'unit-key',
      enableWebReaderMcp: true,
      enableWebSearchMcp: true,
      enableVisionMcp: true,
      visionCommand: {
        command: 'pnpm',
        args: ['exec', 'zai-mcp'],
        env: {
          REGION: 'us',
        },
      },
    });

    const model = provider('glm-4.5-air');
    expect(Object.keys(model.settings.mcpServers ?? {})).toContain('web-search-prime');
    expect(Object.keys(model.settings.mcpServers ?? {})).toContain('web-reader');
    expect(model.settings.mcpServers?.['zai-vision']).toEqual({
      type: 'stdio',
      command: 'pnpm',
      args: ['exec', 'zai-mcp'],
      env: {
        Z_AI_API_KEY: 'unit-key',
        Z_AI_MODE: 'ZAI',
        REGION: 'us',
      },
    });
    expect(model.settings.allowedTools).toEqual(
      expect.arrayContaining([
        'mcp__web-search-prime__webSearchPrime',
        'mcp__web-reader__webReader',
        'WebFetch',
        'mcp__zai-vision__analyze_image',
      ])
    );
    expect(model.settings.mcpServers?.['zai-vision']).toMatchObject({
      env: expect.objectContaining({
        REGION: 'us',
        Z_AI_MODE: 'ZAI',
        Z_AI_API_KEY: 'unit-key',
      }),
    });
  });

  it('respects user-supplied permissionMode defaults', () => {
    const provider = createZaiClaudeCode({
      apiKey: 'unit-key',
      defaultSettings: {
        permissionMode: 'default',
      },
    });

    const model = provider('glm-4.6');
    expect(model.settings.permissionMode).toBe('default');
  });

  it('supports the custom-tools-only guardrail mode', () => {
    const provider = createZaiClaudeCode({
      apiKey: 'unit-key',
      customToolsOnly: {
        allowedTools: ['CustomTool'],
        disallowedTools: ['Read'],
        systemPrompt: 'Only call CustomTool.',
        appendSystemPrompt: 'Do not call Bash.',
      },
      defaultSettings: {
        allowedTools: ['AnotherTool'],
      },
    });

    const model = provider('glm-4.6');
    expect(model.settings.allowedTools).toEqual(['CustomTool', 'AnotherTool']);
    expect(model.settings.disallowedTools).toBeUndefined();
    expect(model.settings.systemPrompt).toContain('Only call CustomTool.');
    expect(model.settings.appendSystemPrompt).toContain('Do not call Bash.');
    expect(model.settings.mcpServers).toBeUndefined();
  });
});

describe('zaiClaudeCode', () => {
  it('lazily resolves the provider using env vars', () => {
    process.env.ZAI_API_KEY = 'lazy-key';
    const model = zaiClaudeCode('glm-4.6');
    expect(model.settings.env?.ANTHROPIC_AUTH_TOKEN).toBe('lazy-key');
  });

  it('still accepts legacy Claude aliases for backwards compatibility', () => {
    const provider = createZaiClaudeCode({ apiKey: 'alias-key' });
    const model = provider('sonnet');
    expect(model.settings.env?.ANTHROPIC_AUTH_TOKEN).toBe('alias-key');
  });
});

describe('createZaiAnthropic', () => {
  it('remaps GLM SKUs to a Claude-compatible fallback by default', () => {
    const provider = createZaiAnthropic({
      apiKey: 'unit-key',
      glmFallbackModel: 'claude-4.5-sonnet-20241022',
    });
    const model = provider('glm-4.6');
    expect(model.modelId).toBe('claude-4.5-sonnet-20241022');
  });

  it('reads the fallback id from ZAI_HTTP_FALLBACK_MODEL when set', () => {
    const original = process.env.ZAI_HTTP_FALLBACK_MODEL;
    process.env.ZAI_HTTP_FALLBACK_MODEL = 'claude-4.5-sonnet-20241022';
    const provider = createZaiAnthropic({
      apiKey: 'unit-key',
    });
    const model = provider('glm-4.6');
    expect(model.modelId).toBe('claude-4.5-sonnet-20241022');
    if (original) {
      process.env.ZAI_HTTP_FALLBACK_MODEL = original;
    } else {
      delete process.env.ZAI_HTTP_FALLBACK_MODEL;
    }
  });

  it('throws when GLM SKUs are requested without a fallback', () => {
    const provider = createZaiAnthropic({
      apiKey: 'unit-key',
      glmFallbackModel: false,
    });
    expect(() => provider('glm-4.6')).toThrow(/Claude-compatible HTTP model/);
  });
});

  it('falls back to disallowed blocking when no allowlist is provided', () => {
    const provider = createZaiClaudeCode({
      apiKey: 'unit-key',
      customToolsOnly: {
        systemPrompt: 'Only use provided tools.',
      },
    });

    const model = provider('glm-4.6');
    expect(model.settings.allowedTools).toBeUndefined();
    expect(model.settings.disallowedTools).toEqual(expect.arrayContaining(['Bash(*)', 'Task(*)']));
  });
