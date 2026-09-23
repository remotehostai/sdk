import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import RemoteHost, {
  RemoteHostAPIError,
  RemoteHostConfigurationError,
  RemoteHostTimeoutError,
  VERSION,
} from "../src/index.js";
import type { SandboxData } from "../src/sandboxes.js";

const sandbox: SandboxData = {
  id: "sandbox_123",
  org_id: "org_123",
  project_id: "project_123",
  name: "My sandbox",
  agent: "codex",
  status: "provisioning",
  mode: "persistent",
  region: "us-east",
  persistence_policy: "sleep_resume",
  sandbox_profile: "agent-standard",
  machine_size: "default",
  allocated_vcpu: 4,
  allocated_memory_gb: 8,
  allocated_disk_gb: 40,
  end_user_id: null,
  vm_lost_at: null,
  disk: null,
  created_at: "2026-09-13T00:00:00.000Z",
  updated_at: "2026-09-13T00:00:00.000Z",
};

test("reports the package version in requests", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  let requestVersion: string | null = null;
  const client = new RemoteHost({
    apiKey: "rh_test",
    orgId: "org_123",
    fetch: async (request) => {
      requestVersion = request.headers.get("x-remotehost-sdk-version");
      return jsonResponse({ sandboxes: [] });
    },
  });

  await client.sandboxes.list();

  assert.equal(VERSION, packageJson.version);
  assert.equal(requestVersion, VERSION);
});

test("requires an organization before making an organization-scoped request", async () => {
  const client = new RemoteHost({ apiKey: "rh_test", fetch: unexpectedFetch });

  await assert.rejects(
    client.sandboxes.list(),
    (error: unknown) =>
      error instanceof RemoteHostConfigurationError && error.message.includes("orgId"),
  );
});

test("lists sandboxes with bearer authentication and the configured organization", async () => {
  const requests: Request[] = [];
  const client = new RemoteHost({
    apiKey: "rh_test",
    baseURL: "https://api.example.test/v1/",
    orgId: "org_123",
    fetch: async (request) => {
      requests.push(request);
      return jsonResponse({ sandboxes: [sandbox] });
    },
  });

  const sandboxes = await client.sandboxes.list({ projectId: "project_123" });

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.url,
    "https://api.example.test/v1/orgs/org_123/sandboxes?projectId=project_123",
  );
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer rh_test");
  assert.equal(sandboxes[0]?.id, "sandbox_123");
  assert.equal(sandboxes[0]?.projectId, "project_123");
});

test("creates a sandbox and keeps its resource instance current after lifecycle calls", async () => {
  const requests: Request[] = [];
  const client = new RemoteHost({
    apiKey: "rh_test",
    orgId: "org_123",
    fetch: async (request) => {
      requests.push(request);
      if (request.url.endsWith("/sleep")) {
        return jsonResponse({ sandbox: { ...sandbox, status: "stopped" } });
      }
      return jsonResponse({ sandbox }, 201);
    },
  });

  const created = await client.sandboxes.create({
    projectId: "project_123",
    agent: "codex",
    waitForReady: false,
  });
  const body = await requests[0]?.json();

  assert.deepEqual(body, { projectId: "project_123", agent: "codex" });
  assert.equal(created.status, "provisioning");
  assert.equal(await created.sleep(), created);
  assert.equal(created.status, "stopped");
  assert.equal(requests[1]?.url, "https://api.remotehost.ai/v1/sandboxes/sandbox_123/sleep");
});

test("throws typed API errors with request metadata", async () => {
  const client = new RemoteHost({
    apiKey: "rh_test",
    orgId: "org_123",
    fetch: async () =>
      jsonResponse({ error: { message: "Sandbox limit reached" } }, 429, {
        "x-request-id": "request_123",
      }),
  });

  await assert.rejects(
    client.sandboxes.create({
      projectId: "project_123",
      agent: "codex",
      waitForReady: false,
    }),
    (error: unknown) => {
      assert.ok(error instanceof RemoteHostAPIError);
      assert.equal(error.status, 429);
      assert.equal(error.requestId, "request_123");
      assert.equal(error.message, "Sandbox limit reached");
      return true;
    },
  );
});

