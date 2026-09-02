import { describe, it, expect, vi } from 'vitest';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import type { NewMessage } from './types.js';
import type { SessionCommandDeps } from './session-commands.js';

describe('extractSessionCommand', () => {
  const trigger = /^@Andy\b/i;

  it('detects bare /compact', () => {
    expect(extractSessionCommand('/compact', trigger)).toBe('/compact');
  });

  it('detects /compact with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /compact', trigger)).toBe('/compact');
  });

  it('rejects /compact with extra text', () => {
    expect(extractSessionCommand('/compact now please', trigger)).toBeNull();
  });

  it('rejects partial matches', () => {
    expect(extractSessionCommand('/compaction', trigger)).toBeNull();
  });

  it('rejects regular messages', () => {
    expect(
      extractSessionCommand('please compact the conversation', trigger),
    ).toBeNull();
  });

  it('handles whitespace', () => {
    expect(extractSessionCommand('  /compact  ', trigger)).toBe('/compact');
  });

  it('is case-sensitive for the command', () => {
    expect(extractSessionCommand('/Compact', trigger)).toBeNull();
  });

  it('detects bare /new', () => {
    expect(extractSessionCommand('/new', trigger)).toBe('/new');
  });

  it('detects /new with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /new', trigger)).toBe('/new');
  });

  it('canonicalises /reset and /clear to /new', () => {
    expect(extractSessionCommand('/reset', trigger)).toBe('/new');
    expect(extractSessionCommand('/clear', trigger)).toBe('/new');
  });

  it('rejects an unknown slash command', () => {
    // Must fall through as an ordinary prompt, not be swallowed as a command.
    expect(extractSessionCommand('/deploy', trigger)).toBeNull();
  });
});

describe('isSessionCommandAllowed', () => {
  it('allows main group regardless of sender', () => {
    expect(isSessionCommandAllowed(true, false)).toBe(true);
  });

  it('allows trusted/admin sender (is_from_me) in non-main group', () => {
    expect(isSessionCommandAllowed(false, true)).toBe(true);
  });

  it('denies untrusted sender in non-main group', () => {
    expect(isSessionCommandAllowed(false, false)).toBe(false);
  });

  it('allows trusted sender in main group', () => {
    expect(isSessionCommandAllowed(true, true)).toBe(true);
  });

  it('allows an authenticated channel in a non-main group', () => {
    expect(isSessionCommandAllowed(false, false, true)).toBe(true);
  });

  it('still denies an unauthenticated channel in a non-main group', () => {
    expect(isSessionCommandAllowed(false, false, false)).toBe(false);
  });
});

function makeMsg(
  content: string,
  overrides: Partial<NewMessage> = {},
): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'group@test',
    sender: 'user@test',
    sender_name: 'User',
    content,
    timestamp: '100',
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<SessionCommandDeps> = {},
): SessionCommandDeps {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    runAgent: vi.fn().mockResolvedValue('success'),
    closeStdin: vi.fn(),
    advanceCursor: vi.fn(),
    formatMessages: vi.fn().mockReturnValue('<formatted>'),
    canSenderInteract: vi.fn().mockReturnValue(true),
    clearSession: vi.fn(),
    ...overrides,
  };
}

const trigger = /^@Andy\b/i;

describe('handleSessionCommand', () => {
  it('returns handled:false when no session command found', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('hello')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result.handled).toBe(false);
  });

  it('handles authorized /compact in main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('handles /new without running the agent', async () => {
    // Dropping the stored session id IS the whole operation — spending a
    // container run (and a full turn of tokens) on it would be waste.
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/new')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.clearSession).toHaveBeenCalledTimes(1);
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'New session started. Previous context cleared.',
    );
  });

  it('does not flush earlier messages into a context it is about to discard', async () => {
    const deps = makeDeps();
    await handleSessionCommand({
      missedMessages: [
        makeMsg('some earlier chatter', { timestamp: '50' }),
        makeMsg('/new', { timestamp: '100' }),
      ],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.formatMessages).not.toHaveBeenCalled();
    expect(deps.clearSession).toHaveBeenCalledTimes(1);
  });

  it('accepts /reset as an alias for /new', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/reset')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.clearSession).toHaveBeenCalledTimes(1);
  });

  it('allows /new from a trusted channel in a non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/new', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'copilot',
      triggerPattern: trigger,
      timezone: 'UTC',
      isTrustedChannel: true,
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.clearSession).toHaveBeenCalledTimes(1);
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'New session started. Previous context cleared.',
    );
  });

  it('denies /new from an untrusted channel in a non-main group', async () => {
    const deps = makeDeps();
    await handleSessionCommand({
      missedMessages: [makeMsg('/new', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(deps.clearSession).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
  });

  it('sends denial to interactable sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('silently consumes denied command when sender cannot interact', async () => {
    const deps = makeDeps({
      canSenderInteract: vi.fn().mockReturnValue(false),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('processes pre-compact messages before /compact', async () => {
    const deps = makeDeps();
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.formatMessages).toHaveBeenCalledWith([msgs[0]], 'UTC');
    // Two runAgent calls: pre-compact + /compact
    expect(deps.runAgent).toHaveBeenCalledTimes(2);
    expect(deps.runAgent).toHaveBeenCalledWith(
      '<formatted>',
      expect.any(Function),
    );
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('allows is_from_me sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: true })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('reports failure when command-stage runAgent returns error without streamed status', async () => {
    // runAgent resolves 'error' but callback never gets status: 'error'
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (prompt, onOutput) => {
        await onOutput({ status: 'success', result: null });
        return 'error';
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
    );
  });

  it('returns success:false on pre-compact failure with no output', async () => {
    const deps = makeDeps({ runAgent: vi.fn().mockResolvedValue('error') });
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: false });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to process'),
    );
  });
});
