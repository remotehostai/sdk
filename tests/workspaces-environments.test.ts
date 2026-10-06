import assert from "node:assert/strict";
import test from "node:test";

import RemoteHost, {
  RemoteHostAPIError,
  RemoteHostConfigurationError,
  Sandbox,
  type Environment,
  type EnvironmentTemplate,
  type Workspace,
} from "../src/index.js";
import type { SandboxData } from "../src/sandboxes.js";

const BASE = "https://api.example.test/v1";

const workspace: Workspace = {
  id: "ws_1",
  org_id: "org_123",
  kind: "external",
  name: "Customers",
  slug: "customers",
  is_default: false,
  created_at: "2026-10-05T00:00:00.000Z",
  updated_at: "2026-10-05T00:00:00.000Z",
};

const template: EnvironmentTemplate = {
  usage: { workspaces: 0, sandboxes: 0 },
  id: "tpl_1",
  projectId: "project_123",
  name: "restricted",
  description: null,
  isDefault: true,
  enforced: false,
  template: null,
  machineSize: null,
  setupScript: null,
  services: [],
  ports: [],
  envVars: {},
  egressPolicy: "trusted",
  egressAllowlist: [],
  applied: true,
  createdAt: "2026-10-05T00:00:00.000Z",
  updatedAt: "2026-10-05T00:00:00.000Z",
};

const environment: Environment = {
  id: "env_1",
  orgId: "org_123",
  projectId: "project_123",
  name: "feature-x",
  title: null,
  environmentId: "tpl_1",
  lifetimePolicy: "persistent",
  expiresAt: null,
  gitBranch: "remotehost/feature-x",
  cpuBaseline: null,
  currentCheckpointId: null,
  status: "sleeping",
  lease: { sandboxId: null, epoch: "0", expiresAt: null, live: false },
  createdBy: null,
  createdAt: "2026-10-05T00:00:00.000Z",
  updatedAt: "2026-10-05T00:00:00.000Z",
  lastActivityAt: "2026-10-05T00:00:00.000Z",
};

const sandbox: SandboxData = {
  id: "sandbox_123",
  org_id: "org_123",
  project_id: "project_123",
  name: "feature-x",
  agent: "claude",
  status: "running",
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
  environment_id: "tpl_1",
  disk: null,
  created_at: "2026-10-05T00:00:00.000Z",
  updated_at: "2026-10-05T00:00:00.000Z",
};

type Recorded = { method: string; path: string; search: string; body: unknown };

// A client whose fetch records each request and answers from `respond`.
function recordingClient(respond: (request: Recorded) => Response, orgId: string | null = "org_123") {
  const requests: Recorded[] = [];
  const client = new RemoteHost({
    apiKey: "rh_test",
    baseURL: BASE,
    orgId: orgId ?? undefined,
    hostGateway: false,
    fetch: async (request) => {
      const url = new URL(request.url);
      const text = await request.text();
      const recorded = {
        method: request.method,
        path: url.pathname.replace(/^\/v1/, ""),
        search: url.search,
        body: text ? JSON.parse(text) : undefined,
      };
      requests.push(recorded);
      return respond(recorded);
    },
  });
  return { client, requests };
}

test("workspaces: list, create, retrieve, update and delete under the org", async () => {
  const { client, requests } = recordingClient((request) => {
    if (request.method === "GET" && request.path === "/orgs/org_123/workspaces") {
      return Response.json({ workspaces: [workspace] });
    }
    if (request.method === "POST") return Response.json({ workspace }, { status: 201 });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ workspace });
  });

  assert.deepEqual(await client.workspaces.list(), [workspace]);
  assert.deepEqual(
    await client.workspaces.create({ name: "Customers", kind: "external", timeoutMs: 5_000 }),
    workspace,
  );
  assert.deepEqual(await client.workspaces.retrieve("ws_1"), workspace);
  assert.deepEqual(await client.workspaces.update("ws_1", { name: "Clients" }), workspace);
  assert.equal(await client.workspaces.delete("ws_1"), undefined);

  assert.deepEqual(
    requests.map(({ method, path, body }) => ({ method, path, body })),
    [
      { method: "GET", path: "/orgs/org_123/workspaces", body: undefined },
      // Request options (timeoutMs, orgId) never reach the body.
      { method: "POST", path: "/orgs/org_123/workspaces", body: { name: "Customers", kind: "external" } },
      { method: "GET", path: "/orgs/org_123/workspaces/ws_1", body: undefined },
      { method: "PATCH", path: "/orgs/org_123/workspaces/ws_1", body: { name: "Clients" } },
      { method: "DELETE", path: "/orgs/org_123/workspaces/ws_1", body: undefined },
    ],
  );
});