test("exposes command, file, preview, and metrics resources on a sandbox", async () => {
  const requests: Request[] = [];
  const client = new RemoteHost({
    apiKey: "rh_test",
    orgId: "org_123",
    fetch: async (request) => {
      requests.push(request);
      const path = new URL(request.url).pathname;

      if (path.endsWith("/exec")) {
        return jsonResponse({
          exitCode: 0,
          stdout: "ok\n",
          stderr: "",
          truncated: false,
          timedOut: false,
        });
      }
      if (path.endsWith("/file") && request.method === "PUT") {
        return jsonResponse({ path: "/code/src/index.ts", size: 18 });
      }
      if (path.endsWith("/file")) {
        return jsonResponse({
          path: "/code/src/index.ts",
          content: "console.log('ok')\n",
          encoding: "utf8",
          size: 18,
        });
      }
      if (path.endsWith("/previews") && request.method === "POST") {
        return jsonResponse({
          preview: {
            kind: "port",
            audience: "team",
            port: 3000,
            status: "ready",
            target: "3000",
            url: "https://preview.example.test",
          },
        });
      }
      if (path.endsWith("/metrics/live")) {
        return jsonResponse({
          cpuPercent: 4,
          memoryTotalGb: 8,
          memoryUsedGb: 2,
          diskTotalGb: 40,
          diskUsedGb: 5,
        });
      }
      return jsonResponse({ sandbox });
    },
  });
  const instance = await client.sandboxes.retrieve("sandbox_123");

  assert.equal((await instance.commands.run("printf ok")).stdout, "ok\n");
  assert.equal(await instance.files.readText("src/index.ts"), "console.log('ok')\n");
  assert.equal((await instance.files.write("src/index.ts", "console.log('ok')\n")).size, 18);
  assert.equal(
    (await instance.previews.create({ port: 3000 })).url,
    "https://preview.example.test",
  );
  assert.equal((await instance.metrics.get()).cpuPercent, 4);
  assert.equal(requests.length, 6);
});

test("waits for a provisioning sandbox to become ready and for its agent to answer", async () => {
  const requests: string[] = [];
  let reads = 0;
  let probes = 0;
  const client = new RemoteHost({
    apiKey: "rh_test",
    orgId: "org_123",
    // The transport retry would otherwise absorb the 502 below.
    maxRetries: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path.endsWith("/files")) {
        probes += 1;
        // The control plane says running before envd inside the guest answers.
        return probes < 2
          ? jsonResponse({ error: { message: "agent unreachable" } }, 502)
          : jsonResponse({ path: "/code", truncated: false, entries: [] });
      }
      reads += 1;
      return jsonResponse({
        sandbox: { ...sandbox, status: reads < 2 ? "provisioning" : "running" },
      });
    },
  });
  const instance = await client.sandboxes.retrieve("sandbox_123");

  assert.equal((await instance.waitUntilReady({ pollIntervalMs: 1 })).status, "running");
  assert.deepEqual(requests, [
    "/v1/sandboxes/sandbox_123",
    "/v1/sandboxes/sandbox_123",
    "/v1/sandboxes/sandbox_123/files",
    "/v1/sandboxes/sandbox_123",
    "/v1/sandboxes/sandbox_123/files",
  ]);
});

test("stops waiting for a sandbox that went to sleep instead of becoming ready", async () => {
  const client = new RemoteHost({
    apiKey: "rh_test",
    orgId: "org_123",
    fetch: async () => jsonResponse({ sandbox: { ...sandbox, status: "stopping" } }),
  });
  const instance = await client.sandboxes.retrieve("sandbox_123");

  await assert.rejects(instance.waitUntilReady({ pollIntervalMs: 1 }), /status "stopping"/);
});

test("surfaces the machine-readable error code the API sets", async () => {
  const client = new RemoteHost({
    apiKey: "rh_test",
    orgId: "org_123",
    fetch: async () =>
      jsonResponse(
        { error: { message: "Too many starts", code: "rate_limited", retryAfterSeconds: 30 } },
        429,
      ),
  });

  await assert.rejects(
    client.sandboxes.create({ projectId: "project_123", agent: "codex", waitForReady: false }),
    (error: unknown) => {
      assert.ok(error instanceof RemoteHostAPIError);
      assert.equal(error.code, "rate_limited");
      return true;
    },
  );
});

test("retries transient reads but never retries mutations", async () => {
  let reads = 0;
  const retryingClient = new RemoteHost({
    apiKey: "rh_test",
    orgId: "org_123",
    fetch: async () => {
      reads += 1;
      return reads === 1
        ? jsonResponse({ error: { message: "try again" } }, 503, { "retry-after": "0" })
        : jsonResponse({ sandboxes: [] });
    },
  });

  assert.deepEqual(await retryingClient.sandboxes.list(), []);
  assert.equal(reads, 2);

  let writes = 0;
  const nonRetryingClient = new RemoteHost({
    apiKey: "rh_test",
    orgId: "org_123",
    maxRetries: 5,
    fetch: async () => {
      writes += 1;
      return jsonResponse({ error: { message: "failed" } }, 503);
    },
  });

  await assert.rejects(
    nonRetryingClient.sandboxes.create({
      projectId: "project_123",
      agent: "codex",
      waitForReady: false,
    }),
    RemoteHostAPIError,
  );
  assert.equal(writes, 1);
});

test("turns transport deadlines into typed timeout errors", async () => {
  const client = new RemoteHost({
    apiKey: "rh_test",
    orgId: "org_123",
    timeoutMs: 5,
    fetch: async (request) => {
      const keepAlive = setTimeout(() => undefined, 100);
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true,
        });
      }).finally(() => clearTimeout(keepAlive));
    },
  });

  await assert.rejects(client.sandboxes.list(), RemoteHostTimeoutError);
});

async function unexpectedFetch(): Promise<Response> {
  throw new Error("Fetch should not have been called");
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers });
}
