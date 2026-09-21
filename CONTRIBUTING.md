# Contributing

Issues and pull requests are welcome at https://github.com/remotehostai/sdk.

Use Node.js 20.19 or newer. Run `npm ci`, `npm test`, `npm run typecheck`, and
`npm run build` before submitting a pull request. The unit tests use mock
responses and do not need a RemoteHost account or API key.

This repository mirrors the SDK in RemoteHost's monorepo. Maintainers port
accepted changes upstream before the next source sync. Do not merge changes
directly into this mirror: a later sync would overwrite them.

Generated types in `src/generated/schema.ts` come from the API contract upstream.
For a contract change, open an issue describing the endpoint and expected types.

Contributions are provided under the repository's MIT license.
