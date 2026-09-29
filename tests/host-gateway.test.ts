import assert from "node:assert/strict";
import test from "node:test";

import RemoteHost, { RemoteHostAPIError, RemoteHostConnectionError } from "../src/index.js";
import { ROUTE_OFF_MS, isSafeGatewayUrl } from "../src/host-gateway.js";
import type { SandboxData } from "../src/sandboxes.js";

// Commands and files through the sandbox's own host (REM-690): off by
// default; on, a single-use ticket from the API for each call and the call
// itself to the host gateway; the API's own route wherever the gateway path
// is not there, and never a command run twice.

const SANDBOX = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const GATEWAY = "https://gw-eu-3-staging.remotehost.ai";
// A sandbox the fake API answers "Sandbox not found." for (REM-715).
const GONE = "0f0f0f0f-0000-4000-8000-000000000000";

const sandboxData: SandboxData = {
  id: SANDBOX,
  org_id: "org_123",
  project_id: "project_123",
  name: "gw",
  agent: "codex",
  status: "running",
  mode: "persistent",
  region: "eu-west",
  persistence_policy: "sleep_resume",
  sandbox_profile: "agent-standard",
  machine_size: "default",
  allocated_vcpu: 4,
  allocated_memory_gb: 8,
  allocated_disk_gb: 40,
  end_user_id: null,
  vm_lost_at: null,
  environment_id: null,
  disk: null,
  created_at: "2026-09-13T00:00:00.000Z",
  updated_at: "2026-09-13T00:00:00.000Z",
};

type Seen = { method: string; url: string; authorization: string | null; body: unknown };

// A fake API and gateway behind one fetch. `gateway` answers the gateway's
// requests; `ticket` the ticket route's.
function world(options: {
  hostGateway?: boolean;
  ticket?: (permission: string) => Response;
  gateway?: (request: Request) => Promise<Response> | Response;
}) {
  const seen: Seen[] = [];
  let tickets = 0;
  const client = new RemoteHost({
    apiKey: "rh_secret_key",
    orgId: "org_123",
    maxRetries: 0,
    ...(options.hostGateway === undefined ? {} : { hostGateway: options.hostGateway }),
    fetch: async (request) => {
      const text = request.body ? await request.text() : "";
      const body = text ? JSON.parse(text) : null;
      seen.push({ method: request.method, url: request.url, authorization: request.headers.get("authorization"), body });
      const url = new URL(request.url);

      // A sandbox the API no longer has: retrievable from an earlier read,
      // and every call on it the API's own 404, with no code.
      if (url.pathname.includes(`/sandboxes/${GONE}`)) {
        if (url.pathname.endsWith(`/sandboxes/${GONE}`)) return Response.json({ sandbox: { ...sandboxData, id: GONE } });
        return Response.json({ error: { message: "Sandbox not found." } }, { status: 404 });
      }

      if (url.origin === GATEWAY || url.hostname === "gw.example.com" || url.hostname === "127.0.0.1") {
        return options.gateway
          ? options.gateway(new Request(request.url, { method: request.method, headers: request.headers, body: text || undefined }))
          : Response.json({ unexpected: true }, { status: 500 });
      }
      if (url.pathname.endsWith("/gateway-ticket")) {
        tickets += 1;
        // The live metrics' own route takes no body (REM-715).
        const metrics = url.pathname.endsWith("/metrics/gateway-ticket");
        const permission = metrics ? "sandbox.files.read" : body.permission;
        return (
          options.ticket?.(metrics ? "metrics" : permission) ??
          Response.json({
            ticket: `rh_hgt_ticket-${tickets}`,
            gatewayUrl: GATEWAY,
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
            sandboxId: SANDBOX.replace(/-/g, ""),
            permission,
          })
        );
      }
      if (url.pathname.endsWith("/metrics/live")) return Response.json({ ...liveMetrics, cpuPercent: 1 });
      if (url.pathname.endsWith(`/sandboxes/${SANDBOX}`)) return Response.json({ sandbox: sandboxData });
      if (url.pathname.endsWith("/exec")) {
        return Response.json({ exitCode: 0, stdout: "from the api\n", stderr: "", truncated: false, timedOut: false });
      }
      if (url.pathname.endsWith("/file") && request.method === "GET") {
        return Response.json({ content: "api", encoding: "utf8", size: 3, path: "/code/a" });
      }
      if (url.pathname.endsWith("/files")) return Response.json({ path: "/code", truncated: false, entries: [] });
      if (url.pathname.endsWith("/file") && request.method === "PUT") return Response.json({ path: "/code/a", size: 1 });
      return Response.json({ error: { message: `unexpected ${request.method} ${url.pathname}` } }, { status: 500 });
    },
  });
  // Requests to the API itself, whose path ends with `suffix`.
  const apiCalls = (suffix: string) =>
    seen.filter((s) => s.url.startsWith("https://api.remotehost.ai/") && new URL(s.url).pathname.endsWith(suffix));
  return { client, seen, apiCalls };
}

