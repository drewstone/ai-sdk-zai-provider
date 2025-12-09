import {
  createClaudeCode,
  type ClaudeCodeProvider,
  type ClaudeCodeProviderSettings,
  type ClaudeCodeSettings,
} from 'ai-sdk-provider-claude-code';
import { createAnthropic } from '@ai-sdk/anthropic';
import { streamText, type CoreMessage, type InferToolInput, type LanguageModel, type ToolSet } from 'ai';

type ClaudeModelAlias = 'sonnet' | 'opus' | 'haiku';

const CLAUDE_ALIASES = new Set<ClaudeModelAlias>(['sonnet', 'opus', 'haiku']);

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic';
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_CUSTOM_TOOLS_SYSTEM_PROMPT =
  'You are running inside the Claude Code CLI with only custom developer-provided tools available. NEVER call Bash, Task, Shell, or any CLI tool; those calls will fail. Only use the explicitly provided tools and wait for a user tool_result before responding.';
const DEFAULT_CUSTOM_TOOLS_DISALLOWED = ['Bash(*)', 'Task(*)'];
const DEFAULT_HTTP_COMPAT_MODEL = 'claude-4.5-sonnet-20241022';
const GLM_HTTP_PATTERN = /^glm-/i;

const DEFAULT_MODEL_MAPPINGS: Record<ClaudeModelAlias, string> = {
  sonnet: 'glm-4.6',
  opus: 'glm-4.6',
  haiku: 'glm-4.5-air',
};

const CORE_ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'LS',
  'Grep',
  'Glob',
  'TodoRead',
  'TodoWrite',
] as const;

const WEB_SEARCH_ALLOWED_TOOLS = ['mcp__web-search-prime__webSearchPrime'] as const;
const WEB_READER_ALLOWED_TOOLS = ['mcp__web-reader__webReader', 'WebFetch'] as const;
const VISION_ALLOWED_TOOLS = [
  // Vision MCP exposed two naming conventions across different TUI builds, so keep both
  'mcp__zai-vision__image_analysis',
  'mcp__zai-vision__video_analysis',
  'mcp__zai-vision__analyze_image',
  'mcp__zai-vision__analyze_video',
] as const;

const WEB_SEARCH_SERVER = 'https://api.z.ai/api/mcp/web_search_prime/mcp';
const WEB_READER_SERVER = 'https://api.z.ai/api/mcp/web_reader/mcp';

interface VisionCommand {
  command: string;
  args?: string[];
  env?: Record<string, string | undefined>;
}

export interface CustomToolsOnlyOptions {
  /**
   * Override the default guardrail prompt injected in CLI custom-tool mode.
   */
  systemPrompt?: string;
  /**
   * Append additional guidance to the guardrail prompt.
   */
  appendSystemPrompt?: string;
  /**
   * Base allowlist that replaces the builtin CLI tools.
   */
  allowedTools?: string[];
  /**
   * Extra tools to block alongside Bash/Task when in custom mode.
   */
  disallowedTools?: string[];
}

export interface CreateZaiClaudeCodeOptions extends ClaudeCodeProviderSettings {
  /**
   * API key for Z.AI. Falls back to process.env.ZAI_API_KEY.
   */
  apiKey?: string;
  /**
   * Anthropic-compatible base URL exposed by Z.AI.
   * The CLI expects the v1 suffix to be omitted.
   * @default 'https://api.z.ai/api/anthropic'
   */
  anthropicBaseUrl?: string;
  /**
   * Timeout for the Claude Code agent in milliseconds.
   * Injected via API_TIMEOUT_MS.
   * @default 300000
   */
  timeoutMs?: number;
  /**
   * Override GLM model mappings for Claude aliases.
   */
  modelMappings?: Partial<Record<ClaudeModelAlias, string>>;
  /**
   * When false, do not append the baked-in Z.AI tool allowlist.
   * @default true
   */
  includeDefaultAllowedTools?: boolean;
  /**
   * Enable/disable the built-in MCP servers.
   * @default true
   */
  enableWebSearchMcp?: boolean;
  /**
   * Enable/disable the built-in web-reader MCP server.
   * @default true
   */
  enableWebReaderMcp?: boolean;
  /**
   * Enable/disable the Z.AI stdio vision MCP server.
   * @default true
   */
  enableVisionMcp?: boolean;
  /**
   * Customize how the stdio vision MCP server is spawned.
   * @default { command: 'npx', args: ['-y', '@z_ai/mcp-server'] }
   */
  visionCommand?: VisionCommand;
  /**
   * Enable a custom-tools-only mode that strips CLI built-ins, blocks Bash/Task,
   * and injects a strong guardrail prompt.
   */
  customToolsOnly?: boolean | CustomToolsOnlyOptions;
}

