import type { components } from "./generated/schema.js";
import { USE_API, hostGatewayFor } from "./host-gateway.js";
import type { APIClient } from "./internal.js";
import { unwrap } from "./internal.js";
import type { RequestOptions } from "./request-options.js";
import { requestSignal } from "./request-options.js";

export type CommandResult = components["schemas"]["ExecSandboxResult"];

export type RunCommandOptions = RequestOptions & {
  timeoutSeconds?: number;
};

export class SandboxCommands {
  constructor(
    private readonly api: APIClient,
    private readonly sandboxId: string,
  ) {}

  /** Run a non-interactive command to completion and capture its exit code and output. */
  async run(command: string, options: RunCommandOptions = {}): Promise<CommandResult> {
    const { timeoutSeconds } = options;
    const signal = requestSignal(options);

    // Through the sandbox's own host when the client is set to (REM-690).
    const viaGateway = await hostGatewayFor(this.api)?.call<CommandResult>(this.sandboxId, {
      permission: "sandbox.terminal.connect",
      method: "POST",
      path: "/v1/exec",
      body: { command, timeoutSeconds },
      idempotent: false,
      signal,
    });
    if (viaGateway !== undefined && viaGateway !== USE_API) {
      return viaGateway;
    }

    return unwrap(
      this.api.POST("/sandboxes/{sandboxId}/exec", {
        params: { path: { sandboxId: this.sandboxId } },
        body: { command, timeoutSeconds },
        signal,
      }),
    );
  }
}
