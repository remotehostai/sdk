# @remotehost/sdk

## 1.0.0

### Major Changes

- First release on a fresh npm name. Every 0.x version of `@remotehost/sdk` was unpublished from npm on 2026-11-01 and the old `remotehostai/sdk` repository deleted, so 1.0.0 is the first version npm serves. It is 0.7.0 renumbered: no API or type changes.

## 0.7.0

### Minor Changes

- c642ca8: `environments.attach` takes `workVolumeId`: a volume of the project to bind as the environment's work volume, the disk its sandboxes mount at `/home/user`, which outlives them. It is bound once, before the environment first runs. Where work volumes are not offered yet, the attach is refused with 409 `work_volumes_not_enabled`. The generated types add the attach's work volume refusals: 409 `work_volume_not_found`, `work_volume_conflict`, `workspace_not_fresh`, `work_volume_too_small`, `volume_limit_exceeded`, 429 `rate_limited` and 503 `volume_service_unavailable`.

  `environments.delete` takes `keepWorkVolume`, sent only when given: for an environment with a work volume, `true` keeps the volume (unbound) once the environment can no longer be restored, and `false`, the API's default, deletes it then. Its result carries `workVolume` (`id` and `fate`, `keep` or `drop`) for an environment with a work volume, and `recoverableUntil` when the environment can be restored until then. New types: `DeleteEnvironmentOptions` and `EnvironmentWorkVolume`.

  `environments.fork` of an environment with a work volume copies the volume for the fork. The generated types add the fork's refusals for it: 409 `checkpoint_volume_moved` (the volume has changed since the checkpoint the fork was asked for), 409 `workspace_unavailable` when a running environment's volume could not be committed first, 409 `work_volume_too_small` when the copy is smaller than 4096 bytes, 409 `volume_limit_exceeded`, 404 `not_found`, and the new 429 `rate_limited` and 503 `volume_service_unavailable` responses.

