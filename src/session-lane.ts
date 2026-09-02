import type { RegisteredGroup } from './types.js';

/**
 * Lane resolution.
 *
 * A lane is one addressable conversation: a JID that carries its own agent
 * session, its own IPC namespace, its own queue slot and its own outbound
 * writer. Several lanes may share a single group folder — same CLAUDE.md,
 * same prompts, same mounts — which is what lets the CoPilot channel run
 * chat and alert investigations as separate conversations without
 * duplicating any group content on disk.
 *
 * These helpers are deliberately pure: the storage they key into lives in
 * index.ts (in-memory cache) and db.ts (the sessions table).
 */

/** Storage key for a lane's agent session. Defaults to the group folder. */
export function sessionKeyFor(group: RegisteredGroup): string {
  return group.sessionKey ?? group.folder;
}

/**
 * IPC namespace for a lane's container. Defaults to the group folder.
 *
 * Two containers running concurrently must never resolve to the same key —
 * the IPC input directory is how follow-up messages reach a running agent,
 * so a shared key delivers one lane's messages to the other's container.
 */
export function ipcKeyFor(group: RegisteredGroup): string {
  return group.ipcKey ?? group.folder;
}

/**
 * Whether a lane stores its session between runs.
 *
 * Ephemeral lanes (alert investigations) do not: each run is self-contained,
 * writes its findings back through the MCP tools, and has nothing worth
 * carrying forward. Resuming them would both inflate every later turn with
 * raw SIEM documents and let one alert's context bleed into the next.
 */
export function shouldPersistSession(group: RegisteredGroup): boolean {
  return group.ephemeralSession !== true;
}

/** The session id a lane should resume, or undefined to start fresh. */
export function resumableSessionId(
  group: RegisteredGroup,
  sessions: Record<string, string>,
): string | undefined {
  if (!shouldPersistSession(group)) return undefined;
  return sessions[sessionKeyFor(group)];
}
