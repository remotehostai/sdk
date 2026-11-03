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

test("a hello the service refuses ends start() with the refusal, never sitting connecting (REM-5490)", async () => {
  const server = new FakeServer({
    refuseHello: (w) =>
      w.backends?.includes("checklist")
        ? { field: "backends", message: 'this copy does not serve backend "checklist"' }
        : null,
  });
  const statuses: string[] = [];
  const client = createSyncClient({
    url: "ws://fake/v1/connect",
    workspace: server.workspace,
    token,
    store: memoryStore(),
    backends: ["checklist"],
    webSocket: server.WebSocket,
  });
  client.onStatus((s) => statuses.push(s));
  await assert.rejects(
    client.start(),
    /sync hello refused: invalid \{field: backends\}: .*checklist/,
  );
  assert.equal(client.status, "refused");
  assert.deepEqual(client.refusal, {
    code: "invalid",
    field: "backends",
    message: 'this copy does not serve backend "checklist"',
  });
  assert.ok(!statuses.includes("live"), statuses.join(","));
  assert.equal(server.socket.readyState, 3, "the client closed its socket");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(server.sockets.length, 1, "and does not connect again");
  assert.equal(server.sent("hello").length, 1);
  await client.stop();
  assert.equal(client.refusal, null);
});

test("a record's json and bool fields arrive as JSON values and survive a reload (REM-5490)", async () => {
  const factory = new IDBFactory();
  const server = new FakeServer();
  const id = "0190f6b0-0000-7000-8000-000000000001";
  const row = {
    id,
    list_id: "0190f6b0-0000-7000-8000-000000000002",
    text: "Milk",
    done: true,
    meta: { tags: ["a", "b"], n: 1.5, nested: { ok: false } },
  };
  server.rows.set(`checklist.item/${id}`, { entity: "checklist.item", id, rev: 1, row });
  server.seq = 1;
  const options = {
    url: "ws://fake/v1/connect",
    workspace: server.workspace,
    token,
    backends: ["checklist"],
    webSocket: server.WebSocket,
    leader: false as const,
  };
  const a = createSyncClient({
    ...options,
    store: indexedDbStore({ name: "rh-json", indexedDB: factory }),
  });
  await a.start();
  await until(() => a.records("checklist", "item").get(id) !== undefined);
  assert.deepEqual(a.records("checklist", "item").get(id), row);
  await a.stop();
  const b = createSyncClient({
    ...options,
    store: indexedDbStore({ name: "rh-json", indexedDB: factory }),
  });
  await b.start();
  const back = b.records<typeof row>("checklist", "item").get(id);
  assert.deepEqual(back, row);
  assert.equal(back?.done, true);
  assert.equal(typeof back?.meta, "object");
  await b.stop();
});
