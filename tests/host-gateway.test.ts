import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer, connect, type Server, type Socket } from "node:net";
import test, { type TestContext } from "node:test";

import RemoteHost, { RemoteHostAPIError, RemoteHostConnectionError, RemoteHostTimeoutError } from "../src/index.js";
import {
  FAILING_PIN_AFTER,
  FAILING_PIN_JITTER,
  FAILING_PIN_MS,
  GATEWAY_BROKEN_FOR_SANDBOX,
  HostGateway,
  ROUTE_OFF_MS,
  USE_API,
  fallsBack,
  hostGatewayFor,
  isSafeGatewayUrl,
  neverConnected,
  sdkGatewayFetch,
} from "../src/host-gateway.js";
import type { SandboxData } from "../src/sandboxes.js";

// Commands and files through the sandbox's own host (REM-690): on by
// default under Node; a single-use ticket from the API for each call and the
// call itself to the host gateway; the API's own route wherever the gateway
// path is not there, and never a command run twice.

const SANDBOX = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
// A second sandbox on the same fake API, for what is remembered API-wide.
const OTHER = "1b2c3d4e-5f60-4b7c-8d9e-0f1a2b3c4d5e";
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
  timeoutMs?: number;
  dangerouslyAllowBrowser?: boolean;
  // The caller's fetch retries a gateway request once after a network
  // error, as a retrying wrapper or undici's RetryAgent does.
  retryGateway?: boolean;
}) {
  const seen: Seen[] = [];
  const inFlight = new Set<Request>();
  let tickets = 0;
  const client = new RemoteHost({
    apiKey: "rh_secret_key",
    orgId: "org_123",
    maxRetries: 0,
    ...(options.dangerouslyAllowBrowser ? { dangerouslyAllowBrowser: true } : {}),
    ...(options.hostGateway === undefined ? {} : { hostGateway: options.hostGateway }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
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
        if (!options.gateway) return Response.json({ unexpected: true }, { status: 500 });
        const answer = Promise.resolve(
          options.gateway(new Request(request.url, { method: request.method, headers: request.headers, body: text || undefined })),
        );
        // Aborted as a real fetch is, so a gateway that never answers times out.
        // Held until the answer, as a real fetch holds its request: Node
        // keeps a signal's followers only weakly, so an unheld request's
        // signal can be collected before it aborts.
        inFlight.add(request);
        answer.finally(() => inFlight.delete(request)).catch(() => {});
        const retried = options.retryGateway
          ? answer.catch(() =>
              options.gateway!(new Request(request.url, { method: request.method, headers: request.headers, body: text || undefined })),
            )
          : answer;
        return new Promise<Response>((resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
          retried.then(resolve, reject);
        });
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
      if (url.pathname.endsWith(`/sandboxes/${OTHER}`)) return Response.json({ sandbox: { ...sandboxData, id: OTHER } });
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

test("hostGateway: false keeps live metrics on the API", async () => {
  const { client, seen } = world({ hostGateway: false });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  assert.equal((await sandbox.metrics.get()).cpuPercent, 1);
  assert.ok(!seen.some((s) => s.url.includes("gateway-ticket")));
});

// REM-690: the gateway path is the default.
async function withGatewayEnv(value: string | undefined, run: () => Promise<void>) {
  const saved = process.env.REMOTEHOST_HOST_GATEWAY;
  if (value === undefined) delete process.env.REMOTEHOST_HOST_GATEWAY;
  else process.env.REMOTEHOST_HOST_GATEWAY = value;
  try {
    await run();
  } finally {
    if (saved === undefined) delete process.env.REMOTEHOST_HOST_GATEWAY;
    else process.env.REMOTEHOST_HOST_GATEWAY = saved;
  }
}

test("is on by default: a command goes through the gateway with no option or variable", async () => {
  await withGatewayEnv(undefined, async () => {
    const { client, seen, apiCalls } = world({ gateway: () => Response.json(execResult) });
    const sandbox = await client.sandboxes.retrieve(SANDBOX);
    assert.equal((await sandbox.commands.run("true")).stdout, "from the gateway\n");
    assert.ok(seen.some((s) => s.url.includes("gateway-ticket")));
    assert.equal(apiCalls("/exec").length, 0);
  });
});

test("REMOTEHOST_HOST_GATEWAY set to 0, false, no or off turns it off; unset, empty or an on-value leaves it on", async () => {
  const warn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => void warnings.push(args);
  try {
    for (const value of ["0", "false", "no", "off", " OFF ", "False"]) {
      await withGatewayEnv(value, async () => {
        const { client, seen } = world({});
        const sandbox = await client.sandboxes.retrieve(SANDBOX);
        assert.equal((await sandbox.commands.run("true")).stdout, "from the api\n", value);
        assert.ok(!seen.some((s) => s.url.includes("gateway-ticket")), value);
      });
    }
    for (const value of [undefined, "", " ", "1", "true", "yes", "on", " ON "]) {
      await withGatewayEnv(value, async () => {
        const { client, seen } = world({ gateway: () => Response.json(execResult) });
        await (await client.sandboxes.retrieve(SANDBOX)).commands.run("true");
        assert.ok(seen.some((s) => s.url.includes("gateway-ticket")), JSON.stringify(value));
      });
    }
    assert.equal(warnings.length, 0, "a recognized value warns nothing");
  } finally {
    console.warn = warn;
  }
});

test("any other REMOTEHOST_HOST_GATEWAY value follows the default, and warns once", async () => {
  const warn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => void warnings.push(args);
  try {
    for (const value of ["disabled", "enable", "2", "of"]) {
      await withGatewayEnv(value, async () => {
        const { client, seen } = world({ gateway: () => Response.json(execResult) });
        await (await client.sandboxes.retrieve(SANDBOX)).commands.run("true");
        assert.ok(seen.some((s) => s.url.includes("gateway-ticket")), `${value}: the default, on under Node`);
      });
    }
    // Where the default is off (a runtime without Node that passes the
    // variable), an unrecognized value is off too, never a guess of on.
    const edge = builtWith("process", { env: { REMOTEHOST_HOST_GATEWAY: "enabled" } }, () =>
      world({ gateway: () => Response.json(execResult) }),
    );
    await (await edge.client.sandboxes.retrieve(SANDBOX)).commands.run("true");
    assert.ok(!edge.seen.some((s) => s.url.includes("gateway-ticket")), "enabled: the default, off without Node");
    assert.equal(warnings.length, 1, "one warning per process");
    assert.match(String(warnings[0]![0]), /REMOTEHOST_HOST_GATEWAY="disabled".*using the default \(on\)/);
  } finally {
    console.warn = warn;
  }
});

// A global replaced while the client is built, the only time the SDK reads
// the runtime; restored before anything is awaited.
function builtWith<T>(name: string, value: unknown, build: () => T): T {
  const saved = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  try {
    return build();
  } finally {
    if (saved) Object.defineProperty(globalThis, name, saved);
    else delete (globalThis as Record<string, unknown>)[name];
  }
}

test("off by default where there is no Node process (browsers, Workers, Deno without Node compatibility)", async () => {
  const runtimes: Array<[string, () => ReturnType<typeof world>]> = [
    ["no process", () => builtWith("process", undefined, () => world({ gateway: () => Response.json(execResult) }))],
    [
      "a process without Node (an edge runtime's shim)",
      () => builtWith("process", { env: {} }, () => world({ gateway: () => Response.json(execResult) })),
    ],
    [
      "a browser page",
      () =>
        builtWith("window", { document: {} }, () =>
          world({ dangerouslyAllowBrowser: true, gateway: () => Response.json(execResult) }),
        ),
    ],
  ];
  for (const [runtime, build] of runtimes) {
    const { client, seen, apiCalls } = build();
    const sandbox = await client.sandboxes.retrieve(SANDBOX);
    assert.equal((await sandbox.commands.run("true")).stdout, "from the api\n", runtime);
    assert.equal(apiCalls("/exec").length, 1, runtime);
    assert.ok(!seen.some((s) => s.url.includes("gateway-ticket")), `${runtime}: no ticket`);
  }
});

test("hostGateway: true turns it on anywhere, and a variable an edge runtime passes does too", async () => {
  const runtimes: Array<[string, () => ReturnType<typeof world>]> = [
    [
      "no process",
      () => builtWith("process", undefined, () => world({ hostGateway: true, gateway: () => Response.json(execResult) })),
    ],
    [
      "a browser page",
      () =>
        builtWith("window", { document: {} }, () =>
          world({ hostGateway: true, dangerouslyAllowBrowser: true, gateway: () => Response.json(execResult) }),
        ),
    ],
    [
      "an edge runtime's process with REMOTEHOST_HOST_GATEWAY=1",
      () =>
        builtWith("process", { env: { REMOTEHOST_HOST_GATEWAY: "1" } }, () =>
          world({ gateway: () => Response.json(execResult) }),
        ),
    ],
  ];
  for (const [runtime, build] of runtimes) {
    const { client, apiCalls } = build();
    const sandbox = await client.sandboxes.retrieve(SANDBOX);
    assert.equal((await sandbox.commands.run("true")).stdout, "from the gateway\n", runtime);
    assert.equal(apiCalls("/exec").length, 0, runtime);
  }
});

test("the option overrides the variable, both ways", async () => {
  await withGatewayEnv("0", async () => {
    const on = world({ hostGateway: true, gateway: () => Response.json(execResult) });
    await (await on.client.sandboxes.retrieve(SANDBOX)).commands.run("true");
    assert.ok(on.seen.some((s) => s.url.includes("gateway-ticket")));
  });
  await withGatewayEnv("1", async () => {
    const off = world({ hostGateway: false });
    await (await off.client.sandboxes.retrieve(SANDBOX)).commands.run("true");
    assert.ok(!off.seen.some((s) => s.url.includes("gateway-ticket")));
  });
});

// Date.now under the test's control, for ROUTE_OFF_MS.
async function withClock(run: (advance: (ms: number) => void) => Promise<void>) {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    await run((ms) => {
      now += ms;
    });
  } finally {
    Date.now = realNow;
  }
}

// Calls on both ticket routes, three of each kind, on two sandboxes, all
// answered by the API.
async function everyCallOnTheAPI(client: RemoteHost) {
  for (const id of [SANDBOX, OTHER]) {
    const sandbox = await client.sandboxes.retrieve(id);
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await sandbox.commands.run("true")).stdout, "from the api\n");
      assert.equal(await sandbox.files.readText("a"), "api");
      assert.equal((await sandbox.metrics.get()).cpuPercent, 1);
    }
  }
}

