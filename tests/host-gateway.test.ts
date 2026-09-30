import assert from "node:assert/strict";
import test from "node:test";

import RemoteHost, { RemoteHostAPIError, RemoteHostConnectionError, RemoteHostTimeoutError } from "../src/index.js";
import { GATEWAY_BROKEN_FOR_SANDBOX, ROUTE_OFF_MS, fallsBack, isSafeGatewayUrl } from "../src/host-gateway.js";
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
        return new Promise<Response>((resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
          answer.then(resolve, reject);
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
    const { client, apiCalls } = world({ hostGateway: true, gateway: answer });
    const sandbox = await client.sandboxes.retrieve(SANDBOX);
    assert.equal((await sandbox.metrics.get()).cpuPercent, 1, `${label}: metrics from the API`);
    assert.equal(await sandbox.files.readText("a"), "api", `${label}: read from the API`);
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
