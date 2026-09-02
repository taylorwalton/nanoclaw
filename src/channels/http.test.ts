import { describe, expect, it, vi } from 'vitest';

import { isValidGroupFolder } from '../group-folder.js';
import { HttpChannel, laneJidForUser, normalizeUserId } from './http.js';
import type { ChannelOpts } from './registry.js';

const COPILOT_JID = 'http:copilot';
const INVESTIGATE_JID = 'http:copilot:investigate';

/** Minimal stand-in for the bits of http.ServerResponse the channel touches. */
function makeRes() {
  return {
    chunks: [] as string[],
    ended: false,
    writableEnded: false,
    write(chunk: string) {
      this.chunks.push(chunk);
      return true;
    },
    end() {
      this.ended = true;
      this.writableEnded = true;
    },
    on: vi.fn(),
    writeHead: vi.fn(),
  };
}

function makeOpts(overrides: Partial<ChannelOpts> = {}): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
    registerGroup: vi.fn(),
    clearSession: vi.fn().mockReturnValue(true),
    unregisterGroup: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

/**
 * A channel with a live registry, so lane registration is observable the way
 * the orchestrator sees it.
 */
function makeChannelWithRegistry() {
  const registry: Record<string, unknown> = {};
  const opts = makeOpts({
    registeredGroups: () => registry as never,
    registerGroup: vi.fn((jid: string, group: unknown) => {
      registry[jid] = group;
    }),
    unregisterGroup: vi.fn((jid: string) => delete registry[jid]),
  });
  const channel = new HttpChannel(opts);
  // connect() would bind a port; seed the template it captures instead.
  (channel as unknown as { baseGroup: unknown }).baseGroup = {
    name: 'CoPilot',
    folder: 'copilot',
    trigger: '',
    added_at: '2026-01-01T00:00:00.000Z',
    requiresTrigger: false,
    trustedSessionCommands: true,
  };
  return { channel, opts, registry };
}

/** Resolve a lane the way the POST /message handler does. */
function laneFor(
  channel: HttpChannel,
  userId: unknown,
  userName?: string,
): string {
  return (
    channel as unknown as {
      ensureUserLane: (id: string | null, name?: string) => string;
    }
  ).ensureUserLane(normalizeUserId(userId), userName);
}

/**
 * Queue a writer on a lane without standing up an HTTP server. The writer maps
 * are private; a test reaching into them is the cheapest way to exercise the
 * lifecycle methods in isolation.
 */
function enqueue(channel: HttpChannel, jid: string) {
  const res = makeRes();
  const resolve = vi.fn();
  const internals = channel as unknown as {
    pending: Map<string, Array<{ res: unknown; resolve: () => void }>>;
  };
  const queue = internals.pending.get(jid) ?? [];
  queue.push({ res, resolve });
  internals.pending.set(jid, queue);
  return { res, resolve };
}

/** Text payloads written to a fake response, with SSE framing stripped. */
function textEvents(res: ReturnType<typeof makeRes>): string[] {
  return res.chunks
    .map((c) => c.replace(/^data: /, '').trim())
    .map((c) => {
      try {
        return JSON.parse(c) as { type?: string; content?: string };
      } catch {
        return null;
      }
    })
    .filter((e): e is { type: string; content: string } => e?.type === 'text')
    .map((e) => e.content);
}

describe('HttpChannel writer isolation', () => {
  it('writes a lane response only to that lane’s writer', async () => {
    const channel = new HttpChannel(makeOpts());
    const chat = enqueue(channel, COPILOT_JID);
    const investigate = enqueue(channel, INVESTIGATE_JID);

    await channel.setTyping(COPILOT_JID, true);
    await channel.setTyping(INVESTIGATE_JID, true);

    await channel.sendMessage(COPILOT_JID, 'answer for the analyst');
    await channel.sendMessage(INVESTIGATE_JID, 'investigation report');

    expect(textEvents(chat.res)).toEqual(['answer for the analyst']);
    expect(textEvents(investigate.res)).toEqual(['investigation report']);
  });

  it('drops output for a lane with no writer instead of borrowing another', async () => {
    // The investigation lane normally has no SSE caller — its results reach
    // CoPilot through the MCP write-back tools. Before per-lane writers this
    // output was written into whichever chat stream happened to be current.
    const channel = new HttpChannel(makeOpts());
    const chat = enqueue(channel, COPILOT_JID);

    await channel.setTyping(COPILOT_JID, true);
    await channel.sendMessage(INVESTIGATE_JID, 'investigation report');

    expect(textEvents(chat.res)).toEqual([]);
    expect(chat.res.ended).toBe(false);
  });

  it('does not let one lane’s turn start steal another lane’s queued writer', async () => {
    const channel = new HttpChannel(makeOpts());
    const chat = enqueue(channel, COPILOT_JID);

    // An investigation starting must not dequeue the chat lane's writer.
    await channel.setTyping(INVESTIGATE_JID, true);
    await channel.sendMessage(COPILOT_JID, 'still waiting');

    expect(textEvents(chat.res)).toEqual([]);

    // …and the chat writer is still there for its own turn.
    await channel.setTyping(COPILOT_JID, true);
    await channel.sendMessage(COPILOT_JID, 'answer for the analyst');
    expect(textEvents(chat.res)).toEqual(['answer for the analyst']);
  });

  it('closes only the completing lane’s stream', async () => {
    const channel = new HttpChannel(makeOpts());
    const chat = enqueue(channel, COPILOT_JID);
    const investigate = enqueue(channel, INVESTIGATE_JID);

    await channel.setTyping(COPILOT_JID, true);
    await channel.setTyping(INVESTIGATE_JID, true);

    await channel.onTurnComplete(INVESTIGATE_JID);

    expect(investigate.res.ended).toBe(true);
    expect(investigate.resolve).toHaveBeenCalled();
    expect(chat.res.ended).toBe(false);
    expect(chat.resolve).not.toHaveBeenCalled();
  });

  it('serialises two callers on the same lane instead of interleaving them', async () => {
    const channel = new HttpChannel(makeOpts());
    const first = enqueue(channel, COPILOT_JID);
    const second = enqueue(channel, COPILOT_JID);

    await channel.setTyping(COPILOT_JID, true);
    await channel.sendMessage(COPILOT_JID, 'first answer');
    await channel.onTurnComplete(COPILOT_JID);

    await channel.setTyping(COPILOT_JID, true);
    await channel.sendMessage(COPILOT_JID, 'second answer');

    expect(textEvents(first.res)).toEqual(['first answer']);
    expect(textEvents(second.res)).toEqual(['second answer']);
  });
});

