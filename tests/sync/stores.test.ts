// The store contract, the same over memory, SQLite (node:sqlite, a temp
// file) and IndexedDB (fake-indexeddb). SQLite's case runs only on Node
// 22.13 or later, which node:sqlite needs: the public export's CI runs this
// file on Node 20 too (package.json engines, >=20).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";

import {
  deleteIndexedDbStores,
  indexedDbStore,
  memoryStore,
  type SyncStore,
} from "../../src/sync/index.js";
import { sqliteStore } from "../../src/sync/sqlite.js";

const dir = mkdtempSync(join(tmpdir(), "rh-sync-store-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

/** Whether this Node has node:sqlite (22.13 or later), as sqliteStore checks. */
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
const hasNodeSqlite = major > 22 || (major === 22 && minor >= 13);

type Kind = [string, () => SyncStore, boolean];
const sqlite: Kind = ["sqlite", () => sqliteStore({ path: join(dir, "a.db") }), true];

const kinds: Kind[] = [
  [
    "memory",
    // One shared store, opened again: memory persists only within itself.
    (() => {
      const store = memoryStore({ shared: true });
      return () => store;
    })(),
    true,
  ],
  ...(hasNodeSqlite ? [sqlite] : []),
  [
    "indexeddb",
    (() => {
      const factory = new IDBFactory();
      return () => indexedDbStore({ indexedDB: factory });
    })(),
    true,
  ],
];

for (const [name, make] of kinds) {
  test(`${name}: rows, tombstones, groups, meta and the outbox persist and roll back`, async () => {
    const store = make();
    await store.open("w1");
    await store.transaction((tx) => {
      tx.putRow({
        entity: "issue",
        id: "a",
        rev: 1,
        row: { id: "a", t: 1 },
        group: "g1",
        shard: 0,
      });
      tx.putRow({ entity: "issue", id: "b", rev: 1, row: { id: "b" }, group: "g2", shard: 0 });
      tx.deleteRow("issue", "c", 4, "deleted");
      tx.setMeta("cursors", { layout: { g1: 1 }, seqs: { "g1/0": 3 } });
      tx.enqueue({ deviceSeq: 2, entryNonce: "n2", op: "{}", enqueuedAt: "t" });
      tx.enqueue({ deviceSeq: 1, entryNonce: "n1", op: "{}", enqueuedAt: "t" });
    });
    await assert.rejects(
      store.transaction((tx) => {
        tx.putRow({ entity: "issue", id: "z", rev: 1, row: {}, group: "g1", shard: 0 });
        throw new Error("abort");
      }),
    );
    await store.transaction((tx) => {
      tx.settle(2);
      tx.dropGroup("g2");
    });
    await store.close();
    const again = make();
    await again.open("w1");
    await again.transaction((tx) => {
      assert.deepEqual(tx.getRow("issue", "a")?.row, { id: "a", t: 1 });
      assert.equal(tx.getRow("issue", "b"), undefined);
      assert.equal(tx.getRow("issue", "z"), undefined);
      assert.deepEqual([tx.getRow("issue", "c")?.rev, tx.getRow("issue", "c")?.row], [4, null]);
      assert.deepEqual(tx.getMeta("cursors"), { layout: { g1: 1 }, seqs: { "g1/0": 3 } });
      assert.deepEqual(
        tx.outbox().map((e) => e.deviceSeq),
        [1],
      );
      assert.equal(Array.from(tx.rowsOf("issue")).length, 2);
    });
    await again.close();
  });
}

test("memory sends ephemeral; IndexedDB and SQLite are replicas", () => {
  assert.equal(memoryStore().deviceKind, "ephemeral");
  assert.equal(sqliteStore({ path: join(dir, "b.db") }).deviceKind, "replica");
  assert.equal(indexedDbStore().deviceKind, "replica");
});

test("deleteIndexedDbStores drops a name's copies, rows and outbox, and no other's", async () => {
  const factory = new IDBFactory();
  for (const [name, workspace] of [
    ["rh-tasks:ana", "w1"],
    ["rh-tasks:ana", "w2"],
    ["rh-tasks:bo", "w1"],
  ] as const) {
    const store = indexedDbStore({ name, indexedDB: factory });
    await store.open(workspace);
    await store.transaction((tx) => {
      tx.enqueue({ deviceSeq: 1, entryNonce: "n", op: "{}", enqueuedAt: "t" });
    });
    await store.close();
  }
  const deleted = await deleteIndexedDbStores({
    name: "rh-tasks:ana",
    workspaces: ["w1", "w3"],
    indexedDB: factory,
  });
  assert.deepEqual(deleted.sort(), ["rh-tasks:ana:w1", "rh-tasks:ana:w2", "rh-tasks:ana:w3"]);
  assert.deepEqual((await factory.databases()).map((d) => d.name).sort(), ["rh-tasks:bo:w1"]);
  const reopened = indexedDbStore({ name: "rh-tasks:ana", indexedDB: factory });
  await reopened.open("w1");
  assert.deepEqual(await reopened.transaction((tx) => tx.outbox()), []);
  await reopened.close();
});

test("an open IndexedDB copy lets go of its database when a sign-out deletes it", async () => {
  const factory = new IDBFactory();
  const store = indexedDbStore({ name: "rh-tasks:ana", indexedDB: factory });
  await store.open("w1");
  const deleted = deleteIndexedDbStores({ name: "rh-tasks:ana", indexedDB: factory });
  const timeout = new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 1000));
  assert.deepEqual(await Promise.race([deleted, timeout]), ["rh-tasks:ana:w1"]);
  await assert.rejects(
    store.transaction((tx) => tx.setMeta("k", 1)),
    /not open/,
  );
  await store.close();
});

test("an IndexedDB store closed while it opens lets go of what it opened", async () => {
  const factory = new IDBFactory();
  const store = indexedDbStore({ name: "rh-tasks:ana", indexedDB: factory });
  const opening = store.open("w1");
  await store.close();
  await assert.rejects(opening, /closed while it opened/);
  // Nothing holds it open: a delete with no versionchange to answer is not blocked.
  const deleted = deleteIndexedDbStores({ name: "rh-tasks:ana", indexedDB: factory });
  const timeout = new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 1000));
  assert.deepEqual(await Promise.race([deleted, timeout]), ["rh-tasks:ana:w1"]);
});