/**
 * Create a Claude Code provider that is pre-configured for Z.AI / GLM.
 */
export function createZaiClaudeCode(options: CreateZaiClaudeCodeOptions = {}): ClaudeCodeProvider {
  const apiKey = options.apiKey ?? process.env.ZAI_API_KEY;
  if (!apiKey) {
    throw new Error('ZAI_API_KEY is required. Pass options.apiKey or set the env var.');
  }

  const anthropicBaseUrl = options.anthropicBaseUrl ?? DEFAULT_ANTHROPIC_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const modelMappings: Record<ClaudeModelAlias, string> = {
    ...DEFAULT_MODEL_MAPPINGS,
    ...options.modelMappings,
  };
  const customToolsOnly = normalizeCustomToolsOnlyOptions(options.customToolsOnly);

  let includeDefaultTools = options.includeDefaultAllowedTools ?? true;
  let enableWebSearch = options.enableWebSearchMcp ?? true;
  let enableWebReader = options.enableWebReaderMcp ?? true;
  let enableVision = options.enableVisionMcp ?? true;

  if (customToolsOnly.enabled) {
    includeDefaultTools = false;
    enableWebSearch = false;
    enableWebReader = false;
    enableVision = false;
  }

  const userDefaults = options.defaultSettings ?? {};
  const baselineAllowedTools = customToolsOnly.enabled
    ? customToolsOnly.allowedTools
    : [
        ...(includeDefaultTools ? CORE_ALLOWED_TOOLS : []),
        ...(enableWebSearch ? WEB_SEARCH_ALLOWED_TOOLS : []),
        ...(enableWebReader ? WEB_READER_ALLOWED_TOOLS : []),
        ...(enableVision ? VISION_ALLOWED_TOOLS : []),
      ];
  const allowedTools = mergeAllowedTools(baselineAllowedTools, userDefaults.allowedTools);
  const shouldApplyDisallowed = customToolsOnly.enabled ? !allowedTools?.length : true;
  const disallowedTools = shouldApplyDisallowed
    ? mergeStringLists(
        customToolsOnly.enabled ? customToolsOnly.disallowedTools : [],
        userDefaults.disallowedTools
      )
    : undefined;
  const systemPrompt = customToolsOnly.enabled
    ? customToolsOnly.systemPrompt ?? userDefaults.systemPrompt ?? DEFAULT_CUSTOM_TOOLS_SYSTEM_PROMPT
    : userDefaults.systemPrompt;
  const appendSystemPrompt = customToolsOnly.enabled
    ? mergeSystemPromptAppend(customToolsOnly.appendSystemPrompt, userDefaults.appendSystemPrompt)
    : userDefaults.appendSystemPrompt;

  const resolvedSettings: ClaudeCodeSettings = {
    ...userDefaults,
    permissionMode: userDefaults.permissionMode ?? 'bypassPermissions',
    allowedTools,
    disallowedTools,
    systemPrompt,
    appendSystemPrompt,
    env: {
      ...buildZaiEnv({ anthropicBaseUrl, apiKey, timeoutMs, modelMappings }),
      ...userDefaults.env,
    },
    mcpServers: mergeMcpServers({
      apiKey,
      enableVision,
      enableWebReader,
      enableWebSearch,
      userMcpServers: userDefaults.mcpServers,
      visionCommand: options.visionCommand,
    }),
  };

  const baseProvider = createClaudeCode({
    defaultSettings: resolvedSettings,
  });

  return wrapProviderWithModelResolution(baseProvider, modelMappings);
}

