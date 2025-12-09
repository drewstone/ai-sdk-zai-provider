import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const ORIGINAL_KEY = process.env.ZAI_API_KEY;

beforeEach(() => {
  process.env.ZAI_API_KEY = ORIGINAL_KEY;
});

afterEach(() => {
  process.env.ZAI_API_KEY = ORIGINAL_KEY;
});

describe('package exports', () => {
  it('exposes the public API surface', async () => {
    const exports = await import('../src/index.js');

    expect(exports.createZaiClaudeCode).toBeDefined();
    expect(typeof exports.createZaiClaudeCode).toBe('function');
    expect(exports.zaiClaudeCode).toBeDefined();
    expect(typeof exports.zaiClaudeCode).toBe('function');
  });

  it('returns providers that behave like AI SDK providers', async () => {
    const { createZaiClaudeCode, zaiClaudeCode } = await import('../src/index.js');
    const provider = createZaiClaudeCode({ apiKey: 'unit-key' });

    const model = provider('glm-4.6');
    expect(model).toHaveProperty('settings');

    process.env.ZAI_API_KEY = 'lazy-key';
    const lazyModel = zaiClaudeCode.languageModel('glm-4.5-air', {
      env: { EXTRA: '1' },
    });
    expect(lazyModel.settings.env?.EXTRA).toBe('1');
  });
});
