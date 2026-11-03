// The memory store: for scripts and tests. Nothing survives a restart, so
// its device is minted fresh each start as `device_kind: "ephemeral"`
// (app backends design 3.2, 4.2), which the service purges once idle.

import type { OutboxEntry, StoredRow, StoreTx, SyncStore } from "../types.js";

/** The three tables every store keeps, in memory: what IndexedDB and SQLite mirror too. */
export class Tables {
  rows = new Map<string, Map<string, StoredRow>>();
  meta = new Map<string, unknown>();
  queue: OutboxEntry[] = [];

  clone(): Tables {
    const t = new Tables();
    for (const [e, m] of this.rows) t.rows.set(e, new Map(m));
    t.meta = new Map(this.meta);
    t.queue = this.queue.slice();
    return t;
  }
}

/** What a transaction changed, for a store that writes it through (IndexedDB, SQLite). */
export interface Changes {
  /** Written rows by `rowKey`; `null` for a row dropped with its group. */
  rows: Map<string, { entity: string; id: string; row: StoredRow | null }>;
  meta: Map<string, unknown>;
  outbox: OutboxEntry[] | null;
}

export const rowKey = (entity: string, id: string) => `${entity}\u0000${id}`;

/** A transaction over `Tables`, recording what it changes. */
export function tablesTx(t: Tables, changes: Changes): StoreTx {
  const outboxChanged = () => {
    changes.outbox = t.queue;
  };
  return {
    getRow: (entity, id) => t.rows.get(entity)?.get(id),
    putRow(row) {
      let m = t.rows.get(row.entity);
      if (!m) t.rows.set(row.entity, (m = new Map()));
      m.set(row.id, row);
      changes.rows.set(rowKey(row.entity, row.id), { entity: row.entity, id: row.id, row });
    },
    deleteRow(entity, id, rev, _state) {
      const old = t.rows.get(entity)?.get(id);
      const row: StoredRow = {
        entity,
        id,
        rev,
        row: null,
        group: old?.group ?? "",
        shard: old?.shard ?? 0,
      };
      let m = t.rows.get(entity);
      if (!m) t.rows.set(entity, (m = new Map()));
      m.set(id, row);
      changes.rows.set(rowKey(entity, id), { entity, id, row });
    },
    rowsOf: (entity) => (t.rows.get(entity) ?? new Map<string, StoredRow>()).values(),
    *allRows() {
      for (const m of t.rows.values()) yield* m.values();
    },
    dropGroup(group) {
      for (const [entity, m] of t.rows) {
        for (const [id, r] of m) {
          if (group === null || r.group === group) {
            m.delete(id);
            changes.rows.set(rowKey(entity, id), { entity, id, row: null });
          }
        }
      }
    },
    getMeta: (key) => t.meta.get(key),
    setMeta(key, value) {
      t.meta.set(key, value);
      changes.meta.set(key, value);
    },
    outbox: () => t.queue.slice(),
    enqueue(entry) {
      t.queue = [...t.queue, entry];
      outboxChanged();
    },
    settle(deviceSeq) {
      t.queue = t.queue.filter((e) => e.deviceSeq !== deviceSeq);
      outboxChanged();
    },
    replaceOutbox(entries) {
      t.queue = entries.slice().sort((a, b) => a.deviceSeq - b.deviceSeq);
      outboxChanged();
    },
  };
}

export function emptyChanges(): Changes {
  return { rows: new Map(), meta: new Map(), outbox: null };
}

/** One writer at a time, in call order. */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/**
 * A store in memory. A transaction that throws leaves the tables as they
 * were. `shared: true` lets two clients in one process share it, as two
 * tabs share one IndexedDB database (for tests of the leader tab).
 */
export function memoryStore(options: { shared?: boolean } = {}): SyncStore {
  const byWorkspace = new Map<string, Tables>();
  let current: Tables | null = null;
  const serial = new Serial();
  return {
    deviceKind: "ephemeral",
    keepsCryptoKeys: true,
    shared: Boolean(options.shared),
    async open(workspace) {
      let t = byWorkspace.get(workspace);
      if (!t) byWorkspace.set(workspace, (t = new Tables()));
      current = t;
    },
    transaction(fn) {
      return serial.run(async () => {
        if (!current) throw new Error("the sync store is not open");
        const draft = current.clone();
        const result = await fn(tablesTx(draft, emptyChanges()));
        current.rows = draft.rows;
        current.meta = draft.meta;
        current.queue = draft.queue;
        return result;
      });
    },
    async close() {
      if (!options.shared) current = null;
    },
  };
}

/** Where a mirrored store writes through: IndexedDB or SQLite. */
export interface Backing {
  load(workspace: string): Promise<Tables>;
  /** Writes one transaction's changes atomically; a throw leaves the mirror as it was. */
  persist(changes: Changes): Promise<void>;
  close(): Promise<void>;
}

/**
 * A store that keeps the tables in memory for synchronous reads and writes
 * each transaction through to `backing` before the mirror takes it.
 */
export function mirroredStore(
  backing: Backing,
  traits: Pick<SyncStore, "deviceKind" | "keepsCryptoKeys" | "shared">,
): SyncStore {
  let current: Tables | null = null;
  let workspace: string | null = null;
  const serial = new Serial();
  return {
    ...traits,
    async open(ws) {
      workspace = ws;
      current = await backing.load(ws);
    },
    transaction(fn) {
      return serial.run(async () => {
        if (!current) throw new Error("the sync store is not open");
        const draft = current.clone();
        const changes = emptyChanges();
        const result = await fn(tablesTx(draft, changes));
        if (changes.rows.size || changes.meta.size || changes.outbox)
          await backing.persist(changes);
        current = draft;
        return result;
      });
    },
    refresh() {
      return serial.run(async () => {
        if (workspace !== null) current = await backing.load(workspace);
      });
    },
    async close() {
      current = null;
      await backing.close();
    },
  };
}