const execResult = { exitCode: 7, stdout: "from the gateway\n", stderr: "", truncated: false, timedOut: false };

const liveMetrics = {
  cpuPercent: 12.5,
  memoryTotalGb: 8,
  memoryUsedGb: 2,
  diskTotalGb: 40,
  diskUsedGb: 4,
  diskUsedBytes: 4294967296,
  diskAvailableBytes: 38654705664,
  swapTotalGb: 0,
  swapUsedGb: 0,
  memoryPressure: null,
  cpuPressure: null,
  memoryWarning: { level: "none", reason: "", suggestedShape: null },
};

// REM-715: live metrics through the gateway, in /metrics/live's own shape.
test("reads live metrics on the sandbox's host with a ticket from the metrics' own route", async () => {
  const { client, seen, apiCalls } = world({
    hostGateway: true,
    gateway: (request) => {
      assert.equal(request.method, "GET");
      assert.equal(new URL(request.url).pathname, "/v1/metrics");
      assert.equal(request.headers.get("authorization"), "Bearer rh_hgt_ticket-1");
      return Response.json(liveMetrics);
    },
  });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  assert.deepEqual(await sandbox.metrics.get(), liveMetrics);
  const ticketCalls = apiCalls("/metrics/gateway-ticket");
  assert.equal(ticketCalls.length, 1);
  assert.equal(ticketCalls[0]!.body, null, "the route takes no body");
  assert.equal(apiCalls("/metrics/live").length, 0, "nothing through the API");
  assert.ok(!seen.some((s) => s.url.startsWith(GATEWAY) && s.authorization?.includes("rh_secret_key")));
});

test("reads live metrics through the API while the streams are off, and keeps the gateway for the rest", async () => {
  const { client, apiCalls } = world({
    hostGateway: true,
    ticket: (permission) =>
      permission === "metrics" ? Response.json({ error: { message: "Not found.", code: "not_found" } }, { status: 404 }) : (undefined as never),
    gateway: () => Response.json(execResult),
  });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  assert.equal((await sandbox.metrics.get()).cpuPercent, 1);
  assert.equal(apiCalls("/metrics/live").length, 1);
  // Exec and files still go to the gateway: one route being off says
  // nothing about the others.
  assert.equal((await sandbox.commands.run("true")).stdout, "from the gateway\n");
  assert.equal(apiCalls("/exec").length, 0);
});

test("remembers that live metrics tickets are off, so a dark API costs one extra request, not one per call", async () => {
  const { client, apiCalls } = world({
    hostGateway: true,
    ticket: (permission) =>
      permission === "metrics" ? Response.json({ error: { message: "Not found.", code: "not_found" } }, { status: 404 }) : (undefined as never),
  });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  const other = await client.sandboxes.retrieve(SANDBOX);
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await sandbox.metrics.get()).cpuPercent, 1);
  }
  assert.equal((await other.metrics.get()).cpuPercent, 1);
  assert.equal(apiCalls("/metrics/gateway-ticket").length, 1, "one ticket request for the whole client");
  assert.equal(apiCalls("/metrics/live").length, 4);
});

test("remembers the API's streams switch being off", async () => {
  const { client, apiCalls } = world({
    hostGateway: true,
    ticket: (permission) =>
      permission === "metrics"
        ? Response.json({ error: { message: "Not found.", code: "host_gateway_streams_off" } }, { status: 404 })
        : (undefined as never),
  });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  await sandbox.metrics.get();
  await sandbox.metrics.get();
  assert.equal(apiCalls("/metrics/gateway-ticket").length, 1);
});

test("a sandbox that isn't there is its own answer, never the route being off for every sandbox", async () => {
  const { client, apiCalls } = world({
    hostGateway: true,
    gateway: () => Response.json(liveMetrics),
  });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  // The same client, a sandbox the API no longer has: its ticket and its
  // /metrics/live both answer the sandbox's own 404.
  const gone = await client.sandboxes.retrieve(GONE);
  await assert.rejects(gone.metrics.get(), (error: unknown) => error instanceof RemoteHostAPIError && error.status === 404);
  // Every other sandbox still reads through the gateway.
  assert.equal((await sandbox.metrics.get()).cpuPercent, 12.5);
  assert.equal(apiCalls("/metrics/live").filter((c) => c.url.includes(SANDBOX)).length, 0);
  assert.equal(apiCalls("/metrics/gateway-ticket").filter((c) => c.url.includes(SANDBOX)).length, 1);
});

