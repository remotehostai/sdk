// The overlay: confirmed rows plus the outbox's predictions; a refusal
// takes its prediction away; a change under a predicted row recomputes it.
import assert from "node:assert/strict";
import { test } from "node:test";

import { checklist } from "../../src/sync/generated/checklist.js";
import { createSyncClient, issues, memoryStore } from "../../src/sync/index.js";
import { Overlay } from "../../src/sync/overlay.js";
import { FakeServer, token } from "./fake.js";

test("a refused op disappears from the overlay and its write resolves refused", async () => {
  const server = new FakeServer({
    refuse: (op) =>
      op.fields?.title === "bad" ? { code: "invalid", reason: "too_long", message: "no" } : null,
  });
  const client = createSyncClient({
    url: "ws://fake",
    workspace: server.workspace,
    token,
    store: memoryStore(),
    backends: ["checklist"],
    webSocket: server.WebSocket,
  });
  await client.start();
  const seen: any[] = [];
  client.records("checklist", "list").subscribe((c) => seen.push(c));
  const op = checklist.putList({ title: "bad" });
  const p = client.write(op);
  assert.ok(client.records("checklist", "list").get(op.id));
  const [o] = await p;
  assert.equal(o!.status, "refused");
  assert.equal(o!.status === "refused" && o!.reason, "too_long");
  assert.equal(client.records("checklist", "list").get(op.id), undefined);
  assert.deepEqual(seen.at(-1), { kind: "delete", id: op.id, confirmed: true });
  await client.stop();
});

test("a change for a row the overlay touches recomputes it on the new confirmed row", () => {
  const o = new Overlay(undefined, () => "user-1");
  o.load([
    {
      entity: "issue",
      id: "i1",
      rev: 1,
      row: { id: "i1", title: "A", state_id: "s1", priority: 0 },
      group: "g",
      shard: 0,
    },
  ]);
  const op = issues.ops.setIssueState({ issue: "i1", state: "s2" });
  const entry = {
    deviceSeq: 1,
    entryNonce: "n",
    op: JSON.stringify(op),
    enqueuedAt: "2026-11-01T00:00:00.000Z",
  };
  o.recompute([entry]);
  assert.equal(o.get("issue", "i1")?.state_id, "s2");
  o.setConfirmed({
    entity: "issue",
    id: "i1",
    rev: 2,
    row: { id: "i1", title: "B", state_id: "s1", priority: 0 },
    group: "g",
    shard: 0,
  });
  o.recompute([entry]);
  assert.deepEqual([o.get("issue", "i1")?.title, o.get("issue", "i1")?.state_id], ["B", "s2"]);
  o.recompute([]);
  assert.equal(o.get("issue", "i1")?.state_id, "s1");
});

test("the console's Issues ops predict their rows", () => {
  const o = new Overlay(undefined, () => "user-1");
  o.load([
    { entity: "team", id: "t1", rev: 1, row: { id: "t1", key: "REM" }, group: "g", shard: 0 },
  ]);
  const create = issues.ops.createIssue({ team: "t1", title: "New", state: "s1", labels: ["l1"] });
  const id = (create as { id: string }).id;
  const ops = [
    create,
    issues.ops.setIssuePriority({ issue: id, priority: 2 }),
    issues.ops.addComment({ issue: id, body: "hi" }),
    issues.ops.setIssueLabel({ issue: id, label: "l1", on: false }),
  ];
  o.recompute(
    ops.map((op, i) => ({
      deviceSeq: i + 1,
      entryNonce: "n",
      op: JSON.stringify(op),
      enqueuedAt: "2026-11-01T00:00:00.000Z",
    })),
  );
  assert.equal(o.get("issue", id)?.priority, 2);
  assert.equal(o.get("issue", id)?.identifier, "REM-");
  assert.equal(Array.from(o.rows("comment")).length, 1);
  assert.equal(o.get("issue_label", `${id}/l1`), undefined);
});