/**
 * Default provider instance that lazily resolves settings from env vars.
 */
export const zaiClaudeCode: ClaudeCodeProvider = createLazyDefaultProvider();

function mergeAllowedTools(
  defaults: readonly string[],
  user?: string[]
): string[] | undefined {
  const merged = [...defaults];
  if (user?.length) {
    for (const tool of user) {
      if (!tool || merged.includes(tool)) continue;
      merged.push(tool);
    }
  }
  return merged.length ? merged : undefined;
}

function mergeStringLists(defaults: readonly string[], user?: string[]): string[] | undefined {
  const merged = [...defaults];
  if (user?.length) {
    for (const entry of user) {
      if (!entry || merged.includes(entry)) continue;
      merged.push(entry);
    }
  }
  return merged.length ? merged : undefined;
}

function mergeSystemPromptAppend(
  customAppend?: string,
  userAppend?: string
): string | undefined {
  const parts = [customAppend, userAppend].filter((part): part is string => Boolean(part?.trim()));
  if (!parts.length) return undefined;
  return parts.join('\n\n');
}

interface BuildEnvArgs {
  anthropicBaseUrl: string;
  apiKey: string;
  timeoutMs: number;
  modelMappings: Record<ClaudeModelAlias, string>;
}

function buildZaiEnv({
  anthropicBaseUrl,
  apiKey,
  timeoutMs,
  modelMappings,
}: BuildEnvArgs): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: anthropicBaseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    API_TIMEOUT_MS: String(timeoutMs),
    ANTHROPIC_DEFAULT_SONNET_MODEL: modelMappings.sonnet,
    ANTHROPIC_DEFAULT_OPUS_MODEL: modelMappings.opus,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: modelMappings.haiku,
  };
}

interface NormalizedCustomToolsOnlyOptions {
  enabled: boolean;
  allowedTools: string[];
  disallowedTools: string[];
  systemPrompt?: string;
  appendSystemPrompt?: string;
}

function normalizeCustomToolsOnlyOptions(
  customToolsOnly?: boolean | CustomToolsOnlyOptions
): NormalizedCustomToolsOnlyOptions {
  if (!customToolsOnly) {
    return {
      enabled: false,
      allowedTools: [],
      disallowedTools: [],
    };
  }

  const options = customToolsOnly === true ? {} : customToolsOnly;
  return {
    enabled: true,
    allowedTools: options.allowedTools ?? [],
    disallowedTools: mergeStringLists(DEFAULT_CUSTOM_TOOLS_DISALLOWED, options.disallowedTools) ?? [],
    systemPrompt: options.systemPrompt,
    appendSystemPrompt: options.appendSystemPrompt,
  };
}

interface MergeMcpArgs {
  apiKey: string;
  enableWebSearch: boolean;
  enableWebReader: boolean;
  enableVision: boolean;
  userMcpServers?: ClaudeCodeSettings['mcpServers'];
  visionCommand?: VisionCommand;
}

