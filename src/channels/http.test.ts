import { describe, expect, it, vi } from 'vitest';

import { HttpChannel } from './http.js';
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

function makeOpts(): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
    registerGroup: vi.fn(),
    clearSession: vi.fn().mockReturnValue(true),
  };
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
