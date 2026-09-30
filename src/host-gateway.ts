import { RemoteHostAPIError, RemoteHostConnectionError, RemoteHostTimeoutError } from "./errors.js";
import type { APIClient } from "./internal.js";

// Commands, files (REM-690) and live metrics (REM-715) through the
// sandbox's own host. On by default under Node since REM-690, and off by
// default where there is no Node `process` (browsers, Workers, Deno without
// Node compatibility), since the gateway answers no CORS preflight.
// `hostGateway` sets it either way, anywhere; REMOTEHOST_HOST_GATEWAY set to
// 0, false, no or off turns the default off (hostGatewayFromEnv).
//
// For each call the SDK asks the API for a single-use ticket for exactly the
// permission the call needs, then sends the same request to the host
// gateway, which answers in the API's own shape. The API authorizes; the
// command's output and the file's bytes go client -> Cloudflare -> the
// sandbox's host, never through the API. The API key goes only to the API,
// and the gateway sees only the ticket.
//
// Where the gateway path is not available the call goes to the API as
// before. An API that issues no tickets on a route (tickets off, or a
// release without the route) is remembered for every sandbox for
// ROUTE_OFF_MS; a sandbox whose host has no gateway yet, for that sandbox.
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
// its host has no gateway (host_gateway_unavailable), or the gateway URL is
// not https.
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

const ON_VALUES = new Set(["1", "true", "yes", "on"]);
const OFF_VALUES = new Set(["0", "false", "no", "off"]);
let warnedUnrecognized = false;

// Whether the gateway path is on, given REMOTEHOST_HOST_GATEWAY and the
// runtime's default (on under Node): unset or empty is the default; 1, true,
// yes or on is on; 0, false, no or off is off. Any other value (a typo,
// "disabled") is the default too, with one console.warn per process saying
// so, rather than a guess either way.
export function hostGatewayFromEnv(value: string | undefined, runtimeDefault: boolean): boolean {
  const setting = (value ?? "").trim().toLowerCase();
  if (setting === "") return runtimeDefault;
  if (ON_VALUES.has(setting)) return true;
  if (OFF_VALUES.has(setting)) return false;
  if (!warnedUnrecognized) {
    warnedUnrecognized = true;
    console.warn(
      `@remotehost/sdk: ${HOST_GATEWAY_ENV}=${JSON.stringify(value)} is not one of 1, true, yes, on, 0, false, no or off; ` +
        `using the default (${runtimeDefault ? "on" : "off"}).`,
    );
  }
  return runtimeDefault;
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

// How long a ticket route found not issuing tickets is taken as off, for
// every sandbox: an API without the route (a release before it, which
// answers an API key a code-less 403 and a user a plain-text 404), the
// API's switch for the route off (`not_found`, `host_gateway_streams_off`),
// or a 2xx that carries no ticket. The switch is API-wide, so this costs one
// ticket request per route per ROUTE_OFF_MS in all, however many sandboxes,
// and a long-lived client still picks up a flip within minutes.
export const ROUTE_OFF_MS = 5 * 60_000;

const GENERIC_TICKET_ROUTE = "gateway-ticket";

// The API's own refusals of one ticket that are about that sandbox or that
// permission, never the route, and that its own route gives too: the
// sandbox's 404 (the API documents that a client must not remember it for
// every sandbox), and authorize()'s 403, "Permission <p> is required." or
// one with a code (a workspace only its owner reaches). A read-only key
// refused a command's ticket still reads files through the gateway.
const SANDBOX_NOT_FOUND_MESSAGE = "Sandbox not found.";
const PERMISSION_REQUIRED = /^Permission \S+ is required\.$/;

function refusedForThisCall(status: number, body: unknown): boolean {
  const code = errorCode(body);
  const message = apiErrorMessage(body);
  if (status === 404) return !code && message === SANDBOX_NOT_FOUND_MESSAGE;
  if (status === 403) return code !== null || PERMISSION_REQUIRED.test(message ?? "");
  return false;
}

export class HostGateway {
  // Sandboxes whose gateway path failed in this client, with why.
  private readonly fellBack = new Map<string, string>();
  // Ticket routes found not issuing tickets, until when (ROUTE_OFF_MS), and
  // why: one entry per route, for every sandbox.
  private readonly routesOff = new Map<string, { until: number; reason: string }>();

  constructor(private readonly config: HostGatewayConfig) {}

  /** Why a sandbox's calls went to the API instead, if they did. */
  fallbackReason(sandboxId: string): string | undefined {
    return this.fellBack.get(sandboxId);
  }

  /** Why a ticket route is taken as off for every sandbox, while it is. */
  routeOffReason(route: string = GENERIC_TICKET_ROUTE): string | undefined {
    const off = this.routesOff.get(route);
    return off && Date.now() < off.until ? off.reason : undefined;
  }

  async call<T>(sandboxId: string, call: GatewayCall): Promise<T | typeof USE_API> {
    if (this.fellBack.has(sandboxId)) {
      return USE_API;
    }

    // A ticket route that issued no tickets a moment ago: no ticket request.
    const route = call.ticketRoute ?? GENERIC_TICKET_ROUTE;
    const off = this.routesOff.get(route);
    if (off !== undefined) {
      if (Date.now() < off.until) return USE_API;
      this.routesOff.delete(route);
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
    const route = call.ticketRoute ?? GENERIC_TICKET_ROUTE;

    if (!response.ok) {
      const code = errorCode(body);
      // This sandbox's host has no gateway yet: the API's route, for this
      // sandbox from now on.
      if (code === "host_gateway_unavailable") {
        this.fellBack.set(sandboxId, `ticket refused: ${response.status} ${code}`);
        return USE_API;
      }
      // Any other 4xx, but a conflict (a sleeping sandbox, a fenced
      // workspace), a rate limit or a refusal about this sandbox or
      // permission (refusedForThisCall), says this API issues no tickets on
      // this route: no such route (a release before it, which answers an
      // API key a code-less 403 and a user a plain-text 404; a proxy), its
      // switch off, or none for this credential. The API's route is the
      // path from before the gateway, so taking it for every sandbox for a
      // while is always safe.
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 409 &&
        response.status !== 429 &&
        !refusedForThisCall(response.status, body)
      ) {
        this.routeOff(route, `ticket refused: ${response.status}${code ? ` ${code}` : ""}`);
      }
      // The API's own route answers the rest too, in its own words: this
      // call goes there.
      return USE_API;
    }

    const answer = body as Partial<TicketAnswer> | null;
    // A 2xx without a ticket (an API, or a proxy in front of it, answering a
    // route it doesn't have) says this API issues none on this route, not
    // that this sandbox's gateway is broken. Nothing has run, so the call
    // goes to the API, as does every call on this route for a while.
    if (
      !answer ||
      typeof answer !== "object" ||
      typeof answer.ticket !== "string" ||
      typeof answer.gatewayUrl !== "string"
    ) {
      this.routeOff(route, `ticket answer without a ticket: ${response.status}`);
      return USE_API;
    }

    if (!isSafeGatewayUrl(answer.gatewayUrl)) {
      this.fellBack.set(sandboxId, "gateway URL is not https");
      return USE_API;
    }

    return answer as TicketAnswer;
  }

  private routeOff(route: string, reason: string) {
    this.routesOff.set(route, { until: Date.now() + ROUTE_OFF_MS, reason });
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