describe('HttpChannel lane ownership', () => {
  it('owns the chat lane and every sub-lane', () => {
    const channel = new HttpChannel(makeOpts());
    expect(channel.ownsJid(COPILOT_JID)).toBe(true);
    expect(channel.ownsJid(INVESTIGATE_JID)).toBe(true);
    expect(channel.ownsJid('http:copilot:u:42')).toBe(true);
  });

  it('does not own another channel’s JID', () => {
    const channel = new HttpChannel(makeOpts());
    expect(channel.ownsJid('webhook:copilot')).toBe(false);
    expect(channel.ownsJid('telegram:123')).toBe(false);
  });
});

describe('normalizeUserId', () => {
  it('accepts ids CoPilot actually issues', () => {
    expect(normalizeUserId(42)).toBe('42');
    expect(normalizeUserId('analyst-7')).toBe('analyst-7');
    expect(normalizeUserId('a_b-C9')).toBe('a_b-C9');
  });

  it('strips characters that would escape the key or path', () => {
    expect(normalizeUserId('../../etc/passwd')).toBe('etcpasswd');
    expect(normalizeUserId('a:b')).toBe('ab');
  });

  it('falls back to the anon lane rather than mangling into a neighbour', () => {
    expect(normalizeUserId('')).toBeNull();
    expect(normalizeUserId('   ')).toBeNull();
    expect(normalizeUserId('///')).toBeNull();
    expect(normalizeUserId(undefined)).toBeNull();
    expect(normalizeUserId(null)).toBeNull();
    expect(normalizeUserId({ id: 1 })).toBeNull();
  });

  it('bounds the length so the derived lane key stays a valid folder', () => {
    // `copilot-u-<id>` is used as both a session key and an IPC namespace, and
    // both resolvers reject anything over 64 characters. An unbounded id would
    // throw at container start rather than at parse time.
    const id = normalizeUserId('x'.repeat(200));
    expect(id).not.toBeNull();
    expect(isValidGroupFolder(`copilot-u-${id}`)).toBe(true);
  });

  it('keeps every accepted id inside a valid lane key', () => {
    for (const raw of ['42', 'analyst-7', 'a_b-C9', 'z'.repeat(300)]) {
      const id = normalizeUserId(raw);
      expect(id).not.toBeNull();
      expect(isValidGroupFolder(`copilot-u-${id}`)).toBe(true);
    }
  });
});

