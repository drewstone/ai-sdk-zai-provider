import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreMessage } from 'ai';

const streamTextMock = vi.fn();

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    streamText: streamTextMock,
  };
});

let forceCustomTools: typeof import('../src/index.js').forceCustomTools;

beforeAll(async () => {
  ({ forceCustomTools } = await import('../src/index.js'));
});

beforeEach(() => {
  streamTextMock.mockReset();
});

describe('forceCustomTools', () => {
  it('invokes the manual tool and injects the call/result blocks', async () => {
    const fakeResult = { id: 'result' };
    streamTextMock.mockReturnValue(fakeResult);
    const execute = vi.fn(async ({ text }: { text: string }) => ({ echoed: text }));
    const tools = {
      echo_tool: {
        description: 'Echo text',
        parameters: { text: 'string' } as any,
        execute,
      },
    };

    const messages: CoreMessage[] = [
      { role: 'system', content: 'be concise' },
      { role: 'user', content: 'run tool' },
    ];

    const result = await forceCustomTools({
      model: {} as any,
      tools,
      toolName: 'echo_tool',
      toolInput: { text: 'custom_check' },
      messages,
      acknowledgement: 'ack',
    });

    expect(result).toBe(fakeResult);
    expect(execute).toHaveBeenCalledWith(
      { text: 'custom_check' },
      expect.objectContaining({
        toolCallId: 'forced:echo_tool',
        messages,
      })
    );
    expect(streamTextMock).toHaveBeenCalledTimes(1);

    const callArgs = streamTextMock.mock.calls[0][0];
    expect(callArgs.model).toBeDefined();
    expect(callArgs.toolChoice).toEqual({ type: 'tool', toolName: 'echo_tool' });
    expect(callArgs.tools).toBe(tools);

    const finalMessage = callArgs.messages[callArgs.messages.length - 1];
    expect(finalMessage).toMatchObject({
      role: 'assistant',
    });
    expect(finalMessage.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool-call', toolName: 'echo_tool' }),
        expect.objectContaining({
          type: 'tool-result',
          toolName: 'echo_tool',
          result: { echoed: 'custom_check' },
        }),
        expect.objectContaining({ type: 'text', text: 'ack' }),
      ])
    );
  });

  it('throws when the requested tool is missing', async () => {
    await expect(
      forceCustomTools({
        model: {} as any,
        tools: {},
        toolName: 'missing' as never,
        toolInput: {},
        messages: [],
      })
    ).rejects.toThrow(/Tool "missing"/);
  });
});
