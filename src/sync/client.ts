// `createSyncClient` (app backends design 4): the reference client of sync
// protocol v1. It keeps a local copy in its store, applies writes
// optimistically and queues them, reconciles refusals, catches up from its
// cursors, and narrows what it holds by backend and scope. The rules are
// atlas-core's replica's (sync design 3.11); this is not a port of its code.

import {
  OP_VERSION,
  PROTOCOL,
  type Base,
  type DeviceResults,
  type HelloWorkspace,
  type Op,
  type OpResult,
  type RejectionCode,
  type ServerFrame,
} from "./generated/protocol.js";
import { backoffMs, Connection } from "./connection.js";
import {
  endDevice,
  heldDevice,
  makeKey,
  META,
  proveHello,
  proveRegistration,
  reconcilePage,
  takeWelcomeDevice,
  type HeldDevice,
  type HeldKey,
} from "./device.js";
import {
  ackedUpto,
  DEFAULT_MAX_FRAME_BYTES,
  enqueue,
  pushFrames,
  rejectionDelay,
  WINDOW,
} from "./outbox.js";
import { Overlay, entityOf, overlayKey, splitKey } from "./overlay.js";
import {
  applyGroups,
  applyRow,
  dropGroup,
  encodeCursor,
  helloCursors,
  layoutCheck,
  readCursors,
  readGroups,
  seqOf,
  setSeq,
  shardKey,
  takeLayouts,
} from "./catchup.js";
import { recordSet, Subscriptions } from "./records.js";
import { browserLeaderEnvironment, Leadership } from "./leader.js";
import { newId } from "./ids.js";
import { planRecord } from "./validate.js";
import { VERSION } from "../version.js";
import type {
  HelloRefusal,
  OutboxEntry,
  PendingWrite,
  RecordRow,
  RecordSet,
  SyncClient,
  SyncClientOptions,
  StoreTx,
  SyncStatus,
  WebSocketLike,
  WriteOutcome,
} from "./types.js";

const RECORD_OPS = new Set(["put_record", "update_record", "delete_record"]);

/**
 * Whether an applied op's writes are still ahead of the cursors, in the
 * groups this copy holds: a write to a group it does not hold, or no
 * longer holds, never comes (the replica's rule, replica.rs). An op that
 * wrote several shards stays predicted until the slowest has caught up,
 * so for that short while it masks a newer remote edit of the same row.
 */
function behind(tx: StoreTx, writes: Base[]): boolean {
  const held = new Set(readGroups(tx).map((g) => g.id));
  return writes.some((w) => held.has(w.group) && seqOf(tx, w.group, w.shard) < w.seq);
}

export function createSyncClient(options: SyncClientOptions): SyncClient {
  return new Client(options);
}

class Client implements SyncClient {
  status: SyncStatus = "offline";
  private readonly listeners = new Set<(s: SyncStatus) => void>();
  private readonly overlay: Overlay;
  private readonly subs = new Subscriptions();
  private outbox: OutboxEntry[] = [];
  /**
   * Ops `write()` has accepted while their outbox transaction runs: the
   * overlay predicts them at once, so a write shows before its first await.
   */
  private enqueuing: OutboxEntry[] = [];
  /**
   * Applied ops whose writes the cursors have not reached: still predicted
   * until the change carrying them lands, as the desktop replica keeps an
   * applied entry in its outbox. Without it the row disappears between
   * the push_result and the change.
   */
  private landing: Array<{ entry: OutboxEntry; writes: Base[] }> = [];
  private conn: Connection | null = null;
  private signedIn: string | null = null;
  private nonce = "";
  private device: HeldDevice | null = null;
  private outboxEpoch = 0;
  private welcomed = false;
  private reconciling = false;
  private stopped = true;
  /** Counts starts and stops: a start that finds it moved on was stopped while it awaited. */
  private runs = 0;
  private terminal = false;
  private refused: HelloRefusal | null = null;
  private attempt = 0;
  private supersededOnce = false;
  private maxFrameBytes = DEFAULT_MAX_FRAME_BYTES;
  private readonly inFlight = new Set<number>();
  private sentUpto = 0;
  private holdUntil = 0;
  private pushTimer: unknown = null;
  private reconnectTimer: unknown = null;
  private readonly waiters = new Map<number, (o: WriteOutcome) => void>();
  private readonly pendingShards = new Set<string>();
  private live: { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void };
  private leadership: Leadership | null = null;
  private isLeader = false;
  /** Frames handled one at a time, in arrival order. */
  private queue: Promise<void> = Promise.resolve();

