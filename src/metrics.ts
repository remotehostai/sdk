import type { components, operations } from "./generated/schema.js";
import type { APIClient } from "./internal.js";
import { unwrap } from "./internal.js";
import type { RequestOptions } from "./request-options.js";
import { requestSignal } from "./request-options.js";

export type SandboxMetrics = components["schemas"]["SandboxMetrics"];
export type LiveSandboxMetrics =
  operations["getSandboxMetrics"]["responses"][200]["content"]["application/json"];

export class SandboxMetricsResource {
  constructor(
    private readonly api: APIClient,
    private readonly sandboxId: string,
  ) {}

  /** Read current resource utilization without persisting a recommendation. */
  get(options: RequestOptions = {}): Promise<LiveSandboxMetrics> {
    return unwrap(
      this.api.GET("/sandboxes/{sandboxId}/metrics/live", {
        params: { path: { sandboxId: this.sandboxId } },
        signal: requestSignal(options),
      }),
    );
  }

  /** Sample utilization and persist the resulting resize recommendation. */
  sample(options: RequestOptions = {}): Promise<SandboxMetrics> {
    return unwrap(
      this.api.POST("/sandboxes/{sandboxId}/metrics/sample", {
        params: { path: { sandboxId: this.sandboxId } },
        signal: requestSignal(options),
      }),
    );
  }
}