function ticketRequests(seen: Seen[], route: "generic" | "metrics"): number {
  return seen.filter((s) => {
    const path = new URL(s.url).pathname;
    const metrics = path.endsWith("/metrics/gateway-ticket");
    return path.endsWith("/gateway-ticket") && (route === "metrics") === metrics;
  }).length;
}

// Production's current release (71b306e3) has neither ticket route. An API
// key is refused by the API-key allow-list first, 403 with no code; a
// signed-in user gets the framework's plain-text 404.
const PRODUCTION_TODAY: Array<[string, (route: string) => Response]> = [
  [
    "an API key",
    (route) =>
      Response.json({ error: { message: `API keys cannot call POST /v1/sandboxes/:id/${route}` } }, { status: 403 }),
  ],
  [
    "a signed-in user",
    () => new Response("404 Not Found", { status: 404, headers: { "content-type": "text/plain; charset=UTF-8" } }),
  ],
];

test("an API without ticket routes (production today) costs one ticket request per route per 5 minutes, for every sandbox", async () => {
  for (const [who, answer] of PRODUCTION_TODAY) {
    await withClock(async (advance) => {
      const { client, seen, apiCalls } = world({
        ticket: (permission) => answer(permission === "metrics" ? "metrics/gateway-ticket" : "gateway-ticket"),
      });
      await everyCallOnTheAPI(client);
      assert.equal(ticketRequests(seen, "generic"), 1, `${who}: one generic ticket request in all`);
      assert.equal(ticketRequests(seen, "metrics"), 1, `${who}: one metrics ticket request in all`);
      assert.equal(apiCalls("/exec").length, 6, who);
      assert.equal(apiCalls("/metrics/live").length, 6, who);

      advance(ROUTE_OFF_MS - 1);
      await everyCallOnTheAPI(client);
      assert.equal(ticketRequests(seen, "generic"), 1, `${who}: still remembered`);
      assert.equal(ticketRequests(seen, "metrics"), 1, `${who}: still remembered`);

      advance(2);
      await everyCallOnTheAPI(client);
      assert.equal(ticketRequests(seen, "generic"), 2, `${who}: asked again once it ran out`);
      assert.equal(ticketRequests(seen, "metrics"), 2, `${who}: asked again once it ran out`);
    });
  }
});

test("a later flip on the API is picked up once the remembered off runs out", async () => {
  await withClock(async (advance) => {
    let production = true;
    const { client, apiCalls } = world({
      ticket: () => (production ? PRODUCTION_TODAY[0]![1]("gateway-ticket") : (undefined as never)),
      gateway: () => Response.json(execResult),
    });
    const sandbox = await client.sandboxes.retrieve(SANDBOX);
    assert.equal((await sandbox.commands.run("true")).stdout, "from the api\n");
    production = false;
    advance(ROUTE_OFF_MS);
    assert.equal((await sandbox.commands.run("true")).stdout, "from the gateway\n");
    assert.equal(apiCalls("/exec").length, 1);
  });
});

test("the API's switch off (not_found) is remembered for every sandbox, not per sandbox", async () => {
  const { client, seen } = world({
    ticket: () => Response.json({ error: { message: "Not found.", code: "not_found" } }, { status: 404 }),
  });
  await everyCallOnTheAPI(client);
  assert.equal(ticketRequests(seen, "generic"), 1);
  assert.equal(ticketRequests(seen, "metrics"), 1);
});

test("a 2xx ticket answer without a ticket takes the route as off for every sandbox, for a while", async () => {
  for (const answer of [
    () => Response.json({ ok: true }),
    () => new Response("", { status: 200 }),
    () => new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } }),
  ]) {
    await withClock(async (advance) => {
      const { client, seen, apiCalls } = world({ ticket: answer });
      await everyCallOnTheAPI(client);
      assert.equal(ticketRequests(seen, "generic"), 1, "once for both sandboxes");
      assert.equal(ticketRequests(seen, "metrics"), 1, "once for both sandboxes");
      assert.equal(apiCalls("/exec").length, 6);
      advance(ROUTE_OFF_MS);
      await everyCallOnTheAPI(client);
      assert.equal(ticketRequests(seen, "generic"), 2, "not pinned for life");
    });
  }
});