  private readonly random: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;
  private readonly now: () => number;

  constructor(private readonly options: SyncClientOptions) {
    this.overlay = new Overlay(options.declarations, () => this.signedIn);
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.now = options.now ?? Date.now;
    this.live = deferred();
  }

  get leader(): boolean {
    return this.isLeader;
  }

  get subject(): string | null {
    return this.signedIn;
  }

  get refusal(): HelloRefusal | null {
    return this.status === "refused" ? this.refused : null;
  }

  // ---- Lifecycle ------------------------------------------------------------

  async start(): Promise<void> {
    if (!this.stopped) return this.live.promise;
    this.stopped = false;
    this.terminal = false;
    this.refused = null;
    this.live = deferred();
    const run = ++this.runs;
    try {
      await this.options.store.open(this.options.workspace);
      await this.reload();
    } catch (error) {
      // Stopped while the store opened: the stop is the answer.
      if (run !== this.runs) return;
      throw error;
    }
    if (run !== this.runs) {
      // Stopped while the store opened, after stop closed it: close what
      // opened since, so a sign-out's delete of the copy is not held up,
      // unless a later start has it now.
      if (this.stopped) await this.options.store.close();
      return;
    }
    const env =
      this.options.store.shared && this.options.leader !== false
        ? (this.options.leader ?? browserLeaderEnvironment())
        : null;
    if (env) {
      this.leadership = new Leadership(env, this.options.workspace, {
        lead: async () => {
          this.isLeader = true;
          // A follower's status mirrored the old leader's: this tab is
          // live only once its own socket is.
          this.setStatus("connecting");
          await this.options.store.refresh?.();
          await this.reload();
          await this.connect();
        },
        resign: () => this.resign(),
        write: (ops, batch) => this.writeLocal(ops, batch),
        changed: () => void this.followerReload(),
        status: (s) => this.setStatus(s as SyncStatus, false),
        current: () => this.status,
      });
      this.leadership.start();
      // A follower reads the shared store; it is ready once loaded.
      return;
    }
    this.isLeader = true;
    await this.connect();
    return this.live.promise;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.runs++;
    this.leadership?.stop();
    this.leadership = null;
    this.resign();
    this.isLeader = false;
    await this.options.store.close();
    this.setStatus("offline");
  }

  /** Stops writing and closes the socket at once: the lock is gone or the client stops. */
  private resign(): void {
    this.isLeader = false;
    this.clearTimers();
    this.welcomed = false;
    this.inFlight.clear();
    // The next leader, this tab or another, reads what landed from the store.
    this.landing = [];
    const conn = this.conn;
    this.conn = null;
    conn?.close(1000, "stopped");
  }

  private clearTimers(): void {
    if (this.pushTimer !== null) this.clearTimer(this.pushTimer);
    if (this.reconnectTimer !== null) this.clearTimer(this.reconnectTimer);
    this.pushTimer = null;
    this.reconnectTimer = null;
  }

  /** Drops the landing ops every write of which the cursors have reached; whether any. */
  private landed(tx: StoreTx): boolean {
    if (!this.landing.length) return false;
    const before = this.landing.length;
    this.landing = this.landing.filter((l) => behind(tx, l.writes));
    return this.landing.length !== before;
  }

