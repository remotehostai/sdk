// A small in-process sync server for the client's tests: no network. It
// follows protocol v1's shapes (REM-5443's brief, app backends design 3)
// closely enough to drive the client: challenge, auth, hello, welcome with a
// minted and rotating device, rows/rows_end/caught_up per shard, push with
// record ops applied into its own table and a `change` per op, and
// device.results. Tests reach in (`frames`, `send`, `refuse`) for the rest.

import type { WebSocketInstance, WebSocketLike } from "../../src/sync/types.js";

export interface Sent {
  id: number;
  method: string;
  params: any;
}

type Row = { entity: string; id: string; rev: number; row: Record<string, unknown> | null };

export class FakeSocket implements WebSocketInstance {
  readyState = 0;
  private listeners = new Map<string, Array<(e: any) => void>>();
  constructor(
    readonly server: FakeServer,
    readonly url: string,
    readonly options: unknown,
  ) {
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.fire("open", {});
      server.opened(this);
    });
  }
  addEventListener(type: string, l: (e: any) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  private fire(type: string, e: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(e);
  }
  send(data: string): void {
    this.server.received(this, JSON.parse(data) as Sent);
  }
  /** The server sends a frame. */
  push(frame: unknown): void {
    if (this.readyState === 1) this.fire("message", { data: JSON.stringify(frame) });
  }
  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.fire("close", { code, reason }));
  }
}

export interface FakeOptions {
  workspace?: string;
  /** Group ids and shards the welcome names. */
  groups?: Array<{ id: string; shards?: number }>;
  /** Whether the server answers itself; off, the test drives every frame. */
  auto?: boolean;
  /** Refuse an op: returns the refusal, or null to apply it. */
  refuse?: (op: any) => { code: string; reason?: string; message: string } | null;
  subject?: string;
  /** Refuse a hello's workspace: returns the refusal's field and message, or null to welcome it. */
  refuseHello?: (w: any) => { field: string; message: string } | null;
}

export class FakeServer {
  readonly sockets: FakeSocket[] = [];
  readonly frames: Sent[] = [];
  readonly rows = new Map<string, Row>();
  seq = 0;
  deviceId: string | null = null;
  generation = 0;
  secrets: string[] = [];
  lastDeviceSeq = 0;
  results = new Map<number, { status: string; device_seq: number }>();
  readonly workspace: string;
  private waiters: Array<{ method: string; resolve: (s: Sent) => void }> = [];

  constructor(readonly opts: FakeOptions = {}) {
    this.workspace = opts.workspace ?? "ws-1";
  }

  get WebSocket(): WebSocketLike {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const server = this;
    return class extends FakeSocket {
      constructor(url: string, options?: unknown) {
        super(server, url, options);
        server.sockets.push(this);
      }
    } as unknown as WebSocketLike;
  }

  get socket(): FakeSocket {
    return this.sockets[this.sockets.length - 1]!;
  }

  /** Resolves with the next frame of `method` the client sends. */
  next(method: string): Promise<Sent> {
    return new Promise((resolve) => this.waiters.push({ method, resolve }));
  }

  sent(method: string): Sent[] {
    return this.frames.filter((f) => f.method === method);
  }

  opened(s: FakeSocket): void {
    s.push({
      event: "challenge",
      nonce: `nonce-${this.sockets.length}`,
      subject: this.opts.subject ?? "user-1",
    });
  }

  received(s: FakeSocket, f: Sent): void {
    this.frames.push(f);
    for (const w of this.waiters.filter((w) => w.method === f.method)) {
      this.waiters.splice(this.waiters.indexOf(w), 1);
      w.resolve(f);
    }
    if (this.opts.auto === false) return;
    switch (f.method) {
      case "auth":
        s.push({ id: f.id, result: { subject: this.opts.subject ?? "user-1" } });
        return;
      case "hello":
        this.hello(s, f.params);
        return;
      case "push":
        this.pushOps(s, f.params);
        return;
      case "device.results":
        s.push({
          event: "device_results",
          workspace: this.workspace,
          device_id: f.params.device_id,
          from_seq: f.params.from_seq,
          upto: f.params.upto,
          applied: [...this.results.values()]
            .filter((r) => r.status === "applied" && r.device_seq >= f.params.from_seq)
            .map((r) => ({ device_seq: r.device_seq, op_hash: "" })),
          refused: [],
          next_from_seq: null,
        });
        return;
      default:
        return;
    }
  }