test("workspaces: a per-request orgId wins, and none at all is a configuration error", async () => {
  const { client, requests } = recordingClient(() => Response.json({ workspaces: [] }), null);

  await client.workspaces.list({ orgId: "org_other" });
  assert.equal(requests[0]?.path, "/orgs/org_other/workspaces");

  await assert.rejects(
    client.workspaces.list(),
    (error: unknown) => error instanceof RemoteHostConfigurationError,
  );
});

test("workspaces: a refused delete and the dark 404 surface as RemoteHostAPIError", async () => {
  const { client } = recordingClient((request) =>
    request.method === "DELETE"
      ? Response.json({ error: { message: "Workspace still holds projects." } }, { status: 409 })
      : Response.json({ error: { message: "Not found" } }, { status: 404 }),
  );

  await assert.rejects(
    client.workspaces.delete("ws_1"),
    (error: unknown) => error instanceof RemoteHostAPIError && error.status === 409,
  );
  await assert.rejects(
    client.workspaces.list(),
    (error: unknown) => error instanceof RemoteHostAPIError && error.status === 404,
  );
});

test("environmentTemplates: every call goes to /environment-templates, never /environments", async () => {
  const propagation = { applied: [], failed: [], notRunning: [] };
  const { client, requests } = recordingClient((request) => {
    if (request.method === "GET" && request.path.endsWith("/environment-templates")) {
      return Response.json({ environments: [template] });
    }
    if (request.method === "POST") return Response.json({ environment: template }, { status: 201 });
    if (request.method === "PATCH") {
      return Response.json({ environment: template, egressPropagation: propagation });
    }
    if (request.method === "DELETE") return Response.json({ deleted: true, keptForSandboxes: true });
    return Response.json({ environment: template });
  });
  const scope = { projectId: "project_123" };

  assert.deepEqual(await client.environmentTemplates.list(scope), [template]);
  assert.deepEqual(await client.environmentTemplates.create({ ...scope, name: "restricted" }), {
    environmentTemplate: template,
  });
  assert.deepEqual(await client.environmentTemplates.retrieve("tpl_1", scope), template);
  assert.deepEqual(
    await client.environmentTemplates.update("tpl_1", { ...scope, egressPolicy: "custom" }),
    { environmentTemplate: template, egressPropagation: propagation },
  );
  assert.deepEqual(await client.environmentTemplates.delete("tpl_1", scope), {
    deleted: true,
    keptForSandboxes: true,
  });

  const prefix = "/orgs/org_123/projects/project_123/environment-templates";
  assert.deepEqual(
    requests.map(({ method, path, body }) => ({ method, path, body })),
    [
      { method: "GET", path: prefix, body: undefined },
      { method: "POST", path: prefix, body: { name: "restricted" } },
      { method: "GET", path: `${prefix}/tpl_1`, body: undefined },
      { method: "PATCH", path: `${prefix}/tpl_1`, body: { egressPolicy: "custom" } },
      { method: "DELETE", path: `${prefix}/tpl_1`, body: undefined },
    ],
  );
});

