## ai-sdk-zai-cc-provider

Drop-in [Vercel AI SDK](https://sdk.vercel.ai/) provider for [Z.AI / GLM](https://docs.z.ai/devpack/tool/claude) that reuses the battle-tested [`ai-sdk-provider-claude-code`](https://github.com/ben-vargas/ai-sdk-provider-claude-code) transport while automatically rewriting the Anthropic CLI env vars, MCP servers, and model mappings used in `tangle-tui` + `redteam`.

> **Provider split:** Use `zaiClaudeCode` for Claude Code CLI/MCP workflows (web-search, reader, vision). Use `zaiAnthropic` for pure HTTP/custom tool integrations where you control the prompts.

### Install

```bash
npm install ai-sdk-zai-cc-provider ai
# requires ZAI_API_KEY in your environment
# see .env.example for the variables we look for
```

### Quick start

```ts
import { z } from 'zod';
import { generateText } from 'ai';
import { zaiClaudeCode } from 'ai-sdk-zai-cc-provider';

// Pass actual GLM SKUs; the provider maps them to the right Claude Code target automatically.
const result = await generateText({
  model: zaiClaudeCode('glm-4.6'),
  prompt: 'List three threat-modeling checks we should automate.',
});

console.log(result.text);
```

Need a pure HTTP/Anthropic flow (ideal for custom tools and chat backends)?

```ts
import { streamText } from 'ai';
import { zaiAnthropic } from 'ai-sdk-zai-cc-provider';

const result = streamText({
  model: zaiAnthropic(process.env.ZAI_HTTP_MODEL ?? 'claude-3-5-sonnet-20241022'),
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Summarize the latest GLM release.' },
  ],
});
```

> The HTTP-compatible endpoint currently proxies Claude-compatible ids (default `claude-3-5-sonnet-20241022`). Set `ZAI_HTTP_MODEL` or pass `glmFallbackModel` to change the mapping once Z.AI ships the GLM v2 HTTP surface.

### Why this wrapper?

- Mirrors the environment + MCP wiring used in `../../webb/tangle-tui` and `../../webb/redteam` so GLM models behave identically to their Claude counterparts.
- Overrides `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, timeout, and per-model mappings so Claude Code routes every request to Z.AI without external scripts.
- Offers turnkey wiring for the web-search, reader, and vision MCP servers documented by Z.AI (including the stdio `@z_ai/mcp-server`) with a single flag.
- Provides an Anthropic-compatible provider (`zaiAnthropic`) for standard Vercel AI SDK workflows—perfect for deterministic custom tools, chat flows, or any HTTP-based integration.
- Fully typed API with Vitest coverage validating env + MCP merging logic.

### API

```ts
import { createZaiClaudeCode } from 'ai-sdk-zai-cc-provider';

const provider = createZaiClaudeCode({
  apiKey: process.env.ZAI_API_KEY, // optional when env var is set
  anthropicBaseUrl: 'https://api.z.ai/api/anthropic', // override if you proxy traffic
  timeoutMs: 240_000,
  modelMappings: {
    opus: 'glm-4.6-pro', // map Claude aliases to GLM SKUs
  },
  includeDefaultAllowedTools: true, // disable to provide your own allowlist
  enableWebSearchMcp: true, // disable to skip provisioning the HTTP MCP server
  enableWebReaderMcp: true,
  enableVisionMcp: true,
  visionCommand: {
    command: 'pnpm',
    args: ['exec', 'zai-mcp'],
    env: { REGION: 'us-west' },
  },
  defaultSettings: {
    allowedTools: ['Read', 'Graphviz'],
    env: { CUSTOM_FLAG: '1' },
  },
});

const model = provider('opus');
```

Every model created through this provider receives:

- `permissionMode: 'bypassPermissions'` unless you override it.
- `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `API_TIMEOUT_MS`, and `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL` env vars.
- The default Claude Code tool allowlist (`Bash`, `Read`, etc.) plus Z.AI's MCP-backed tools (web-search, web-reader/WebFetch, and vision) enabled out-of-the-box so everything works without extra wiring. Toggle the `enable*` flags if you need to opt out.
- Optional MCP wiring you can enable via the `enable*` flags (tool names are auto-added when enabled):
  - `web-search-prime` → `https://api.z.ai/api/mcp/web_search_prime/mcp`
  - `web-reader` → `https://api.z.ai/api/mcp/web_reader/mcp`
  - `zai-vision` → stdio driver (`npx -y @z_ai/mcp-server`) with `Z_AI_API_KEY` + `Z_AI_MODE`.

Pass `includeDefaultAllowedTools: false` or toggle the MCP booleans to opt in/out.

### Message types & streaming parity with Z.AI

Z.AI exposes the Anthropic-compatible `POST /api/anthropic/v1/messages` surface (see the `docs.z.ai` pages above). Running the included integration tests (see below) captures the same event stream you get in `tangle-tui`/`redteam`:

- **Streaming events**: `start`, `start-step`, `text-start`, `text-delta`, `text-end`, `tool-input-start`, `tool-input-delta`, `tool-input-end`, `tool-call`, `tool-result`, `tool-error`, `finish-step`, `finish`.
- **Assistant/tool content blocks**: `text`, `tool-call`, `tool-result` (including success + error payloads).
- **Usage + metadata**: `result.usage`, `result.providerMetadata['claude-code']` (raw Anthropic usage including `server_tool_use` counters).

Because Z.AI mirrors Anthropic's schema, you can still include other standard blocks (`image_url`, `input_text`, etc.) when interacting via the raw HTTP API. The Claude Code CLI surfaces the stream + block types above today, which is why this library focuses on them to maintain perfect parity with existing Z.AI automation flows. The integration tests cover:

1. Plain streaming text.
2. Built-in Claude WebSearch tool usage (still available as an alias to the MCP server).
3. MCP web-search invocation (`mcp__web-search-prime__webSearchPrime`).
4. MCP vision analysis (`mcp__zai-vision__analyze_image`), even when the upstream service returns an error payload.

### Tests

```bash
npm test                   # runs unit + integration suites (requires ZAI_API_KEY)
npm run test:integration   # integration-only focus when debugging MCP flows
```

Set `ZAI_API_KEY` (and optionally `ZAI_HTTP_MODEL`) in your shell or `.env` so the integration suite can talk to the live backend.

Vitest covers:

- API key validation + env merging.
- Tool allowlist + MCP wiring (unit tests).
- Streaming + MCP behavior against the live Z.AI backend (web search + vision analysis flows) plus deterministic custom-tool execution via the Anthropic-compatible provider.
- End-to-end logging can be captured with `npm run log:stream`, which writes the entire `fullStream` event trace (text deltas, tool calls, usage, provider metadata) to `logs/`.

### Custom tools

For deterministic tool behavior, prefer the Anthropic-compatible HTTP provider. The CLI path is optimized for Claude Code’s built-in tools/MCPs and ignores ad hoc tools unless you expose them via MCP or enable the custom-tools-only guardrails described below.

**HTTP (recommended)**

The `examples/custom-tool.mjs` script matches the deterministic integration test and respects the `ZAI_HTTP_MODEL` fallback:

```ts
const tools = {
  repo_search: {
    description: 'Search GitHub repositories for a keyword.',
    parameters: z.object({ query: z.string() }),
    execute: async ({ query }) => {
      const res = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=3`);
      const data = await res.json();
      return data.items.map(repo => ({ name: repo.full_name, stars: repo.stargazers_count }));
    },
  },
};

