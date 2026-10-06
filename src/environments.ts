import type { EgressPropagation } from "./environment-templates.js";
import type { components, operations } from "./generated/schema.js";
import type { APIClient } from "./internal.js";
import { requireOrgId, unwrap } from "./internal.js";
import type { RequestOptions } from "./request-options.js";
import { requestSignal } from "./request-options.js";
import { Sandbox } from "./sandboxes.js";

// The API still serves environments at /orgs/{orgId}/projects/{projectId}/workspaces
// and names them Workspace in its OpenAPI schema; publicly they are
// Environments. The routes move to /environments in a later release, and
// only this file changes when they do.

/**
 * A project's environment: durable work (a disk, its checkpoints and its own
 * git branch, `remotehost/<name>`) that outlives any one sandbox. At most one
 * sandbox runs it at a time, under a lease; attach to get that sandbox.
 *
 * `environmentId` on it names the environment template it boots from (null
 * follows the project's default). It keeps the API's field name.
 */
export type Environment = components["schemas"]["Workspace"];
export type EnvironmentLease = components["schemas"]["WorkspaceLease"];
export type EnvironmentRecovery = components["schemas"]["WorkspaceRecovery"];
export type EnvironmentStatus = Environment["status"];
export type EnvironmentLifetimePolicy = Environment["lifetimePolicy"];

type CreateBody = NonNullable<
  operations["createWorkspace"]["requestBody"]
>["content"]["application/json"];
type UpdateBody = NonNullable<
  operations["updateWorkspace"]["requestBody"]
>["content"]["application/json"];
type AttachBody = NonNullable<
  operations["attachWorkspace"]["requestBody"]
>["content"]["application/json"];
type ForkBody = NonNullable<
  operations["forkWorkspace"]["requestBody"]
>["content"]["application/json"];

export type EnvironmentRequestOptions = RequestOptions & {
  orgId?: string;
  projectId: string;
};

export type ListEnvironmentsOptions = EnvironmentRequestOptions & {
  /** At most this many, most recently active first. */
  limit?: number;
};

type TemplateChoice = {
  /**
   * The environment template its sandboxes boot from; null follows the
   * project's default. Refused (403 `environment_enforced`) when the project
   * enforces its default.
   */
  environmentTemplateId?: string | null;
};

export type CreateEnvironmentOptions = Omit<CreateBody, "environmentId"> &
  TemplateChoice &
  EnvironmentRequestOptions;
export type UpdateEnvironmentOptions = Omit<UpdateBody, "environmentId"> &
  TemplateChoice &
  EnvironmentRequestOptions;
export type AttachEnvironmentOptions = AttachBody & EnvironmentRequestOptions;
export type ForkEnvironmentOptions = ForkBody & EnvironmentRequestOptions;

export type EnvironmentUpdateResult = {
  environment: Environment;
  /** Present when the request named a template: what its running sandbox was held to. */
  egressPropagation?: EgressPropagation;
};

export type EnvironmentDeleteResult = {
  deleted: true;
  environmentId: string;
  /** Sandboxes that could not be destroyed yet; each is destroyed once it can be. */
  executionsPendingCleanup: { sandboxId: string; message: string }[];
};

export type EnvironmentAttachResult = {
  environment: Environment;
  /** The running sandbox for the environment. */
  sandbox: Sandbox;
  /** created, resumed (woken), existing (already running) or takeover. */
  attached: "created" | "resumed" | "existing" | "takeover";
  leaseRenewed?: boolean;
  /** Present after a takeover: what was restored and what was lost. */
  recovery?: EnvironmentRecovery;
};

export type EnvironmentDetachResult = {
  environment: Environment;
  sandbox: Sandbox | null;
  /** stopping (the save is under way) or already (nothing was running). */
  detached: "stopping" | "already";
};

export type EnvironmentForkResult = {
  environment: Environment;
  forkedFrom: { environmentId: string; checkpointId: string };
};

/** A project's environments: create, attach, detach, fork, rename and delete. */
export class Environments {
  constructor(
    private readonly api: APIClient,
    private readonly defaultOrgId?: string,
  ) {}

  /** List a project's environments, most recently active first. Deleted ones are not listed. */
  async list(options: ListEnvironmentsOptions): Promise<Environment[]> {
    const data = await unwrap(
      this.api.GET("/orgs/{orgId}/projects/{projectId}/workspaces", {
        params: {
          path: this.projectPath(options),
          query: options.limit === undefined ? undefined : { limit: options.limit },
        },
        signal: requestSignal(options),
      }),
    );
    return data.workspaces;
  }

  /**
   * Create an environment. It starts asleep with no sandbox; attach it to
   * get one. Its name fixes its git branch, `remotehost/<name>`.
   */
  async create(options: CreateEnvironmentOptions): Promise<Environment> {
    const {
      orgId,
      projectId,
      environmentTemplateId,
      signal: _signal,
      timeoutMs: _timeoutMs,
      ...rest
    } = options;
    const body: CreateBody =
      "environmentTemplateId" in options ? { ...rest, environmentId: environmentTemplateId } : rest;
    const data = await unwrap(
      this.api.POST("/orgs/{orgId}/projects/{projectId}/workspaces", {
        params: { path: this.projectPath({ orgId, projectId }) },
        body,
        signal: requestSignal(options),
      }),
    );
    return data.workspace;
  }