test("a sleeping sandbox, a rate limit, a refusal about this sandbox or permission, or a 5xx is for that call only", async () => {
  for (const [what, refusal] of [
    [
      "a sleeping sandbox",
      () =>
        Response.json(
          { error: { message: 'Cannot reach a sandbox with status "paused". Wake it first.', code: "sandbox_not_running" } },
          { status: 409 },
        ),
    ],
    ["a rate limit", () => Response.json({ error: { message: "Too many requests." } }, { status: 429 })],
    ["the sandbox's own 404", () => Response.json({ error: { message: "Sandbox not found." } }, { status: 404 })],
    [
      "a permission this key lacks",
      () => Response.json({ error: { message: "Permission sandbox.terminal.connect is required." } }, { status: 403 }),
    ],
    [
      "a workspace only its owner reaches",
      () =>
        Response.json(
          { error: { message: "Workspace w belongs to another user.", code: "workspace_owner_only" } },
          { status: 403 },
        ),
    ],
    ["a 5xx", () => Response.json({ error: { message: "Internal error." } }, { status: 500 })],
  ] as const) {
    let refused = false;
    const { client, seen, apiCalls } = world({
      ticket: () => {
        if (refused) return undefined as never;
        refused = true;
        return refusal();
      },
      gateway: () => Response.json(execResult),
    });
    const sandbox = await client.sandboxes.retrieve(SANDBOX);
    assert.equal((await sandbox.commands.run("true")).stdout, "from the api\n", what);
    const other = await client.sandboxes.retrieve(OTHER);
    assert.equal((await other.commands.run("true")).stdout, "from the gateway\n", `${what}: not every sandbox`);
    assert.equal((await sandbox.commands.run("true")).stdout, "from the gateway\n", `${what}: not this sandbox for good`);
    assert.equal(ticketRequests(seen, "generic"), 3, what);
    assert.equal(apiCalls("/exec").length, 1, what);
  }
});

test("a host without a gateway keeps that sandbox on the API, and no other", async () => {
  let first = true;
  const { client, seen, apiCalls } = world({
    ticket: () => {
      if (!first) return undefined as never;
      first = false;
      return Response.json(
        { error: { message: "This sandbox's host has no gateway yet.", code: "host_gateway_unavailable" } },
        { status: 409 },
      );
    },
    gateway: () => Response.json(execResult),
  });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  assert.equal((await sandbox.commands.run("true")).stdout, "from the api\n");
  assert.equal((await sandbox.commands.run("true")).stdout, "from the api\n");
  const other = await client.sandboxes.retrieve(OTHER);
  assert.equal((await other.commands.run("true")).stdout, "from the gateway\n");
  assert.equal(ticketRequests(seen, "generic"), 2, "none again for the pinned sandbox");
  assert.equal(apiCalls("/exec").length, 2);
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

// REM-906: which gateway failures send a call to the API.
const cloudflare502 = () =>
  new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } });

test("a transient gateway failure on a read falls back to the API, and the next read tries the gateway again", async () => {
  for (const [label, answer] of [
    ["502 sandbox_unavailable", () => Response.json({ error: { message: "sandbox unreachable", code: "sandbox_unavailable" } }, { status: 502 })],
    ["code-less 502 from envd", () => Response.json({ error: { message: "envd: connection reset" } }, { status: 502 })],
    ["500", () => Response.json({ error: { message: "boom" } }, { status: 500 })],
    ["503 policy_lost", () => Response.json({ error: { message: "lost", code: "policy_lost" } }, { status: 503 })],
    ["Cloudflare's own 502 page", cloudflare502],
    ["Cloudflare 530, no body", () => new Response(null, { status: 530 })],
  ] as const) {
    let calls = 0;
    const { client, apiCalls } = world({
      hostGateway: true,
      gateway: () => (++calls === 1 ? answer() : Response.json(liveMetrics)),
    });
    const sandbox = await client.sandboxes.retrieve(SANDBOX);
    assert.equal((await sandbox.metrics.get()).cpuPercent, 1, `${label}: from the API`);
    assert.equal(apiCalls("/metrics/live").length, 1, label);
    assert.equal((await sandbox.metrics.get()).cpuPercent, 12.5, `${label}: the gateway again`);
    assert.equal(calls, 2, label);
  }

  // File reads, the same.
  const { client, apiCalls } = world({ hostGateway: true, gateway: cloudflare502 });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  assert.equal(await sandbox.files.readText("a"), "api");
  assert.deepEqual((await sandbox.files.list()).entries, []);
  assert.equal(apiCalls("/file").length, 1);
  assert.equal(apiCalls("/files").length, 1);
});

test("a command or a write is never sent twice once it may have run", async () => {
  for (const [label, answer] of [
    ["502 from envd", () => Response.json({ error: { message: "envd: stream cut" } }, { status: 502 })],
    ["500", () => Response.json({ error: { message: "boom" } }, { status: 500 })],
    ["503 policy_lost", () => Response.json({ error: { message: "lost", code: "policy_lost" } }, { status: 503 })],
    ["Cloudflare's own 502 page", cloudflare502],
    ["Cloudflare 524 timeout", () => new Response("timeout", { status: 524 })],
  ] as const) {
    const { client, apiCalls } = world({ hostGateway: true, gateway: answer });
    const sandbox = await client.sandboxes.retrieve(SANDBOX);
    await assert.rejects(sandbox.commands.run("make deploy"), RemoteHostAPIError, label);
    await assert.rejects(sandbox.files.write("a", "x"), RemoteHostAPIError, label);
    assert.equal(apiCalls("/exec").length, 0, label);
    assert.equal(apiCalls("/file").length, 0, label);
  }
});

test("a command or a write falls back when the gateway refused it before touching the sandbox", async () => {
  for (const [label, answer] of [
    ["404 no_credential", () => Response.json({ error: { message: "No envd credential for this sandbox.", code: "no_credential" } }, { status: 404 })],
    ["the code-less no-credential 404 of older gateways", () => Response.json({ error: { message: "No envd credential for this sandbox.", code: "" } }, { status: 404 })],
    ["404 not_found, the group off", () => Response.json({ error: { message: "Not found.", code: "not_found" } }, { status: 404 })],
    ["a plain-text 404, the route not there", () => new Response("404 page not found\n", { status: 404 })],
    ["429 too_many_streams", () => Response.json({ error: { message: "At most 16", code: "too_many_streams" } }, { status: 429 })],
    ["Cloudflare's 429", () => new Response("rate limited", { status: 429 })],
  ] as const) {
    const { client, apiCalls } = world({ hostGateway: true, gateway: answer });
    const sandbox = await client.sandboxes.retrieve(SANDBOX);
    assert.equal((await sandbox.commands.run("true")).stdout, "from the api\n", label);
    assert.equal((await sandbox.files.write("a", "x")).size, 1, label);
    assert.equal(apiCalls("/exec").length, 1, label);
    assert.equal(apiCalls("/file").length, 1, label);
  }
});

