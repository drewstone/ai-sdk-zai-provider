## ai-sdk-zai-provider

Expert-friendly [Vercel AI SDK](https://sdk.vercel.ai/) provider for [Z.AI / GLM](https://docs.z.ai/devpack/tool/claude). It reuses the hardened [`ai-sdk-provider-claude-code`](https://github.com/ben-vargas/ai-sdk-provider-claude-code) transport, patches the Anthropic env vars that Z.AI expects, and wires the documented MCP servers automatically.

### Capabilities
- **Claude Code CLI** (`zaiClaudeCode` / `createZaiClaudeCode`): drop-in CLI parity with web-search, reader/WebFetch, and vision MCP servers enabled, including guardrails for custom tools.
- **Anthropic HTTP** (`zaiAnthropic` / `createZaiAnthropic`): deterministic HTTP surface for custom tools, hosted agents, and CI harnesses.
- **Force-only custom tools**: `forceCustomTools` helper simulates the assistant tool-call flow so the CLI only sees your tool.
- **Typed options**: env merging, model remaps, MCP/vision process control, and permission defaults are all surfaced via TypeScript.

### Install

```bash
npm install ai-sdk-zai-provider ai
# ensure ZAI_API_KEY is set in your shell or .env
```

### Usage

#### Claude Code + MCP flows
```ts
import { generateText } from 'ai';
import { zaiClaudeCode } from 'ai-sdk-zai-provider';

const result = await generateText({
  model: zaiClaudeCode('glm-4.6'),
  prompt: 'List three threat-modeling checks we should automate.',
});
```

#### HTTP + deterministic custom tools
```ts
import { streamText } from 'ai';
import { zaiAnthropic } from 'ai-sdk-zai-provider';

const result = streamText({
  model: zaiAnthropic(process.env.ZAI_HTTP_MODEL ?? 'claude-3-5-sonnet-20241022'),
  tools: { /* Anthropic-style tool map */ },
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Summarize the latest GLM release.' },
  ],
});
```
> Z.AI’s HTTP proxy currently routes Claude-compatible ids. Override `ZAI_HTTP_MODEL` or pass `glmFallbackModel`/`false` to `createZaiAnthropic` when the v2 GLM HTTP endpoint lands.

### createZaiClaudeCode overview
```ts
import { createZaiClaudeCode } from 'ai-sdk-zai-provider';

const provider = createZaiClaudeCode({
  anthropicBaseUrl: 'https://api.z.ai/api/anthropic',
  includeDefaultAllowedTools: true,
  enableWebSearchMcp: true,
  enableWebReaderMcp: true,
  enableVisionMcp: true,
  customToolsOnly: {
    allowedTools: ['echo_tool'],
    appendSystemPrompt: 'Do not call Bash/Task.',
  },
});

const model = provider('glm-4.6');
```
Every model inherits:
- Z.AI env vars (`ANTHROPIC_*`, `API_TIMEOUT_MS`, per-alias mappings).
- Claude Code default tools + optional MCP tool ids (`mcp__web-search-prime__webSearchPrime`, `mcp__web-reader__webReader`, `WebFetch`, `mcp__zai-vision__*`).
- MCP definitions pointing at the Z.AI endpoints or the stdio `@z_ai/mcp-server`. Override `visionCommand` to use a different runner.
- `permissionMode: 'bypassPermissions'` unless overridden.

### Streaming & telemetry parity
- Emits the same stream structure (`start`, `text-delta`, `tool-input-*`, `tool-call`, `tool-result`, `finish`).
- `result.usage` and `result.providerMetadata['claude-code']` stay intact for billing/analytics.
- HTTP provider mirrors CLI blocks so swapping surfaces doesn’t require schema changes.

### Tests
```bash
npm test                 # unit + mocked integration suites (requires ZAI_API_KEY)
npm run test:integration # focus on the integration spec
```
Coverage includes env merging, MCP wiring, deterministic custom tools via HTTP, and stream-shape validation. All integration specs run against local fixtures—no flaky external dependencies.

### Custom tools

**HTTP (recommended)**
```ts
const tools = {
  repo_search: {
    description: 'Search GitHub repositories for a keyword.',
    parameters: z.object({ query: z.string() }),
    execute: async ({ query }) => {
      const res = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=3`);
      const data = await res.json();
      return data.items.map((repo) => ({ name: repo.full_name, stars: repo.stargazers_count }));
    },
  },
};

const result = streamText({
  model: zaiAnthropic(process.env.ZAI_HTTP_MODEL ?? 'claude-3-5-sonnet-20241022'),
  tools,
  messages: [{ role: 'system', content: 'Use repo_search exactly once before answering.' }],
});
```

**Claude Code guardrail mode**
```ts
import { createZaiClaudeCode, forceCustomTools } from 'ai-sdk-zai-provider';

const provider = createZaiClaudeCode({
  customToolsOnly: { allowedTools: ['echo_tool'] },
  defaultSettings: { allowedTools: ['echo_tool'] },
});

const tools = {
  echo_tool: {
    description: 'Echo text back for verification.',
    parameters: z.object({ text: z.string() }),
    execute: async ({ text }, options) => ({ echoed: text, callId: options.toolCallId }),
  },
};

await forceCustomTools({
  model: provider('glm-4.6'),
  tools,
  toolName: 'echo_tool',
  toolInput: { text: 'custom_check' },
  messages: [{ role: 'user', content: 'Confirm the custom tool output.' }],
});
```
`forceCustomTools` runs your tool once, injects the `tool-call`/`tool-result`, and hands control back to the CLI model with Bash/Task disabled.

### License
MIT © 2024