  groups(): Array<{
    id: string;
    kind: string;
    scope: { kind: string; id: string };
    shards: number;
    layout_version: number;
  }> {
    return (this.opts.groups ?? [{ id: "g-ws" }]).map((g) => ({
      id: g.id,
      kind: "workspace",
      scope: { kind: "workspace", id: this.workspace },
      shards: g.shards ?? 1,
      layout_version: 1,
    }));
  }

  hello(s: FakeSocket, params: any): void {
    const w = params.workspaces[0];
    const refusal = this.opts.refuseHello?.(w) ?? null;
    if (refusal) {
      s.push({ event: "hello_refused", workspace: this.workspace, code: "invalid", ...refusal });
      return;
    }
    if (w.device === null) {
      this.deviceId = `dev-${this.secrets.length + 1}`;
      this.generation = 0;
      this.lastDeviceSeq = 0;
      this.results.clear();
    }
    this.generation += 1;
    const secret = `secret-${this.generation}`;
    this.secrets.push(secret);
    s.push({
      event: "welcome",
      protocol: 1,
      workspace: this.workspace,
      subject: this.opts.subject ?? "user-1",
      device: { id: this.deviceId, secret, generation: this.generation },
      device_epoch: 1,
      outbox_epoch: 1,
      last_device_seq: this.lastDeviceSeq,
      op_versions: { min: 4, max: 4 },
      mode: "catch_up",
      cut: {},
      groups: this.groups(),
      max_frame_bytes: 1 << 20,
    });
    for (const g of this.groups()) {
      const have = w.cursors?.seqs?.[`${g.id}/0`] ?? 0;
      if (have < this.seq || have === 0) {
        s.push({
          event: "rows",
          workspace: this.workspace,
          group: g.id,
          shard: 0,
          layout_version: 1,
          rows: [...this.rows.values()]
            .filter((r) => r.row)
            .map(({ entity, id, rev, row }) => ({ entity, id, rev, row })),
          tombstones: [],
        });
        s.push({
          event: "rows_end",
          workspace: this.workspace,
          group: g.id,
          shard: 0,
          layout_version: 1,
          upto_seq: this.seq,
          coverage: { complete: true },
        });
      }
      for (let shard = 0; shard < g.shards; shard++)
        s.push({
          event: "caught_up",
          workspace: this.workspace,
          group: g.id,
          shard,
          seq: this.seq,
        });
    }
  }

  pushOps(s: FakeSocket, params: any): void {
    const results = [];
    for (const o of params.ops) {
      const done = this.results.get(o.device_seq);
      if (done) {
        results.push(done);
        continue;
      }
      const refusal = this.opts.refuse?.(o.op) ?? null;
      const result = refusal
        ? { status: "refused", device_seq: o.device_seq, ...refusal }
        : { status: "applied", device_seq: o.device_seq, writes: [] };
      this.results.set(o.device_seq, result);
      this.lastDeviceSeq = Math.max(this.lastDeviceSeq, o.device_seq);
      results.push(result);
      if (!refusal) this.apply(s, o.op);
    }
    s.push({ event: "push_result", workspace: this.workspace, results });
  }

  apply(s: FakeSocket, op: any): void {
    const entity = op.backend === "issues" ? op.type : `${op.backend}.${op.type}`;
    const key = `${entity}/${op.id}`;
    const old = this.rows.get(key);
    const rev = (old?.rev ?? 0) + 1;
    let row: Record<string, unknown> | null = null;
    if (op.op === "put_record") row = { id: op.id, ...op.fields };
    else if (op.op === "update_record") row = { ...(old?.row ?? { id: op.id }), ...op.set };
    this.rows.set(key, { entity, id: op.id, rev, row });
    this.seq += 1;
    const g = this.groups()[0]!;
    s.push({
      event: "change",
      workspace: this.workspace,
      group: g.id,
      shard: 0,
      layout_version: 1,
      from_seq: this.seq,
      to_seq: this.seq,
      rows: [
        row
          ? { entity, id: op.id, rev, row }
          : { entity, id: op.id, rev, row: null, state: "deleted" },
      ],
    });
  }
}

/** Waits until `check` holds, polling the microtask and timer queues. */
export async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 1));
  }
}

export const token = async () => ({ token: "test:user-1" });
