import type { components, operations } from "./generated/schema.js";
import { USE_API, hostGatewayFor } from "./host-gateway.js";
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
  async get(options: RequestOptions = {}): Promise<LiveSandboxMetrics> {
    // Through the sandbox's host when the client uses the host gateway
    // (REM-715): the same answer, the sample read on the host and the memory
    // warning from the API's allocation. A read, so any gateway failure
    // falls back to the API.
    const viaGateway = await hostGatewayFor(this.api)?.call<LiveSandboxMetrics>(this.sandboxId, {
      permission: "sandbox.files.read",
      method: "GET",
      path: "/v1/metrics",
      ticketRoute: "metrics/gateway-ticket",
      idempotent: true,
      signal: requestSignal(options),
    });
    if (viaGateway !== undefined && viaGateway !== USE_API) {
      return viaGateway;
    }

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
