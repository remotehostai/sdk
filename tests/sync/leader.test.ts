// Two tabs on one shared store, with a Web Locks and BroadcastChannel shim:
// only the leader opens a socket, a follower's write goes through it, and
// when the leader stops a follower takes over.
import assert from "node:assert/strict";
import { test } from "node:test";

import { checklist } from "../../src/sync/generated/checklist.js";
import { createSyncClient, memoryStore } from "../../src/sync/index.js";
import type {
  BroadcastChannelLike,
  LeaderEnvironment,
  LockManagerLike,
} from "../../src/sync/types.js";
import { FakeServer, token, until } from "./fake.js";

function browserShim(): () => LeaderEnvironment {
  const holders = new Map<string, Array<() => void>>();
  const held = new Set<string>();
  const locks: LockManagerLike = {
    request(name, options, callback) {
      return new Promise<void>((resolve, reject) => {
        const run = () => {
          held.add(name);
          void callback(null).finally(() => {
            held.delete(name);
            resolve();
            holders.get(name)?.shift()?.();
          });
        };
        options.signal?.addEventListener("abort", () => {
          const q = holders.get(name) ?? [];
          const i = q.indexOf(run);
          if (i >= 0) {
            q.splice(i, 1);
            reject(new Error("aborted"));
          }
        });
        if (held.has(name)) holders.set(name, [...(holders.get(name) ?? []), run]);
        else run();
      });
    },
  };
  const channels = new Map<string, Set<{ fire: (d: unknown) => void }>>();
  const channel = (name: string): BroadcastChannelLike => {
    const listeners: Array<(e: { data: unknown }) => void> = [];
    const me = { fire: (d: unknown) => listeners.forEach((l) => l({ data: structuredClone(d) })) };
    const set = channels.get(name) ?? new Set();
    channels.set(name, set);
    set.add(me);
    return {
      postMessage: (m) => queueMicrotask(() => set.forEach((o) => o !== me && o.fire(m))),
      addEventListener: (_t, l) => listeners.push(l),
      close: () => set.delete(me),
    };
  };
  return () => ({ locks, channel });
}

test("one socket for two tabs; a follower writes through the leader; a follower takes over", async () => {
  const server = new FakeServer();
  const store = memoryStore({ shared: true });
  const env = browserShim();
  const options = {
    url: "ws://fake",
    workspace: server.workspace,
    token,
    store,
    backends: ["checklist"],
    webSocket: server.WebSocket,
  };
  const tabA = createSyncClient({ ...options, leader: env() });
  const tabB = createSyncClient({ ...options, leader: env() });
  await tabA.start();
  await tabB.start();
  await until(() => tabA.status === "live");
  assert.equal(tabA.leader, true);
  assert.equal(tabB.leader, false);
  assert.equal(server.sockets.length, 1);

  const op = checklist.putList({ title: "from B" });
  const [o] = await tabB.write(op);
  assert.equal(o!.status, "applied");
  await until(() => Boolean(tabB.records("checklist", "list").get(op.id)));

  await tabA.stop();
  await until(() => tabB.leader && tabB.status === "live");
  assert.equal(server.sockets.length, 2);
  const [o2] = await tabB.write(checklist.putList({ title: "B leads" }));
  assert.equal(o2!.status, "applied");
  await tabB.stop();
});

test("a tab that joins a live leader shows live at once", async () => {
  const server = new FakeServer();
  const store = memoryStore({ shared: true });
  const env = browserShim();
  const options = {
    url: "ws://fake",
    workspace: server.workspace,
    token,
    store,
    backends: ["checklist"],
    webSocket: server.WebSocket,
  };
  const tabA = createSyncClient({ ...options, leader: env() });
  await tabA.start();
  await until(() => tabA.status === "live");
  // The leader's status no longer changes: the late tab asks for it.
  const tabB = createSyncClient({ ...options, leader: env() });
  await tabB.start();
  assert.equal(tabB.leader, false);
  await until(() => tabB.status === "live", 500);
  await tabB.stop();
  await tabA.stop();
});
