import { SandboxCommands } from "./commands.js";
import {
  RemoteHostAPIError,
  RemoteHostConfigurationError,
  RemoteHostError,
  RemoteHostTimeoutError,
} from "./errors.js";
import { SandboxFiles } from "./files.js";
import type { components } from "./generated/schema.js";
import type { APIClient } from "./internal.js";
import { unwrap } from "./internal.js";
import { SandboxMetricsResource } from "./metrics.js";
import { SandboxPreviews } from "./previews.js";
import type { RequestOptions } from "./request-options.js";
import { abortableDelay, requestSignal } from "./request-options.js";

export type SandboxData = components["schemas"]["Sandbox"];
export type CreateSandboxBody = components["schemas"]["CreateSandboxBody"];
export type SandboxProfile =
  | "auto"
  | "agent-small"
  | "agent-standard"
  | "build-heavy"
  | "browser-heavy"
  | "repo-large"
  | "long-running";
// The whole shape, every time: the API refuses a resize without all three
// of vcpu, memoryGb and diskGb as positive numbers (400 "vcpu, memoryGb, and
// diskGb must be positive numbers."), so a partial one does not type-check
// (REM-5401). restart (REM-57): stop a running persistent sandbox and start
// it again at the new shape in the same request, answered with applied
// "restart"; running processes end, files stay. It is sent only when true,
// so an API without it answers every other resize as before (REM-4099).
export type ResizeSandboxBody = {
  vcpu: number;
  memoryGb: number;
  diskGb: number;
  restart?: boolean;
};

export type WakeSandboxOptions = RequestOptions & {
  acknowledgeLostState?: boolean;
  /**
   * How long to wait for a snapshot that is still saving, in milliseconds
   * (default 180000; 0 does not wait).
   */
  snapshotWaitMs?: number;
};

// A sleep's snapshot save takes seconds; the wake asks again once a second.
const DEFAULT_SNAPSHOT_WAIT_MS = 180_000;
const SNAPSHOT_POLL_MS = 1_000;

export type ListSandboxesOptions = RequestOptions & {
  orgId?: string;
  projectId?: string;
  endUserId?: string;
};

export type CreateSandboxOptions = Omit<
  CreateSandboxBody,
  "agent" | "machineSize" | "mode" | "persistencePolicy" | "profile" | "projectId"
> &
  RequestOptions & {
    agent: SandboxData["agent"];
    machineSize?: SandboxData["machine_size"];
    mode?: SandboxData["mode"];
    orgId?: string;
    persistencePolicy?: SandboxData["persistence_policy"];
    pollIntervalMs?: number;
    profile?: SandboxProfile;
    projectId: string;
    waitForReady?: boolean;
    waitTimeoutMs?: number;
  };

export type SandboxResizeResult = {
  applied: "current" | "live" | "next_resume" | "restart";
  liveResizeError: string | null;
  pendingAllocation: {
    vcpu: number;
    memoryGb: number;
    diskGb: number;
  } | null;
  sandbox: Sandbox;
};

export type WaitForSandboxOptions = RequestOptions & {
  pollIntervalMs?: number;
};

export class Sandboxes {
  constructor(
    private readonly api: APIClient,
    private readonly defaultOrgId?: string,
  ) {}

  /** List non-deleted sandboxes visible in an organization. */
  async list(options: ListSandboxesOptions = {}): Promise<Sandbox[]> {
    const { orgId, projectId, endUserId } = options;
    const data = await unwrap(
      this.api.GET("/orgs/{orgId}/sandboxes", {
        params: {
          path: { orgId: this.requireOrgId(orgId) },
          query: { projectId, endUserId },
        },
        signal: requestSignal(options),
      }),
    );

    return data.sandboxes.map((sandbox) => new Sandbox(this.api, sandbox));
  }

  /** Create a sandbox, waiting for it to become ready by default. */
  async create(options: CreateSandboxOptions): Promise<Sandbox> {
    const {
      orgId,
      pollIntervalMs,
      signal: _signal,
      timeoutMs: _timeoutMs,
      waitForReady = true,
      waitTimeoutMs,
      ...body
    } = options;
    const data = await unwrap(
      this.api.POST("/orgs/{orgId}/sandboxes", {
        params: { path: { orgId: this.requireOrgId(orgId) } },
        body,
        signal: requestSignal(options),
      }),
    );

    const sandbox = new Sandbox(this.api, data.sandbox);
    return waitForReady
      ? sandbox.waitUntilReady({
          pollIntervalMs,
          signal: options.signal,
          timeoutMs: waitTimeoutMs,
        })
      : sandbox;
  }

