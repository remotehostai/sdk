// The browser store (app backends design 4.2): one IndexedDB database per
// workspace (and origin, which the browser gives), with object stores
// `rows` (key [entity, id], index `entity`), `meta` and `outbox`. The device
// key is a non-extractable CryptoKey kept by structured clone. Tabs share
// the database; one leader tab owns the socket (leader.ts).

import type { OutboxEntry, StoredRow, SyncStore } from "../types.js";
import { mirroredStore, Tables, type Backing, type Changes } from "./memory.js";

const VERSION = 1;

function done(req: IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function browserFactory(given?: IDBFactory): IDBFactory {
  const f = given ?? globalThis.indexedDB;
  if (!f)
    throw new Error(
      "indexedDbStore needs IndexedDB: use sqliteStore (@remotehost/sdk/sync/sqlite) or memoryStore outside a browser",
    );
  return f;
}

/**
 * Deletes the local copies `indexedDbStore({ name })` made, rows, device and
 * outbox: `<name>:<workspace>` for each workspace given, and every database
 * the browser lists under the name (where it can list them). For a person
 * signing out. Stop the clients over them first: a database another tab
 * holds open is deleted once that tab closes it. Resolves with the names.
 */
export async function deleteIndexedDbStores(options: {
  name?: string;
  workspaces?: string[];
  indexedDB?: IDBFactory;
}): Promise<string[]> {
  const f = browserFactory(options.indexedDB);
  const prefix = `${options.name ?? "rh-sync"}:`;
  const names = new Set((options.workspaces ?? []).map((w) => `${prefix}${w}`));
  const listed = await f.databases?.().catch(() => []);
  for (const { name } of listed ?? []) if (name?.startsWith(prefix)) names.add(name);
  await Promise.all([...names].map((name) => done(f.deleteDatabase(name))));
  return [...names];
}

export function indexedDbStore(options: { name?: string; indexedDB?: IDBFactory } = {}): SyncStore {
  let db: IDBDatabase | null = null;
  // Counts closes: an open that a close overtook lets go of what it opened.
  let closes = 0;
  const factory = () => browserFactory(options.indexedDB);
  const backing: Backing = {
    async load(workspace) {
      if (!db) {
        const closed = closes;
        const req = factory().open(`${options.name ?? "rh-sync"}:${workspace}`, VERSION);
        req.onupgradeneeded = () => {
          const d = req.result;
          const rows = d.createObjectStore("rows", { keyPath: ["entity", "id"] });
          rows.createIndex("entity", "entity");
          d.createObjectStore("meta");
          d.createObjectStore("outbox", { keyPath: "deviceSeq" });
        };
        const opened = (await done(req)) as IDBDatabase;
        // A delete of this copy (deleteIndexedDbStores, at a sign-out in
        // this tab or another) asks open connections to go: this one does,
        // rather than hold the delete up for as long as the page is open.
        opened.onversionchange = () => {
          opened.close();
          if (db === opened) db = null;
        };
        if (closed !== closes) {
          opened.close();
          throw new Error("the sync store was closed while it opened");
        }
        db = opened;
      }
      const tx = db.transaction(["rows", "meta", "outbox"], "readonly");
      const [rows, metaKeys, metaValues, outbox] = (await Promise.all([
        done(tx.objectStore("rows").getAll()),
        done(tx.objectStore("meta").getAllKeys()),
        done(tx.objectStore("meta").getAll()),
        done(tx.objectStore("outbox").getAll()),
      ])) as [StoredRow[], IDBValidKey[], unknown[], OutboxEntry[]];
      const t = new Tables();
      for (const r of rows) {
        let m = t.rows.get(r.entity);
        if (!m) t.rows.set(r.entity, (m = new Map()));
        m.set(r.id, r);
      }
      metaKeys.forEach((k, i) => t.meta.set(String(k), metaValues[i]));
      t.queue = outbox.sort((a, b) => a.deviceSeq - b.deviceSeq);
      return t;
    },
    async persist(changes: Changes) {
      if (!db) throw new Error("the sync store is not open");
      const tx = db.transaction(["rows", "meta", "outbox"], "readwrite");
      const rows = tx.objectStore("rows");
      for (const { entity, id, row } of changes.rows.values()) {
        if (row) rows.put(row);
        else rows.delete([entity, id]);
      }
      const meta = tx.objectStore("meta");
      for (const [k, v] of changes.meta) meta.put(v, k);
      if (changes.outbox) {
        const outbox = tx.objectStore("outbox");
        outbox.clear();
        for (const e of changes.outbox) outbox.put(e);
      }
      await finished(tx);
    },
    async close() {
      closes++;
      db?.close();
      db = null;
    },
  };
  return mirroredStore(backing, { deviceKind: "replica", keepsCryptoKeys: true, shared: true });
}