- 0ce4112: `getWorkspaceVendorCost` (`/orgs/{orgId}/workspaces/{workspaceId}/usage/vendor-cost`) now accepts an API key pinned to a workspace, so such a key with `billing.read` in its own scopes can read its own workspace's usage at vendor cost, itemized line by line. Any other workspace, in the same org or another, answers 404 to that key, and an API key not pinned to a workspace still gets 403. The route answers 404 to everyone until the server turns workspaces on.
- ac81975: `Sandbox.resize()` takes `restart: true`: a running persistent sandbox stops and starts again at the new shape in the same request, and `SandboxResizeResult.applied` is `"restart"` (running processes end, files stay). The key is sent only when true, so every other resize is the request it was. The API refuses it (400) until resize restart is enabled for the deployment.
- d38979e: **Breaking (types):** `ResizeSandboxBody`, what `sandbox.resize()` takes, now requires `vcpu`, `memoryGb` and `diskGb`. It accepted any one of them, but the API refuses a resize without all three (400 "vcpu, memoryGb, and diskGb must be positive numbers."), so a call that compiled always failed. Send the whole shape; `restart` stays optional.
- beaaee4: The generated API types carry the VMM (virtual machine monitor) a sandbox runs on. A sandbox has `vmm` (`"firecracker"` or `"qemu"`, typed as a string so a VMM added later still reads), and `provider`, which the API already sent and which stays `"firecracker"` whatever the VMM. A workspace has the `vmm` it was made with, which every execution of it runs on, and an environment template a `vmm` that is null when it names none. Creating a sandbox, creating a workspace and creating or updating an environment template take an optional `vmm` (`"qemu"` or `"firecracker"`). The sandbox create, workspace create and workspace attach error codes gain `vmm_mismatch` and `vmm_unavailable`, and an environment template's 409 carries `error.code` `vmm_mismatch` when its VMM and its custom template's differ. The API refuses a `vmm` (400) until VMM choice is enabled for the deployment.
- d395c60: `sandbox.wake()` (and the deprecated `resume()`) waits for a snapshot that is still saving: `sleep()` returns as the save starts, and a wake before it finishes used to throw 409 `snapshot_in_progress`. The wake now asks again once a second for up to `snapshotWaitMs` (default 180000; `0` does not wait), then wakes, and past that throws the API's error. `timeoutMs` and `signal` bound the whole call. New type: `WakeSandboxOptions`.
- d27ded8: `Workspace` gains `add_ons`: for an Internal workspace, whether each of its add-ons (`issues`, `repos`, `agents`) is on, each on until switched off; null for an External workspace (`OrgWorkspaceAddOns` in the generated types). `workspaces.update` takes `addOns` to switch some of them; those not named keep their state. The switches set what the workspace's sidebar shows and gate no API. Like the rest of the workspace API, it answers 404 until the workspace API is enabled for the deployment.
- e11e1c0: The generated types add three read operations for a workspace's infrastructure: `getWorkspaceStorage` (`/orgs/{orgId}/workspaces/{workspaceId}/storage`) returns the durable volumes of the environments in its projects, with their forks, checkpoints and last disk samples (`WorkspaceStorage`, `WorkspaceVolume`); `getWorkspaceCompute` (`/compute`) returns its projects' machines with counts by status and the regions machines can run in (`WorkspaceCompute`, `WorkspaceMachine`, `WorkspaceLocation`); and `getWorkspaceNetwork` (`/network`) returns its machines' preview links that still open and each environment's egress (`WorkspaceNetwork`, `WorkspacePreviewLink`, `WorkspaceEgress`). Each lists only the projects where the caller holds the read permission it needs, names what it cannot serve yet in `unavailable` rather than estimating it, and cannot be called with an API key. All three answer 404 until the server turns workspaces on.
- 2c761f3: `Workspace` gains `manager_workspace_id`: for an External workspace, the Internal workspace of the organization that runs it, or null (always null for an Internal workspace, and when the caller cannot see the manager). `workspaces.update` takes `managerWorkspaceId` to set it, or null to clear it. It is descriptive and grants no access. Like the rest of the workspace API, it answers 404 until the workspace API is enabled for the deployment.
- a8a1736: The workspace network's type carries `privateNetwork`: an Internal workspace's IPv6 ULA /48, whether its machines join it, and one page of the machines that hold an address in it, or null. `WorkspaceNetworkUnavailable`'s `field` no longer names `tailscale`.
- 563af60: `environments.attach` takes an optional `workVolumeId`, an existing volume of the project bound as the environment's work volume before its first execution. Where work volumes are not enabled it is refused with 409 `work_volumes_not_enabled`. The attach's error codes gain `work_volume_not_found`, `work_volume_conflict`, `workspace_not_fresh`, `work_volumes_not_enabled` and `volume_service_unavailable` (503, safe to retry), and its error carries `reason` with `workspace_unavailable` from a work volume's lease. A sandbox wake's 503 can also be `volume_service_unavailable`.
- 0c2e81f: New resources for the workspace model. `remotehost.workspaces` lists, creates, retrieves, renames and deletes an organization's workspaces, each `internal` or `external` for good (`Workspace`, `WorkspaceKind`); it answers 404 until the workspace API is enabled for the deployment. `remotehost.environmentTemplates` manages a project's boot configurations at `/environment-templates` (`EnvironmentTemplate`), with `egressPropagation` on writes. `remotehost.environments` manages a project's environments, the durable unit (disk, checkpoints, git branch) a sandbox attaches to: list, create, retrieve, update, delete, `attach` (returns a `Sandbox`), `detach` and `fork` (`Environment`, `EnvironmentLease`, `EnvironmentRecovery`). The API still serves environments at `/projects/{projectId}/workspaces`; the SDK calls them environments and takes `environmentTemplateId` where the API's field is `environmentId`.

  The generated types add the org workspace operations (`listOrgWorkspaces`, `createOrgWorkspace`, `getOrgWorkspace`, `updateOrgWorkspace`, `deleteOrgWorkspace`), `workspace_id` and `workspace_kind` on projects, the `EnvironmentTemplate` schema and its `*EnvironmentTemplate*` operations, and mark the `/environments` operations deprecated.

