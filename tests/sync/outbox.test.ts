// The outbox: gap-free seqs, verbatim op bytes, the window, frame splits
// that never split a batch, and resends after gap, retry and reconnect.
import assert from "node:assert/strict";
import { test } from "node:test";

import { checklist } from "../../src/sync/generated/checklist.js";
import { createSyncClient, memoryStore } from "../../src/sync/index.js";
import { encodePushOp, pushFrames, rejectionDelay, WINDOW } from "../../src/sync/outbox.js";
import type { OutboxEntry } from "../../src/sync/types.js";
import { FakeServer, token, until } from "./fake.js";

const entry = (seq: number, batch?: string): OutboxEntry => ({
  deviceSeq: seq,
  entryNonce: `n${seq}`,
  op: `{"op":"delete_record","backend":"b","type":"t","id":"${"x".repeat(100)}"}`,
  enqueuedAt: "2026-11-01T00:00:00.000Z",
  ...(batch ? { batch } : {}),
});
const header = { workspace: "w", epoch: 1, outbox_epoch: 1, acked_upto: 0 };

test("a pushed op carries its bytes verbatim, its nonce, op_version and origin app", () => {
  const e = { ...entry(1), op: '{"op":"delete_record", "id":"spaced"}' };
  const text = encodePushOp(e);
  assert.ok(text.endsWith(`"op":${e.op}}`));
  const parsed = JSON.parse(text);
  assert.deepEqual(
    [parsed.device_seq, parsed.entry_nonce, parsed.op_version, parsed.origin],
    [1, "n1", 4, "app"],
  );
});

test("frames split by max_frame_bytes, the window caps the ops, a batch is never split", () => {
  const entries = Array.from({ length: 10 }, (_, i) => entry(i + 1));
  const frames = pushFrames(entries, header, WINDOW, 600);
  assert.ok(frames.length > 1);
  assert.deepEqual(
    frames.flatMap((f) => f.seqs),
    entries.map((e) => e.deviceSeq),
  );
  for (const f of frames) assert.ok(f.build(1).length < 600 + 300);
  assert.deepEqual(
    pushFrames(entries, header, 3, 1 << 20).flatMap((f) => f.seqs),
    [1, 2, 3],
  );
  const batched = [entry(1), entry(2, "b"), entry(3, "b"), entry(4, "b")];
  assert.deepEqual(
    pushFrames(batched, header, 2, 1 << 20).flatMap((f) => f.seqs),
    [1],
  );
  assert.deepEqual(
    pushFrames(batched, header, 4, 400).map((f) => f.seqs),
    [[1], [2, 3, 4]],
  );
});

test("rate_limited and retry wait the server's time with jitter", () => {
  assert.equal(
    rejectionDelay("rate_limited", 2000, () => 0),
    2000,
  );
  assert.equal(
    rejectionDelay("retry", 2000, () => 1),
    3000,
  );
  assert.equal(
    rejectionDelay("gap", undefined, () => 0),
    null,
  );
});

test("device seqs are gap-free; a gap resends from expected; rate_limited resends after its wait", async () => {
  const server = new FakeServer({ auto: true });
  const client = createSyncClient({
    url: "ws://fake",
    workspace: server.workspace,
    token,
    store: memoryStore(),
    backends: ["checklist"],
    webSocket: server.WebSocket,
  });
  await client.start();
  await Promise.all([
    client.write(checklist.putList({ title: "a" })),
    client.write(checklist.putList({ title: "b" })),
  ]);
  const seqs = server.sent("push").flatMap((p) => p.params.ops.map((o: any) => o.device_seq));
  assert.deepEqual(seqs, [1, 2]);

  const s = server.socket;
  server.opts.auto = false;
  const waitPush = server.next("push");
  const p = client.write(checklist.putList({ title: "c" }));
  await waitPush;
  server.opts.auto = true;
  s.push({
    event: "rejected",
    workspace: server.workspace,
    code: "gap",
    from_device_seq: 3,
    expected: 3,
  });
  await until(
    () =>
      server.sent("push").filter((f) => f.params.ops.some((o: any) => o.device_seq === 3)).length >=
      2,
  );
  await p;

  const before = server.sent("push").length;
  s.push({
    event: "rejected",
    workspace: server.workspace,
    code: "rate_limited",
    from_device_seq: 4,
    retry_after_ms: 20,
  });
  const q = client.write(checklist.putList({ title: "d" }));
  await q;
  assert.ok(server.sent("push").length > before);
  await client.stop();
});

test("after a reconnect the client resends from the first unacknowledged op", async () => {
  const server = new FakeServer({ refuse: () => null });
  const client = createSyncClient({
    url: "ws://fake",
    workspace: server.workspace,
    token,
    store: memoryStore(),
    backends: ["checklist"],
    webSocket: server.WebSocket,
    random: () => 0,
  });
  await client.start();
  server.opts.auto = false;
  const p = client.write(checklist.putList({ title: "lost" }));
  await server.next("push");
  server.socket.close(1006);
  server.opts.auto = true;
  const [o] = await p;
  assert.equal(o!.status, "applied");
  assert.equal(server.sockets.length, 2);
  await client.stop();
});