  /** One shard current; the client is live once every pending shard is. */
  private caughtUp(group: string, shard: number): void {
    this.pendingShards.delete(shardKey(group, shard));
    if (!this.pendingShards.size && this.status === "catching_up") this.setStatus("live");
  }

  private setStatus(s: SyncStatus, broadcast = true): void {
    if (this.status === s) return;
    this.status = s;
    if (s === "live") this.live.resolve();
    if (s === "update_required" || s === "forbidden") this.live.reject(new Error(`sync ${s}`));
    if (s === "refused") this.live.reject(refusedError(this.refused));
    for (const l of this.listeners) l(s);
    if (broadcast && this.isLeader) this.leadership?.post({ kind: "status", status: s });
  }

  onStatus(listener: (s: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- Reads ----------------------------------------------------------------

  records<T = RecordRow>(backend: string, type: string): RecordSet<T> {
    return recordSet<T>(
      entityOf(backend, type, this.options.declarations),
      this.overlay,
      this.subs,
    );
  }

  async pending(): Promise<PendingWrite[]> {
    return this.outbox.map((e) => ({
      deviceSeq: e.deviceSeq,
      op: JSON.parse(e.op) as Op,
      enqueuedAt: e.enqueuedAt,
    }));
  }

  cursor(): Promise<string> {
    return this.options.store.transaction((tx) => encodeCursor(readCursors(tx)));
  }

  async setScopes(scopes: Array<{ kind: "team"; id: string }> | undefined): Promise<void> {
    this.options.scopes = scopes;
    if (this.welcomed && this.conn?.isOpen()) await this.sendHello();
  }

  /** Reloads confirmed rows and the outbox from the store, recomputing the overlay. */
  private async reload(): Promise<Set<string>> {
    const before = new Set<string>();
    for (const [e, m] of this.overlay.confirmed)
      for (const id of m.keys()) before.add(overlayKey(e, id));
    const [rows, outbox] = await this.options.store.transaction(
      (tx) => [Array.from(tx.allRows()), tx.outbox()] as const,
    );
    this.overlay.load(rows);
    for (const r of rows) before.add(overlayKey(r.entity, r.id));
    this.outbox = outbox;
    for (const k of this.overlay.recompute(outbox)) before.add(k);
    return before;
  }

  private async followerReload(): Promise<void> {
    await this.options.store.refresh?.();
    this.emit(await this.reload());
  }

  private emit(touched: Set<string>): void {
    for (const k of touched) {
      const [entity, id] = splitKey(k);
      this.subs.emit(entity, id, this.overlay);
    }
  }

  /** After a store change: recompute the overlay, tell subscribers and the other tabs. */
  private changed(touched: Set<string>, outbox?: OutboxEntry[]): void {
    if (outbox) this.outbox = outbox;
    const ops = [...this.landing.map((l) => l.entry), ...this.outbox, ...this.enqueuing];
    for (const k of this.overlay.recompute(ops)) touched.add(k);
    this.emit(touched);
    if (this.isLeader) this.leadership?.post({ kind: "changed" });
  }

  // ---- Writes ---------------------------------------------------------------

  async write(ops: Op[] | Op, options: { batch?: boolean } = {}): Promise<WriteOutcome[]> {
    const list = Array.isArray(ops) ? ops : [ops];
    if (this.leadership && !this.leadership.leading)
      return this.leadership.forward(list, Boolean(options.batch));
    return this.writeLocal(list, Boolean(options.batch));
  }

  private async writeLocal(ops: Op[], batch: boolean): Promise<WriteOutcome[]> {
    // A tab that lost the lead never writes the outbox again.
    if (this.leadership && !this.leadership.leading) return this.leadership.forward(ops, batch);
    const outcomes: Array<WriteOutcome | Promise<WriteOutcome>> = new Array(ops.length);
    const queued: Op[] = [];
    const slots: number[] = [];
    ops.forEach((op, i) => {
      const refusal = this.validate(op);
      if (refusal) outcomes[i] = { status: "refused", deviceSeq: 0, ...refusal };
      else {
        queued.push(op);
        slots.push(i);
      }
    });
    if (batch && queued.length !== ops.length) {
      // A batch is all or nothing: one local refusal refuses the rest unsent.
      return ops.map(
        (_, i) =>
          (outcomes[i] as WriteOutcome | undefined) ?? {
            status: "refused",
            deviceSeq: 0,
            code: "invalid",
            reason: "batch_refused",
            message: "another op in the batch was refused",
          },
      );
    }
    if (queued.length) {
      const batchId = batch && queued.length > 1 ? newId() : undefined;
      const now = new Date(this.now());
      const held: OutboxEntry[] = queued.map((op) => ({
        deviceSeq: 0,
        entryNonce: "",
        op: JSON.stringify(op),
        enqueuedAt: now.toISOString(),
      }));
      this.enqueuing.push(...held);
      this.changed(new Set());
      let entries: OutboxEntry[];
      let outbox: OutboxEntry[];
      try {
        [entries, outbox] = await this.options.store.transaction((tx) => {
          const e = enqueue(tx, queued, batchId, now);
          return [e, tx.outbox()] as const;
        });
      } catch (e) {
        this.enqueuing = this.enqueuing.filter((p) => !held.includes(p));
        this.changed(new Set());
        throw e;
      }
      this.enqueuing = this.enqueuing.filter((p) => !held.includes(p));
      entries.forEach((e, j) => {
        outcomes[slots[j]!] = new Promise<WriteOutcome>((resolve) =>
          this.waiters.set(e.deviceSeq, resolve),
        );
      });
      this.changed(new Set(), outbox);
      this.pump();
    }
    return Promise.all(outcomes);
  }

  /** Local validation of a declared op; Issues ops are validated by the service alone. */
  private validate(
    op: Op,
  ): Omit<Extract<WriteOutcome, { status: "refused" }>, "status" | "deviceSeq"> | null {
    if (!RECORD_OPS.has((op as { op: string }).op)) return null;
    const rec = op as Extract<Op, { op: "put_record" | "update_record" | "delete_record" }>;
    if (!this.options.declarations?.[rec.backend]) return null;
    const planned = planRecord(
      rec,
      this.options.declarations,
      this.overlay.recordStore(rec.backend),
    );
    return planned.ok ? null : planned.refusal;
  }

  private settle(result: OpResult, touched: Set<string>): void {
    void touched;
    const resolve = this.waiters.get(result.device_seq);
    this.waiters.delete(result.device_seq);
    this.inFlight.delete(result.device_seq);
    if (result.status === "applied") resolve?.({ status: "applied", deviceSeq: result.device_seq });
    else if (result.status === "refused") {
      const { code, reason, field, message, current } = result;
      resolve?.({
        status: "refused",
        deviceSeq: result.device_seq,
        code,
        message,
        ...(reason ? { reason } : {}),
        ...(field ? { field } : {}),
        ...(current !== undefined ? { current } : {}),
      });
    }
  }

  /** Pushes what the window has room for. */
  private pump(): void {
    const conn = this.conn;
    if (!this.isLeader || !this.welcomed || this.reconciling || !conn?.isOpen() || !this.device)
      return;
    if (this.now() < this.holdUntil) return;
    const room = WINDOW - this.inFlight.size;
    if (room <= 0) return;
    const entries = this.outbox.filter((e) => e.deviceSeq > this.sentUpto);
    if (!entries.length) return;
    const header = {
      workspace: this.options.workspace,
      epoch: this.device.epoch,
      outbox_epoch: this.outboxEpoch,
      acked_upto: entries[0]!.deviceSeq - 1,
    };
    for (const f of pushFrames(entries, header, room, this.maxFrameBytes)) {
      if (!conn.sendBuilt(f.build)) return;
      for (const s of f.seqs) this.inFlight.add(s);
      this.sentUpto = Math.max(this.sentUpto, ...f.seqs);
    }
  }

  private rejected(
    code: RejectionCode,
    fromSeq: number,
    retryAfterMs: number | undefined,
    expected: number | undefined,
  ): void {
    switch (code) {
      case "gap":
        this.rewind((expected ?? fromSeq) - 1);
        this.pump();
        return;
      case "update_required":
        this.terminal = true;
        this.setStatus("update_required");
        this.conn?.close(1000, "update required");
        return;
      case "superseded":
        void this.superseded();
        return;
      case "device_conflict":
        void this.startReconcile();
        return;
      default: {
        const wait = rejectionDelay(code, retryAfterMs, this.random) ?? 1000;
        this.rewind(fromSeq - 1);
        this.holdUntil = this.now() + wait;
        if (this.pushTimer !== null) this.clearTimer(this.pushTimer);
        this.pushTimer = this.setTimer(() => {
          this.pushTimer = null;
          this.holdUntil = 0;
          this.pump();
        }, wait);
      }
    }
  }

  /** Resend from `upto + 1`: what was in flight past it is sent again. */
  private rewind(upto: number): void {
    this.sentUpto = Math.min(this.sentUpto, upto);
    for (const s of Array.from(this.inFlight)) if (s > upto) this.inFlight.delete(s);
  }

  // ---- Connection -----------------------------------------------------------

  private async connect(): Promise<void> {
    if (this.stopped || this.terminal || !this.isLeader) return;
    this.setStatus("connecting");
    const webSocket =
      this.options.webSocket ?? (globalThis as { WebSocket?: WebSocketLike }).WebSocket;
    if (!webSocket)
      throw new Error(
        "no WebSocket: pass options.webSocket (Node 20) or run on Node 22 or a browser",
      );
    const isNode =
      typeof (globalThis as { window?: unknown }).window === "undefined" &&
      Boolean(
        (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node,
      );
    const conn = new Connection(
      {
        url: this.options.url,
        token: this.options.token,
        webSocket,
        headers: isNode,
        setTimeout: this.setTimer,
        clearTimeout: this.clearTimer,
        now: this.now,
      },
      {
        ready: ({ subject, nonce }) => {
          if (this.conn !== conn) return;
          this.signedIn = subject ?? this.signedIn;
          this.nonce = nonce;
          this.enqueueFrame(() => this.sendHello());
        },
        frame: (f) => {
          if (this.conn !== conn) return;
          this.enqueueFrame(() => this.onFrame(f));
        },
        closed: () => {
          if (this.conn !== conn) return;
          this.conn = null;
          this.welcomed = false;
          this.inFlight.clear();
          this.sentUpto = 0;
          this.scheduleReconnect();
        },
      },
    );
    this.conn = conn;
    try {
      await conn.open();
    } catch {
      if (this.conn === conn) {
        this.conn = null;
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect(afterMs?: number): void {
    if (this.stopped || this.terminal || !this.isLeader) return;
    this.setStatus("offline");
    if (this.reconnectTimer !== null) this.clearTimer(this.reconnectTimer);
    const wait = afterMs ?? backoffMs(this.attempt++, this.random);
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, wait);
  }

  private enqueueFrame(fn: () => Promise<void> | void): void {
    this.queue = this.queue.then(fn).catch((e: unknown) => {
      // A frame the client cannot apply: start again from the store.
      console.error("@remotehost/sdk/sync:", e);
      this.conn?.close(4000, "client error");
    });
  }

  private async sendHello(): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    const o = this.options;
    const nonce = this.nonce;
    const ws = await o.store.transaction(async (tx) => {
      const device = heldDevice(tx);
      let key = (tx.getMeta(META.key) as HeldKey | null | undefined) ?? null;
      const common = {
        workspace: o.workspace,
        cursors: helloCursors(tx),
        backends: o.backends ?? ["issues"],
        ...(o.scopes ? { scopes: o.scopes } : {}),
        ...(o.store.deviceKind === "ephemeral" ? { device_kind: "ephemeral" as const } : {}),
      };
      if (device && key) {
        return {
          ...common,
          device: {
            id: device.id,
            secret: device.secret,
            generation: device.generation,
            proof: await proveHello(key, device.id, device.generation, nonce),
          },
          next_device_seq: Number(tx.getMeta(META.nextDeviceSeq) ?? 1),
          acked_upto: ackedUpto(tx),
        } satisfies HelloWorkspace;
      }
      if (device) endDevice(tx);
      if (!key) {
        key = await makeKey(o.store.keepsCryptoKeys);
        tx.setMeta(META.key, key);
      }
      return {
        ...common,
        device: null,
        device_key: key.publicJwk,
        proof: await proveRegistration(key, nonce),
        next_device_seq: 1,
        acked_upto: 0,
      } satisfies HelloWorkspace;
    });
    conn.send({
      method: "hello",
      params: {
        protocol: PROTOCOL,
        app_version: o.appVersion ?? `sdk-${VERSION}`,
        op_versions: { min: OP_VERSION, max: OP_VERSION },
        schema_version: 1,
        profile: "full",
        workspaces: [ws],
      },
    });
  }

  private async superseded(): Promise<void> {
    if (!this.supersededOnce) {
      this.supersededOnce = true;
      await this.sendHello();
      return;
    }
    this.conn?.close(1000, "superseded");
  }

  // ---- Frames ---------------------------------------------------------------

  private async onFrame(f: ServerFrame): Promise<void> {
    const store = this.options.store;
    const touched = new Set<string>();
    if ("workspace" in f && f.workspace !== this.options.workspace) return;
    switch (f.event) {
      case "welcome": {
        if (f.mode === "update_required") {
          this.terminal = true;
          this.setStatus("update_required");
          this.conn?.close(1000, "update required");
          return;
        }
        const { renumbered, outbox, device, groups } = await store.transaction((tx) => {
          if (f.mode === "reset") dropGroup(tx, this.overlay, null, touched);
          const r = takeWelcomeDevice(tx, f);
          takeLayouts(tx, this.overlay, f.groups, touched);
          this.landed(tx);
          return { ...r, outbox: tx.outbox(), device: heldDevice(tx), groups: f.groups };
        });
        for (const [from, to] of renumbered) {
          const w = this.waiters.get(from);
          this.waiters.delete(from);
          if (w) this.waiters.set(to, w);
        }
        this.device = device;
        this.outboxEpoch = f.outbox_epoch;
        this.signedIn = f.subject;
        this.maxFrameBytes = f.max_frame_bytes ?? DEFAULT_MAX_FRAME_BYTES;
        this.welcomed = true;
        this.reconciling = false;
        this.attempt = 0;
        this.supersededOnce = false;
        this.inFlight.clear();
        this.sentUpto = 0;
        this.pendingShards.clear();
        for (const g of groups)
          for (let s = 0; s < g.shards; s++) this.pendingShards.add(shardKey(g.id, s));
        this.conn?.send({
          method: "ack",
          params: {
            workspace: this.options.workspace,
            acked_upto: outbox[0] ? outbox[0].deviceSeq - 1 : Math.max(0, f.last_device_seq),
            generation: f.device.generation,
          },
        });
        this.changed(touched, outbox);
        this.setStatus(this.pendingShards.size ? "catching_up" : "live");
        this.pump();
        return;
      }
      case "rows": {
        await store.transaction((tx) => {
          const check = layoutCheck(tx, f.group, f.layout_version);
          if (check === "ahead")
            this.conn?.send({
              method: "layout_req",
              params: { workspace: f.workspace, group: f.group },
            });
          if (check !== "ok") return;
          for (const r of f.rows) applyRow(tx, this.overlay, f.group, f.shard, r, touched);
          for (const t of f.tombstones) applyRow(tx, this.overlay, f.group, f.shard, t, touched);
        });
        this.changed(touched);
        return;
      }
      case "rows_end": {
        const pruned = await store.transaction((tx) => {
          // An instant set's filtered rows_end moves no cursor (REM-2462):
          // a reconnect from it would skip the rest of the group.
          if (f.coverage?.complete && layoutCheck(tx, f.group, f.layout_version) === "ok")
            setSeq(tx, f.group, f.shard, f.layout_version, f.upto_seq);
          return this.landed(tx);
        });
        if (pruned) this.changed(touched);
        // atlas-sync ends each shard's catch-up with a complete `rows_end`
        // and sends no `caught_up` (stream/catchup.rs); the desktop replica
        // settles on it too. An instant set's filtered one is not the end.
        if (f.coverage?.complete) this.caughtUp(f.group, f.shard);
        return;
      }
      case "change": {
        await store.transaction((tx) => {
          const check = layoutCheck(tx, f.group, f.layout_version);
          if (check === "ahead")
            this.conn?.send({
              method: "layout_req",
              params: { workspace: f.workspace, group: f.group },
            });
          if (check !== "ok") return;
          const cur = seqOf(tx, f.group, f.shard);
          if (f.to_seq <= cur) return;
          if (f.from_seq > cur + 1) {
            this.conn?.send({
              method: "resume",
              params: { workspace: f.workspace, group: f.group, shard: f.shard, from_seq: cur + 1 },
            });
            return;
          }
          for (const r of f.rows) applyRow(tx, this.overlay, f.group, f.shard, r, touched);
          setSeq(tx, f.group, f.shard, f.layout_version, f.to_seq);
          this.landed(tx);
        });
        this.changed(touched);
        return;
      }
      case "caught_up": {
        this.caughtUp(f.group, f.shard);
        return;
      }
      case "groups": {
        await store.transaction((tx) => {
          applyGroups(tx, this.overlay, f, touched);
          this.landed(tx);
        });
        this.changed(touched);
        return;
      }
      case "reset": {
        // A reset comes inside a catch-up the service is already sending
        // (every cursor at 0 is a "bootstrap"; a purge or a removed
        // link's tombstone restarts it): drop the group and wait for its
        // shards' caught_up again, as the desktop replica does. A new
        // hello here would be welcomed with a rotated secret and reset
        // again, forever, until the subject's registrations run out.
        // Only a server rollback asks for a hello, and what it rolled back
        // may never come: nothing it answered is held.
        if (f.reason === "server_rollback") this.landing = [];
        const groups = await store.transaction((tx) => {
          dropGroup(tx, this.overlay, f.group ?? null, touched);
          this.landed(tx);
          return readGroups(tx);
        });
        this.changed(touched);
        if (f.reason === "server_rollback") {
          this.setStatus("catching_up");
          await this.sendHello();
          return;
        }
        for (const g of groups)
          if (f.group == null || g.id === f.group)
            for (let s = 0; s < g.shards; s++) this.pendingShards.add(shardKey(g.id, s));
        this.setStatus("catching_up");
        return;
      }
      case "push_result": {
        const settled = new Set<number>();
        for (const r of f.results) if (r.status !== "rejected") settled.add(r.device_seq);
        const sent = new Map(this.outbox.map((e) => [e.deviceSeq, e]));
        const outbox = await store.transaction((tx) => {
          for (const r of f.results) {
            const entry = sent.get(r.device_seq);
            if (r.status === "applied" && entry && behind(tx, r.writes))
              this.landing.push({ entry, writes: r.writes });
          }
          for (const seq of settled) tx.settle(seq);
          return tx.outbox();
        });
        this.outbox = outbox;
        for (const r of f.results) {
          if (r.status === "rejected")
            this.rejected(r.code, r.device_seq, r.retry_after_ms, r.expected);
          else this.settle(r, touched);
        }
        this.changed(touched, outbox);
        this.pump();
        return;
      }
      case "rejected":
        this.rejected(f.code, f.from_device_seq, f.retry_after_ms, f.expected);
        return;
      case "superseded":
        await this.superseded();
        return;
      case "device_conflict":
        if (this.device && f.device_id !== this.device.id) return;
        await this.startReconcile();
        return;
      case "forbidden":
        if (f.reason === "stale_secret") {
          await this.startReconcile();
          return;
        }
        this.terminal = true;
        this.setStatus("forbidden");
        this.conn?.close(1000, "forbidden");
        return;
      case "hello_refused":
        // The same hello would be refused again (REM-5490): the client
        // stops, saying why, until the app changes what it asks and starts
        // it again.
        this.terminal = true;
        this.refused = {
          code: f.code,
          message: f.message,
          ...(f.field !== undefined ? { field: f.field } : {}),
        };
        this.setStatus("refused");
        this.conn?.close(1000, "hello refused");
        return;
      case "device_results":
        await this.reconciled(f);
        return;
      case "device_results_refused":
        await this.finishReconcile();
        return;
      case "reconnect":
        this.conn?.close(1000, "reconnect");
        this.scheduleReconnect(f.after_ms);
        return;
      default:
        return;
    }
  }

  // ---- Reconcile (sync design 3.2; atlas-core's device lineage) ---------------

  private async startReconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    this.welcomed = false;
    this.inFlight.clear();
    this.sentUpto = 0;
    const [ending, outbox] = await this.options.store.transaction(
      (tx) => [endDevice(tx), tx.outbox()] as const,
    );
    this.device = null;
    const first = outbox[0];
    const last = outbox[outbox.length - 1];
    if (ending && first && last) {
      this.conn?.send({
        method: "device.results",
        params: {
          workspace: this.options.workspace,
          device_id: ending.id,
          from_seq: first.deviceSeq,
          upto: last.deviceSeq,
        },
      });
      return;
    }
    await this.finishReconcile();
  }

  private async reconciled(answer: { event: "device_results" } & DeviceResults): Promise<void> {
    if (!this.reconciling) return;
    const touched = new Set<string>();
    const [decided, outbox] = await this.options.store.transaction(
      (tx) => [reconcilePage(tx, answer), tx.outbox()] as const,
    );
    this.outbox = outbox;
    for (const seq of decided.applied)
      this.settle({ status: "applied", device_seq: seq, writes: [] }, touched);
    for (const r of decided.refused)
      this.settle(
        {
          status: "refused",
          device_seq: r.device_seq,
          code: r.code,
          message: r.message,
          ...(r.reason ? { reason: r.reason } : {}),
        },
        touched,
      );
    this.changed(touched, outbox);
    if (answer.next_from_seq !== null && outbox.length) {
      this.conn?.send({
        method: "device.results",
        params: {
          workspace: this.options.workspace,
          device_id: answer.device_id,
          from_seq: answer.next_from_seq,
          upto: answer.upto,
        },
      });
      return;
    }
    await this.finishReconcile();
  }

  /** Registers anew: the rest of the outbox is numbered for the new device at its welcome. */
  private async finishReconcile(): Promise<void> {
    await this.options.store.transaction((tx) => tx.setMeta(META.ending, null));
    this.reconciling = false;
    await this.sendHello();
  }
}

/** What `start()` rejects with once the service refused the hello. */
function refusedError(r: HelloRefusal | null): Error {
  const field = r?.field ? ` {field: ${r.field}}` : "";
  return new Error(`sync hello refused: ${r?.code ?? "invalid"}${field}: ${r?.message ?? ""}`);
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}
