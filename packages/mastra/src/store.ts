// Where a thread's Submilli session is remembered between agent runs.

import type { MastraMemory } from "@mastra/core/memory";

/** A run a person was asked to approve a call of, and the agent run that asked. */
export interface WaitingRun {
  executionId: string;
  /** Mastra's id for the agent run whose execute tool suspended on it. */
  agentRunId: string;
}

/** The session a thread runs its programs in. */
export interface StoredSession {
  id: string;
  /** The server it was opened on. */
  server: string;
  blueprint: string;
  /** The Blueprint variables it was opened with. Secrets are never stored. */
  variables: Record<string, string>;
  /** A fingerprint of the application tools it was opened with, when it has any. */
  tools?: string;
  /** Runs that wait on a person's approval through Mastra's suspend and resume. */
  waiting?: WaitingRun[];
}

type MaybePromise<T> = T | Promise<T>;

/**
 * Keeps each thread's session, keyed by its Mastra thread id, so that later
 * agent runs on the thread reuse it.
 *
 * By default the session is kept in the thread's own metadata, in the agent's
 * memory, so it survives restarts and is shared by every instance that shares
 * the storage. Without memory, it is kept in this process's memory.
 */
export interface SessionStore {
  get(threadId: string): MaybePromise<StoredSession | undefined>;
  set(threadId: string, session: StoredSession): MaybePromise<void>;
  delete(threadId: string): MaybePromise<void>;
}

/** A `SessionStore` in this process's memory, holding at most `limit` threads. */
export function memorySessionStore(limit = 10_000): SessionStore {
  const sessions = new Map<string, StoredSession>();
  return {
    get: (threadId) => sessions.get(threadId),
    set: (threadId, session) => {
      sessions.delete(threadId);
      sessions.set(threadId, session);
      for (const oldest of sessions.keys()) {
        if (sessions.size <= limit) break;
        sessions.delete(oldest);
      }
    },
    delete: (threadId) => {
      sessions.delete(threadId);
    },
  };
}

// The metadata key a thread's session is kept under.
const METADATA_KEY = "submilli";

// One store per memory, so that the per-store locks serialize a thread's writes.
const threadStores = new WeakMap<MastraMemory, SessionStore>();

/**
 * A `SessionStore` that keeps each thread's session in the thread's metadata,
 * under `submilli`, in `memory`'s storage. The thread must exist: Mastra saves
 * it when an agent run on it starts.
 */
export function threadSessionStore(memory: MastraMemory): SessionStore {
  let store = threadStores.get(memory);
  if (store) return store;
  const update = async (threadId: string, session: StoredSession | undefined): Promise<void> => {
    const thread = await memory.getThreadById({ threadId });
    if (!thread) {
      if (session === undefined) return;
      throw new Error(`thread '${threadId}' is not in the agent's memory, so its Submilli session cannot be kept`);
    }
    // Null, not a missing key, because storage adapters merge metadata on update.
    const metadata = { ...thread.metadata, [METADATA_KEY]: session ?? null };
    await memory.updateThread({ id: thread.id, title: thread.title ?? "", metadata });
  };
  store = {
    get: async (threadId) => {
      const thread = await memory.getThreadById({ threadId });
      const stored = thread?.metadata?.[METADATA_KEY];
      return isStoredSession(stored) ? stored : undefined;
    },
    set: (threadId, session) => update(threadId, session),
    delete: (threadId) => update(threadId, undefined),
  };
  threadStores.set(memory, store);
  return store;
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== "object" || value === null) return false;
  const session = value as Partial<StoredSession>;
  return typeof session.id === "string" && typeof session.server === "string" && typeof session.blueprint === "string";
}

// The store threads share when the agent has no memory and the application names none.
export const defaultStore: SessionStore = memorySessionStore();