test("an answer in the API's own words is the answer, not a fallback, even for a read", async () => {
  for (const [status, message] of [
    [404, "/code/a was not found in the workspace."],
    [400, "path is required."],
    [413, "The file is too large."],
  ] as const) {
    const { client, apiCalls } = world({
      hostGateway: true,
      gateway: () => Response.json({ error: { message, code: "" } }, { status }),
    });
    const sandbox = await client.sandboxes.retrieve(SANDBOX);
    await assert.rejects(sandbox.files.readText("a"), (error: unknown) => {
      assert.ok(error instanceof RemoteHostAPIError);
      assert.equal(error.status, status);
      return true;
    });
    assert.equal(apiCalls("/file").length, 0, message);
  }
});

test("the fallback policy, answer by answer", () => {
  const read = { idempotent: true };
  const run = { idempotent: false };
  const coded = (code: string, message = "m") => ({ error: { message, code } });
  const cases: [string, number, unknown, boolean, boolean][] = [
    // label, status, body, read falls back, command falls back
    ["missing_ticket", 401, coded("missing_ticket"), true, true],
    ["invalid_ticket", 403, coded("invalid_ticket"), true, true],
    ["policy_unavailable", 503, coded("policy_unavailable"), true, true],
    ["credential_unavailable", 503, coded("credential_unavailable"), true, true],
    ["no_credential", 404, coded("no_credential"), true, true],
    ["not_found", 404, coded("not_found"), true, true],
    ["too_many_streams", 429, coded("too_many_streams"), true, true],
    ["old no-credential 404", 404, coded("", "No envd credential for this sandbox."), true, true],
    ["plain 404", 404, "404 page not found", true, true],
    ["empty 429", 429, null, true, true],
    ["policy_lost", 503, coded("policy_lost"), true, false],
    ["sandbox_unavailable", 502, coded("sandbox_unavailable"), true, false],
    ["code-less 500", 500, coded(""), true, false],
    ["HTML 502", 502, "<html>", true, false],
    ["non-JSON 403 from the edge", 403, "<html>blocked</html>", true, false],
    ["access_revoked", 403, coded("access_revoked"), false, false],
    ["file not in the workspace", 404, coded("", "/code/a was not found in the workspace."), false, false],
    ["bad body", 400, coded("invalid_body"), false, false],
  ];
  for (const [label, status, body, readFallsBack, runFallsBack] of cases) {
    assert.equal(fallsBack(read, status, body), readFallsBack, `read: ${label}`);
    assert.equal(fallsBack(run, status, body), runFallsBack, `command: ${label}`);
  }
});

// Which failures send a sandbox's later calls to the API for good (REM-906):
// only a gateway that would not take the API's own ticket.
test("only a refused ticket keeps a sandbox on the API; every other failure is for that call", async () => {
  const pinned = [
    [401, "missing_ticket"],
    [403, "invalid_ticket"],
  ] as const;
  const passing = [
    [503, "credential_unavailable"],
    [404, "no_credential"],
    [404, "not_found"],
    [503, "policy_unavailable"],
    [429, "too_many_streams"],
    [502, "sandbox_unavailable"],
  ] as const;
  assert.deepEqual([...GATEWAY_BROKEN_FOR_SANDBOX].sort(), pinned.map(([, code]) => code).sort());

  for (const [status, code] of [...pinned, ...passing]) {
    let calls = 0;
    const { client, seen } = world({
      hostGateway: true,
      gateway: () =>
        ++calls === 1 ? Response.json({ error: { message: "no", code } }, { status }) : Response.json(liveMetrics),
    });
    const sandbox = await client.sandboxes.retrieve(SANDBOX);
    assert.equal((await sandbox.metrics.get()).cpuPercent, 1, `${code}: the API`);
    const second = await sandbox.metrics.get();
    const tickets = seen.filter((s) => s.url.includes("gateway-ticket")).length;
    if (pinned.some(([, pinnedCode]) => pinnedCode === code)) {
      assert.equal(second.cpuPercent, 1, `${code}: still the API`);
      assert.equal(tickets, 1, `${code}: no second ticket`);
    } else {
      assert.equal(second.cpuPercent, 12.5, `${code}: the gateway again`);
      assert.equal(tickets, 2, `${code}: a second ticket`);
    }
  }
});

test("a lost connection on a read falls back for that call, and later calls use the gateway", async () => {
  let calls = 0;
  const { client, apiCalls } = world({
    hostGateway: true,
    gateway: () => {
      if (++calls === 1) throw new TypeError("fetch failed: ECONNRESET");
      return Response.json(execResult);
    },
  });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  assert.equal((await sandbox.metrics.get()).cpuPercent, 1);
  assert.equal((await sandbox.commands.run("true")).stdout, "from the gateway\n");
  assert.equal(apiCalls("/exec").length, 0);
});

test("a 2xx cut off: a read falls back, a command or a write is an error and never sent twice", async () => {
  for (const [label, answer] of [
    ["an empty body", () => new Response(null, { status: 200 })],
    ["JSON cut off", () => new Response('{"exitCode":0,"std', { status: 200, headers: { "content-type": "application/json" } })],
    ["not JSON", () => new Response("<html>ok</html>", { status: 200 })],
  ] as const) {
    // Reads and writes on separate clients, each under FAILING_PIN_AFTER,
    // so every call meets the gateway rather than the pin.
    const reads = world({ hostGateway: true, gateway: answer });
    const readSandbox = await reads.client.sandboxes.retrieve(SANDBOX);
    assert.equal((await readSandbox.metrics.get()).cpuPercent, 1, `${label}: metrics from the API`);
    assert.equal(await readSandbox.files.readText("a"), "api", `${label}: read from the API`);
    const { client, apiCalls } = world({ hostGateway: true, gateway: answer });
    const sandbox = await client.sandboxes.retrieve(SANDBOX);
    await assert.rejects(sandbox.commands.run("make deploy"), RemoteHostConnectionError, label);
    await assert.rejects(sandbox.files.write("a", "x"), RemoteHostConnectionError, label);
    assert.equal(apiCalls("/exec").length, 0, label);
    assert.equal(apiCalls("/file").filter((s) => s.method === "PUT").length, 0, label);
  }
});

test("a read that times out on the gateway falls back; a command that times out is an error", async () => {
  // A gateway that answers long after the client's 50 ms. Its timer is what
  // keeps the loop alive, as a real open socket would: AbortSignal.timeout's
  // own timer does not.
  const timers: ReturnType<typeof setTimeout>[] = [];
  const late = () => new Promise<Response>((resolve) => timers.push(setTimeout(() => resolve(Response.json(liveMetrics)), 5_000)));
  const { client, apiCalls } = world({ hostGateway: true, timeoutMs: 50, gateway: late });
  try {
    const sandbox = await client.sandboxes.retrieve(SANDBOX);
    assert.equal((await sandbox.metrics.get()).cpuPercent, 1);
    assert.equal(await sandbox.files.readText("a"), "api");
    await assert.rejects(sandbox.commands.run("sleep 600"), RemoteHostTimeoutError);
    assert.equal(apiCalls("/exec").length, 0);
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
});

test("a command whose answer the timeout cuts off is a timeout, not an incomplete answer", async () => {
  // Headers at once, then half a body, then the connection drops well after
  // the client's 50 ms.
  const cutOff = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"exitCode":0,'));
          setTimeout(() => controller.error(new Error("connection reset")), 200);
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const { client, apiCalls } = world({ hostGateway: true, timeoutMs: 50, gateway: cutOff });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  await assert.rejects(sandbox.commands.run("make deploy"), RemoteHostTimeoutError);
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

// REM-967: a connection that never opened sent nothing, so a command or a
// write goes to the API too; one that opened and was lost does not.
function fetchFailed(code: string) {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(`connect ${code}`), { code }) });
}

