// Catch-up: rows by rev, tombstones, cursors, reset, splits and scopes.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyGroups,
  applyRow,
  dropGroup,
  readCursors,
  setSeq,
  takeLayouts,
} from "../../src/sync/catchup.js";
import { Overlay } from "../../src/sync/overlay.js";
import { memoryStore } from "../../src/sync/index.js";
import { createSyncClient } from "../../src/sync/index.js";
import { FakeServer, token, until } from "./fake.js";

async function open() {
  const store = memoryStore();
  await store.open("w");
  return { store, overlay: new Overlay(undefined, () => null) };
}

test("a row is written only when its rev is newer; a tombstone deletes", async () => {
  const { store, overlay } = await open();
  await store.transaction((tx) => {
    const t = new Set<string>();
    assert.equal(
      applyRow(
        tx,
        overlay,
        "g",
        0,
        { entity: "issue", id: "i", rev: 2, row: { id: "i", title: "two" } },
        t,
      ),
      true,
    );
    assert.equal(
      applyRow(
        tx,
        overlay,
        "g",
        0,
        { entity: "issue", id: "i", rev: 1, row: { id: "i", title: "one" } },
        t,
      ),
      false,
    );
    assert.equal(overlay.get("issue", "i")?.title, "two");
    applyRow(tx, overlay, "g", 0, { entity: "issue", id: "i", rev: 3, state: "deleted" }, t);
    assert.equal(overlay.get("issue", "i"), undefined);
    assert.equal(
      applyRow(tx, overlay, "g", 0, { entity: "issue", id: "i", rev: 2, row: { id: "i" } }, t),
      false,
    );
    applyRow(
      tx,
      overlay,
      "g",
      0,
      { entity: "issue_label", id: ["a", "b"], rev: 1, row: { issue_id: "a", label_id: "b" } },
      t,
    );
    assert.ok(overlay.get("issue_label", "a/b"));
  });
});

test("rows_end sets the shard cursor; reset drops the group and its cursors", async () => {
  const { store, overlay } = await open();
  await store.transaction((tx) => {
    const t = new Set<string>();
    applyRow(tx, overlay, "g1", 0, { entity: "issue", id: "i", rev: 1, row: { id: "i" } }, t);
    applyRow(tx, overlay, "g2", 0, { entity: "issue", id: "j", rev: 1, row: { id: "j" } }, t);
    setSeq(tx, "g1", 0, 1, 7);
    setSeq(tx, "g2", 0, 1, 3);
    dropGroup(tx, overlay, "g1", t);
    assert.deepEqual(readCursors(tx), { layout: { g2: 1 }, seqs: { "g2/0": 3 } });
    assert.equal(overlay.get("issue", "i"), undefined);
    assert.ok(overlay.get("issue", "j"));
  });
});

test("groups.update maps the cursor to the new layout's base seqs; remove drops", async () => {
  const { store, overlay } = await open();
  await store.transaction((tx) => {
    const t = new Set<string>();
    takeLayouts(
      tx,
      overlay,
      [{ id: "g", kind: "team", scope: { kind: "team", id: "t" }, shards: 1, layout_version: 1 }],
      t,
    );
    setSeq(tx, "g", 0, 1, 10);
    applyGroups(
      tx,
      overlay,
      { update: [{ id: "g", shards: 2, layout_version: 2, base_seqs: { "0": 4, "1": 6 } }] },
      t,
    );
    assert.deepEqual(readCursors(tx), { layout: { g: 2 }, seqs: { "g/0": 4, "g/1": 6 } });
    applyGroups(tx, overlay, { remove: ["g"] }, t);
    assert.deepEqual(readCursors(tx), { layout: {}, seqs: {} });
  });
});

test("partial sync: hello names backends and scopes; groups no longer asked are dropped", async () => {
  const server = new FakeServer({ groups: [{ id: "g-ws" }, { id: "g-team-a" }] });
  const client = createSyncClient({
    url: "ws://fake",
    workspace: server.workspace,
    token,
    store: memoryStore(),
    backends: ["issues"],
    scopes: [{ kind: "team", id: "a" }],
    webSocket: server.WebSocket,
  });
  await client.start();
  const w = server.sent("hello")[0]!.params.workspaces[0];
  assert.deepEqual([w.backends, w.scopes], [["issues"], [{ kind: "team", id: "a" }]]);
  const layout = async () =>
    JSON.parse(Buffer.from(await client.cursor(), "base64url").toString()).layout as Record<
      string,
      number
    >;
  assert.equal((await layout())["g-team-a"], 1);
  server.opts.groups = [{ id: "g-ws" }];
  await client.setScopes([]);
  await until(() => server.sent("hello").length === 2);
  assert.deepEqual(server.sent("hello")[1]!.params.workspaces[0].scopes, []);
  for (let i = 0; i < 200 && (await layout())["g-team-a"] !== undefined; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal((await layout())["g-team-a"], undefined);
  await client.stop();
});

test("a change past the cursor asks resume from the next seq", async () => {
  const server = new FakeServer();
  const client = createSyncClient({
    url: "ws://fake",
    workspace: server.workspace,
    token,
    store: memoryStore(),
    webSocket: server.WebSocket,
  });
  await client.start();
  server.socket.push({
    event: "change",
    workspace: server.workspace,
    group: "g-ws",
    shard: 0,
    layout_version: 1,
    from_seq: 5,
    to_seq: 5,
    rows: [],
  });
  const resume = await server.next("resume");
  assert.deepEqual(resume.params, {
    workspace: server.workspace,
    group: "g-ws",
    shard: 0,
    from_seq: 1,
  });
  await client.stop();
});
