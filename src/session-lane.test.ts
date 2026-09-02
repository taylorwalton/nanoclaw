import { describe, expect, it } from 'vitest';

import {
  ipcKeyFor,
  resumableSessionId,
  sessionKeyFor,
  shouldPersistSession,
} from './session-lane.js';
import type { RegisteredGroup } from './types.js';

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'CoPilot',
    folder: 'copilot',
    trigger: '',
    added_at: '2026-01-01T00:00:00.000Z',
    requiresTrigger: false,
    ...overrides,
  };
}

describe('sessionKeyFor', () => {
  it('defaults to the group folder', () => {
    expect(sessionKeyFor(makeGroup())).toBe('copilot');
  });

  it('uses sessionKey when set', () => {
    expect(
      sessionKeyFor(makeGroup({ sessionKey: 'copilot-investigate' })),
    ).toBe('copilot-investigate');
  });

  it('keeps lanes sharing a folder on separate keys', () => {
    const chat = makeGroup();
    const investigate = makeGroup({ sessionKey: 'copilot-investigate' });

    expect(chat.folder).toBe(investigate.folder);
    expect(sessionKeyFor(chat)).not.toBe(sessionKeyFor(investigate));
  });
});

describe('ipcKeyFor', () => {
  it('defaults to the group folder', () => {
    expect(ipcKeyFor(makeGroup())).toBe('copilot');
  });

  it('uses ipcKey when set', () => {
    expect(ipcKeyFor(makeGroup({ ipcKey: 'copilot-investigate' }))).toBe(
      'copilot-investigate',
    );
  });

  it('keeps concurrent lanes on separate IPC namespaces', () => {
    // Two containers resolving to the same IPC key would deliver one lane's
    // piped follow-up messages into the other lane's running agent.
    const chat = makeGroup();
    const investigate = makeGroup({ ipcKey: 'copilot-investigate' });

    expect(ipcKeyFor(chat)).not.toBe(ipcKeyFor(investigate));
  });
});

describe('shouldPersistSession', () => {
  it('persists by default', () => {
    expect(shouldPersistSession(makeGroup())).toBe(true);
  });

  it('does not persist for an ephemeral lane', () => {
    expect(shouldPersistSession(makeGroup({ ephemeralSession: true }))).toBe(
      false,
    );
  });

  it('persists when explicitly non-ephemeral', () => {
    expect(shouldPersistSession(makeGroup({ ephemeralSession: false }))).toBe(
      true,
    );
  });
});

describe('resumableSessionId', () => {
  const sessions = {
    copilot: 'chat-session-1',
    'copilot-investigate': 'stale-investigate-session',
  };

  it('resumes the session stored under the lane key', () => {
    expect(resumableSessionId(makeGroup(), sessions)).toBe('chat-session-1');
  });

  it('resumes nothing for an ephemeral lane, even with a stored session', () => {
    // A stored row must never resurrect an investigation's context — this is
    // the guard that keeps one alert's findings out of the next one.
    const group = makeGroup({
      sessionKey: 'copilot-investigate',
      ephemeralSession: true,
    });
    expect(resumableSessionId(group, sessions)).toBeUndefined();
  });

  it('resumes nothing when the lane has no stored session', () => {
    const group = makeGroup({ sessionKey: 'copilot-u-42' });
    expect(resumableSessionId(group, sessions)).toBeUndefined();
  });
});