### Patch Changes

- 9dde23f: The generated API types document the `401` every authenticated operation answers (`{ error: { message, code? } }`): a request with no credential gets `401` with the message `Missing bearer token.` and no `code`, and one whose credential is not valid gets `code: "invalid_credential"`. Nothing the API answers changes; `GET /me`, whose only error it is, now has an error response type at all. `GET /addons`, which needs no credential, is unchanged.
- d584e69: Environments: `remotehost.environments` works with an API key where the deployment enables key access to environments; until then every key is refused with `403`, as before. Once it is on, a key reaches only its owner's environments (the person who minted it, or its service account): it lists only those, and anyone else's answers `404` as if it did not exist. `environments.delete` needs a key whose own scopes name `sandbox.environment.delete`: no key template includes it, and an unscoped key does not hold it.
- 7c10731: Host gateway: a gateway whose single-use ticket cache is full answers 503 `ticket_cache_full`. The SDK now sends that one call, a command or a write included, to the API (nothing ran on the gateway) and keeps using the gateway for the sandbox's later calls.
- 8327422: Host gateway: a command that goes to the API after a gateway ticket was issued for it now names that ticket (the `RemoteHost-Gateway-Ticket` header, its id only). An API that finds the gateway already ran that ticket refuses the command with 409 `ticket_redeemed` instead of running it a second time; an API without that check ignores the header.
- fdc7f22: The host gateway client's comment no longer says ticket redemptions are recorded only while an API switch is on: every RemoteHost API records them now. No behaviour change.
- 5a9ebbd: The add-ons catalog's schema description says "marketplace" where it said "store" (REM-1630).
- 91aa262: `ProjectMcpConnection` now carries `listing_id` and whether the connection has a credential (`credential_set`, `credential_set_by`, `credential_set_at`). The credential itself is never returned. The schema also describes `setProjectMcpCredential` and `clearProjectMcpCredential` (PUT and DELETE `.../mcp-connections/{connectionId}/credential`), and who can read a credential once it is set.
- 659f41d: The README names the API's OpenAPI base document at its new home, `contracts/openapi/base/openapi.json`, now that the TS API it lived in is deleted (REM-3384). The generated API contract and the SDK's code are unchanged.
- 6be68c9: Previews: a team preview may carry `viewerUrl` beside `url`, the URL with a one-use viewer handoff for the caller's own browser to open once, within two minutes. It is present only for a person's own session while the environment issues handoffs. Show and share `url`, never `viewerUrl`.
- a21eecd: `DELETE /v1/orgs/:orgId/projects/:projectId` deletes a project that holds nothing, for an org's owners and admins; a project that holds anything is refused with 409 `project_not_empty` and a `held` list (REM-2342).
- 9940fa8: Creating or renaming a project to a name another project in the org already has, compared case-insensitively, answers 409 `project_name_taken` (REM-2354).
- e4ad6b1: Publishing only: the package's `prepublishOnly` now runs the repository's local publish gate first, which refuses a publish while public publishing is switched off or during business hours (REM-4953). The published manifest carries that script, so the package's files change, but its API and behaviour do not.
- 4fbca9d: The SDK's generated types now come from the published public spec, `contracts/openapi/dist/remotehost.json`, instead of the TS API's document directly. The spec publishes no new operations yet, so the types are unchanged.
- 0f8d7e9: The generated API schema names three more refusals:
  - `resource_unit_changed`: an allocation, while some of the resource's allocations are still in another unit.
  - `resource_quantity_allocated`: buying a resource add-on, or lowering its quantity, below what its allocations count. Release some first.
  - `resource_sandbox_unavailable`: allocating to a sandbox that is still being made, or was deleted.

  No resource can be allocated or bought yet.