function mergeMcpServers({
  apiKey,
  enableVision,
  enableWebReader,
  enableWebSearch,
  userMcpServers,
  visionCommand,
}: MergeMcpArgs): ClaudeCodeSettings['mcpServers'] {
  const defaults: NonNullable<ClaudeCodeSettings['mcpServers']> = {};

  if (enableWebSearch) {
    defaults['web-search-prime'] = {
      type: 'http',
      url: WEB_SEARCH_SERVER,
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    };
  }

  if (enableWebReader) {
    defaults['web-reader'] = {
      type: 'http',
      url: WEB_READER_SERVER,
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    };
  }

  if (enableVision) {
    const cmd = visionCommand ?? { command: 'npx', args: ['-y', '@z_ai/mcp-server'] };
    defaults['zai-vision'] = {
      type: 'stdio',
      command: cmd.command,
      args: cmd.args ?? ['-y', '@z_ai/mcp-server'],
      env: {
        Z_AI_API_KEY: apiKey,
        Z_AI_MODE: 'ZAI',
        ...cmd.env,
      },
    };
  }

  if (userMcpServers) {
    return {
      ...defaults,
      ...userMcpServers,
    };
  }

  return Object.keys(defaults).length ? defaults : undefined;
}

function wrapProviderWithModelResolution(
  baseProvider: ClaudeCodeProvider,
  mappings: Record<ClaudeModelAlias, string>
): ClaudeCodeProvider {
  const provider = ((modelId: string, settings?: ClaudeCodeSettings) =>
    baseProvider(resolveModelId(modelId, mappings), settings)) as ClaudeCodeProvider;

  provider.languageModel = (modelId, settings) =>
    baseProvider.languageModel(resolveModelId(modelId, mappings), settings);
  provider.chat = (modelId, settings) =>
    baseProvider.chat(resolveModelId(modelId, mappings), settings);
  provider.imageModel = baseProvider.imageModel.bind(baseProvider);
  provider.textEmbeddingModel = baseProvider.textEmbeddingModel.bind(baseProvider);

  return provider;
}

function resolveModelId(
  requestedId: string,
  mappings: Record<ClaudeModelAlias, string>
): ClaudeModelAlias {
  if (CLAUDE_ALIASES.has(requestedId as ClaudeModelAlias)) {
    return requestedId as ClaudeModelAlias;
  }

  for (const [alias, mappedId] of Object.entries(mappings) as Array<[ClaudeModelAlias, string]>) {
    if (mappedId === requestedId) {
      return alias;
    }
  }

  throw new Error(
    `Unsupported model "${requestedId}". Use one of ${Array.from(CLAUDE_ALIASES).join(
      ', '
    )} or provide a matching entry via modelMappings.`
  );
}

export type { ClaudeCodeProvider, ClaudeCodeProviderSettings, ClaudeCodeSettings };

function resolveAnthropicHttpModelId(requestedId: string, fallbackModel: string | false): string {
  if (!GLM_HTTP_PATTERN.test(requestedId)) {
    return requestedId;
  }

  if (fallbackModel === false) {
    throw new Error(
      `Model "${requestedId}" is only supported via the Claude Code CLI today. Pass a Claude-compatible HTTP model (e.g., ${DEFAULT_HTTP_COMPAT_MODEL}) or enable customToolsOnly with CLI workflows.`
    );
  }

  const resolved = fallbackModel || DEFAULT_HTTP_COMPAT_MODEL;
  if (!resolved) {
    throw new Error(
      `Unable to resolve an Anthropic-compatible HTTP model for "${requestedId}". Set options.glmFallbackModel or ZAI_HTTP_MODEL.`
    );
  }

  return resolved;
}

function createLazyDefaultProvider(): ClaudeCodeProvider {
  let inner: ClaudeCodeProvider | undefined;
  const ensure = () => {
    inner ??= createZaiClaudeCode();
    return inner;
  };

  const provider = ((modelId: Parameters<ClaudeCodeProvider>[0], settings?: Parameters<
    ClaudeCodeProvider
  >[1]) => ensure()(modelId, settings)) as ClaudeCodeProvider;

  provider.chat = (modelId, settings) => ensure().chat(modelId, settings);
  provider.languageModel = (modelId, settings) => ensure().languageModel(modelId, settings);
  provider.imageModel = (modelId) => ensure().imageModel(modelId);
  provider.textEmbeddingModel = (modelId) => ensure().textEmbeddingModel(modelId);

  return provider;
}

