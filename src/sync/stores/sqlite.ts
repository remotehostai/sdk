// The SQLite store (app backends design 4.2): `node:sqlite` (Node 22.13 or
// later), no native dependency, the same three tables. Loaded only through
// `@remotehost/sdk/sync/sqlite` with a dynamic import, so the browser entry
// never references `node:sqlite`. The device key is kept as a JWK (SQLite
// cannot hold a CryptoKey).

import type { SyncStore } from "../types.js";
import { mirroredStore, Tables, type Backing, type Changes } from "./memory.js";

/** The slice of `node:sqlite`'s `DatabaseSync` this store uses. */
interface Database {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): Array<Record<string, unknown>>;
  };
  close(): void;
}

const MIN = [22, 13] as const;
const SPEC = ["node", "sqlite"].join(":");

/** Node's version, read without Node's types: the entry's build has none. */
function nodeVersion(): string | undefined {
  return (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node;
}

async function openDatabase(path: string): Promise<Database> {
  const [major = 0, minor = 0] = (nodeVersion() ?? "0.0").split(".").map(Number);
  if (major < MIN[0] || (major === MIN[0] && minor < MIN[1])) {
    throw new Error(
      `sqliteStore needs Node ${MIN.join(".")} or later for node:sqlite (this is ${nodeVersion() ?? "not Node"}); use memoryStore instead`,
    );
  }
  const mod = (await import(/* @vite-ignore */ SPEC)) as {
    DatabaseSync: new (path: string) => Database;
  };
  return new mod.DatabaseSync(path);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rows (workspace TEXT NOT NULL, entity TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, row TEXT, grp TEXT NOT NULL, shard INTEGER NOT NULL, PRIMARY KEY (workspace, entity, id));
CREATE TABLE IF NOT EXISTS meta (workspace TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (workspace, key));
CREATE TABLE IF NOT EXISTS outbox (workspace TEXT NOT NULL, device_seq INTEGER NOT NULL, entry TEXT NOT NULL, PRIMARY KEY (workspace, device_seq));
`;

export function sqliteStore(options: { path: string } | { database: unknown }): SyncStore {
  let db: Database | null = null;
  let workspace = "";
  const backing: Backing = {
    async load(ws) {
      workspace = ws;
      if (!db) {
        db =
          "database" in options ? (options.database as Database) : await openDatabase(options.path);
        db.exec(SCHEMA);
      }
      const t = new Tables();
      for (const r of db
        .prepare("SELECT entity, id, rev, row, grp, shard FROM rows WHERE workspace = ?")
        .all(ws)) {
        const entity = String(r.entity);
        let m = t.rows.get(entity);
        if (!m) t.rows.set(entity, (m = new Map()));
        m.set(String(r.id), {
          entity,
          id: String(r.id),
          rev: Number(r.rev),
          row: r.row === null ? null : (JSON.parse(String(r.row)) as Record<string, unknown>),
          group: String(r.grp),
          shard: Number(r.shard),
        });
      }
      for (const r of db.prepare("SELECT key, value FROM meta WHERE workspace = ?").all(ws)) {
        t.meta.set(String(r.key), r.value === null ? null : JSON.parse(String(r.value)));
      }
      t.queue = db
        .prepare("SELECT entry FROM outbox WHERE workspace = ? ORDER BY device_seq")
        .all(ws)
        .map((r) => JSON.parse(String(r.entry)));
      return t;
    },
    async persist(changes: Changes) {
      if (!db) throw new Error("the sync store is not open");
      db.exec("BEGIN IMMEDIATE");
      try {
        const put = db.prepare(
          "INSERT OR REPLACE INTO rows (workspace, entity, id, rev, row, grp, shard) VALUES (?, ?, ?, ?, ?, ?, ?)",
        );
        const del = db.prepare("DELETE FROM rows WHERE workspace = ? AND entity = ? AND id = ?");
        for (const { entity, id, row } of changes.rows.values()) {
          if (row)
            put.run(
              workspace,
              entity,
              id,
              row.rev,
              row.row === null ? null : JSON.stringify(row.row),
              row.group,
              row.shard,
            );
          else del.run(workspace, entity, id);
        }
        const meta = db.prepare(
          "INSERT OR REPLACE INTO meta (workspace, key, value) VALUES (?, ?, ?)",
        );
        for (const [k, v] of changes.meta)
          meta.run(workspace, k, v === undefined ? null : JSON.stringify(v));
        if (changes.outbox) {
          db.prepare("DELETE FROM outbox WHERE workspace = ?").run(workspace);
          const ins = db.prepare(
            "INSERT INTO outbox (workspace, device_seq, entry) VALUES (?, ?, ?)",
          );
          for (const e of changes.outbox) ins.run(workspace, e.deviceSeq, JSON.stringify(e));
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    async close() {
      if (db && !("database" in options)) db.close();
      db = null;
    },
  };
  return mirroredStore(backing, { deviceKind: "replica", keepsCryptoKeys: false, shared: false });
}