  /** Retrieve one environment by id. */
  async retrieve(environmentId: string, options: EnvironmentRequestOptions): Promise<Environment> {
    const data = await unwrap(
      this.api.GET("/orgs/{orgId}/projects/{projectId}/workspaces/{workspaceId}", {
        params: { path: { ...this.projectPath(options), workspaceId: environmentId } },
        signal: requestSignal(options),
      }),
    );
    return data.workspace;
  }

  /**
   * Rename or reconfigure an environment. A rename does not move its git
   * branch. Moving it to another template pushes that template's network
   * rules to its running sandbox; see `egressPropagation`.
   */
  async update(
    environmentId: string,
    options: UpdateEnvironmentOptions,
  ): Promise<EnvironmentUpdateResult> {
    const {
      orgId,
      projectId,
      environmentTemplateId,
      signal: _signal,
      timeoutMs: _timeoutMs,
      ...rest
    } = options;
    const body: UpdateBody =
      "environmentTemplateId" in options ? { ...rest, environmentId: environmentTemplateId } : rest;
    const data = await unwrap(
      this.api.PATCH("/orgs/{orgId}/projects/{projectId}/workspaces/{workspaceId}", {
        params: { path: { ...this.projectPath({ orgId, projectId }), workspaceId: environmentId } },
        body,
        signal: requestSignal(options),
      }),
    );
    return data.egressPropagation === undefined
      ? { environment: data.workspace }
      : { environment: data.workspace, egressPropagation: data.egressPropagation };
  }

  /**
   * Delete an environment and destroy its sandboxes. Uncommitted work is
   * lost. A sandbox that cannot be destroyed yet is listed in
   * `executionsPendingCleanup` and destroyed once it can be.
   */
  async delete(
    environmentId: string,
    options: EnvironmentRequestOptions,
  ): Promise<EnvironmentDeleteResult> {
    const data = await unwrap(
      this.api.DELETE("/orgs/{orgId}/projects/{projectId}/workspaces/{workspaceId}", {
        params: { path: { ...this.projectPath(options), workspaceId: environmentId } },
        signal: requestSignal(options),
      }),
    );
    return {
      deleted: data.deleted,
      environmentId: data.workspaceId,
      executionsPendingCleanup: data.executionsPendingCleanup,
    };
  }

  /**
   * Get a running sandbox for the environment: the one already running, the
   * sleeping one woken, or a new one. While another sandbox is starting or
   * stopping it fails with 409 `workspace_leased`; when the host running it
   * has stopped answering, 409 `lease_expired`, and `takeover: true` moves
   * it to a new sandbox restored from its last saved snapshot.
   */
  async attach(
    environmentId: string,
    options: AttachEnvironmentOptions,
  ): Promise<EnvironmentAttachResult> {
    const { orgId, projectId, signal: _signal, timeoutMs: _timeoutMs, ...body } = options;
    const data = await unwrap(
      this.api.POST("/orgs/{orgId}/projects/{projectId}/workspaces/{workspaceId}/attach", {
        params: { path: { ...this.projectPath({ orgId, projectId }), workspaceId: environmentId } },
        body,
        signal: requestSignal(options),
      }),
    );
    const result: EnvironmentAttachResult = {
      environment: data.workspace,
      sandbox: new Sandbox(this.api, data.sandbox),
      attached: data.attached,
    };
    if (data.leaseRenewed !== undefined) result.leaseRenewed = data.leaseRenewed;
    if (data.recovery !== undefined) result.recovery = data.recovery;
    return result;
  }

  /**
   * Save the environment's sandbox and stop it. Resolves once the stop is
   * under way; the lease is released when the snapshot commits. Idempotent.
   */
  async detach(
    environmentId: string,
    options: EnvironmentRequestOptions,
  ): Promise<EnvironmentDetachResult> {
    const data = await unwrap(
      this.api.POST("/orgs/{orgId}/projects/{projectId}/workspaces/{workspaceId}/detach", {
        params: { path: { ...this.projectPath(options), workspaceId: environmentId } },
        signal: requestSignal(options),
      }),
    );
    return {
      environment: data.workspace,
      sandbox: data.sandbox ? new Sandbox(this.api, data.sandbox) : null,
      detached: data.detached,
    };
  }

  /**
   * Create a new environment in the same project that starts as a copy of
   * this one at a durable checkpoint (its head by default), uncommitted work
   * included. Only the environment's owner may fork it. Off unless the
   * server enables it; while off it fails with 404.
   */
  async fork(environmentId: string, options: ForkEnvironmentOptions): Promise<EnvironmentForkResult> {
    const { orgId, projectId, signal: _signal, timeoutMs: _timeoutMs, ...body } = options;
    const data = await unwrap(
      this.api.POST("/orgs/{orgId}/projects/{projectId}/workspaces/{workspaceId}/fork", {
        params: { path: { ...this.projectPath({ orgId, projectId }), workspaceId: environmentId } },
        body,
        signal: requestSignal(options),
      }),
    );
    return {
      environment: data.workspace,
      forkedFrom: {
        environmentId: data.forkedFrom.workspaceId,
        checkpointId: data.forkedFrom.checkpointId,
      },
    };
  }

  private projectPath(options: { orgId?: string; projectId: string }) {
    return { orgId: requireOrgId(options.orgId, this.defaultOrgId), projectId: options.projectId };
  }
}
