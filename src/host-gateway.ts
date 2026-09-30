import { RemoteHostAPIError, RemoteHostConnectionError, RemoteHostTimeoutError } from "./errors.js";
import type { APIClient } from "./internal.js";

// Commands, files (REM-690) and live metrics (REM-715) through the
// sandbox's own host. Off unless
// the client is created with `hostGateway: true`, or REMOTEHOST_HOST_GATEWAY
// is 1, true, yes or on, while the gateways are proven on staging.
//
// For each call the SDK asks the API for a single-use ticket for exactly the
// permission the call needs, then sends the same request to the host
// gateway, which answers in the API's own shape. The API authorizes; the
// command's output and the file's bytes go client -> Cloudflare -> the
// sandbox's host, never through the API. The API key goes only to the API,
// and the gateway sees only the ticket.
//
// Where the gateway path is not available (the API issues no tickets, the
// sandbox's host has no gateway yet) the call goes to the API as before, and
// so does every later call for that sandbox.
//
// When the gateway fails a call, whether it goes to the API depends on the
// call (REM-906):
// - Any call, when the gateway refused it before touching the sandbox
//   (REFUSED_BEFORE_RUNNING, a 429, or a route it does not serve): nothing
//   ran.
// - A read (`idempotent`), also on any other failure of the gateway or the
//   path to it: a 5xx, an answer not in the API's shape (Cloudflare's own
//   error pages), a 2xx cut off, a lost connection or a timeout. Reading
//   twice is harmless.
// - Never an answer in the API's own words that the API would give too: a
//   file not in the workspace, a body it refuses, a revoked access.
// - A command or a write never after it may have run: a 5xx, `policy_lost`,
//   a 2xx cut off, a timeout or a connection lost mid-command is an error,
//   never a second run.
//
// Each fallback is for that one call. A sandbox's later calls go straight to
// the API for the life of the client only when its gateway path cannot work:
// the gateway would not take the API's ticket (GATEWAY_BROKEN_FOR_SANDBOX),
// the API issues it no tickets (a 404 from gateway-ticket, or
// host_gateway_unavailable), or the gateway URL is not https.
//
// A gateway built before `policy_lost` answers a policy lost mid-command
// with `policy_unavailable`, which reads as "nothing ran": until the
// gateways run a build with it, a command can still be sent twice then.

export const HOST_GATEWAY_ENV = "REMOTEHOST_HOST_GATEWAY";

export type GatewayPermission = "sandbox.terminal.connect" | "sandbox.files.read" | "sandbox.files.write";

// The answer that means "use the API's route instead".
export const USE_API: unique symbol = Symbol("use the API");

// The gateway's refusals before it touches a sandbox (internal/gateway
// api.go and streams.go): a ticket it would not take, a revocation policy it
// cannot vouch for, no envd credential from the API, a group of routes that
// is off, or a stream cap. Nothing ran, so the API's route is safe to use
// instead. Not `policy_lost`: the policy went stale while the call ran.
const REFUSED_BEFORE_RUNNING = new Set([
  "missing_ticket",
  "invalid_ticket",
  "policy_unavailable",
  "credential_unavailable",
  "no_credential",
  "not_found",
  "too_many_streams",
]);

// Of those, the ones that say the gateway path does not work for this
// sandbox, so its later calls go straight to the API: the gateway would not
// take the API's own ticket. The rest pass: a policy catching up, the
// gateway briefly unable to get a credential from the API (its route's
// 429, 401 or 503), a sandbox moving or waking, a cap, a route off.
export const GATEWAY_BROKEN_FOR_SANDBOX = new Set(["missing_ticket", "invalid_ticket"]);

// The code-less 404 gateways sent for `no_credential` before it had a code.
const NO_CREDENTIAL_MESSAGE = "No envd credential for this sandbox.";

export function hostGatewayEnabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

type TicketAnswer = {
  ticket: string;
  gatewayUrl: string;
  expiresAt: string;
  sandboxId: string;
};

export type GatewayCall = {
  permission: GatewayPermission;
  method: "GET" | "POST" | "PUT";
  path: "/v1/exec" | "/v1/files" | "/v1/file" | "/v1/metrics";
  // The API route that issues this call's ticket, under the sandbox, when it
  // is not the generic gateway-ticket: live metrics have their own
  // (metrics/gateway-ticket), on only while the gateway's streams are.
  ticketRoute?: "metrics/gateway-ticket";
  query?: Record<string, string | undefined>;
  body?: unknown;
  // A read is sent to the API after a failure of the gateway or the path to
  // it, but not after an answer in the API's own words; a command or a
  // write only when the gateway refused it before touching the sandbox.
  idempotent: boolean;
  signal?: AbortSignal;
};

