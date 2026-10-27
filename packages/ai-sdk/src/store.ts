// Where a conversation's Submilli session is remembered between requests.

/** The session a conversation runs its programs in. */
export interface StoredSession {
  id: string;
  /** The server it was opened on. */
  server: string;
  blueprint: string;
  /** The Blueprint variables it was opened with. Secrets are never stored. */
  variables: Record<string, string>;
  /** A fingerprint of the application tools it was opened with, when it has any. */
  tools?: string;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * Keeps each conversation's session, keyed by the application's conversation
 * id, so that later requests in the conversation reuse it.
 *
 * The default keeps sessions in this process's memory. An application that
 * serves a conversation from more than one process, as on serverless
 * platforms, stores them where its conversations live: a database row next
 * to the chat, or a key-value store.
 */
export interface SessionStore {
  get(conversationId: string): MaybePromise<StoredSession | undefined>;
  set(conversationId: string, session: StoredSession): MaybePromise<void>;
  delete(conversationId: string): MaybePromise<void>;
}

/** A `SessionStore` in this process's memory, holding at most `limit` conversations. */
export function memorySessionStore(limit = 10_000): SessionStore {
  const sessions = new Map<string, StoredSession>();
  return {
    get: (conversationId) => sessions.get(conversationId),
    set: (conversationId, session) => {
      sessions.delete(conversationId);
      sessions.set(conversationId, session);
      for (const oldest of sessions.keys()) {
        if (sessions.size <= limit) break;
        sessions.delete(oldest);
      }
    },
    delete: (conversationId) => {
      sessions.delete(conversationId);
    },
  };
}

// The store conversations share when the application names none.
export const defaultStore: SessionStore = memorySessionStore();