- f86a932: The generated API schema now says that creating a sandbox can answer 409 when one more sandbox would take a resource its project gives each sandbox by default past what the org bought or its plan allows (`resource_quantity_exceeded`, `resource_quota_not_set`, `resource_quota_exceeded`), or with `resource_allocation_changed`, to retry, when the org's entitlements changed while the check ran. No resource is counted per sandbox yet, so no create is refused this way today.
- 60b981d: The usage fee's `marginPercentMax` is documented as 1.6, the cap since the 2026-10-29 fee version (2.9% payment processing, 0.5% billing and tax tooling, 1.6% RemoteHost margin: 5% in all). Only the field's description changes; its type and shape do not.

## 0.6.0

### Minor Changes

- cd2c3fc: **Breaking (API keys create):** `POST /orgs/{orgId}/api-keys` now requires two explicit choices, and the generated request type enforces them. Say what the key may do with `scopes`, a `template` (`ci`, `read-only`, `platform`, `agent-watcher`, `claims`) or `unscoped: true`, and when it stops with `expiresInDays` or `neverExpires: true`. A request missing either is refused with 400; previously both defaulted to the broadest answer (unscoped, never expires).

  Also new: `POST /orgs/{orgId}/api-keys/{keyId}/rotate` mints a successor with the same name, scopes and lifetime and ends the old key after `overlapHours` (default 24, at most 168). API keys in listings now include `created_by`, the user the key acts as.