export type HostGatewayConfig = {
  baseUrl: string;
  headers: Headers;
  // The client's own fetch, without the SDK's retries: a ticket is spent by
  // its first use.
  fetch: (request: Request) => Promise<Response>;
  // The API's fetch, with the SDK's retries, for the ticket itself.
  apiFetch: (request: Request) => Promise<Response>;
  timeoutMs: number;
};

// How long a ticket route of its own that answered 404 (its group off on the
// API, e.g. the live streams while they are dark) is taken as off, for every
// sandbox: the API's switch is API-wide. Short enough that a flip is picked
// up within minutes by a long-lived client.
export const ROUTE_OFF_MS = 5 * 60_000;

// The 404s that mean the route itself is off: the API's switch
// (`host_gateway_streams_off`), or an API without the route at all
// (`not_found`, its unmatched-route answer).
const ROUTE_OFF_CODES = new Set(["host_gateway_streams_off", "not_found"]);

export class HostGateway {
  // Sandboxes whose gateway path failed in this client, with why.
  private readonly fellBack = new Map<string, string>();
  // Ticket routes of their own found off, until when (ROUTE_OFF_MS).
  private readonly routesOff = new Map<string, number>();

  constructor(private readonly config: HostGatewayConfig) {}

  /** Why a sandbox's calls went to the API instead, if they did. */
  fallbackReason(sandboxId: string): string | undefined {
    return this.fellBack.get(sandboxId);
  }

