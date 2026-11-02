import type { components, operations } from "./generated/schema.js";
import type { APIClient } from "./internal.js";
import { requireOrgId, unwrap } from "./internal.js";
import type { RequestOptions } from "./request-options.js";
import { requestSignal } from "./request-options.js";

/**
 * A project's named, reusable boot configuration: image, machine size, setup
 * script, services, ports, environment variables and egress policy. Every
 * environment and sandbox in the project boots from one.
 */
export type EnvironmentTemplate = components["schemas"]["EnvironmentTemplate"];
export type CreateEnvironmentTemplateBody = NonNullable<
  operations["createEnvironmentTemplate"]["requestBody"]
>["content"]["application/json"];
export type UpdateEnvironmentTemplateBody = NonNullable<
  operations["updateEnvironmentTemplate"]["requestBody"]
>["content"]["application/json"];

/**
 * What a change to the network rules did to the running sandboxes held to
 * them: which now enforce them, which the push could not reach (and whether
 * each was stopped instead), and which were not running.
 */
export type EgressPropagation = NonNullable<
  operations["updateEnvironmentTemplate"]["responses"][200]["content"]["application/json"]["egressPropagation"]
>;

export type EnvironmentTemplateWriteResult = {
  environmentTemplate: EnvironmentTemplate;
  /** Present when the change altered what running sandboxes are held to. */
  egressPropagation?: EgressPropagation;
};

export type EnvironmentTemplateDeleteResult = {
  deleted: boolean;
  /** True when sandboxes still boot from it: it is kept for them until the last one is deleted. */
  keptForSandboxes?: boolean;
  egressPropagation?: EgressPropagation;
};

export type EnvironmentTemplateRequestOptions = RequestOptions & {
  orgId?: string;
  projectId: string;
};
export type CreateEnvironmentTemplateOptions = CreateEnvironmentTemplateBody &
  EnvironmentTemplateRequestOptions;
export type UpdateEnvironmentTemplateOptions = UpdateEnvironmentTemplateBody &
  EnvironmentTemplateRequestOptions;

/**
 * A project's environment templates, at
 * `/orgs/{orgId}/projects/{projectId}/environment-templates`.
 */
export class EnvironmentTemplates {
  constructor(
    private readonly api: APIClient,
    private readonly defaultOrgId?: string,
  ) {}

  /** List a project's environment templates. */
  async list(options: EnvironmentTemplateRequestOptions): Promise<EnvironmentTemplate[]> {
    const data = await unwrap(
      this.api.GET("/orgs/{orgId}/projects/{projectId}/environment-templates", {
        params: { path: this.projectPath(options) },
        signal: requestSignal(options),
      }),
    );
    return data.environments;
  }

  /** Create an environment template. */
  async create(options: CreateEnvironmentTemplateOptions): Promise<EnvironmentTemplateWriteResult> {
    const { orgId, projectId, signal: _signal, timeoutMs: _timeoutMs, ...body } = options;
    const data = await unwrap(
      this.api.POST("/orgs/{orgId}/projects/{projectId}/environment-templates", {
        params: { path: this.projectPath({ orgId, projectId }) },
        body,
        signal: requestSignal(options),
      }),
    );
    return writeResult(data);
  }

  /** Retrieve one environment template by id. */
  async retrieve(
    environmentTemplateId: string,
    options: EnvironmentTemplateRequestOptions,
  ): Promise<EnvironmentTemplate> {
    const data = await unwrap(
      this.api.GET("/orgs/{orgId}/projects/{projectId}/environment-templates/{environmentId}", {
        params: { path: { ...this.projectPath(options), environmentId: environmentTemplateId } },
        signal: requestSignal(options),
      }),
    );
    return data.environment;
  }

  /**
   * Update an environment template. Fields left out are unchanged; null
   * clears a nullable one. A change to its egress policy or allowlist is
   * pushed to the running sandboxes it affects; see `egressPropagation`.
   */
  async update(
    environmentTemplateId: string,
    options: UpdateEnvironmentTemplateOptions,
  ): Promise<EnvironmentTemplateWriteResult> {
    const { orgId, projectId, signal: _signal, timeoutMs: _timeoutMs, ...body } = options;
    const data = await unwrap(
      this.api.PATCH("/orgs/{orgId}/projects/{projectId}/environment-templates/{environmentId}", {
        params: {
          path: { ...this.projectPath({ orgId, projectId }), environmentId: environmentTemplateId },
        },
        body,
        signal: requestSignal(options),
      }),
    );
    return writeResult(data);
  }

  /**
   * Delete an environment template. Refused with 409 while any environment
   * names it. Sandboxes still booting from it keep it until the last of them
   * is deleted (`keptForSandboxes`).
   */
  async delete(
    environmentTemplateId: string,
    options: EnvironmentTemplateRequestOptions,
  ): Promise<EnvironmentTemplateDeleteResult> {
    const data = await unwrap(
      this.api.DELETE("/orgs/{orgId}/projects/{projectId}/environment-templates/{environmentId}", {
        params: { path: { ...this.projectPath(options), environmentId: environmentTemplateId } },
        signal: requestSignal(options),
      }),
    );
    return data;
  }

  private projectPath(options: { orgId?: string; projectId: string }) {
    return { orgId: requireOrgId(options.orgId, this.defaultOrgId), projectId: options.projectId };
  }
}

function writeResult(data: {
  environment: EnvironmentTemplate;
  egressPropagation?: EgressPropagation;
}): EnvironmentTemplateWriteResult {
  return data.egressPropagation === undefined
    ? { environmentTemplate: data.environment }
    : { environmentTemplate: data.environment, egressPropagation: data.egressPropagation };
}
