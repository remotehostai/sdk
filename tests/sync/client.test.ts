// The client end to end against the in-process fake server: start, catch
// up, write optimistically, settle, and resume from the store's cursors.
import assert from "node:assert/strict";
import { test } from "node:test";

import { IDBFactory } from "fake-indexeddb";

import { checklist } from "../../src/sync/generated/checklist.js";
import {
  createSyncClient,
  deleteIndexedDbStores,
  indexedDbStore,
  memoryStore,
  type SyncStore,
} from "../../src/sync/index.js";
import { FakeServer, token, until } from "./fake.js";

test("start resolves live; a write shows at once, then confirmed; origin app on every op", async () => {
  const server = new FakeServer();
  const client = createSyncClient({
    url: "ws://fake/v1/connect",
    workspace: server.workspace,
    token,
    store: memoryStore(),
    backends: ["checklist"],
    webSocket: server.WebSocket,
  });
  await client.start();
  assert.equal(client.status, "live");
  const hello = server.sent("hello")[0]!;
  assert.equal(hello.params.schema_version, 1);
  assert.equal(hello.params.workspaces[0].device_kind, "ephemeral");
  assert.deepEqual(hello.params.workspaces[0].backends, ["checklist"]);

  const changes: unknown[] = [];
  client.records("checklist", "list").subscribe((c) => changes.push(c));
  const op = checklist.putList({ title: "Groceries" });
  const pending = client.write(op);
  assert.equal(
    client.records<{ title: string }>("checklist", "list").get(op.id)?.title,
    "Groceries",
  );
  const [outcome] = await pending;
  assert.equal(outcome!.status, "applied");
  const push = server.sent("push")[0]!;
  assert.equal(push.params.ops[0].origin, "app");
  assert.deepEqual(push.params.ops[0].op, op);
  await until(() => changes.some((c: any) => c.confirmed));
  assert.deepEqual(await client.pending(), []);
  await client.stop();
});

test("a restart resumes from the stored cursors and device", async () => {
  const server = new FakeServer();
  const store = memoryStore();
  const options = {
    url: "ws://fake/v1/connect",
    workspace: server.workspace,
    token,
    store,
    backends: ["checklist"],
    webSocket: server.WebSocket,
  };
  const a = createSyncClient(options);
  await a.start();
  await a.write(checklist.putList({ title: "One" }));
  await until(() => server.seq === 1);
  await until(() => a.records("checklist", "list").all().length === 1);
  await a.stop();
  const b = createSyncClient(options);
  await b.start();
  const hello = server.sent("hello").at(-1)!.params.workspaces[0];
  assert.equal(hello.device.id, server.deviceId);
  assert.equal(hello.cursors.seqs["g-ws/0"], 1);
  assert.equal(b.records("checklist", "list").all().length, 1);
  assert.ok(JSON.parse(Buffer.from(await b.cursor(), "base64url").toString()).seqs);
  await b.stop();
});

test("a stop while the store opens closes it once open, and the start ends without connecting", async () => {
  // REM-5489: a sign-out while a client is still starting must not leave
  // the copy open, or the sign-out's delete of it waits on the page.
  const server = new FakeServer();
  const inner = memoryStore();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const calls: string[] = [];
  const store: SyncStore = {
    ...inner,
    async open(workspace) {
      await gate;
      await inner.open(workspace);
      calls.push("opened");
    },
    async close() {
      calls.push("closed");
      await inner.close();
    },
  };
  const client = createSyncClient({
    url: "ws://fake/v1/connect",
    workspace: server.workspace,
    token,
    store,
    backends: ["checklist"],
    webSocket: server.WebSocket,
  });
  const starting = client.start();
  await client.stop();
  release();
  await starting;
  assert.deepEqual(calls, ["closed", "opened", "closed"]);
  assert.deepEqual(server.sent("hello"), []);
  assert.equal(client.status, "offline");
});

test("a sign-out's delete is not held up by a client stopped while its IndexedDB copy opened", async () => {
  const factory = new IDBFactory();
  const server = new FakeServer();
  const client = createSyncClient({
    url: "ws://fake/v1/connect",
    workspace: server.workspace,
    token,
    store: indexedDbStore({ name: "rh-tasks:ana", indexedDB: factory }),
    backends: ["checklist"],
    webSocket: server.WebSocket,
    leader: false,
  });
  const starting = client.start();
  await client.stop();
  await starting;
  const deleted = deleteIndexedDbStores({ name: "rh-tasks:ana", indexedDB: factory });
  const timeout = new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 1000));
  assert.deepEqual(await Promise.race([deleted, timeout]), [`rh-tasks:ana:${server.workspace}`]);
});