const result = streamText({
  model: zaiAnthropic(process.env.ZAI_HTTP_MODEL ?? 'claude-3-5-sonnet-20241022'),
  tools,
  messages: [{ role: 'system', content: 'Use repo_search exactly once before answering.' }],
});
```

Run it with:

```bash
npm run build
node examples/custom-tool.mjs
```

You’ll see tool-call/tool-result events in the stream plus a final answer that cites the GitHub repos. The integration suite also includes a deterministic custom tool test using `zaiAnthropic` to ensure this path stays green.

**Claude Code custom-tools-only mode**

When you must stay inside the CLI, enable `customToolsOnly` so Bash/Task are blocked, the built-in allowlist is stripped, and a guardrail prompt is injected. Pair it with the `forceCustomTools` helper to manually execute your tool and inject the resulting `tool-call`/`tool-result` blocks before resuming the conversation:

```ts
import { z } from 'zod';
import { createZaiClaudeCode, forceCustomTools } from 'ai-sdk-zai-cc-provider';

const provider = createZaiClaudeCode({
  customToolsOnly: {
    allowedTools: ['echo_tool'],
  },
  defaultSettings: {
    allowedTools: ['echo_tool'],
  },
});

const tools = {
  echo_tool: {
    description: 'Echo text back for verification.',
    parameters: z.object({ text: z.string() }),
    execute: async ({ text }) => ({ echoed: text }),
  },
};

const result = await forceCustomTools({
  model: provider('glm-4.6'),
  tools,
  toolName: 'echo_tool',
  toolInput: { text: 'custom_check' },
  messages: [{ role: 'user', content: 'Confirm the custom tool output.' }],
});
```

`forceCustomTools` simulates the manual assistant tool-call pattern used in the CLI, then hands the augmented transcript back to the model while keeping Bash/Task disabled. The helper fails fast when the model attempts to route outside of your provided tools so you can keep the CLI focused on the integration under test.

### License

MIT © 2024
