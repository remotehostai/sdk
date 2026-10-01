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
// - A command or a write too when the connection to the gateway was never
//   ready for it (refused, a name that does not resolve, no route, a TLS
//   handshake that failed, the connect timing out after
//   GATEWAY_CONNECT_TIMEOUT_MS), and only on the SDK's own transport, which
//   saw that no byte of the request left: nothing was sent (REM-967).
//   Through a fetch the caller passed, or a dispatcher the SDK did not make,
//   an earlier attempt may have sent it before a retry was refused, so that
//   is an error.
// - A command or a write never after it may have run: a 5xx, `policy_lost`,
//   a 2xx cut off, a timeout or a connection lost mid-command is an error,
//   never a second run.
//
// Each fallback is for that one call. A sandbox's later calls go straight to
// the API for the life of the client only when its gateway path cannot work:
// the gateway would not take the API's ticket (GATEWAY_BROKEN_FOR_SANDBOX),
// its host has no gateway (host_gateway_unavailable), or the gateway URL is
// not https. A gateway that keeps failing a sandbox's calls
// (FAILING_PIN_AFTER in a row) sends them to the API for FAILING_PIN_MS
// without asking for tickets. Once that runs out one read at a time tries
// the gateway again, and commands and writes stay on the API until a read
// has succeeded there (REM-967).
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

// Connection failures before a byte of the request was sent, by the code
// Node or undici puts on the error or its cause: nothing reached the
// gateway, so even a command may go to the API (REM-967). Not a reset or a
// socket closed after connecting (ECONNRESET, UND_ERR_SOCKET), nor ETIMEDOUT,
// which a read can give too.
const NEVER_CONNECTED = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

// A gateway that fails this many of a sandbox's calls in a row (a 5xx, an
// answer not in the API's shape, a refusal before running such as
// `credential_unavailable`, a lost or never-opened connection, a timeout)
// sends that sandbox's calls to the API for FAILING_PIN_MS, give or take
// FAILING_PIN_JITTER, with no ticket requests: each failure costs a ticket, a
// gateway round trip and, for `credential_unavailable`, a request to the
// API's credential route (REM-967). A success clears the count; a 429 leaves
// it as it was.
//
// Once the pin runs out, one read at a time probes the gateway while every
// other call keeps to the API. A probe that fails pins the sandbox again; one
// that succeeds lifts the pin. Commands and writes never probe: they stay on
// the API until a read has succeeded, and one of them past the pin with no
// probe out sets off the SDK's own (a list of /code). An answer to a call sent before the
// pin was set says nothing about the gateway since, so it neither lifts the
// pin nor counts.
export const FAILING_PIN_AFTER = 3;
export const FAILING_PIN_MS = 60_000;
export const FAILING_PIN_JITTER = 0.1;
// Sandboxes whose failures are remembered at once, at most: past this the
// oldest is forgotten, which only sends its calls to the gateway sooner.
export const FAILING_MAX_SANDBOXES = 1_000;

type Failing = {
  count: number;
  // When the pin was last set, and until when it holds (performance.now());
  // `until` 0 while not pinned. A pin that has run out stays set until a
  // read probe succeeds.
  pinnedAt: number;
  until: number;
  // A read probing the gateway past the pin.
  probing: boolean;
};