test("asks again once the remembered off has run out", async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    let off = true;
    const { client, apiCalls } = world({
      hostGateway: true,
      ticket: (permission) =>
        permission === "metrics" && off
          ? Response.json({ error: { message: "Not found.", code: "not_found" } }, { status: 404 })
          : (undefined as never),
      gateway: () => Response.json(liveMetrics),
    });
    const sandbox = await client.sandboxes.retrieve(SANDBOX);
    assert.equal((await sandbox.metrics.get()).cpuPercent, 1);
    off = false;
    now += ROUTE_OFF_MS - 1;
    assert.equal((await sandbox.metrics.get()).cpuPercent, 1, "still remembered off");
    now += 2;
    assert.equal((await sandbox.metrics.get()).cpuPercent, 12.5, "the flip is picked up");
    assert.equal(apiCalls("/metrics/gateway-ticket").length, 2);
  } finally {
    Date.now = realNow;
  }
});

test("reads live metrics through the API when the gateway does not serve them", async () => {
  for (const unserved of [
    () => Response.json({ error: { message: "Not found.", code: "not_found" } }, { status: 404 }),
    () => new Response("404 page not found\n", { status: 404, headers: { "content-type": "text/plain" } }),
    () => Response.json({ error: { message: "revocation policy unavailable", code: "policy_unavailable" } }, { status: 503 }),
  ]) {
    const { client, apiCalls } = world({ hostGateway: true, gateway: unserved });
    const sandbox = await client.sandboxes.retrieve(SANDBOX);
    assert.equal((await sandbox.metrics.get()).cpuPercent, 1);
    assert.equal(apiCalls("/metrics/live").length, 1);
  }
});

test("is off by default for live metrics too", async () => {
  const { client, seen } = world({ hostGateway: false });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  assert.equal((await sandbox.metrics.get()).cpuPercent, 1);
  assert.ok(!seen.some((s) => s.url.includes("gateway-ticket")));
});

test("is off by default: nothing asks for a ticket", async () => {
  const saved = process.env.REMOTEHOST_HOST_GATEWAY;
  delete process.env.REMOTEHOST_HOST_GATEWAY;
  try {
    const { client, seen } = world({});
    const sandbox = await client.sandboxes.retrieve(SANDBOX);
    assert.equal((await sandbox.commands.run("true")).stdout, "from the api\n");
    assert.ok(!seen.some((s) => s.url.includes("gateway-ticket")));
  } finally {
    if (saved !== undefined) process.env.REMOTEHOST_HOST_GATEWAY = saved;
  }
});

test("REMOTEHOST_HOST_GATEWAY turns it on, and the option overrides it", async () => {
  const saved = process.env.REMOTEHOST_HOST_GATEWAY;
  process.env.REMOTEHOST_HOST_GATEWAY = "1";
  try {
    const on = world({ gateway: () => Response.json(execResult) });
    await (await on.client.sandboxes.retrieve(SANDBOX)).commands.run("true");
    assert.ok(on.seen.some((s) => s.url.includes("gateway-ticket")));

    const off = world({ hostGateway: false });
    await (await off.client.sandboxes.retrieve(SANDBOX)).commands.run("true");
    assert.ok(!off.seen.some((s) => s.url.includes("gateway-ticket")));
  } finally {
    if (saved === undefined) delete process.env.REMOTEHOST_HOST_GATEWAY;
    else process.env.REMOTEHOST_HOST_GATEWAY = saved;
  }
});

test("runs a command on the sandbox's host with a ticket, and the API key goes only to the API", async () => {
  const { client, seen, apiCalls } = world({
    hostGateway: true,
    gateway: async (request) => {
      assert.equal(request.method, "POST");
      assert.equal(new URL(request.url).pathname, "/v1/exec");
      assert.deepEqual(await request.json(), { command: "echo hi", timeoutSeconds: 5 });
      return Response.json(execResult);
    },
  });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  assert.deepEqual(await sandbox.commands.run("echo hi", { timeoutSeconds: 5 }), execResult);

  const ticket = seen.find((s) => s.url.includes("gateway-ticket"))!;
  assert.deepEqual(ticket.body, { permission: "sandbox.terminal.connect" });
  assert.equal(ticket.authorization, "Bearer rh_secret_key");
  const onGateway = seen.filter((s) => s.url.startsWith(GATEWAY));
  assert.equal(onGateway.length, 1);
  assert.equal(onGateway[0]!.authorization, "Bearer rh_hgt_ticket-1");
  assert.ok(!JSON.stringify(onGateway).includes("rh_secret_key"));
  assert.equal(apiCalls("/exec").length, 0, "the API ran nothing");
});

