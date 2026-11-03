# RemoteHost TypeScript SDK

The official server-side TypeScript SDK for the RemoteHost API, licensed under MIT.

Source, issues, and contributions: [remotehostai/sdk](https://github.com/remotehostai/sdk).

The low-level request and response types in `src/generated` are generated from
the published public spec, `contracts/openapi/dist/remotehost.json`: the TS
API's `contracts/openapi/base/openapi.json` plus the `contracts/openapi` documents
listed in `contracts/openapi/published.yaml`. The public resource API is
maintained by hand in the rest of `src`.

## Install

```sh
npm install @remotehost/sdk
```

## Usage

```ts
import RemoteHost from "@remotehost/sdk";

const remotehost = new RemoteHost({
  apiKey: process.env.REMOTEHOST_API_KEY,
  orgId: "org_123",
});

const sandbox = await remotehost.sandboxes.create({
  projectId: "project_123",
  agent: "codex",
});

console.log(sandbox.id, sandbox.status);
const result = await sandbox.commands.run("pnpm test");
const source = await sandbox.files.readText("src/index.ts");
const preview = await sandbox.previews.create({ port: 3000 });
await sandbox.sleep();
```

`apiKey` defaults to `REMOTEHOST_API_KEY` in server environments. Browser use
is rejected by default to prevent accidentally exposing a secret key. Sandbox
creation waits until the sandbox is running and the agent inside it answers,
so the first command works; pass `waitForReady: false` to get the
provisioning response immediately.

An organization's work is split into workspaces, each `internal` or
`external` for good; projects live in one. A project's environments are
durable work (a disk, checkpoints, a git branch) that a sandbox attaches to,
and each boots from one of the project's environment templates:

```ts
const workspaces = await remotehost.workspaces.list();

const [template] = await remotehost.environmentTemplates.list({ projectId: "project_123" });
const environment = await remotehost.environments.create({
  projectId: "project_123",
  name: "feature-x",
  environmentTemplateId: template?.id,
});
const { sandbox: attached } = await remotehost.environments.attach(environment.id, {
  projectId: "project_123",
});
await remotehost.environments.detach(environment.id, { projectId: "project_123" });
```

`remotehost.workspaces` answers 404 until the workspace API is enabled for the
deployment.

API failures throw `RemoteHostAPIError` with `status`, `code` (for example
`rate_limited` or `limit_reached`), `requestId`, and the response body.

For endpoints without a convenience resource, use the fully typed
`remotehost.raw` OpenAPI client. Generated `paths`, `operations`, and
`components` types are available from `@remotehost/sdk/openapi`.

See the [SDK guide](https://docs.remotehost.ai/docs/sdk) for commands, files,
previews, metrics, lifecycle methods, errors, retries, and cancellation.

## Sync client

`@remotehost/sdk/sync` keeps a local copy of a workspace's backends (`tasks`, the
Atlas tracker's issues, teams and states) and syncs it live over sync protocol
v1. Writes show at once and settle when the service answers; a refused write
disappears and its `write()` resolves `refused`. Stores: `indexedDbStore()` in a
browser (one leader tab owns the socket), `memoryStore()` for scripts, and
`sqliteStore()` from `@remotehost/sdk/sync/sqlite` on Node 22.13 or later.

```ts
import { createSyncClient, tasks, type TasksIssue, type TasksState } from "@remotehost/sdk/sync";
import { sqliteStore } from "@remotehost/sdk/sync/sqlite";

const sync = createSyncClient({
  url: "wss://sync-staging.remotehost.ai/v1/connect",
  workspace: workspaceId,
  token: async () => ({ token: await mintSyncToken() }), // POST /v1/auth/sync-token
  store: sqliteStore({ path: "./replica.db" }),
  backends: ["tasks"],
});
await sync.start(); // resolves once caught up

const issues = sync.records<TasksIssue>("tasks", "issue");
issues.subscribe((change) => console.log(change.kind, change.confirmed));

// A new task in the first state's team; the service numbers it.
const todo = sync.records<TasksState>("tasks", "state").all()[0];
if (!todo) throw new Error("the workspace has no states yet");
const issue = tasks.putIssue({
  identifier: "",
  number: 0,
  title: "Ship the launch",
  state_id: todo.id,
  team_id: todo.team_id,
});
const [outcome] = await sync.write(issue);
console.log(outcome?.status, await sync.pending());
await sync.stop();
```

## Development

The public repository is a standalone source mirror maintained from RemoteHost's
monorepo. Clone it to inspect the implementation, run tests, or contribute a fix:

```sh
git clone https://github.com/remotehostai/sdk.git
cd sdk
npm ci
npm test
npm run typecheck
npm run build
```

The generated API types are checked in, so building does not require access to
the API server or the monorepo. Do not edit `src/generated/schema.ts` by hand;
report contract changes in an issue so they can be regenerated upstream.

Public pull requests are welcome. Maintainers integrate changes into the
monorepo and synchronize them back here. Published versions have matching
`v<version>` tags and GitHub releases; `main` may contain an unpublished snapshot.
See [CONTRIBUTING.md](https://github.com/remotehostai/sdk/blob/main/CONTRIBUTING.md).

For development inside the monorepo:

```sh
pnpm --filter @remotehost/sdk generate
pnpm --filter @remotehost/sdk test
pnpm --filter @remotehost/sdk build
```

## License

[MIT](LICENSE.md). Dependencies retain their own licenses; see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
