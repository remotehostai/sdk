// The sync client's public types (app backends design 4.1, 4.2).

import type { Declaration } from "./validate.js";
import type { Op, RefusalCode } from "./generated/protocol.js";

export type SyncOp = Op;

export type SyncStatus =
  "connecting" | "catching_up" | "live" | "offline" | "update_required" | "forbidden";

export interface RecordRow {
  id: string;
  [field: string]: unknown;
}

export type RecordChange<T> =
  | { kind: "upsert"; row: T; confirmed: boolean }
  | { kind: "delete"; id: string; confirmed: boolean };

export interface PendingWrite {
  deviceSeq: number;
  op: SyncOp;
  enqueuedAt: string;
}

export type WriteOutcome =
  | { status: "applied"; deviceSeq: number }
  | {
      status: "refused";
      deviceSeq: number;
      code: RefusalCode;
      reason?: string;
      field?: string;
      message: string;
      current?: unknown;
    };

/** A confirmed row as the server sent it, with where it lives. */
export interface StoredRow {
  /** The wire entity: a native name (`issue`) or `"<backend>.<type>"`. */
  entity: string;
  /** The row's key; a link row's two ids are joined by `/`. */
  id: string;
  rev: number;
  /** `null` for a tombstone (deleted or moved out). */
  row: Record<string, unknown> | null;
  group: string;
  shard: number;
}

/** One queued write (sync design 3.2, 3.4). */
export interface OutboxEntry {
  deviceSeq: number;
  entryNonce: string;
  /** The op's bytes as first encoded: hashed and sent verbatim (L8). */
  op: string;
  batch?: string;
  enqueuedAt: string;
}

export interface StoreTx {
  getRow(entity: string, id: string): StoredRow | undefined;
  putRow(row: StoredRow): void;
  deleteRow(entity: string, id: string, rev: number, state: "deleted" | "moved_out"): void;
  rowsOf(entity: string): Iterable<StoredRow>;
  /** Every row, live or tombstoned: what a client loads at start. */
  allRows(): Iterable<StoredRow>;
  /** Drops every row of `group`, or of every group: a `reset`. */
  dropGroup(group: string | null): void;
  getMeta(key: string): unknown;
  setMeta(key: string, value: unknown): void;
  outbox(): OutboxEntry[];
  enqueue(entry: OutboxEntry): void;
  settle(deviceSeq: number): void;
  /** Replaces the whole outbox: a reconcile's renumbering. */
  replaceOutbox(entries: OutboxEntry[]): void;
}

export interface SyncStore {
  /** `ephemeral` for a store that forgets on restart (memory). */
  readonly deviceKind: "replica" | "ephemeral";
  /** Whether a non-extractable `CryptoKey` survives in its meta (IndexedDB, memory). */
  readonly keepsCryptoKeys: boolean;
  /** Whether other tabs share it, so one leader tab must own the socket. */
  readonly shared: boolean;
  open(workspace: string): Promise<void>;
  transaction<T>(fn: (tx: StoreTx) => Promise<T> | T): Promise<T>;
  /** Reloads what another tab wrote (a shared store's follower). */
  refresh?(): Promise<void>;
  close(): Promise<void>;
}

export interface TokenGrant {
  token: string;
  /** A DPoP proof for the bound token, over the connect URL and the challenge nonce. */
  dpop?: (htu: string, nonce: string) => Promise<string>;
}

export interface SyncClientOptions {
  url: string;
  workspace: string;
  token: () => Promise<TokenGrant>;
  store: SyncStore;
  backends?: string[];
  scopes?: Array<{ kind: "team"; id: string }>;
  declarations?: Record<string, Declaration>;
  webSocket?: WebSocketLike;
  /** Multi-tab coordination for a shared store; defaults to the browser's. */
  leader?: LeaderEnvironment | false;
  /** The app's version, for `hello`. */
  appVersion?: string;
  /** For tests: the random source of backoff jitter and the clock. */
  random?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  now?: () => number;
}

export interface SyncClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly status: SyncStatus;
  onStatus(listener: (s: SyncStatus) => void): () => void;
  records<T = RecordRow>(backend: string, type: string): RecordSet<T>;
  write(ops: SyncOp[] | SyncOp, options?: { batch?: boolean }): Promise<WriteOutcome[]>;
  pending(): Promise<PendingWrite[]>;
  cursor(): Promise<string>;
  /** Narrows or widens what the client holds; groups no longer asked are dropped. */
  setScopes(scopes: Array<{ kind: "team"; id: string }> | undefined): Promise<void>;
  /** Whether this tab holds the socket (always, unless the store is shared). */
  readonly leader: boolean;
  /**
   * Who the service says is signed in (its welcome's subject: a person's
   * id), once this tab has been welcomed; null before, and in a tab that
   * does not hold the socket.
   */
  readonly subject: string | null;
}

export interface RecordSet<T> {
  get(id: string): T | undefined;
  all(filter?: (row: T) => boolean): T[];
  subscribe(listener: (change: RecordChange<T>) => void): () => void;
}

/** The WebSocket constructor the client opens; Node 22's global or the browser's. */
export interface WebSocketLike {
  new (
    url: string,
    protocolsOrOptions?: string | string[] | { headers?: Record<string, string> },
  ): WebSocketInstance;
}

export interface WebSocketInstance {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "close" | "error" | "message",
    listener: (event: any) => void,
  ): void;
}

export interface LockManagerLike {
  request(
    name: string,
    options: { signal?: AbortSignal },
    callback: (lock: unknown) => Promise<void>,
  ): Promise<void>;
}

export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  close(): void;
}

export interface LeaderEnvironment {
  locks: LockManagerLike;
  channel: (name: string) => BroadcastChannelLike;
}