  /** Retrieve one sandbox by id. */
  async retrieve(sandboxId: string, options: RequestOptions = {}): Promise<Sandbox> {
    const data = await unwrap(
      this.api.GET("/sandboxes/{sandboxId}", {
        params: { path: { sandboxId } },
        signal: requestSignal(options),
      }),
    );
    return new Sandbox(this.api, data.sandbox);
  }

  private requireOrgId(orgId?: string): string {
    const resolved = orgId ?? this.defaultOrgId;
    if (!resolved) {
      throw new RemoteHostConfigurationError(
        "An orgId is required. Pass it to the client or this request.",
      );
    }
    return resolved;
  }
}

export class Sandbox {
  #data: SandboxData;
  readonly commands: SandboxCommands;
  readonly files: SandboxFiles;
  readonly metrics: SandboxMetricsResource;
  readonly previews: SandboxPreviews;

  constructor(
    private readonly api: APIClient,
    data: SandboxData,
  ) {
    this.#data = data;
    this.commands = new SandboxCommands(api, data.id);
    this.files = new SandboxFiles(api, data.id);
    this.metrics = new SandboxMetricsResource(api, data.id);
    this.previews = new SandboxPreviews(api, data.id);
  }

  /** Latest raw API representation. Call refresh() to update it. */
  get data(): Readonly<SandboxData> {
    return this.#data;
  }

  get id(): string {
    return this.#data.id;
  }

  get orgId(): string {
    return this.#data.org_id;
  }

  get projectId(): string {
    return this.#data.project_id;
  }

  get name(): string {
    return this.#data.name;
  }

  get status(): SandboxData["status"] {
    return this.#data.status;
  }

  /** Release compute while preserving the disk of a persistent sandbox. */
  async sleep(options: RequestOptions = {}): Promise<this> {
    const data = await unwrap(
      this.api.POST("/sandboxes/{sandboxId}/sleep", {
        params: { path: { sandboxId: this.id } },
        signal: requestSignal(options),
      }),
    );
    return this.update(data.sandbox);
  }

  /** @deprecated Use sleep(). */
  async stop(options: RequestOptions = {}): Promise<this> {
    const data = await unwrap(
      this.api.POST("/sandboxes/{sandboxId}/stop", {
        params: { path: { sandboxId: this.id } },
        signal: requestSignal(options),
      }),
    );
    return this.update(data.sandbox);
  }