- 7c0baad: New API keys start `rh_sk_` and end in a checksum, so a mistyped or truncated key is refused before it is looked up. Keys in the older `rh_` format are no longer accepted; create a new key. A sandbox's own Remotehost Claims key is its own kind, `rh_sb_`, in the same format. It is managed by RemoteHost: it is not in `listApiKeys`, and `revokeApiKey` and `rotateApiKey` answer it with 409 `code: "sandbox_key_managed"`. To stop a sandbox using Claims, delete the sandbox or revoke the key it was issued from. Every refused bearer token, an API key or a session token, now answers 401 with `code: "invalid_credential"` and the same message whatever the reason.
- c6724dd: Add `enforced` to environments: when the project's default environment is enforced, every sandbox and workspace execution in the project boots from it, whatever the caller's role, and another environment or template is refused with 403 `environment_enforced`.
- 560df13: Add `listSandboxPorts` (`GET /sandboxes/{sandboxId}/ports`). It lists the ports a sandbox's environment declares. For each port it reports the service that declares it, whether anything is listening, and a team preview URL ready to open, so none has to be requested. Nothing is made public: public links are still created explicitly through the previews endpoint.
- 2d980a5: Add `listSandboxServices` (`GET /sandboxes/{sandboxId}/services`). Where environment services are enabled (rolling out), an environment's declared services start after its setup script on every create and cold boot, as the sandbox user. This endpoint reports whether each one is running, has exited (with its exit code) or never started, whether anything is listening on its port, and where its log is. On a workspace's execution, only the workspace's owner may read it. Until services are enabled, the list is empty.
- 943b191: Sandboxes now report the environment they boot from (`environment_id`). Deleting an environment that sandboxes still boot from no longer fails with 409: the environment is removed for everything else, while those sandboxes keep waking under its last configuration until the last one is deleted (`keptForSandboxes` in the response). A workspace takeover's new execution boots from the workspace's environment as it is now. If that environment is deleted at the same moment, or the takeover meets another change, it is refused with a retryable 409 (`workspace_environment_unavailable` or `takeover_conflict`) and changes nothing; a workspace attach can also pass through `environment_not_found`. `remote new`, `remote claude` and `remote codex` take `--environment <name or id>`.
- 3f49029: Environments report `usage`: how many live workspaces and sandboxes boot from each, which an edit reaches at their next start and a delete is refused over.
- fc0c9d6: Add the Environments API types: list, create, get, update and delete a project's environments (named machine configurations with template, size, setup script, services, ports, non-secret env vars and an egress policy).
- 6a74815: `sandbox.commands.run` and `sandbox.files.list`, `read` and `write` can run through the sandbox's own host instead of through the API (the `hostGateway` option, or `REMOTEHOST_HOST_GATEWAY`). For each call the SDK asks the API for a single-use ticket for exactly the permission that call needs, and sends only that ticket to the host; answers are the same as the API's. Where a sandbox's host has no gateway yet the SDK uses the API as before. A command or a write is never sent twice: if the connection to the host drops mid-call, the call fails with `RemoteHostConnectionError`.
- bebb449: Retry a create, wake or any other request the API refuses with `503` `host_unavailable` and `retryable: true` (the sandbox's host was restarting and nothing was changed), honoring `Retry-After`. The SDK retries for up to `hostUnavailableRetryMs` (default 60 seconds, `0` to turn it off) and adds the `host_unavailable` error code, the `503` responses, and the `429` a host at capacity answers on sleep and destroy to its generated types; `remote wake`, `remote new`, `remote claude` and `remote codex` retry for up to a minute.
- 8a506ad: Add `egressPropagation` to the environment update response: a change to an environment's egress policy or allowlist now reaches its running sandboxes as it is saved, and the response says which took it, which could not (and were put to sleep), and which had already stopped.
- ba3be0c: An `Org` no longer carries `metronome_customer_id`, `metronome_contract_id` or `metronome_contract_plan`. Org reads (`GET /v1/me/orgs`, `GET /v1/me/orgs/{slug}`, `POST /v1/orgs`, `PATCH /v1/orgs/{orgId}`) now return exactly the documented fields: `id`, `name`, `slug`, `plan`, `onboarded_at`, `created_at` and `updated_at`. Billing and identity-provider identifiers are not shown to org members.
- fa6ba77: Organizations have slugs. `Org.slug` is now always a string: the org's URL handle, as in `console.remotehost.ai/<slug>`. Ids stay the canonical way to address an org. The generated API types add:

  - `GET /me/orgs/{slug}` (`getMyOrgBySlug`): finds one of your organizations by its current or old slug, with `viaAlias` set for an old one. Anything else is the same `404`, whether or not the organization exists.
  - `POST /orgs` (`createOrg`) and `PATCH /orgs/{orgId}` (`updateOrg`): take an optional `slug`. A changed slug leaves the old one as an alias that no other org can take.
  - `GET /orgs/{orgId}/slug-aliases` and `DELETE /orgs/{orgId}/slug-aliases/{slug}`: list and release old slugs.
  - Error codes `slug_taken`, `slug_reserved`, `slug_format`, `slug_invalid` and `slug_current`.

- b01be5b: `Sandbox` carries `disk`: the persistent disk as of the last sample from inside the sandbox, with `usedBytes`, `totalBytes`, `availableBytes`, `warning` (80 or 95 once usage passes that share, otherwise null, and null whenever the sandbox is not ready or running) and `sampledAt`, when the numbers were read. The template's own files count as used from the first boot, so `availableBytes` rather than `allocated_disk_gb` is the free space. `disk` is null until the sandbox has been sampled.
- fb2ff6c: Sandbox create accepts `environmentId`: the sandbox boots from that environment's template, machine size, environment variables and setup script, and is held to its egress policy on every start. Environments now report `applied: true`.
- 4e52923: Add optional `repoWarnings` to the sandbox create and wake responses: a project repo whose Git connection now belongs to another organization is skipped instead of cloned, and each warning names the repo and how to attach it again.
- 1aec3e0: Sandbox create, wake, resume and workspace attach can now answer 504 with `error.code` `start_timeout` and `error.retryable` `true` when no host started the sandbox within the create budget. The hosts were slow or hung, so the request may succeed if sent again. Error bodies gain an optional `retryable` field, true when trying the same request again may succeed.
- 0d66245: Behaviour change: under Node, the host gateway path is now the default. To keep every call on the API, pass `hostGateway: false`, or set `REMOTEHOST_HOST_GATEWAY=0`.

  Commands, file reads and writes, and live metrics go through the sandbox's own host with a single-use ticket from the API, and fall back to the API wherever the gateway path isn't there. Where there is no Node `process` (browsers, Workers, Deno without Node compatibility) the default stays off, since the gateway answers no CORS preflight; `hostGateway: true` turns it on there. `REMOTEHOST_HOST_GATEWAY` set to `1`, `true`, `yes` or `on` turns it on, and `0`, `false`, `no` or `off` turns it off; any other value keeps the default and logs one warning.

  An API that issues no tickets on a route (an older API, the route switched off, or a ticket answer that carries no ticket) is remembered for every sandbox for 5 minutes, so a long-lived client pays one ticket request per route per 5 minutes, and picks the gateway up again once the API issues tickets.

- bce7a96: Add the workspace API types: create, list, read, update and delete a workspace, and attach or detach it to get a sandbox. Sandbox errors can now carry the workspace codes `workspace_fenced`, `workspace_leased` and `workspace_execution`.
- b77a264: Add `egressPropagation` to the workspace update response. Moving a workspace to another environment now pushes that environment's network rules to its running execution when the change is saved. The response says whether the execution took them, could not take them (and was stopped), or had already stopped.
- 015aed2: Workspace errors can carry `takeoverCommitted` and `recovery`. When a takeover committed but its new execution could not be started, the old execution is already cut off; attach again once the cause is fixed, and `recovery` says what was restored and what was lost.

### Patch Changes

- 65d6d51: The generated API schema now describes the add-on catalog: browsing an organization's catalog (`GET /orgs/{orgId}/addons`), one add-on with its details, the add-ons installed in an organization, allowing or forbidding one, opting in to community add-ons, and the public listing (`GET /addons`, no credential). Error responses may carry the code `addon_not_found`. No SDK method calls these routes yet.
- 31751d2: The generated API schema now describes the add-on install API: `POST /orgs/{orgId}/addons/{listingId}/installs` installs a catalog add-on at an org, project, sandbox or Atlas workspace scope, and `DELETE /orgs/{orgId}/addons/{listingId}/installs/{installId}` removes one. Error responses may carry the install checks' codes (`addon_blocked`, `addon_retired`, `addon_scope_not_allowed`, `addon_forbidden_by_org`, `addon_community_not_allowed`, `addon_not_held`, `addon_off_above`, `addon_already_installed`, `addon_install_name_taken`, `addon_listing_ambiguous`, `custom_addons_not_allowed` and others). No SDK method calls these routes yet.
- fbbce18: The generated API schema now describes add-on purchases: `POST /orgs/{orgId}/addons/{listingId}/purchase` buys a paid add-on as an item on the org's subscription, `PATCH` changes its quantity, and `DELETE` cancels it at the end of the paid period. The routes are switched off (they answer 501 `addon_purchase_not_available`) until purchase is enabled. Error responses may carry the purchase codes (`addon_free`, `addon_included`, `addon_not_for_sale`, `addon_trialing`, `addon_plan_required`, `addon_billing_exempt`, `addon_already_held`, `addon_purchase_pending`, `addon_purchase_busy`, `addon_product_shared_with_plan`, `subscription_scheduled` and others). No SDK method calls these routes yet.
- 96f7fd8: Updating an environment's `egressPolicy` or `egressAllowlist` needs the new `environments.egress.manage` permission; changing any other field needs `environments.manage`, and a request that changes both needs both. `environments.egress.manage` is also a valid API key scope.
- a2c7b90: Through the host gateway, `sandbox.metrics.get()` reads live metrics on the sandbox's own host, with a single-use ticket from the API, once the API serves the live streams through host gateways. The answer is the same as the API's, memory warning included. Wherever the gateway does not serve it, the call goes to the API as before.
- 41028c9: A request body that cannot be read, is not JSON, or is not a JSON object is now refused with 400 and `code: "invalid_body"`, and nothing is done. Before, many operations read such a body as if no fields had been sent and acted on their defaults (rotating an API key with the default overlap, for one), and `createProject`, `updateProject`, `createSandbox` and `resizeSandbox` answered 500 to malformed JSON.

  An empty body is a 400 wherever the operation needs one. Where every field is optional (rotating an API key, syncing a catalog, rebuilding a template, attaching or restoring a workspace) it is still a request with none of them, and `attachWorkspace`'s schema now names each default. `updateProject`, which answered 500 to an empty body or to `{}`, now answers 400, as do the MCP and skill connection updates; so does a workspace update of nothing.

  A seat change now needs both `seats` and `premiumSeats`, whole numbers in bounds: `{}` answered by resizing the subscription to the minimum. A fleet toggle needs `disabled`, true or false: `{}` disabled the fleet. Both are now 400.

  An operation that takes no body (the sandbox lifecycle actions, among others) now refuses any body, an empty JSON object included, with 400 `invalid_body` rather than ignore it. Send none.

  `createProject`, `updateProject`, `createSandbox` and `resizeSandbox` now read a JSON body whatever its `Content-Type`, as every other operation already did: before, they ignored a body sent without `Content-Type: application/json` and acted on their defaults.

- 45e4ff0: `GET /me` now returns `avatarUrl`: the profile picture on the caller's account, or null when there is none.
- 0a85671: `listMyOrgs` called with an org API key now lists only the org the key belongs to, the one org the key can act in. A person's session still lists every org they belong to.
- b2ef61b: The project members listing returns `grantableRoles`: the project roles the caller may hand out on that project. Adding, changing or inviting a project member with any other role, or setting your own project role, is refused with `403` and a `code` (`cannot_grant_role`, `cannot_manage_role`, `self`, `cannot_add_to_org`).
- 35eb342: Every operation whose method can carry a request body can now answer 413 with `code: "body_too_large"` and the route's limit in bytes as `limit`. The limit is 1 MiB, except `writeSandboxFile`, which takes a body of up to 5 MiB (its file content is still at most 2 MiB). A body over the limit is refused before any of it is acted on and is never read past the limit: at once when its `Content-Length` says so, or at the first chunk past the limit when it is sent chunked. A chunked body is read only once the caller is authenticated, and must arrive in full within 30 seconds, or the answer is 408 with `code: "body_timeout"`.
- f3fa1a1: Every API response now declares an `X-Request-Id` header. Quote it when asking about a response, especially a refused one: it identifies the request and the access decision that answered it.
- 7ef475f: The generated API schema now describes resource allocations through the add-on install API: installing a resource add-on allocates `config.quantity` of it to a project (the default for its sandboxes) or one sandbox, a second install at the same scope changes the quantity (200), and removing it releases the allocation. An install record gains `projectId`, `quantity` and `unit`, its `kind` may be `resource` and its scope a `sandbox`. `GET /orgs/{orgId}/addons/attached` lists allocations too, and with `projectId` answers `effective`: what that project's sandboxes are given. Error responses may carry the allocation codes (`resource_quantity_invalid`, `resource_not_priced`, `resource_exceeds_project`, `resource_quantity_exceeded`, `resource_quota_not_set`, `resource_quota_exceeded`, `resource_org_cap_not_set`, `resource_org_cap_exceeded`, `resource_allocation_changed`, and 503 `addon_capacity_unavailable`). No resource can be allocated yet, and no SDK method calls these routes.
- 4c529da: Organization lists only show what the caller can use. The projects, sandboxes and ports lists return only rows from projects where the caller holds the list's permission, and a member with no project access gets an empty list rather than an error. Reading an organization's subscription now needs `billing.read`. The documented 403 reasons for the projects, sandboxes and subscription endpoints say so.
- e66ace7: Through the host gateway, a read (live metrics, file list and read) falls back to the API after any failure of the sandbox's host gateway or the path to it (a 5xx, a 429, an error page from the edge, an answer cut off, a lost connection or a timeout), instead of throwing, and only for that call. A command or a write falls back only when the gateway refused it before touching the sandbox, including when the gateway has no credential for the sandbox or is at a stream cap; after it may have run, it is never sent twice, and an answer cut off is an error. A sandbox's later calls stay on the API only when its gateway path cannot work: the gateway refused the API's ticket, its host has no gateway, or the gateway URL is not https.
- 277b896: Host gateway: a command or a file write now goes to the API when the connection to the sandbox's host gateway was never ready for it (refused, a name that doesn't resolve, no route, a TLS handshake that failed, no connection within 10 seconds), since nothing was sent; a reset after connecting is still an error, never a second run. That holds only on the SDK's own transport: without a `fetch` option, Node reaches gateways with node:http(s), not globalThis.fetch or its global dispatcher. Through a `fetch` you pass, which may retry, such a command or write is an error rather than a second run; reads still fall back. A gateway that fails 3 of a sandbox's calls in a row is skipped for about 60 seconds, with no ticket requests; past that, one read at a time tries it again, and commands and writes return to it only once a read has succeeded; a client that only runs commands gets there through a read the SDK makes itself.
- 886127d: A workspace now reports its head, `currentCheckpointId`: its newest durable checkpoint, which is what a takeover restores. A takeover's `recovery` says whether it restored a checkpoint, the superseded execution's own snapshot, or nothing (`restoredFrom`).
- d74069e: Adds `forkWorkspace`: `POST /orgs/{orgId}/projects/{projectId}/workspaces/{workspaceId}/fork` with `{ name, checkpointId? }` creates a new, sleeping workspace that starts from one of the source's durable checkpoints (its head by default) and answers `201` with the new workspace and `forkedFrom: { workspaceId, checkpointId }`. Only the source's owner may fork it (`403 workspace_owner_only`). The error schema now lists `workspace_owner_only` (with `workspaceId`), which every owner-only workspace route already answers. New error codes: `checkpoint_not_found`, `checkpoint_not_durable`, `checkpoint_unavailable`, `nothing_to_fork`, `workspace_not_found`. The route is off on the server until enabled and answers 404 until then.

