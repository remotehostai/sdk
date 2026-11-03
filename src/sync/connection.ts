// The socket (app backends design 3.3, 3.4, 4.4): opens the connect URL,
// authenticates (the header for an unbound token where the WebSocket
// implementation takes headers; otherwise, and always for a DPoP-bound
// token, the `auth` frame with a proof over the challenge nonce), refreshes
// the token with `auth.refresh` one minute before it expires, and reports
// frames. Reconnects are the client's, with `backoffMs`.

import {
  decodeServer,
  encodeClient,
  type ClientFrame,
  type Reply,
  type ServerFrame,
} from "./generated/protocol.js";
import type { TokenGrant, WebSocketInstance, WebSocketLike } from "./types.js";
import { fromBase64url } from "./ids.js";

const OPEN = 1;

/** Jittered exponential backoff from 0.5 s to 30 s. */
export function backoffMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(30_000, 500 * 2 ** Math.max(0, attempt));
  return Math.max(500, Math.round(ceiling * (0.5 + random() / 2)));
}

/** A JWT's `exp` in ms, or `null` for a token that is not a readable JWT. */
export function tokenExpiry(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as {
      exp?: unknown;
    };
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

export interface ConnectionEvents {
  /** Authenticated: the subject, and the challenge nonce key proofs sign. */
  ready(info: { subject: string | null; nonce: string }): void;
  frame(frame: ServerFrame): void;
  closed(info: { code: number; reason: string; authFailed: boolean }): void;
}

export interface ConnectionOptions {
  url: string;
  token: () => Promise<TokenGrant>;
  webSocket: WebSocketLike;
  /** Whether the header path may be tried (Node); browsers always use the frame. */
  headers: boolean;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
}

export class Connection {
  private ws: WebSocketInstance | null = null;
  private nextId = 1;
  private waiting = new Map<number, (r: Reply) => void>();
  private refreshTimer: unknown = null;
  private nonce: string | null = null;
  private grant: TokenGrant | null = null;
  private closedByUs = false;
  private authFailed = false;

  constructor(
    private readonly opts: ConnectionOptions,
    private readonly events: ConnectionEvents,
  ) {}

  async open(): Promise<void> {
    this.grant = await this.opts.token();
    const bound = Boolean(this.grant.dpop);
    let ws: WebSocketInstance | null = null;
    let viaHeader = false;
    if (this.opts.headers && !bound) {
      try {
        ws = new this.opts.webSocket(this.opts.url, {
          headers: { authorization: `Bearer ${this.grant.token}` },
        });
        viaHeader = true;
      } catch {
        ws = null;
      }
    }
    ws ??= new this.opts.webSocket(this.opts.url);
    this.ws = ws;
    ws.addEventListener(
      "message",
      (e: { data: unknown }) => void this.onMessage(String(e.data), viaHeader),
    );
    ws.addEventListener("close", (e: { code?: number; reason?: string }) =>
      this.onClose(e.code ?? 1006, e.reason ?? ""),
    );
    ws.addEventListener("error", () => undefined);
  }

  private async onMessage(text: string, viaHeader: boolean): Promise<void> {
    const msg = decodeServer(text);
    if (!msg) return;
    if (!("event" in msg)) {
      const resolve = this.waiting.get(msg.id);
      this.waiting.delete(msg.id);
      resolve?.(msg);
      return;
    }
    if (msg.event === "challenge") {
      this.nonce = msg.nonce;
      if (viaHeader) {
        this.scheduleRefresh();
        this.events.ready({ subject: msg.subject ?? null, nonce: msg.nonce });
        return;
      }
      const reply = await this.request({ method: "auth", params: await this.authParams() });
      if ("error" in reply) {
        this.authFailed = true;
        this.close(4401, "auth refused");
        return;
      }
      const subject = (reply.result as { subject?: string } | null)?.subject ?? msg.subject ?? null;
      this.scheduleRefresh();
      this.events.ready({ subject, nonce: msg.nonce });
      return;
    }
    this.events.frame(msg);
  }

  private async authParams(): Promise<{ token: string; dpop?: string }> {
    const g = this.grant!;
    return g.dpop
      ? { token: g.token, dpop: await g.dpop(this.opts.url, this.nonce ?? "") }
      : { token: g.token };
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) this.opts.clearTimeout(this.refreshTimer);
    const exp = this.grant ? tokenExpiry(this.grant.token) : null;
    if (exp === null) return;
    const wait = Math.max(0, exp - 60_000 - this.opts.now());
    this.refreshTimer = this.opts.setTimeout(() => void this.refresh(), wait);
  }

  private async refresh(): Promise<void> {
    this.refreshTimer = null;
    if (!this.isOpen()) return;
    try {
      this.grant = await this.opts.token();
      const reply = await this.request({ method: "auth.refresh", params: await this.authParams() });
      if ("error" in reply) {
        this.authFailed = true;
        this.close(4401, "auth.refresh refused");
        return;
      }
      this.scheduleRefresh();
    } catch {
      this.close(4000, "token refresh failed");
    }
  }

  private onClose(code: number, reason: string): void {
    if (this.refreshTimer !== null) this.opts.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    for (const resolve of this.waiting.values()) resolve({ id: 0, error: { code: "closed" } });
    this.waiting.clear();
    this.ws = null;
    this.events.closed({ code, reason, authFailed: this.authFailed || code === 4401 });
  }

  isOpen(): boolean {
    return this.ws?.readyState === OPEN;
  }

  /** Sends a frame; false when the socket is not open. */
  send(frame: ClientFrame): boolean {
    return this.sendText(encodeClient(this.nextId++, frame));
  }

  /** Sends prebuilt frame text with this connection's next request id. */
  sendBuilt(build: (id: number) => string): boolean {
    return this.sendText(build(this.nextId++));
  }

  private sendText(text: string): boolean {
    if (!this.ws || this.ws.readyState !== OPEN) return false;
    this.ws.send(text);
    return true;
  }

  request(frame: ClientFrame): Promise<Reply> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      if (!this.sendText(encodeClient(id, frame))) {
        this.waiting.delete(id);
        resolve({ id, error: { code: "closed" } });
      }
    });
  }

  close(code = 1000, reason = ""): void {
    this.closedByUs = true;
    try {
      this.ws?.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  get closedLocally(): boolean {
    return this.closedByUs;
  }
}