const NEVER_CONNECTED_CODES = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"];

test("each never-connected code, on the error or its cause, is a connection that never opened", () => {
  for (const code of NEVER_CONNECTED_CODES) {
    assert.equal(neverConnected(fetchFailed(code)), true, code);
    assert.equal(neverConnected(Object.assign(new Error(code), { code })), true, code);
  }
});

// Review A of #811, finding 1: a fetch the caller passed may retry, so a
// refused connection says nothing about an earlier attempt.
test("through the caller's fetch, a command or a write whose gateway connection never opened is an error, never sent to the API", async () => {
  for (const code of NEVER_CONNECTED_CODES) {
    const { client, apiCalls } = world({
      hostGateway: true,
      gateway: () => {
        throw fetchFailed(code);
      },
    });
    const sandbox = await client.sandboxes.retrieve(SANDBOX);
    await assert.rejects(sandbox.commands.run("make deploy"), (error: unknown) => {
      assert.ok(error instanceof RemoteHostConnectionError, code);
      assert.match(error.message, /custom fetch or dispatcher/, code);
      return true;
    });
    await assert.rejects(sandbox.files.write("a", "x"), RemoteHostConnectionError, code);
    assert.equal(apiCalls("/exec").length, 0, `${code}: never on the API`);
    assert.equal(apiCalls("/file").filter((s) => s.method === "PUT").length, 0, code);
    // A read still goes to the API.
    assert.equal(await sandbox.files.readText("a"), "api", code);
  }
});

test("through a fetch that retries, a command sent before a refused retry is never sent again through the API", async () => {
  // The first attempt delivers the call and is reset; the retry is refused.
  const delivered: unknown[] = [];
  let attempts = 0;
  const { client, apiCalls } = world({
    hostGateway: true,
    retryGateway: true,
    gateway: async (request) => {
      attempts += 1;
      if (attempts % 2 === 1) {
        delivered.push(await request.json());
        throw fetchFailed("ECONNRESET");
      }
      throw fetchFailed("ECONNREFUSED");
    },
  });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  await assert.rejects(sandbox.commands.run("make deploy"), RemoteHostConnectionError);
  await assert.rejects(sandbox.files.write("a", "x"), RemoteHostConnectionError);
  assert.equal(delivered.length, 2, "each reached the gateway once");
  assert.equal(apiCalls("/exec").length, 0, "and never the API");
  assert.equal(apiCalls("/file").filter((s) => s.method === "PUT").length, 0);
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// A gateway that reads each whole request, then resets the connection: the
// call reached it, and no answer came back.
async function resettingGateway() {
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
      const head = received.indexOf("\r\n\r\n");
      if (head < 0) return;
      const length = Number(/content-length: *(\d+)/i.exec(received.slice(0, head))?.[1] ?? 0);
      if (received.length - head - 4 < length) return;
      requests.push(received);
      socket.resetAndDestroy();
    });
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// A client with no fetch of its own, under Node: the API is
// globalThis.fetch, faked here, and the gateway is reached for real at
// `gatewayUrl` by the SDK's own transport. The fake global fetch stands for
// a global dispatcher that retries (undici's RetryAgent): a gateway request
// through it was delivered by a first attempt and reset, and its retry was
// refused.
function nodeWorld(t: TestContext, gatewayUrl: string) {
  const seen: Seen[] = [];
  const throughGlobalFetch: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = request.body ? await request.text() : "";
    seen.push({ method: request.method, url: request.url, authorization: request.headers.get("authorization"), body: text ? JSON.parse(text) : null });
    if (url.origin === new URL(gatewayUrl).origin) {
      throughGlobalFetch.push(`${request.method} ${url.pathname}`);
      throw fetchFailed("ECONNREFUSED");
    }
    if (url.pathname.endsWith("/gateway-ticket")) {
      return Response.json({ ticket: "rh_hgt_ticket", gatewayUrl, expiresAt: new Date(Date.now() + 30_000).toISOString(), sandboxId: SANDBOX });
    }
    if (url.pathname.endsWith(`/sandboxes/${SANDBOX}`)) return Response.json({ sandbox: sandboxData });
    if (url.pathname.endsWith("/exec")) {
      return Response.json({ exitCode: 0, stdout: "from the api\n", stderr: "", truncated: false, timedOut: false });
    }
    if (url.pathname.endsWith("/file") && request.method === "PUT") return Response.json({ path: "/code/a", size: 1 });
    return Response.json({ error: { message: `unexpected ${request.method} ${url.pathname}` } }, { status: 500 });
  });
  const client = new RemoteHost({ apiKey: "rh_secret_key", orgId: "org_123", maxRetries: 0, hostGateway: true });
  const apiCalls = (suffix: string) =>
    seen.filter((s) => s.url.startsWith("https://api.remotehost.ai/") && new URL(s.url).pathname.endsWith(suffix));
  return { client, apiCalls, throughGlobalFetch };
}

test("without a fetch of its own, a command or a write reaches the gateway once, whatever the global dispatcher retries", async (t) => {
  const gateway = await resettingGateway();
  t.after(gateway.close);
  const { client, apiCalls, throughGlobalFetch } = nodeWorld(t, gateway.url);
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  await assert.rejects(sandbox.commands.run("make deploy"), RemoteHostConnectionError);
  await assert.rejects(sandbox.files.write("a", "x"), RemoteHostConnectionError);
  assert.equal(gateway.requests.length, 2, "each sent to the gateway once");
  assert.match(gateway.requests[0]!, /^POST \/v1\/exec /);
  assert.match(gateway.requests[1]!, /^PUT \/v1\/file /);
  assert.deepEqual(throughGlobalFetch, [], "not through globalThis.fetch");
  assert.equal(apiCalls("/exec").length, 0, "never on the API");
  assert.equal(apiCalls("/file").length, 0);
});

test("without a fetch of its own, a command or a write goes to the API when the gateway's connection never opened", async (t) => {
  const port = await closedPort();
  // 127.0.0.1 refuses once; localhost may try ::1 and 127.0.0.1, which
  // Node reports as an AggregateError.
  for (const host of ["127.0.0.1", "localhost"]) {
    const { client, apiCalls, throughGlobalFetch } = nodeWorld(t, `http://${host}:${port}`);
    const sandbox = await client.sandboxes.retrieve(SANDBOX);
    assert.equal((await sandbox.commands.run("make deploy")).stdout, "from the api\n", host);
    assert.equal((await sandbox.files.write("a", "x")).path, "/code/a", host);
    assert.equal(apiCalls("/exec").length, 1, `${host}: one run, on the API`);
    assert.equal(apiCalls("/file").filter((s) => s.method === "PUT").length, 1, host);
    assert.deepEqual(throughGlobalFetch, [], host);
    t.mock.restoreAll();
  }
});

