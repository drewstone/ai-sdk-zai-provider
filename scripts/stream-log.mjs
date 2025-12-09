#!/usr/bin/env node
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import fs from 'fs';
import { streamText } from 'ai';

loadEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOG_DIR = process.env.ZAI_STREAM_LOG_DIR
  ? resolve(process.cwd(), process.env.ZAI_STREAM_LOG_DIR)
  : resolve(process.cwd(), 'logs');

const ensureDist = () => {
  const distPath = resolve(process.cwd(), 'dist', 'index.js');
  if (!fs.existsSync(distPath)) {
    console.error('Build output not found. Run `npm run build` before executing this script.');
    process.exit(1);
  }
};

ensureDist();

const { zaiClaudeCode } = await import('../dist/index.js');

if (!process.env.ZAI_API_KEY) {
  console.error('ZAI_API_KEY is required. Set it in your environment or .env file.');
  process.exit(1);
}

await fs.promises.mkdir(LOG_DIR, { recursive: true });
const logPath = join(LOG_DIR, `zai-stream-${Date.now()}.log`);
const logStream = fs.createWriteStream(logPath, { flags: 'w' });

const log = (type, payload) => {
  logStream.write(
    JSON.stringify({ ts: new Date().toISOString(), type, payload }, null, 0) + '\n'
  );
};

const messages = [
  { role: 'system', content: 'You are a concise assistant.' },
  {
    role: 'user',
    content:
      'List two GLM-4.6 release highlights and cite where you found them. Use the built-in WebSearch tool if you need fresh info.',
  },
];

log('meta', { message: 'Starting stream', logPath });

try {
  const result = streamText({
    model: zaiClaudeCode('glm-4.6'),
    messages,
  });

  for await (const part of result.fullStream) {
    log('event', part);
  }

  const response = await result.response;
  const usage = await result.usage;
  const providerMetadata = await result.providerMetadata;

  log('response', response);
  log('usage', usage);
  log('providerMetadata', providerMetadata);
  log('status', { success: true });
  console.log(`Streaming session logged to ${logPath}`);
} catch (error) {
  log('error', {
    message: error?.message,
    stack: error?.stack,
    name: error?.name,
  });
  console.error('Failed to stream text. See log for details:', logPath);
  process.exit(1);
} finally {
  logStream.end();
}
