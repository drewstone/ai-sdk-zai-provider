#!/usr/bin/env node
import { config as loadEnv } from 'dotenv';
import { streamText } from 'ai';
import { z } from 'zod';
import { zaiAnthropic } from '../dist/index.js';

loadEnv();

if (!process.env.ZAI_API_KEY) {
  console.error('Set ZAI_API_KEY before running this example.');
  process.exit(1);
}

const tools = {
  repo_search: {
    description: 'Search GitHub repositories for a keyword.',
    parameters: z.object({
      query: z.string(),
    }),
    execute: async ({ query }) => {
      const res = await fetch(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=3`
      );
      const data = await res.json();
      return {
        query,
        topResults: (data.items || []).map((repo) => ({
          name: repo.full_name,
          stars: repo.stargazers_count,
          url: repo.html_url,
        })),
      };
    },
  },
};

const httpModelId = process.env.ZAI_HTTP_MODEL ?? 'glm-4.6';

const result = streamText({
  model: zaiAnthropic(httpModelId),
  tools,
  messages: [
    {
      role: 'system',
      content: 'Use the repo_search tool exactly once before answering.',
    },
    {
      role: 'user',
      content: 'Find a few repos related to "zai sdk" and summarize them.',
    },
  ],
});

for await (const part of result.fullStream) {
  console.log(part);
}