  /**
   * Wake a sleeping persistent sandbox.
   *
   * `sleep()` returns as the sandbox's snapshot starts saving, and a wake
   * before the save finishes is refused 409 `snapshot_in_progress` with
   * nothing changed. The wake waits for the save, for up to
   * `snapshotWaitMs` (default 180000; 0 does not wait), then wakes; past
   * that it throws the API's error. `timeoutMs` and `signal` bound the whole
   * call, waiting included.
   *
   * A sandbox whose machine was lost before it could be snapshotted refuses
   * to wake with 409 `vm_lost`, because the snapshot it would restore is
   * older than the work that was in it. `acknowledgeLostState` wakes it from
   * that older snapshot anyway. `vm_lost_at` on the sandbox says whether
   * this applies, and the error names both dates.
   */
  async wake(options: WakeSandboxOptions = {}): Promise<this> {
    const query = options.acknowledgeLostState ? { acknowledgeLostState: "true" as const } : {};
    return this.#waitingOutSnapshot(options, (signal) =>
      unwrap(
        this.api.POST("/sandboxes/{sandboxId}/wake", {
          params: { path: { sandboxId: this.id }, query },
          signal,
        }),
      ),
    );
  }

  /** @deprecated Use wake(). */
  async resume(options: RequestOptions & Pick<WakeSandboxOptions, "snapshotWaitMs"> = {}): Promise<this> {
    return this.#waitingOutSnapshot(options, (signal) =>
      unwrap(
        this.api.POST("/sandboxes/{sandboxId}/resume", {
          params: { path: { sandboxId: this.id } },
          signal,
        }),
      ),
    );
  }

  // Sends a wake again while the API answers that the sandbox's snapshot is
  // still saving (REM-5400), once a second, within snapshotWaitMs.
  async #waitingOutSnapshot(
    options: RequestOptions & { snapshotWaitMs?: number },
    send: (signal: AbortSignal | undefined) => Promise<{ sandbox: SandboxData }>,
  ): Promise<this> {
    const waitMs = options.snapshotWaitMs ?? DEFAULT_SNAPSHOT_WAIT_MS;
    if (!Number.isFinite(waitMs) || waitMs < 0) {
      throw new TypeError("snapshotWaitMs must be a non-negative number.");
    }
    const signal = requestSignal(options);
    const startedAt = Date.now();

    for (;;) {
      try {
        const data = await send(signal);
        return this.update(data.sandbox);
      } catch (error) {
        const saving =
          error instanceof RemoteHostAPIError && error.status === 409 && error.code === "snapshot_in_progress";
        if (!saving || Date.now() - startedAt + SNAPSHOT_POLL_MS > waitMs) {
          throw error;
        }
        await abortableDelay(SNAPSHOT_POLL_MS, signal);
      }
    }
  }

  /** Renew the sandbox lease. */
  async renew(options: RequestOptions = {}): Promise<this> {
    const data = await unwrap(
      this.api.POST("/sandboxes/{sandboxId}/renew", {
        params: { path: { sandboxId: this.id } },
        signal: requestSignal(options),
      }),
    );
    return this.update(data.sandbox);
  }

  /** Permanently destroy the sandbox. */
  async destroy(options: RequestOptions = {}): Promise<this> {
    const data = await unwrap(
      this.api.POST("/sandboxes/{sandboxId}/destroy", {
        params: { path: { sandboxId: this.id } },
        signal: requestSignal(options),
      }),
    );
    return this.update(data.sandbox);
  }

  /**
   * Change the requested resource allocation. With `restart: true` a
   * running persistent sandbox stops and starts again at the new shape in
   * this request (`applied: "restart"`). It needs `sandbox.stop` and
   * `sandbox.create` on the sandbox besides `sandbox.resize`, and the API
   * refuses it (400) until resize restart is enabled for the deployment.
   */
  async resize(
    body: ResizeSandboxBody,
    options: RequestOptions = {},
  ): Promise<SandboxResizeResult> {
    const { restart, ...allocation } = body;
    const data = await unwrap(
      this.api.POST("/sandboxes/{sandboxId}/resize", {
        params: { path: { sandboxId: this.id } },
        body: restart === true ? { ...allocation, restart: true } : allocation,
        signal: requestSignal(options),
      }),
    );

    this.update(data.sandbox);
    return {
      applied: data.applied,
      liveResizeError: data.liveResizeError,
      pendingAllocation: data.pendingAllocation,
      sandbox: this,
    };
  }

  /** Refresh this resource in place from the API. */
  async refresh(options: RequestOptions = {}): Promise<this> {
    const data = await unwrap(
      this.api.GET("/sandboxes/{sandboxId}", {
        params: { path: { sandboxId: this.id } },
        signal: requestSignal(options),
      }),
    );
    return this.update(data.sandbox);
  }

  /**
   * Poll until the sandbox can accept commands, or throw on failure or timeout.
   *
   * "running" is the control plane's view; the agent inside the guest can take
   * a few more seconds to answer. Readiness is therefore confirmed with a
   * directory listing through the agent, so the first command after this
   * resolves does not fail with a 502.
   */
  async waitUntilReady(options: WaitForSandboxOptions = {}): Promise<this> {
    const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    const startedAt = Date.now();

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("timeoutMs must be a positive number.");
    }
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new TypeError("pollIntervalMs must be a positive number.");
    }

    while (true) {
      if (this.status === "ready" || this.status === "running") {
        const remainingMs = timeoutMs - (Date.now() - startedAt);
        if (await this.agentAnswers({ signal: options.signal, timeoutMs: remainingMs })) {
          return this;
        }
      } else if (
        this.status === "error" ||
        this.status === "deleted" ||
        this.status === "stopping" ||
        this.status === "stopped"
      ) {
        // A sandbox that is asleep, or on its way to sleep, will not become
        // ready on its own; waiting would only run out the clock. Wake it first.
        throw new RemoteHostError(
          `Sandbox ${this.id} entered status "${this.status}" while waiting for readiness.`,
        );
      }

      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        throw new RemoteHostTimeoutError(`Sandbox ${this.id} was not ready within ${timeoutMs}ms.`);
      }

      await abortableDelay(Math.min(pollIntervalMs, remainingMs), options.signal);
      await this.refresh({ signal: options.signal, timeoutMs: remainingMs });
    }
  }

  toJSON(): SandboxData {
    return { ...this.#data };
  }

  /**
   * True once the agent inside the sandbox answers a directory listing. A
   * 400, 500, or 502 means the guest is still coming up, or has just been
   * paused, and is worth another poll; any other failure is real.
   */
  private async agentAnswers(options: RequestOptions): Promise<boolean> {
    if (options.timeoutMs !== undefined && options.timeoutMs <= 0) {
      return false;
    }

    try {
      await this.files.list("/code", options);
      return true;
    } catch (error) {
      if (
        error instanceof RemoteHostAPIError &&
        (error.status === 400 || error.status === 500 || error.status === 502)
      ) {
        return false;
      }
      throw error;
    }
  }

  private update(data: SandboxData): this {
    this.#data = data;
    return this;
  }
}
