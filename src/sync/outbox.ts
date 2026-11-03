// The outbox (sync design 3.2, 3.4; app backends design 4.3): gap-free
// `device_seq`, an `entry_nonce` per op, the op's bytes kept as first
// encoded and sent verbatim, a window of 256 ops in flight, pushes split by
// `max_frame_bytes` (never through a batch), resend from the first
// unacknowledged, and the server's timing for rejections.

import { OP_VERSION, type Op, type RejectionCode } from "./generated/protocol.js";
import { randomToken } from "./ids.js";
import type { OutboxEntry, StoreTx } from "./types.js";
import { META } from "./device.js";

/** Ops in flight at once. */
export const WINDOW = 256;
/** The frame cap when the welcome names none. */
export const DEFAULT_MAX_FRAME_BYTES = 1 << 20;

/** Appends ops to the outbox, numbered from the store's next device seq. */
export function enqueue(
  tx: StoreTx,
  ops: Op[],
  batch: string | undefined,
  now: Date,
): OutboxEntry[] {
  let seq = Number(tx.getMeta(META.nextDeviceSeq) ?? 1);
  const out: OutboxEntry[] = [];
  for (const op of ops) {
    const entry: OutboxEntry = {
      deviceSeq: seq++,
      entryNonce: randomToken(),
      op: JSON.stringify(op),
      enqueuedAt: now.toISOString(),
      ...(batch ? { batch } : {}),
    };
    tx.enqueue(entry);
    out.push(entry);
  }
  tx.setMeta(META.nextDeviceSeq, seq);
  return out;
}

/** Everything below the first unsettled entry has a result the client holds. */
export function ackedUpto(tx: StoreTx): number {
  const first = tx.outbox()[0];
  if (first) return first.deviceSeq - 1;
  return Number(tx.getMeta(META.nextDeviceSeq) ?? 1) - 1;
}

/** One op as a push carries it, with its bytes spliced in verbatim. */
export function encodePushOp(e: OutboxEntry): string {
  const head = JSON.stringify({
    device_seq: e.deviceSeq,
    entry_nonce: e.entryNonce,
    op_version: OP_VERSION,
    ...(e.batch ? { batch: e.batch } : {}),
    at_client: e.enqueuedAt,
    origin: "app",
  });
  return `${head.slice(0, -1)},"op":${e.op}}`;
}

export interface PushHeader {
  workspace: string;
  epoch: number;
  outbox_epoch: number;
  acked_upto: number;
}

/**
 * The push frames for `entries` (those not yet in flight, in order), at most
 * `room` ops, each frame under `maxFrameBytes`. A batch is never split: it
 * goes whole or waits. Returns the frames' text (without the request id,
 * which `frame` adds) and the device seqs they carry.
 */
export function pushFrames(
  entries: OutboxEntry[],
  header: PushHeader,
  room: number,
  maxFrameBytes: number,
): Array<{ seqs: number[]; build: (id: number) => string }> {
  const groups: OutboxEntry[][] = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    if (e.batch && last && last[0]!.batch === e.batch) last.push(e);
    else groups.push([e]);
  }
  const frames: Array<{ seqs: number[]; build: (id: number) => string }> = [];
  const params = JSON.stringify(header);
  const overhead = params.length + 64;
  let ops: string[] = [];
  let seqs: number[] = [];
  let size = overhead;
  let budget = room;
  const flush = () => {
    if (!ops.length) return;
    const body = `${params.slice(0, -1)},"ops":[${ops.join(",")}]}`;
    frames.push({ seqs, build: (id) => `{"id":${id},"method":"push","params":${body}}` });
    ops = [];
    seqs = [];
    size = overhead;
  };
  for (const group of groups) {
    if (group.length > budget) break;
    const encoded = group.map(encodePushOp);
    const bytes = encoded.reduce((n, s) => n + new TextEncoder().encode(s).length + 1, 0);
    if (size + bytes > maxFrameBytes && ops.length) flush();
    ops.push(...encoded);
    seqs.push(...group.map((e) => e.deviceSeq));
    size += bytes;
    budget -= group.length;
  }
  flush();
  return frames;
}

/** How long to wait before resending after a rejection, with jitter; `null` when it is not a wait. */
export function rejectionDelay(
  code: RejectionCode,
  retryAfterMs: number | undefined,
  random: () => number,
): number | null {
  switch (code) {
    case "rate_limited":
    case "retry":
    case "window_full":
    case "paused": {
      const base = retryAfterMs ?? 1000;
      return Math.round(base * (1 + random() * 0.5));
    }
    default:
      return null;
  }
}