describe('per-user lanes', () => {
  it('registers a lane per user, cloned from the base group', () => {
    const { channel, registry } = makeChannelWithRegistry();

    const jid = laneFor(channel, '42', 'Dana');

    expect(jid).toBe(laneJidForUser('42'));
    expect(registry[jid]).toMatchObject({
      folder: 'copilot',
      sessionKey: 'copilot-u-42',
      ipcKey: 'copilot-u-42',
      trustedSessionCommands: true,
    });
  });

  it('gives two users separate sessions and IPC namespaces', () => {
    const { channel, registry } = makeChannelWithRegistry();

    const a = laneFor(channel, '1', 'Ana');
    const b = laneFor(channel, '2', 'Ben');

    expect(a).not.toBe(b);
    const laneA = registry[a] as { sessionKey: string; ipcKey: string };
    const laneB = registry[b] as { sessionKey: string; ipcKey: string };
    expect(laneA.sessionKey).not.toBe(laneB.sessionKey);
    expect(laneA.ipcKey).not.toBe(laneB.ipcKey);
    // …while still sharing every mount and prompt.
    expect((registry[a] as { folder: string }).folder).toBe(
      (registry[b] as { folder: string }).folder,
    );
  });

  it('registers a returning user once', () => {
    const { channel, opts } = makeChannelWithRegistry();

    laneFor(channel, '42', 'Dana');
    laneFor(channel, '42', 'Dana');
    laneFor(channel, '42', 'Dana');

    expect(opts.registerGroup).toHaveBeenCalledTimes(1);
  });

  it('routes a request with no user id to the shared anon lane', () => {
    const { channel, opts } = makeChannelWithRegistry();

    expect(laneFor(channel, undefined)).toBe(COPILOT_JID);
    expect(opts.registerGroup).not.toHaveBeenCalled();
  });

  it('does not deliver one user’s reply to another', () => {
    // The reported bug: two analysts chatting at once, and B receives A's
    // answer. Separate lanes mean separate writers, so it cannot happen.
    const { channel } = makeChannelWithRegistry();
    const ana = laneFor(channel, '1', 'Ana');
    const ben = laneFor(channel, '2', 'Ben');

    const anaRes = enqueue(channel, ana);
    const benRes = enqueue(channel, ben);

    return (async () => {
      await channel.setTyping(ana, true);
      await channel.setTyping(ben, true);

      await channel.sendMessage(ana, 'answer for Ana');
      await channel.sendMessage(ben, 'answer for Ben');

      expect(textEvents(anaRes.res)).toEqual(['answer for Ana']);
      expect(textEvents(benRes.res)).toEqual(['answer for Ben']);
    })();
  });

  it('owns every per-user lane it hands out', () => {
    const { channel } = makeChannelWithRegistry();
    expect(channel.ownsJid(laneFor(channel, 'analyst-7'))).toBe(true);
  });
});

describe('session reset scoping', () => {
  it('resets only the requesting user’s lane', () => {
    const { channel, opts } = makeChannelWithRegistry();
    laneFor(channel, '1', 'Ana');
    laneFor(channel, '2', 'Ben');

    // What POST /session/reset does for scope 'chat' with a user_id.
    opts.clearSession?.(laneJidForUser('1'));

    expect(opts.clearSession).toHaveBeenCalledTimes(1);
    expect(opts.clearSession).toHaveBeenCalledWith(laneJidForUser('1'));
    expect(opts.clearSession).not.toHaveBeenCalledWith(laneJidForUser('2'));
  });

  it('enumerates every user lane for a scope of all', () => {
    const { channel } = makeChannelWithRegistry();
    laneFor(channel, '1', 'Ana');
    laneFor(channel, '2', 'Ben');

    const lanes = (
      channel as unknown as { userLaneJids: () => string[] }
    ).userLaneJids();

    expect(lanes.sort()).toEqual(
      [laneJidForUser('1'), laneJidForUser('2')].sort(),
    );
  });
});

describe('idle lane sweep', () => {
  function sweep(channel: HttpChannel) {
    (channel as unknown as { sweepIdleLanes: () => void }).sweepIdleLanes();
  }

  function setLastSeen(channel: HttpChannel, jid: string, at: number) {
    (
      channel as unknown as { laneLastSeen: Map<string, number> }
    ).laneLastSeen.set(jid, at);
  }

  it('drops a lane that has gone quiet, releasing its session', () => {
    const { channel, opts, registry } = makeChannelWithRegistry();
    const jid = laneFor(channel, '1', 'Ana');

    setLastSeen(channel, jid, Date.now() - 48 * 60 * 60 * 1000);
    sweep(channel);

    expect(opts.clearSession).toHaveBeenCalledWith(jid);
    expect(opts.unregisterGroup).toHaveBeenCalledWith(jid);
    expect(registry[jid]).toBeUndefined();
  });

  it('keeps a recently active lane', () => {
    const { channel, opts } = makeChannelWithRegistry();
    laneFor(channel, '1', 'Ana');

    sweep(channel);

    expect(opts.clearSession).not.toHaveBeenCalled();
    expect(opts.unregisterGroup).not.toHaveBeenCalled();
  });

  it('never sweeps a lane with an open stream', () => {
    const { channel, opts } = makeChannelWithRegistry();
    const jid = laneFor(channel, '1', 'Ana');
    enqueue(channel, jid);

    setLastSeen(channel, jid, Date.now() - 48 * 60 * 60 * 1000);
    sweep(channel);

    expect(opts.clearSession).not.toHaveBeenCalled();
  });

  it('leaves the anon and investigation lanes alone', () => {
    const { channel, opts } = makeChannelWithRegistry();
    laneFor(channel, undefined);

    setLastSeen(channel, COPILOT_JID, 0);
    setLastSeen(channel, INVESTIGATE_JID, 0);
    sweep(channel);

    expect(opts.clearSession).not.toHaveBeenCalled();
  });
});