## 0.5.0

### Minor Changes

- 119ba8d: A sandbox whose machine was lost before it could be snapshotted now says so instead of waking into older state silently. `Sandbox` carries `vm_lost_at`, and `wake()` takes `acknowledgeLostState` to restore the surviving older snapshot anyway; without it such a wake is refused with `409 vm_lost`, naming both the date the machine was lost and the date of the snapshot it would restore.

## 0.4.0

### Minor Changes

- ab4f66b: Add the agent-session conversation transcript (`getAgentTranscript`): user messages, replies, tool calls with status, output and diffs, reasoning summaries, and turn and approval markers. The event stream now also carries `conversation` events and reply `itemId`s.
- 4350f94: Add agent-session event streaming types: `streamAgentSessionEvents` (server-sent events with resumable output cursors) and `waitForAgentSession` (long-poll that returns when a reply, turn transition or approval request arrives).
- 7e65ee8: Add managed agent-session release types and terminal resume instructions for Claude Code and Codex. Session state now includes released and releasing flags.

### Patch Changes

- e06d6a9: Document every generated API operation: each now carries a summary, and the sandbox lifecycle, command and file operations describe their behavior. Types are unchanged.

## 0.3.0

### Minor Changes

- 91b9f42: Expose agent-independent communication capabilities and setup/restart requirements
  on agent sessions. Session agent IDs are extensible strings; supported operations
  are reported separately from caller permissions.
- ba2f505: Add typed agent-session discovery, creation, output, messaging, approvals,
  interruption and Codex recovery endpoints, plus personal agent-token management
  for access across authorized projects and organizations.
- 177ef49: Add optional agent-message request keys and replay responses so clients can retry lost responses without creating another turn.

## 0.2.0

### Minor Changes

- 20b7ee5: Add generated REST types for managed agent-session discovery, creation, output, messages, approvals, and interruption.
- f2a81fe: Add typed caller identity, usage reporting, API-key management and filesystem
  tree operations to the raw API client. Serve the deployed OpenAPI contract at
  `/openapi.json` and document the complete core sandbox workflow.

## 0.1.1

### Patch Changes

- a88e5d9: License the SDK under MIT and publish its implementation, tests, and standalone
  build configuration at https://github.com/remotehostai/sdk.

## 0.1.0

### Minor Changes

- 2cbed35: Release the first public RemoteHost TypeScript SDK with generated API types and
  resource-oriented sandbox, command, file, preview, metrics, and lifecycle APIs.