  async call<T>(sandboxId: string, call: GatewayCall): Promise<T | typeof USE_API> {
    if (this.fellBack.has(sandboxId)) {
      return USE_API;
    }

    // A route of its own that was off a moment ago: no ticket request.
    const offUntil = call.ticketRoute ? this.routesOff.get(call.ticketRoute) : undefined;
    if (offUntil !== undefined) {
      if (Date.now() < offUntil) return USE_API;
      this.routesOff.delete(call.ticketRoute!);
    }

    const issued = await this.ticket(sandboxId, call);
    if (issued === USE_API) {
      return USE_API;
    }

    const url = new URL(`${issued.gatewayUrl.replace(/\/+$/, "")}${call.path}`);
    for (const [name, value] of Object.entries(call.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, value);
    }

    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await this.config.fetch(
        new Request(url, {
          method: call.method,
          // The ticket, and nothing of the API key.
          headers: {
            authorization: `Bearer ${issued.ticket}`,
            ...(call.body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: call.body === undefined ? undefined : JSON.stringify(call.body),
          signal,
        }),
      );
    } catch (error) {
      if (call.signal?.aborted) throw error;
      // A read goes to the API, a timeout included, for this call only: a
      // connection lost once says nothing about the next one (REM-906).
      if (call.idempotent) return USE_API;
      if (timeout.aborted) {
        throw new RemoteHostTimeoutError("The sandbox's host gateway timed out.", { cause: error });
      }
      throw new RemoteHostConnectionError("Lost the connection to the sandbox's host gateway.", {
        cause: error,
      });
    }

    const body = await readJson(response);

    // A 2xx cut off, or not the JSON object every gateway route answers: a
    // read goes to the API; a command or a write may have run, so it is an
    // error, never a second run.
    if (response.ok && !(body && typeof body === "object")) {
      if (call.idempotent) return USE_API;
      // An answer cut off by the caller's abort or the SDK's timeout says
      // so, as a request cut off before its answer does.
      if (call.signal?.aborted) throw call.signal.reason;
      if (timeout.aborted) throw new RemoteHostTimeoutError("The sandbox's host gateway timed out.");
      throw new RemoteHostConnectionError("The sandbox's host gateway sent an incomplete answer.");
    }

    if (!response.ok) {
      if (fallsBack(call, response.status, body)) {
        const code = errorCode(body);
        if (code && GATEWAY_BROKEN_FOR_SANDBOX.has(code)) {
          this.fellBack.set(sandboxId, `gateway refused: ${response.status} ${code}`);
        }
        return USE_API;
      }
      throw new RemoteHostAPIError(response, body);
    }

    return body as T;
  }

  private async ticket(sandboxId: string, call: GatewayCall): Promise<TicketAnswer | typeof USE_API> {
    const headers = new Headers(this.config.headers);
    if (!call.ticketRoute) headers.set("content-type", "application/json");

    let response: Response;
    try {
      response = await this.config.apiFetch(
        new Request(
          `${this.config.baseUrl}/sandboxes/${encodeURIComponent(sandboxId)}/${call.ticketRoute ?? "gateway-ticket"}`,
          {
            method: "POST",
            headers,
            // A route of its own takes no body: the route names the permission.
            body: call.ticketRoute ? undefined : JSON.stringify({ permission: call.permission }),
            signal: call.signal,
          },
        ),
      );
    } catch (error) {
      if (call.signal?.aborted) throw error;
      throw new RemoteHostConnectionError("Could not connect to the RemoteHost API.", { cause: error });
    }

    const body = await readJson(response);

    if (!response.ok) {
      // Tickets are off, or this sandbox's host has no gateway yet: the
      // API's route, for this sandbox from now on.
      // A route of its own that is off says nothing about the others; it is
      // off for every sandbox for a while. Only the API's switch says so
      // (ROUTE_OFF_CODES): a sandbox's own 404 ("Sandbox not found.") must
      // not send every other sandbox's calls to the API.
      if (response.status === 404 && call.ticketRoute && ROUTE_OFF_CODES.has(errorCode(body) ?? "")) {
        this.routesOff.set(call.ticketRoute, Date.now() + ROUTE_OFF_MS);
      }
      if ((response.status === 404 && !call.ticketRoute) || errorCode(body) === "host_gateway_unavailable") {
        this.fellBack.set(sandboxId, `ticket refused: ${response.status}${errorCode(body) ? ` ${errorCode(body)}` : ""}`);
      }
      // Anything else (no permission, a sleeping sandbox) the API's own
      // route answers too, in its own words: this call goes there.
      return USE_API;
    }

    const answer = body as Partial<TicketAnswer> | null;
    if (!answer || typeof answer.ticket !== "string" || typeof answer.gatewayUrl !== "string") {
      throw new RemoteHostConnectionError("The API answered a gateway ticket request without a ticket.");
    }

    if (!isSafeGatewayUrl(answer.gatewayUrl)) {
      this.fellBack.set(sandboxId, "gateway URL is not https");
      return USE_API;
    }

    return answer as TicketAnswer;
  }
}

// Only a TLS gateway, or one on this machine for development: the ticket
// must not cross a network in the clear.
export function isSafeGatewayUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  return (
    (url.protocol === "https:" || (url.protocol === "http:" && local)) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}

// Whether a gateway's failed answer sends this call to the API: the policy
// at the top of this file.
export function fallsBack(call: Pick<GatewayCall, "idempotent">, status: number, body: unknown): boolean {
  const code = errorCode(body);
  const apiShaped = apiErrorMessage(body) !== null;

  // Refused before the sandbox: a code that says so; the code-less
  // no-credential 404 of gateways before `no_credential`; a route the
  // gateway does not have (a plain-text 404); a rate limit, the gateway's
  // or Cloudflare's, which is answered before anything runs.
  if (code && REFUSED_BEFORE_RUNNING.has(code)) return true;
  if (status === 404 && !code && (apiErrorMessage(body) === NO_CREDENTIAL_MESSAGE || !apiShaped)) return true;
  if (status === 429) return true;

  // A read, after any other failure of the gateway or the path to it.
  // An answer in the API's own words below 500 is the API's answer too.
  if (call.idempotent) return status >= 500 || !apiShaped;

  return false;
}

function apiErrorMessage(body: unknown): string | null {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error: unknown }).error;
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
      return error.message;
    }
  }
  return null;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorCode(body: unknown): string | null {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error: unknown }).error;
    if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
      return error.code;
    }
  }
  return null;
}

// Which gateway, if any, each API client uses. Internal: the resources find
// it from the client they were given.
const gateways = new WeakMap<APIClient, HostGateway>();

export function useHostGateway(api: APIClient, gateway: HostGateway) {
  gateways.set(api, gateway);
}

export function hostGatewayFor(api: APIClient): HostGateway | undefined {
  return gateways.get(api);
}