export interface CreateZaiAnthropicOptions {
  apiKey?: string;
  baseURL?: string;
  /**
   * Map GLM SKUs to a Claude-compatible HTTP model until the v2 endpoint ships.
   * Pass false to throw instead of remapping.
   */
  glmFallbackModel?: string | false;
}

export function createZaiAnthropic(options: CreateZaiAnthropicOptions = {}): (modelId: string) => LanguageModel {
  const apiKey = options.apiKey ?? process.env.ZAI_API_KEY;
  if (!apiKey) {
    throw new Error('ZAI_API_KEY is required. Pass options.apiKey or set the env var.');
  }

  const anthropic = createAnthropic({
    apiKey,
    baseURL: options.baseURL ?? `${DEFAULT_ANTHROPIC_BASE_URL}/v1`,
    headers: {
      'anthropic-version': '2023-06-01',
    },
  });

  const glmFallbackModel =
    options.glmFallbackModel ??
    process.env.ZAI_HTTP_FALLBACK_MODEL ??
    process.env.ZAI_HTTP_MODEL ??
    DEFAULT_HTTP_COMPAT_MODEL;

  return (modelId: string) =>
    anthropic(resolveAnthropicHttpModelId(modelId, glmFallbackModel)) as unknown as LanguageModel;
}

export const zaiAnthropic = createZaiAnthropic();

export interface ForceCustomToolsArgs<
  TOOLS extends ToolSet,
  NAME extends Extract<keyof TOOLS, string>
> {
  /**
   * Claude Code language model to invoke (CLI workflow).
   */
  model: LanguageModel;
  /**
   * Tool map shared with the AI SDK call.
   */
  tools: TOOLS;
  /**
   * Tool to invoke manually before handing context back to the model.
   */
  toolName: NAME;
  /**
   * Input passed to the tool execute function.
   */
  toolInput: InferToolInput<TOOLS[NAME]>;
  /**
   * Core message history to replay.
   */
  messages: CoreMessage[];
  /**
   * Optional acknowledgement inserted after the tool_result block.
   */
  acknowledgement?: string;
  /**
   * Override the guardrail system prompt used for the manual invocation.
   */
  systemPrompt?: string;
}

/**
 * Runs custom tools manually and injects the tool-call/tool-result content so the
 * Claude Code CLI stays focused on the provided tools instead of calling Bash/Task.
 */
export async function forceCustomTools<
  TOOLS extends ToolSet,
  NAME extends Extract<keyof TOOLS, string>
>({
  model,
  tools,
  toolName,
  toolInput,
  messages,
  acknowledgement = 'Tool call completed. Use the result above verbatim and do not attempt to call CLI tools.',
  systemPrompt,
}: ForceCustomToolsArgs<TOOLS, NAME>) {
  const tool = tools[toolName];
  if (!tool || typeof tool.execute !== 'function') {
    throw new Error(`Tool "${toolName}" is not defined or missing an execute handler.`);
  }

  const manualResult = await tool.execute(toolInput, {
    toolCallId: `forced:${toolName}`,
    messages,
  });
  const manualBlocks: any[] = [
    {
      type: 'tool-call',
      toolName,
      args: toolInput,
    },
    {
      type: 'tool-result',
      toolName,
      result: manualResult,
    },
  ];

  if (acknowledgement) {
    manualBlocks.push({
      type: 'text',
      text: acknowledgement,
    });
  }

  const augmentedMessages: CoreMessage[] = [
    {
      role: 'system',
      content: systemPrompt ?? DEFAULT_CUSTOM_TOOLS_SYSTEM_PROMPT,
    },
    ...messages,
    {
      role: 'assistant',
      content: manualBlocks,
    },
  ];

  return streamText({
    model,
    tools,
    toolChoice: { type: 'tool', toolName },
    messages: augmentedMessages,
  });
}