// Review A of #811, finding 2: Node's AggregateError carries the first
// attempt's code itself, so every attempt must be read whatever it says.
test("Node's AggregateError of every address refused is a connection that never opened; one reset among them is not", async () => {
  const refused = (address: string) => Object.assign(new Error(`connect ECONNREFUSED ${address}`), { code: "ECONNREFUSED" });
  const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  // Shaped as Node makes it: `code` set to the first attempt's.
  const aggregate = (attempts: Error[]) =>
    Object.assign(new AggregateError(attempts), { code: (attempts[0] as { code?: string } | undefined)?.code });
  assert.equal(neverConnected(new TypeError("fetch failed", { cause: aggregate([refused("::1"), refused("127.0.0.1")]) })), true);
  assert.equal(neverConnected(new TypeError("fetch failed", { cause: aggregate([refused("::1"), reset]) })), false);
  assert.equal(neverConnected(aggregate([refused("::1"), reset])), false);
  assert.equal(neverConnected(new TypeError("fetch failed")), false, "no code: may have been sent");
  assert.equal(neverConnected(Object.assign(new AggregateError([]), { code: "ECONNREFUSED" })), false);

  // And Node's own, from a connect to every address of localhost refused.
  const port = await closedPort();
  const real = await new Promise<Error>((resolve) => connect({ host: "localhost", port }).on("error", resolve));
  assert.equal(neverConnected(real), true, `${real.constructor.name} ${(real as { code?: string }).code}`);
});

// The pin's clock, under the test's control.
function pinClock(t: TestContext) {
  let now = performance.now();
  t.mock.method(performance, "now", () => now);
  return (ms: number) => {
    now += ms;
  };
}

// Past any pin, however it was jittered.
const PAST_PIN = FAILING_PIN_MS * (1 + FAILING_PIN_JITTER) + 1;

test("a reset after the connection opened still throws for a command or a write, never a second run", async () => {
  for (const code of ["ECONNRESET", "UND_ERR_SOCKET", "ETIMEDOUT", "EPIPE"]) {
    const { client, apiCalls } = world({
      hostGateway: true,
      gateway: () => {
        throw fetchFailed(code);
      },
    });
    const sandbox = await client.sandboxes.retrieve(SANDBOX);
    await assert.rejects(sandbox.commands.run("make deploy"), RemoteHostConnectionError, code);
    await assert.rejects(sandbox.files.write("a", "x"), RemoteHostConnectionError, code);
    assert.equal(apiCalls("/exec").length, 0, code);
    assert.equal(apiCalls("/file").filter((s) => s.method === "PUT").length, 0, code);
  }
});

test("a gateway that keeps failing a sandbox is skipped for a while, with no ticket requests", async (t) => {
  const advance = pinClock(t);
  let gatewayCalls = 0;
  let healthy = false;
  const { client, apiCalls } = world({
    hostGateway: true,
    gateway: () => {
      gatewayCalls += 1;
      return healthy
        ? Response.json(liveMetrics)
        : Response.json({ error: { message: "no credential", code: "credential_unavailable" } }, { status: 503 });
    },
  });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  for (let i = 0; i < FAILING_PIN_AFTER; i += 1) assert.equal((await sandbox.metrics.get()).cpuPercent, 1);
  assert.equal(gatewayCalls, FAILING_PIN_AFTER);
  const tickets = () => apiCalls("/gateway-ticket").length;
  assert.equal(tickets(), FAILING_PIN_AFTER);

  // Pinned: the API, with no ticket and no gateway call.
  for (let i = 0; i < 5; i += 1) assert.equal((await sandbox.commands.run("true")).stdout, "from the api\n");
  assert.equal(gatewayCalls, FAILING_PIN_AFTER);
  assert.equal(tickets(), FAILING_PIN_AFTER);

  // Another sandbox is not pinned.
  const other = await client.sandboxes.retrieve(OTHER);
  await other.metrics.get();
  assert.equal(gatewayCalls, FAILING_PIN_AFTER + 1);

  // Past the pin, one read tries; a failure pins again at once.
  advance(PAST_PIN);
  assert.equal((await sandbox.metrics.get()).cpuPercent, 1);
  assert.equal(gatewayCalls, FAILING_PIN_AFTER + 2);
  await sandbox.metrics.get();
  assert.equal(gatewayCalls, FAILING_PIN_AFTER + 2, "pinned again after one failure");

  // Past that pin, a success clears the count.
  advance(PAST_PIN);
  healthy = true;
  assert.equal((await sandbox.metrics.get()).cpuPercent, 12.5);
  healthy = false;
  for (let i = 0; i < FAILING_PIN_AFTER - 1; i += 1) await sandbox.metrics.get();
  healthy = true;
  assert.equal((await sandbox.metrics.get()).cpuPercent, 12.5, "under the count: still the gateway");
});

test("a success, or an answer in the API's own words, resets the count", async () => {
  let calls = 0;
  const { client } = world({
    hostGateway: true,
    gateway: () => {
      calls += 1;
      // fail, fail, the API's own 404, fail, fail, then healthy
      if (calls === 3) return Response.json({ error: { message: "Path was not found in the workspace." } }, { status: 404 });
      if (calls <= 5) return Response.json({ error: { message: "boom" } }, { status: 500 });
      return Response.json({ content: "gw", encoding: "utf8", size: 2, path: "/code/a" });
    },
  });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  await sandbox.files.readText("a");
  await sandbox.files.readText("a");
  await assert.rejects(sandbox.files.readText("a"), RemoteHostAPIError);
  await sandbox.files.readText("a");
  await sandbox.files.readText("a");
  assert.equal(await sandbox.files.readText("a"), "gw", "never three failures in a row, so never pinned");
  assert.equal(calls, 6);
});

// Review B of #751: the abort branch of the cut-off 2xx check.
test("a command whose cut-off answer the caller aborts gives the abort's reason, and is never sent to the API", async () => {
  const controller = new AbortController();
  const cutOff = () =>
    new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"exitCode":0,'));
          setTimeout(() => controller.abort(new Error("caller gave up")), 20);
          setTimeout(() => stream.error(new Error("connection reset")), 100);
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const { client, apiCalls } = world({ hostGateway: true, gateway: cutOff });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  await assert.rejects(sandbox.commands.run("make deploy", { signal: controller.signal }), /caller gave up/);
  assert.equal(apiCalls("/exec").length, 0);
});

// Review A of #811, finding 3: a 429 is not a success, and an answer to a
// call sent before the pin says nothing about the gateway since.
const cloudflare429 = () => new Response("<html>rate limited</html>", { status: 429 });

test("a 429 neither counts as a failure nor clears the count", async (t) => {
  pinClock(t);
  const answers = [cloudflare502, cloudflare502, cloudflare429, cloudflare502];
  let gatewayCalls = 0;
  const { client } = world({ hostGateway: true, gateway: () => (answers[gatewayCalls++] ?? (() => Response.json(liveMetrics)))() });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  for (let i = 0; i < answers.length; i += 1) assert.equal((await sandbox.metrics.get()).cpuPercent, 1);
  assert.ok(hostGatewayFor(client.raw)!.failingUntil(SANDBOX) !== undefined, "failure, failure, 429, failure pins");
  await sandbox.metrics.get();
  assert.equal(gatewayCalls, answers.length, "pinned: no gateway call");
});

