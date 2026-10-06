import type { components, operations } from "./generated/schema.js";
import type { APIClient } from "./internal.js";
import { requireOrgId, unwrap, unwrapNoContent } from "./internal.js";
import type { RequestOptions } from "./request-options.js";
import { requestSignal } from "./request-options.js";

/**
 * One of an organization's workspaces. Its kind, `internal` (where the team
 * builds) or `external` (the infrastructure the team's product runs on, for
 * its customers), is set at creation and never changes; every project in it
 * has that kind.
 */
export type Workspace = components["schemas"]["OrgWorkspace"];
export type WorkspaceKind = Workspace["kind"];
export type CreateWorkspaceBody = NonNullable<
  operations["createOrgWorkspace"]["requestBody"]
>["content"]["application/json"];
export type UpdateWorkspaceBody = NonNullable<
  operations["updateOrgWorkspace"]["requestBody"]
>["content"]["application/json"];

export type WorkspaceRequestOptions = RequestOptions & { orgId?: string };
export type CreateWorkspaceOptions = CreateWorkspaceBody & WorkspaceRequestOptions;
export type UpdateWorkspaceOptions = UpdateWorkspaceBody & WorkspaceRequestOptions;

/**
 * An organization's workspaces: list, create, retrieve, rename and delete.
 *
 * The workspace API is off until it is enabled for a deployment; until then
 * every call fails with a 404 RemoteHostAPIError. Once it is on, an API key
 * pinned to a workspace may `retrieve` that one workspace (any other answers
 * the 404 a missing one does); `list` and every write refuse API keys with a
 * 403, and a key with no workspace pin cannot call it at all.
 */
export class Workspaces {
  constructor(
    private readonly api: APIClient,
    private readonly defaultOrgId?: string,
  ) {}

  /** The org's workspaces the caller can see, defaults first. */
  async list(options: WorkspaceRequestOptions = {}): Promise<Workspace[]> {
    const data = await unwrap(
      this.api.GET("/orgs/{orgId}/workspaces", {
        params: { path: { orgId: requireOrgId(options.orgId, this.defaultOrgId) } },
        signal: requestSignal(options),
      }),
    );
    return data.workspaces;
  }

  /** Create a workspace. Its kind is fixed from here on. */
  async create(options: CreateWorkspaceOptions): Promise<Workspace> {
    const { orgId, signal: _signal, timeoutMs: _timeoutMs, ...body } = options;
    const data = await unwrap(
      this.api.POST("/orgs/{orgId}/workspaces", {
        params: { path: { orgId: requireOrgId(orgId, this.defaultOrgId) } },
        body,
        signal: requestSignal(options),
      }),
    );
    return data.workspace;
  }

  /** Retrieve one workspace by id. */
  async retrieve(workspaceId: string, options: WorkspaceRequestOptions = {}): Promise<Workspace> {
    const data = await unwrap(
      this.api.GET("/orgs/{orgId}/workspaces/{workspaceId}", {
        params: { path: { orgId: requireOrgId(options.orgId, this.defaultOrgId), workspaceId } },
        signal: requestSignal(options),
      }),
    );
    return data.workspace;
  }

  /** Rename a workspace or change its slug. The kind cannot change. */
  async update(workspaceId: string, options: UpdateWorkspaceOptions): Promise<Workspace> {
    const { orgId, signal: _signal, timeoutMs: _timeoutMs, ...body } = options;
    const data = await unwrap(
      this.api.PATCH("/orgs/{orgId}/workspaces/{workspaceId}", {
        params: { path: { orgId: requireOrgId(orgId, this.defaultOrgId), workspaceId } },
        body,
        signal: requestSignal(options),
      }),
    );
    return data.workspace;
  }

  /**
   * Delete an empty workspace. Refused for a workspace that still holds
   * projects, and for one of the org's defaults.
   */
  async delete(workspaceId: string, options: WorkspaceRequestOptions = {}): Promise<void> {
    await unwrapNoContent(
      this.api.DELETE("/orgs/{orgId}/workspaces/{workspaceId}", {
        params: { path: { orgId: requireOrgId(options.orgId, this.defaultOrgId), workspaceId } },
        signal: requestSignal(options),
      }),
    );
  }
}