test("environments: CRUD on the project's environments, served today at /workspaces", async () => {
  const { client, requests } = recordingClient((request) => {
    if (request.method === "GET" && request.path.endsWith("/workspaces")) {
      return Response.json({ workspaces: [environment] });
    }
    if (request.method === "POST") return Response.json({ workspace: environment }, { status: 201 });
    if (request.method === "DELETE") {
      return Response.json({
        deleted: true,
        workspaceId: "env_1",
        executionsPendingCleanup: [{ sandboxId: "sandbox_123", message: "host not answering" }],
      });
    }
    return Response.json({ workspace: environment });
  });
  const scope = { projectId: "project_123" };

  assert.deepEqual(await client.environments.list({ ...scope, limit: 5 }), [environment]);
  assert.deepEqual(
    await client.environments.create({ ...scope, name: "feature-x", environmentTemplateId: "tpl_1" }),
    environment,
  );
  assert.deepEqual(await client.environments.retrieve("env_1", scope), environment);
  assert.deepEqual(await client.environments.update("env_1", { ...scope, title: "Feature X" }), {
    environment,
  });
  assert.deepEqual(await client.environments.delete("env_1", scope), {
    deleted: true,
    environmentId: "env_1",
    executionsPendingCleanup: [{ sandboxId: "sandbox_123", message: "host not answering" }],
  });

  const prefix = "/orgs/org_123/projects/project_123/workspaces";
  assert.deepEqual(
    requests.map(({ method, path, search, body }) => ({ method, path, search, body })),
    [
      { method: "GET", path: prefix, search: "?limit=5", body: undefined },
      // The SDK's environmentTemplateId is the API's environmentId.
      { method: "POST", path: prefix, search: "", body: { name: "feature-x", environmentId: "tpl_1" } },
      { method: "GET", path: `${prefix}/env_1`, search: "", body: undefined },
      { method: "PATCH", path: `${prefix}/env_1`, search: "", body: { title: "Feature X" } },
      { method: "DELETE", path: `${prefix}/env_1`, search: "", body: undefined },
    ],
  );
});

test("environments: a null environmentTemplateId is sent, to follow the project's default", async () => {
  const { client, requests } = recordingClient(() => Response.json({ workspace: environment }));

  await client.environments.update("env_1", { projectId: "project_123", environmentTemplateId: null });

  assert.deepEqual(requests[0]?.body, { environmentId: null });
});

test("environments: attach and detach hand back Sandbox resources; fork names its source", async () => {
  const recovery = {
    supersededSandboxId: "sandbox_old",
    supersededHolderHealth: "gone" as const,
    restoredFrom: "checkpoint" as const,
    restoredSnapshotAt: null,
    restoredSnapshotDurable: true,
    message: "Restored from the last checkpoint.",
  };
  const { client, requests } = recordingClient((request) => {
    if (request.path.endsWith("/attach")) {
      return Response.json({ workspace: environment, sandbox, attached: "takeover", recovery });
    }
    if (request.path.endsWith("/detach")) {
      return Response.json({ workspace: environment, sandbox: null, detached: "already" });
    }
    return Response.json(
      { workspace: { ...environment, id: "env_2" }, forkedFrom: { workspaceId: "env_1", checkpointId: "cp_1" } },
      { status: 201 },
    );
  });
  const scope = { projectId: "project_123" };

  const attached = await client.environments.attach("env_1", { ...scope, takeover: true });
  assert.ok(attached.sandbox instanceof Sandbox);
  assert.equal(attached.sandbox.id, "sandbox_123");
  assert.equal(attached.attached, "takeover");
  assert.deepEqual(attached.recovery, recovery);
  assert.equal("leaseRenewed" in attached, false);

  const detached = await client.environments.detach("env_1", scope);
  assert.equal(detached.sandbox, null);
  assert.equal(detached.detached, "already");

  const forked = await client.environments.fork("env_1", { ...scope, name: "feature-y" });
  assert.equal(forked.environment.id, "env_2");
  assert.deepEqual(forked.forkedFrom, { environmentId: "env_1", checkpointId: "cp_1" });

  const prefix = "/orgs/org_123/projects/project_123/workspaces/env_1";
  assert.deepEqual(
    requests.map(({ method, path, body }) => ({ method, path, body })),
    [
      { method: "POST", path: `${prefix}/attach`, body: { takeover: true } },
      { method: "POST", path: `${prefix}/detach`, body: undefined },
      { method: "POST", path: `${prefix}/fork`, body: { name: "feature-y" } },
    ],
  );
});