async function until(condition: () => boolean) {
  for (let i = 0; i < 1_000 && !condition(); i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(condition());
}

test("an answer to a call sent before the pin, a 2xx or a 429, leaves the pin", async (t) => {
  pinClock(t);
  const held: Array<(answer: Response) => void> = [];
  const { client } = world({ hostGateway: true, gateway: () => new Promise<Response>((resolve) => held.push(resolve)) });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  const gateway = hostGatewayFor(client.raw)!;
  const calls = Array.from({ length: 5 }, () => sandbox.metrics.get());
  await until(() => held.length === 5);
  for (let i = 0; i < FAILING_PIN_AFTER; i += 1) {
    held[i]!(cloudflare502());
    assert.equal((await calls[i]!).cpuPercent, 1);
  }
  assert.ok(gateway.failingUntil(SANDBOX) !== undefined, "pinned");
  held[3]!(Response.json(liveMetrics));
  held[4]!(cloudflare429());
  assert.equal((await calls[3]!).cpuPercent, 12.5, "the late answer is still the call's answer");
  assert.equal((await calls[4]!).cpuPercent, 1);
  assert.ok(gateway.failingUntil(SANDBOX) !== undefined, "still pinned");
  await sandbox.metrics.get();
  assert.equal(held.length, 5, "no gateway call while pinned");
});

// Review A of #811, finding 4, and review B: past the pin exactly one call
// probes the gateway, and it is a read.
// Whether a sandbox is still pinned, the pin run out or not: until a read
// probe succeeds.
function pinned(client: RemoteHost): boolean {
  return (hostGatewayFor(client.raw) as unknown as { failing: Map<string, { until: number }> }).failing.get(SANDBOX)?.until
    ? true
    : false;
}

test("past the pin exactly one call probes the gateway, a read; commands and writes keep to the API", async (t) => {
  const advance = pinClock(t);
  let failing = true;
  const gatewayRequests: string[] = [];
  let releaseProbe: ((answer: Response) => void) | undefined;
  const { client, apiCalls } = world({
    hostGateway: true,
    gateway: (request) => {
      const path = new URL(request.url).pathname;
      gatewayRequests.push(`${request.method} ${path}`);
      if (failing) return cloudflare502();
      if (request.method === "GET" && !releaseProbe) return new Promise<Response>((resolve) => (releaseProbe = resolve));
      return path === "/v1/exec" ? Response.json(execResult) : Response.json(liveMetrics);
    },
  });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  for (let i = 0; i < FAILING_PIN_AFTER; i += 1) await sandbox.metrics.get();
  assert.ok(hostGatewayFor(client.raw)!.failingUntil(SANDBOX) !== undefined, "pinned");
  failing = false;
  advance(PAST_PIN);
  const tickets = apiCalls("/gateway-ticket").length;

  // Eight at once, a command first: it sets off the SDK's own read, and
  // every call keeps to the API while that is out.
  const results = await Promise.all([
    sandbox.commands.run("make deploy"),
    sandbox.files.write("a", "x"),
    sandbox.metrics.get(),
    sandbox.commands.run("make test"),
    sandbox.files.readText("a"),
    sandbox.metrics.get(),
    sandbox.files.write("b", "y"),
    sandbox.commands.run("true"),
  ]);
  await until(() => releaseProbe !== undefined);
  assert.deepEqual(gatewayRequests.slice(FAILING_PIN_AFTER), ["GET /v1/files"], "exactly one gateway call, a read");
  assert.equal(apiCalls("/gateway-ticket").length, tickets + 1, "one ticket, the probe's");
  assert.equal(apiCalls("/exec").length, 3, "every command on the API");
  assert.equal((results[2] as { cpuPercent: number }).cpuPercent, 1, "reads on the API too");
  assert.ok(pinned(client), "still pinned while the probe is out");

  // The probe succeeds: the pin is lifted, and commands use the gateway.
  releaseProbe!(Response.json({ path: "/code", truncated: false, entries: [] }));
  await until(() => !pinned(client));
  assert.equal((await sandbox.commands.run("true")).stdout, "from the gateway\n");
});

test("a client that only runs commands comes back to the gateway past the pin, through the SDK's own read", async (t) => {
  const advance = pinClock(t);
  let failing = true;
  const gatewayRequests: string[] = [];
  const { client } = world({
    hostGateway: true,
    gateway: (request) => {
      const path = new URL(request.url).pathname;
      gatewayRequests.push(`${request.method} ${path}`);
      if (failing) return cloudflare502();
      return path === "/v1/exec" ? Response.json(execResult) : Response.json({ path: "/code", truncated: false, entries: [] });
    },
  });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  for (let i = 0; i < FAILING_PIN_AFTER; i += 1) await sandbox.metrics.get();
  advance(PAST_PIN);

  // The gateway still fails: the SDK's read re-pins, and the command ran on the API.
  assert.equal((await sandbox.commands.run("true")).stdout, "from the api\n");
  await until(() => hostGatewayFor(client.raw)!.failingUntil(SANDBOX) !== undefined);
  assert.deepEqual(gatewayRequests.slice(FAILING_PIN_AFTER), ["GET /v1/files"]);

  // Healthy again, past that pin: the next command's read lifts it.
  failing = false;
  advance(PAST_PIN);
  assert.equal((await sandbox.commands.run("true")).stdout, "from the api\n");
  await until(() => !pinned(client));
  assert.equal((await sandbox.commands.run("true")).stdout, "from the gateway\n");
  assert.deepEqual(gatewayRequests.slice(FAILING_PIN_AFTER), ["GET /v1/files", "GET /v1/files", "POST /v1/exec"]);
});

test("a probe that fails pins the sandbox again, and a 429 on the probe lets the next read probe", async (t) => {
  const advance = pinClock(t);
  const answers: Array<() => Response> = [];
  let gatewayCalls = 0;
  const { client } = world({
    hostGateway: true,
    gateway: () => (answers[gatewayCalls++] ?? cloudflare502)(),
  });
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  const gateway = hostGatewayFor(client.raw)!;
  for (let i = 0; i < FAILING_PIN_AFTER; i += 1) await sandbox.metrics.get();
  assert.ok(gateway.failingUntil(SANDBOX) !== undefined);

  advance(PAST_PIN);
  // Indexed by the gateway call; a 502 where there is none.
  answers[FAILING_PIN_AFTER] = cloudflare429;
  answers[FAILING_PIN_AFTER + 1] = () => Response.json(liveMetrics);
  assert.equal((await sandbox.metrics.get()).cpuPercent, 1, "the probe's 429: the API");
  assert.equal(gateway.failingUntil(SANDBOX), undefined, "a 429 does not pin");
  assert.equal((await sandbox.metrics.get()).cpuPercent, 12.5, "the next read probes, and succeeds");
  assert.equal(gatewayCalls, FAILING_PIN_AFTER + 2);

  // Fail again: pinned; past it, a failed probe pins at once.
  for (let i = 0; i < FAILING_PIN_AFTER; i += 1) await sandbox.metrics.get();
  assert.ok(gateway.failingUntil(SANDBOX) !== undefined);
  advance(PAST_PIN);
  await sandbox.metrics.get();
  assert.ok(gateway.failingUntil(SANDBOX) !== undefined, "a failed probe pins again");
  const calls = gatewayCalls;
  await sandbox.metrics.get();
  assert.equal(gatewayCalls, calls);
});

test("a pin is jittered by up to a tenth either way", async (t) => {
  pinClock(t);
  const pinnedAt = performance.now();
  for (const random of [0, 0.5, 0.999]) {
    t.mock.method(Math, "random", () => random);
    const { client } = world({ hostGateway: true, gateway: cloudflare502 });
    const sandbox = await client.sandboxes.retrieve(SANDBOX);
    for (let i = 0; i < FAILING_PIN_AFTER; i += 1) await sandbox.metrics.get();
    const pin = hostGatewayFor(client.raw)!.failingUntil(SANDBOX)! - pinnedAt;
    assert.ok(Math.abs(pin - FAILING_PIN_MS * (1 - FAILING_PIN_JITTER + 2 * FAILING_PIN_JITTER * random)) < 1e-6, `${random}: ${pin}`);
  }
});

// Review B of 7316d4fa: the SDK's transport gives up on a connection that is
// never ready, a TLS handshake that fails sent nothing, and neither bound
// ever cuts a request once sent.
const gatewayCommand = {
  permission: "sandbox.terminal.connect",
  method: "POST",
  path: "/v1/exec",
  body: { command: "make deploy" },
  idempotent: false,
} as const;

// A HostGateway on the SDK's transport, with a fake API that issues tickets
// for `gatewayUrl`.
function onTransport(gatewayUrl: string, options: { connectTimeoutMs: number; idleTimeoutMs?: number }) {
  const transport = sdkGatewayFetch(options);
  assert.ok(transport);
  return new HostGateway({
    baseUrl: "https://api.remotehost.ai/v1",
    headers: new Headers({ authorization: "Bearer rh_secret_key" }),
    fetch: transport,
    apiFetch: async () => Response.json({ ticket: "rh_hgt_ticket", gatewayUrl, expiresAt: "", sandboxId: SANDBOX }),
    timeoutMs: 3_000,
  });
}

// A TCP server on 127.0.0.1 that does `onConnection` with each connection,
// and keeps what each one sent.
async function tcpGateway(onConnection: (socket: Socket) => void) {
  const received: Buffer[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (chunk) => received.push(chunk));
    onConnection(socket);
  });
  const port = await listen(server);
  return {
    port,
    received: () => Buffer.concat(received),
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("a gateway that never completes the connection is given up on after the connect timeout, and a command goes to the API", async (t) => {
  // Takes the connection, then says nothing to the TLS handshake.
  const silent = await tcpGateway(() => {});
  t.after(silent.close);
  const started = Date.now();
  const answer = await onTransport(`https://127.0.0.1:${silent.port}`, { connectTimeoutMs: 100 }).call(SANDBOX, gatewayCommand);
  assert.equal(answer, USE_API, "nothing was sent, so the API");
  assert.ok(Date.now() - started < 2_000, `gave up after ${Date.now() - started} ms`);
  assert.equal(silent.received()[0], 0x16, "only a TLS handshake reached it");
  assert.ok(!silent.received().includes("make deploy"));
});

test("a TLS handshake that fails sent nothing, so a command goes to the API", async (t) => {
  const cases: Array<[string, (socket: Socket) => void]> = [
    ["an answer that is not TLS", (socket) => void socket.once("data", () => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"))],
    ["closed at once", (socket) => void socket.end()],
    ["reset on the ClientHello", (socket) => void socket.once("data", () => socket.resetAndDestroy())],
  ];
  for (const [label, onConnection] of cases) {
    const gateway = await tcpGateway(onConnection);
    t.after(gateway.close);
    const answer = await onTransport(`https://127.0.0.1:${gateway.port}`, { connectTimeoutMs: 2_000 }).call(SANDBOX, gatewayCommand);
    assert.equal(answer, USE_API, label);
    assert.ok(!gateway.received().includes("make deploy"), label);
  }
});

test("the connect timeout never cuts a request once sent: a slow but healthy gateway answers, on a fresh socket and a kept-alive one", async (t) => {
  const requests: string[] = [];
  const server = createHttpServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    // Well past the connect timeout and the idle timeout: the head, half
    // the body, then the rest.
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"exitCode":7,"stdout":"from the gateway\\n",');
      setTimeout(() => response.end('"stderr":"","truncated":false,"timedOut":false}'), 300);
    }, 300);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const gateway = onTransport(`http://127.0.0.1:${address.port}`, { connectTimeoutMs: 50, idleTimeoutMs: 50 });
  for (const label of ["fresh", "again"]) {
    const answer = await gateway.call<{ stdout: string }>(SANDBOX, gatewayCommand);
    assert.notEqual(answer, USE_API, label);
    assert.equal((answer as { stdout: string }).stdout, "from the gateway\n", label);
  }
  const read = await gateway.call<{ exitCode: number }>(SANDBOX, { ...gatewayCommand, idempotent: true });
  assert.equal((read as { exitCode: number }).exitCode, 7, "a long read too");
  assert.equal(requests.length, 3, "each sent once");
});

// Review B of 77354589: the SDK's own probe that gets no usable answer pins
// again, so a key refused for reads never costs a ticket request per command.
test("a key that runs commands but can't read files makes one probe per pin, and every command uses the API", async (t) => {
  const advance = pinClock(t);
  const { client, seen, apiCalls } = world({
    hostGateway: true,
    ticket: (permission) =>
      permission === "sandbox.files.read"
        ? Response.json({ error: { message: "Permission sandbox.files.read is required." } }, { status: 403 })
        : Response.json({ ticket: "rh_hgt_ticket", gatewayUrl: GATEWAY, expiresAt: "", sandboxId: SANDBOX }),
    // Refused before running: each command falls back, and counts.
    gateway: () => Response.json({ error: { message: "no credential", code: "credential_unavailable" } }, { status: 503 }),
  });
  const readTickets = () =>
    seen.filter((s) => new URL(s.url).pathname.endsWith("/gateway-ticket") && (s.body as { permission?: string } | null)?.permission === "sandbox.files.read").length;
  const sandbox = await client.sandboxes.retrieve(SANDBOX);
  for (let i = 0; i < FAILING_PIN_AFTER; i += 1) assert.equal((await sandbox.commands.run("true")).stdout, "from the api\n");
  assert.ok(hostGatewayFor(client.raw)!.failingUntil(SANDBOX) !== undefined, "pinned");
  const onTheAPI = () => apiCalls("/exec").length;

  for (const window of [1, 2]) {
    advance(PAST_PIN);
    for (let i = 0; i < 20; i += 1) {
      assert.equal((await sandbox.commands.run("true")).stdout, "from the api\n");
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(readTickets(), window, `one probe in expiry window ${window}`);
    assert.ok(hostGatewayFor(client.raw)!.failingUntil(SANDBOX) !== undefined, "pinned again");
  }
  assert.equal(onTheAPI(), FAILING_PIN_AFTER + 40, "every command on the API");
  assert.equal(seen.filter((s) => s.url.startsWith(GATEWAY)).length, FAILING_PIN_AFTER, "none on the gateway past the pin");
});
