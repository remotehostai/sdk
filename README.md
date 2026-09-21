# RemoteHost TypeScript SDK

The official server-side TypeScript SDK for the RemoteHost API, licensed under MIT.

Source, issues, and contributions: [remotehostai/sdk](https://github.com/remotehostai/sdk).

The low-level request and response types in `src/generated` are generated from
`apps/api/generated/openapi.json`. The public resource API is maintained by hand
in the rest of `src`.

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

API failures throw `RemoteHostAPIError` with `status`, `code` (for example
`rate_limited` or `limit_reached`), `requestId`, and the response body.

For endpoints without a convenience resource, use the fully typed
`remotehost.raw` OpenAPI client. Generated `paths`, `operations`, and
`components` types are available from `@remotehost/sdk/openapi`.

See the [SDK guide](https://docs.remotehost.ai/docs/sdk) for commands, files,
previews, metrics, lifecycle methods, errors, retries, and cancellation.

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
