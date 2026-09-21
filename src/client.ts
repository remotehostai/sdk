import createClient from "openapi-fetch";

import { RemoteHostConfigurationError } from "./errors.js";
import type { paths } from "./generated/schema.js";
import type { APIClient } from "./internal.js";
import { Sandboxes } from "./sandboxes.js";
import { VERSION } from "./version.js";

const DEFAULT_BASE_URL = "https://api.remotehost.ai/v1";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_RETRIES = 2;

export type RemoteHostOptions = {
  /** Secret API key. Defaults to REMOTEHOST_API_KEY outside browsers. */
  apiKey?: string;
  /** API root, including `/v1`. */
  baseURL?: string;
  /** Default organization for organization-scoped operations. */
  orgId?: string;
  /** Custom Fetch implementation, useful for tests and non-Node runtimes. */
  fetch?: (request: Request) => Promise<Response>;
  /** Headers included with every request. Authorization and SDK version are managed by the SDK. */
  headers?: HeadersInit;
  /** Maximum automatic retries for safe GET and HEAD requests. Defaults to 2. */
  maxRetries?: number;
  /** Default deadline for one HTTP request. Defaults to 10 minutes. */
  timeoutMs?: number;
  /** Allow secret-key use in a browser. This can expose the key to users. */
  dangerouslyAllowBrowser?: boolean;
};

/** Server-side client for the RemoteHost API. */
export class RemoteHost {
  /** Fully typed access to every operation in the generated OpenAPI contract. */
  readonly raw: APIClient;
  /** Create, list, and retrieve sandboxes. */
  readonly sandboxes: Sandboxes;

  constructor(options: RemoteHostOptions = {}) {
    if (isBrowser() && !options.dangerouslyAllowBrowser) {
      throw new RemoteHostConfigurationError(
        "RemoteHost API keys must not be exposed in browser code. Use a server environment, or explicitly set dangerouslyAllowBrowser if you understand the risk.",
      );
    }

    const apiKey = options.apiKey ?? readEnvironmentVariable("REMOTEHOST_API_KEY");
    if (!apiKey) {
      throw new RemoteHostConfigurationError(
        "Missing API key. Pass apiKey or set REMOTEHOST_API_KEY.",
      );
    }

    const headers = new Headers(options.headers);
    headers.set("authorization", `Bearer ${apiKey}`);
    headers.set("x-remotehost-sdk-version", VERSION);

    const fetcher = options.fetch ?? globalThis.fetch;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new RemoteHostConfigurationError("maxRetries must be a non-negative integer.");
    }

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RemoteHostConfigurationError("timeoutMs must be a positive number.");
    }

    const api = createClient<paths>({
      baseUrl: trimTrailingSlash(options.baseURL ?? DEFAULT_BASE_URL),
      fetch: createReliableFetch(fetcher, { maxRetries, timeoutMs }),
      headers,
    });

    this.raw = api;
    this.sandboxes = new Sandboxes(api, options.orgId);
  }
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.document !== "undefined";
}

function readEnvironmentVariable(name: string): string | undefined {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return runtime.process?.env?.[name];
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function createReliableFetch(
  fetcher: (request: Request) => Promise<Response>,
  options: { maxRetries: number; timeoutMs: number },
): (request: Request) => Promise<Response> {
  return async (request) => {
    const retryable = request.method === "GET" || request.method === "HEAD";
    let attempt = 0;

    while (true) {
      const timeout = AbortSignal.timeout(options.timeoutMs);
      const signal = AbortSignal.any([request.signal, timeout]);

      try {
        const response = await fetcher(new Request(request, { signal }));

        if (!retryable || attempt >= options.maxRetries || !isRetryableStatus(response.status)) {
          return response;
        }

        await response.body?.cancel().catch(() => undefined);
        await delay(retryDelayMs(response, attempt), request.signal);
      } catch (error) {
        if (request.signal.aborted || errorName(error) === "TimeoutError") {
          throw error;
        }
        if (!retryable || attempt >= options.maxRetries) {
          throw error;
        }
        await delay(backoffMs(attempt), request.signal);
      }

      attempt += 1;
    }
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 60_000);
    }

    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return Math.min(Math.max(date - Date.now(), 0), 60_000);
    }
  }
  return backoffMs(attempt);
}

function backoffMs(attempt: number): number {
  const exponential = Math.min(500 * 2 ** attempt, 8_000);
  return Math.round(exponential * (0.75 + Math.random() * 0.5));
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function errorName(error: unknown): string | null {
  return error instanceof Error ? error.name : null;
}
