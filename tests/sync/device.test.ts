// Devices: P-256 keys through WebCrypto, proofs atlas-core verifies,
// minting on the first hello, rotation confirmed by ack, the auth frame for
// a bound token, and reconcile then re-register after a conflict.
import assert from "node:assert/strict";
import { test } from "node:test";

import { checklist } from "../../src/sync/generated/checklist.js";
import { createSyncClient, memoryStore } from "../../src/sync/index.js";
import {
  makeKey,
  proveHello,
  proveRegistration,
  thumbprint,
  verify,
} from "../../src/sync/device.js";
import { fromBase64url } from "../../src/sync/ids.js";
import { FakeServer, token, until } from "./fake.js";

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

test("proofs are ES256 JWSs with low S that verify against the key, in atlas-core's claim order", async () => {
  for (const keeps of [true, false]) {
    const key = await makeKey(keeps);
    const reg = await proveRegistration(key, "nonce-1");
    assert.ok(await verify(key.publicJwk, reg));
    const [h, p, s] = reg.split(".");
    assert.equal(
      new TextDecoder().decode(fromBase64url(h!)),
      '{"alg":"ES256","typ":"device-registration+jwt"}',
    );
    assert.equal(
      new TextDecoder().decode(fromBase64url(p!)),
      `{"kind":"registration","jkt":"${await thumbprint(key.publicJwk)}","nonce":"nonce-1"}`,
    );
    const sBytes = fromBase64url(s!).subarray(32);
    assert.ok(BigInt(`0x${Buffer.from(sBytes).toString("hex")}`) <= N / 2n);
    const hello = await proveHello(key, "dev-1", 3, "n2");
    assert.equal(
      new TextDecoder().decode(fromBase64url(hello.split(".")[1]!)),
      '{"kind":"hello","device_id":"dev-1","generation":3,"nonce":"n2"}',
    );
    assert.ok(await verify(key.publicJwk, hello));
  }
});

test("a device is minted on the first hello and its secret rotates on every hello, confirmed by ack", async () => {
  const server = new FakeServer();
  const store = memoryStore();
  const opts = {
    url: "ws://fake",
    workspace: server.workspace,
    token,
    store,
    webSocket: server.WebSocket,
  };
  const a = createSyncClient(opts);
  await a.start();
  const first = server.sent("hello")[0]!.params.workspaces[0];
  assert.equal(first.device, null);
  assert.ok(await verify(first.device_key, first.proof));
  assert.equal(server.sent("ack")[0]!.params.generation, 1);
  await a.stop();
  const b = createSyncClient(opts);
  await b.start();
  const second = server.sent("hello")[1]!.params.workspaces[0];
  assert.deepEqual(
    [second.device.id, second.device.secret, second.device.generation],
    [server.deviceId, "secret-1", 1],
  );
  assert.ok(await verify(first.device_key, second.device.proof));
  assert.equal(server.sent("ack")[1]!.params.generation, 2);
  await b.stop();
});

test("a DPoP-bound token always takes the auth frame, with a proof over the challenge nonce", async () => {
  const server = new FakeServer();
  const seen: string[] = [];
  const client = createSyncClient({
    url: "ws://fake/v1/connect",
    workspace: server.workspace,
    token: async () => ({
      token: "bound",
      dpop: async (htu, nonce) => (seen.push(`${htu} ${nonce}`), "proof"),
    }),
    store: memoryStore(),
    webSocket: server.WebSocket,
  });
  await client.start();
  assert.deepEqual(server.sent("auth")[0]!.params, { token: "bound", dpop: "proof" });
  assert.deepEqual(seen, ["ws://fake/v1/connect nonce-1"]);
  assert.equal(server.socket.options, undefined);
  await client.stop();
});

test("device_conflict: device.results settles what the old device did, then a new device takes the rest", async () => {
  const server = new FakeServer();
  const client = createSyncClient({
    url: "ws://fake",
    workspace: server.workspace,
    token,
    store: memoryStore(),
    backends: ["checklist"],
    webSocket: server.WebSocket,
  });
  await client.start();
  server.opts.auto = false;
  const p = client.write(checklist.putList({ title: "x" }));
  const push = await server.next("push");
  // The service applied it but the result was lost; then the device conflicts.
  server.results.set(1, { status: "applied", device_seq: 1 });
  server.opts.auto = true;
  const old = server.deviceId;
  server.socket.push({
    event: "device_conflict",
    workspace: server.workspace,
    device_id: old,
    reason: "stale_secret",
  });
  const asked = await server.next("device.results");
  assert.deepEqual([asked.params.device_id, asked.params.from_seq, asked.params.upto], [old, 1, 1]);
  const [o] = await p;
  assert.deepEqual(o, { status: "applied", deviceSeq: push.params.ops[0].device_seq });
  await until(() => server.sent("hello").length === 2);
  assert.equal(server.sent("hello")[1]!.params.workspaces[0].device, null);
  await client.stop();
});