test("asks for exactly the permission each file call needs", async () => {
  const permissions: string[] = [];
  const { client } = world({
    hostGateway: true,
    ticket: (permission) => {
      permissions.push(permission);
      return Response.json({ ticket: `rh_hgt_${permission}`, gatewayUrl: GATEWAY, expiresAt: "", sandboxId: "x" });
    },
    gateway: (request) => {
      const url = new URL(request.url);
      if (request.method === "PUT") return Response.json({ path: "/code/out", size: 2 });
      if (url.pathname === "/v1/files") return Response.json({ path: "/code", truncated: false, entries: [] });
      assert.equal(url.searchParams.get("path"), "src/a.ts");
      return Response.json({ content: "gw", encoding: "utf8", size: 2, path: "/code/src/a.ts" });
    },
  });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  await sandbox.files.list();
  assert.equal(await sandbox.files.readText("src/a.ts"), "gw");
  assert.deepEqual(await sandbox.files.write("out", "hi"), { path: "/code/out", size: 2 });
  assert.deepEqual(permissions, ["sandbox.files.read", "sandbox.files.read", "sandbox.files.write"]);
});

test("uses the API's route, from then on, where tickets are off or the host has no gateway", async () => {
  for (const answer of [
    () => Response.json({ error: { message: "Not found.", code: "not_found" } }, { status: 404 }),
    () =>
      Response.json(
        { error: { message: "This sandbox's host has no gateway yet.", code: "host_gateway_unavailable" } },
        { status: 409 },
      ),
  ]) {
    const { client, seen, apiCalls } = world({ hostGateway: true, ticket: answer });
    const sandbox = await client.sandboxes.retrieve(SANDBOX);
    assert.equal((await sandbox.commands.run("true")).stdout, "from the api\n");
    assert.equal((await sandbox.commands.run("true")).stdout, "from the api\n");
    assert.equal(seen.filter((s) => s.url.includes("gateway-ticket")).length, 1, "asked once");
    assert.equal(apiCalls("/exec").length, 2);
  }
});

test("uses the API's route when the gateway refused the ticket before running anything", async () => {
  for (const [status, code] of [
    [401, "invalid_ticket"],
    [503, "policy_unavailable"],
    [503, "credential_unavailable"],
  ] as const) {
    const { client, apiCalls } = world({
      hostGateway: true,
      gateway: () => Response.json({ error: { message: "no", code } }, { status }),
    });
    const sandbox = await client.sandboxes.retrieve(SANDBOX);
    assert.equal((await sandbox.commands.run("true")).stdout, "from the api\n", code);
    assert.equal(apiCalls("/exec").length, 1, code);
  }
});

test("never runs a command twice: a connection lost to the gateway is an error", async () => {
  const { client, apiCalls } = world({
    hostGateway: true,
    gateway: () => {
      throw new TypeError("fetch failed");
    },
  });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  await assert.rejects(sandbox.commands.run("rm -rf build"), RemoteHostConnectionError);
  await assert.rejects(sandbox.files.write("a", "x"), RemoteHostConnectionError);
  assert.equal(apiCalls("/exec").length, 0);
  assert.equal(apiCalls("/file").length, 0);
});

test("a read retries on the API when the gateway cannot be reached", async () => {
  const { client, apiCalls } = world({
    hostGateway: true,
    gateway: () => {
      throw new TypeError("fetch failed");
    },
  });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  assert.equal(await sandbox.files.readText("a"), "api");
  assert.equal(apiCalls("/file").length, 1);
});

test("a revocation is the caller's error, not a fallback", async () => {
  const { client, apiCalls } = world({
    hostGateway: true,
    gateway: () =>
      Response.json({ error: { message: "Access to this sandbox was revoked.", code: "access_revoked" } }, { status: 403 }),
  });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  await assert.rejects(sandbox.commands.run("true"), (error: unknown) => {
    assert.ok(error instanceof RemoteHostAPIError);
    assert.equal(error.status, 403);
    assert.equal(error.code, "access_revoked");
    return true;
  });
  assert.equal(apiCalls("/exec").length, 0);
});

test("never sends a ticket to a gateway that is not https", async () => {
  const { client, seen } = world({
    hostGateway: true,
    ticket: () => Response.json({ ticket: "rh_hgt_x", gatewayUrl: "http://gw.example.com", expiresAt: "", sandboxId: "x" }),
  });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  assert.equal((await sandbox.commands.run("true")).stdout, "from the api\n");
  assert.ok(!seen.some((s) => s.url.startsWith("http://gw.example.com")));

  assert.ok(isSafeGatewayUrl("https://gw-eu-3-staging.remotehost.ai"));
  assert.ok(isSafeGatewayUrl("http://127.0.0.1:3020"));
  for (const bad of ["http://gw.example.com", "https://u:p@gw.example.com", "https://gw.example.com?x=1", "wss://gw", "nope"]) {
    assert.ok(!isSafeGatewayUrl(bad), bad);
  }
});