// A call let through to the gateway: when, and whether it is the probe.
type Admitted = { sentAt: number; probe: boolean };

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
  // The gateway's transport, without the SDK's retries: a ticket is spent
  // by its first use. The caller's own fetch when it passed one; otherwise
  // the SDK's (sdkGatewayFetch), the only one whose connection failures let
  // a command or a write go to the API.
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
  // Each sandbox's gateway failures in a row, and its pin (FAILING_PIN_AFTER,
  // FAILING_PIN_MS).
  private readonly failing = new Map<string, Failing>();

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

  /**
   * Until when (performance.now()) a sandbox's calls skip a gateway that
   * keeps failing, if they do.
   */
  failingUntil(sandboxId: string): number | undefined {
    const until = this.failing.get(sandboxId)?.until;
    return until && performance.now() < until ? until : undefined;
  }

  async call<T>(sandboxId: string, call: GatewayCall): Promise<T | typeof USE_API> {
    if (this.fellBack.has(sandboxId)) return USE_API;

    // A ticket route that issued no tickets a moment ago: no ticket request.
    const route = call.ticketRoute ?? GENERIC_TICKET_ROUTE;
    const off = this.routesOff.get(route);
    if (off !== undefined) {
      if (Date.now() < off.until) return USE_API;
      this.routesOff.delete(route);
    }

    const admitted = this.admit(sandboxId, call);
    if (admitted === USE_API) return USE_API;
    try {
      return await this.viaGateway<T>(sandboxId, call, admitted);
    } finally {
      if (admitted.probe) {
        const failing = this.failing.get(sandboxId);
        if (failing) failing.probing = false;
      }
    }
  }

  // Whether a call may go to the gateway, given the sandbox's pin: not while
  // it holds; past it, one read at a time, and never a command or a write
  // until a read has succeeded. A command or a write past the pin sets off
  // the SDK's own read instead, so a client that only runs commands comes
  // back to the gateway too.
  private admit(sandboxId: string, call: GatewayCall): Admitted | typeof USE_API {
    const sentAt = performance.now();
    const failing = this.failing.get(sandboxId);
    if (!failing || failing.until === 0) return { sentAt, probe: false };
    if (sentAt < failing.until || failing.probing) return USE_API;
    if (!call.idempotent) {
      this.probe(sandboxId);
      return USE_API;
    }
    failing.probing = true;
    return { sentAt, probe: true };
  }

  // The SDK's own probe past a pin: a list of /code. Its answer is dropped
  // and only moves the pin. One that gets no usable answer (a refused
  // ticket, as for a key that runs commands but can't read files; a 401 or
  // 403; a 429; a timeout; an error) pins the sandbox again, so a client
  // makes at most one probe per pin, never a ticket request per command.
  private probe(sandboxId: string) {
    void this.call(sandboxId, {
      permission: "sandbox.files.read",
      method: "GET",
      path: "/v1/files",
      query: { path: "/code" },
      idempotent: true,
    }).then(
      (answer) => {
        if (answer === USE_API) this.pinAgain(sandboxId);
      },
      () => this.pinAgain(sandboxId),
    );
  }

  // Pins a sandbox again whose pin a probe did not lift.
  private pinAgain(sandboxId: string) {
    const failing = this.failing.get(sandboxId);
    if (failing && failing.until !== 0) this.pin(failing);
  }

  // For FAILING_PIN_MS give or take FAILING_PIN_JITTER, so sandboxes pinned
  // together don't all probe together.
  private pin(failing: Failing) {
    const now = performance.now();
    failing.pinnedAt = now;
    failing.until = now + FAILING_PIN_MS * (1 - FAILING_PIN_JITTER + 2 * FAILING_PIN_JITTER * Math.random());
  }

  private async viaGateway<T>(sandboxId: string, call: GatewayCall, admitted: Admitted): Promise<T | typeof USE_API> {
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
      this.gatewayFailed(sandboxId, admitted);
      // A read goes to the API, a timeout included, for this call only: a
      // connection lost once says nothing about the next one (REM-906).
      if (call.idempotent) return USE_API;
      if (timeout.aborted) {
        throw new RemoteHostTimeoutError("The sandbox's host gateway timed out.", { cause: error });
      }
      // A connection never ready for the request carried nothing: a command
      // or a write too, but only when the SDK's own transport saw that
      // (REM-967).
      if (sentNothing(error)) return USE_API;
      if (neverConnected(error)) {
        throw new RemoteHostConnectionError(
          "Could not connect to the sandbox's host gateway. The call was not sent to the API instead: through a " +
            "custom fetch or dispatcher the SDK cannot tell whether an earlier attempt, before a retry, reached the gateway.",
          { cause: error },
        );
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
      // An answer cut off by the caller's abort or the SDK's timeout says
      // so, as a request cut off before its answer does.
      if (call.signal?.aborted) throw call.signal.reason;
      this.gatewayFailed(sandboxId, admitted);
      if (call.idempotent) return USE_API;
      if (timeout.aborted) throw new RemoteHostTimeoutError("The sandbox's host gateway timed out.");
      throw new RemoteHostConnectionError("The sandbox's host gateway sent an incomplete answer.");
    }

    if (!response.ok) {
      // The gateway, or the path to it, failing: a 5xx, an answer not in the
      // API's shape, a refusal before running. An answer in the API's own
      // words is the gateway working. A cap (429) is neither: it leaves the
      // count and the pin as they were.
      if (response.status === 429) {
        // Neither.
      } else if (
        response.status >= 500 ||
        apiErrorMessage(body) === null ||
        REFUSED_BEFORE_RUNNING.has(errorCode(body) ?? "")
      ) {
        this.gatewayFailed(sandboxId, admitted);
      } else {
        this.gatewayWorked(sandboxId, admitted);
      }
      if (fallsBack(call, response.status, body)) {
        const code = errorCode(body);
        if (code && GATEWAY_BROKEN_FOR_SANDBOX.has(code)) {
          this.fellBack.set(sandboxId, `gateway refused: ${response.status} ${code}`);
        }
        return USE_API;
      }
      throw new RemoteHostAPIError(response, body);
    }

    this.gatewayWorked(sandboxId, admitted);
    return body as T;
  }

  // An answer to a call sent before the sandbox's pin was last set: from the
  // gateway as it was then, so it neither counts nor lifts the pin.
  private stale(failing: Failing | undefined, admitted: Admitted): boolean {
    return failing !== undefined && failing.pinnedAt !== 0 && admitted.sentAt <= failing.pinnedAt;
  }

  private gatewayWorked(sandboxId: string, admitted: Admitted) {
    if (!this.stale(this.failing.get(sandboxId), admitted)) this.failing.delete(sandboxId);
  }

  private gatewayFailed(sandboxId: string, admitted: Admitted) {
    let failing = this.failing.get(sandboxId);
    if (this.stale(failing, admitted)) return;
    if (!failing) {
      if (this.failing.size >= FAILING_MAX_SANDBOXES) {
        const oldest = this.failing.keys().next();
        if (!oldest.done) this.failing.delete(oldest.value);
      }
      failing = { count: 0, pinnedAt: 0, until: 0, probing: false };
      this.failing.set(sandboxId, failing);
    }
    failing.count += 1;
    // FAILING_PIN_AFTER in a row, or a probe past the pin failing: pinned
    // (again), for FAILING_PIN_MS give or take FAILING_PIN_JITTER, so
    // sandboxes pinned together don't all probe together.
    if (failing.count >= FAILING_PIN_AFTER || failing.until !== 0) this.pin(failing);
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

// Whether a failed fetch never opened its connection (NEVER_CONNECTED): the
// code on the error or the first cause that has one. For an AggregateError
// (Node trying each address in turn), every attempt's, whatever its own
// code says: Node sets that to the first attempt's.
export function neverConnected(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 8; depth += 1) {
    const attempts = (current as { errors?: unknown }).errors;
    if (current instanceof AggregateError || Array.isArray(attempts)) {
      return Array.isArray(attempts) && attempts.length > 0 && attempts.every((attempt) => neverConnected(attempt));
    }
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return NEVER_CONNECTED.has(code);
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// Errors from the SDK's own transport (sdkGatewayFetch) raised before its
// connection could carry a byte of the request: before the TCP connect, and
// for https before `secureConnect` (a refusal, a name that does not resolve,
// a TLS handshake that failed, the connect timing out). Only that transport
// adds to it, so an error from a fetch the caller passed is never in it.
const unsent = new WeakSet<object>();

// Whether a failed gateway fetch certainly sent nothing: the SDK's own
// transport failed before its connection was ready for the request.
export function sentNothing(error: unknown): boolean {
  return typeof error === "object" && error !== null && unsent.has(error);
}

// How long the SDK's transport waits for a gateway connection to be ready
// (TCP, and TLS for https) before giving up on it, as the CLI does: above
// the gateway's own 5 s wait for a fresh connection. Past it nothing was
// sent, so the call goes to the API. It never cuts a request once sent.
export const GATEWAY_CONNECT_TIMEOUT_MS = 10_000;

// The little of node:http and node:https the SDK's transport uses.
type NodeSocket = {
  once(event: "connect" | "secureConnect", listener: () => void): unknown;
};
type NodeResponse = {
  statusCode?: number;
  statusMessage?: string;
  rawHeaders: string[];
  complete: boolean;
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  destroy(): void;
};
type NodeRequest = {
  reusedSocket: boolean;
  destroy(error: Error): void;
  on(event: "socket", listener: (socket: NodeSocket) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "response", listener: (response: NodeResponse) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  end(body?: Uint8Array): void;
};
type NodeHttp = {
  Agent: new (options: { keepAlive: boolean; timeout: number }) => unknown;
  request(
    url: URL,
    options: { method: string; headers: Record<string, string>; agent: unknown; signal: AbortSignal },
  ): NodeRequest;
};

// The SDK's own transport to host gateways under Node: node:http(s) on
// agents of its own, not globalThis.fetch, whose global dispatcher the app
// may have made retry (undici's RetryAgent). It sends each request once and
// knows whether its connection was ever ready for the request: a failure
// before that, a connect that took longer than `connectTimeoutMs` included,
// sent nothing (sentNothing). Undefined where the runtime has no
// process.getBuiltinModule (browsers, Workers, Node before 20.16).
export function sdkGatewayFetch(
  options: { connectTimeoutMs?: number; idleTimeoutMs?: number } = {},
): ((request: Request) => Promise<Response>) | undefined {
  const connectTimeoutMs = options.connectTimeoutMs ?? GATEWAY_CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? 4_000;
  const runtime = globalThis as typeof globalThis & {
    process?: { getBuiltinModule?: (id: string) => unknown };
  };
  const load = runtime.process?.getBuiltinModule;
  if (typeof load !== "function") return undefined;
  const http = load.call(runtime.process, "node:http") as NodeHttp | undefined;
  const https = load.call(runtime.process, "node:https") as NodeHttp | undefined;
  if (typeof http?.request !== "function" || typeof https?.request !== "function") return undefined;
  // Idle sockets closed after 4 s, as fetch's own agent does, well before a
  // server would close one under a request.
  const agents = {
    "http:": new http.Agent({ keepAlive: true, timeout: idleTimeoutMs }),
    "https:": new https.Agent({ keepAlive: true, timeout: idleTimeoutMs }),
  };

  return async (request) => {
    const url = new URL(request.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new TypeError(`The host gateway transport does not speak ${url.protocol}`);
    }
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    if (body) headers["content-length"] = String(body.byteLength);

    return new Promise<Response>((resolve, reject) => {
      const secure = url.protocol === "https:";
      // Whether the connection can carry the request yet: connected, and
      // for https past the TLS handshake. Until then no byte of it has left.
      let ready = false;
      const outgoing = (secure ? https : http).request(url, {
        method: request.method,
        headers,
        agent: agents[url.protocol as "http:" | "https:"],
        signal: request.signal,
      });
      const connectTimer = setTimeout(() => {
        if (ready) return;
        outgoing.destroy(
          Object.assign(new Error(`The host gateway's connection was not ready within ${connectTimeoutMs} ms.`), {
            code: "UND_ERR_CONNECT_TIMEOUT",
          }),
        );
      }, connectTimeoutMs);
      const isReady = () => {
        ready = true;
        clearTimeout(connectTimer);
      };
      outgoing.on("close", () => clearTimeout(connectTimer));
      outgoing.on("socket", (socket) => {
        // A kept-alive socket was made ready long ago.
        if (outgoing.reusedSocket) isReady();
        else socket.once(secure ? "secureConnect" : "connect", isReady);
      });
      outgoing.on("error", (error) => {
        clearTimeout(connectTimer);
        if (!ready && typeof error === "object" && error !== null) unsent.add(error);
        reject(error);
      });
      outgoing.on("response", (incoming) => {
        let settled = false;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const cutOff = (error: Error) => {
              if (!settled) controller.error(error);
              settled = true;
            };
            incoming.on("data", (chunk) => {
              if (!settled) controller.enqueue(new Uint8Array(chunk));
            });
            incoming.on("end", () => {
              if (!settled) controller.close();
              settled = true;
            });
            incoming.on("error", cutOff);
            incoming.on("close", () => {
              if (!incoming.complete) cutOff(new Error("The host gateway's answer was cut off."));
            });
          },
          cancel() {
            settled = true;
            incoming.destroy();
          },
        });
        const answerHeaders = new Headers();
        for (let i = 0; i + 1 < incoming.rawHeaders.length; i += 2) {
          answerHeaders.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
        }
        const status = incoming.statusCode ?? 502;
        try {
          const empty = request.method === "HEAD" || status === 204 || status === 205 || status === 304;
          resolve(new Response(empty ? null : stream, { status, statusText: incoming.statusMessage ?? "", headers: answerHeaders }));
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      });
      outgoing.end(body);
    });
  };
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
