// Catch-up and live changes (sync design 3.5, 3.8; app backends design 3.6,
// 3.7, 4.4): rows by `rev` only when newer, tombstones, `rows_end` setting
// the shard's cursor, `change` frames in order per shard (a gap asks
// `resume`), `reset` dropping a group, `groups` add/update/remove (a split's
// `update` maps the cursor before any new-layout frame), and the opaque
// per-workspace cursor (the workspace's change number).

import type {
  ChangedRow,
  Cursors,
  GroupLayout,
  GroupUpdate,
  RowImage,
  Tombstone,
} from "./generated/protocol.js";
import { META } from "./device.js";
import { keyOf, overlayKey, type Overlay } from "./overlay.js";
import { base64url } from "./ids.js";
import type { StoreTx } from "./types.js";

export const shardKey = (group: string, shard: number) => `${group}/${shard}`;

export function readCursors(tx: StoreTx): Cursors {
  return (tx.getMeta(META.cursors) as Cursors | undefined) ?? { layout: {}, seqs: {} };
}

export function readGroups(tx: StoreTx): GroupLayout[] {
  return (tx.getMeta(META.groups) as GroupLayout[] | undefined) ?? [];
}

/** The cursor `hello` sends: `null` before anything was caught up. */
export function helloCursors(tx: StoreTx): Cursors | null {
  const c = readCursors(tx);
  return Object.keys(c.layout).length || Object.keys(c.seqs).length ? c : null;
}

/** The opaque cursor applications may store: base64url of the cursors' JSON. */
export function encodeCursor(c: Cursors): string {
  return base64url(new TextEncoder().encode(JSON.stringify(c)));
}

/** Writes one row if it is newer than what the store holds; returns whether it did. */
export function applyRow(
  tx: StoreTx,
  overlay: Overlay,
  group: string,
  shard: number,
  r: RowImage | ChangedRow | Tombstone,
  touched: Set<string>,
): boolean {
  const id = keyOf(r.id);
  const held = tx.getRow(r.entity, id);
  if (held && held.rev >= r.rev) return false;
  const image = "row" in r ? r.row : null;
  const state = "state" in r ? r.state : undefined;
  if (image && (state === undefined || state === "live")) {
    const row = { entity: r.entity, id, rev: r.rev, row: image, group, shard };
    tx.putRow(row);
    overlay.setConfirmed(row);
  } else {
    tx.deleteRow(r.entity, id, r.rev, state === "moved_out" ? "moved_out" : "deleted");
    overlay.setConfirmed({ entity: r.entity, id, rev: r.rev, row: null, group, shard });
  }
  touched.add(overlayKey(r.entity, id));
  return true;
}

/** Drops a group's rows (or every group's) and their cursors. */
export function dropGroup(
  tx: StoreTx,
  overlay: Overlay,
  group: string | null,
  touched: Set<string>,
): void {
  for (const r of Array.from(tx.allRows())) {
    if (group === null || r.group === group) {
      overlay.dropConfirmed(r.entity, r.id);
      touched.add(overlayKey(r.entity, r.id));
    }
  }
  tx.dropGroup(group);
  const c = readCursors(tx);
  if (group === null) {
    tx.setMeta(META.cursors, { layout: {}, seqs: {} });
    return;
  }
  delete c.layout[group];
  for (const k of Object.keys(c.seqs)) if (k.startsWith(`${group}/`)) delete c.seqs[k];
  tx.setMeta(META.cursors, c);
}

export function setSeq(
  tx: StoreTx,
  group: string,
  shard: number,
  layoutVersion: number,
  seq: number,
): void {
  const c = readCursors(tx);
  c.layout[group] = layoutVersion;
  c.seqs[shardKey(group, shard)] = seq;
  tx.setMeta(META.cursors, c);
}

export function seqOf(tx: StoreTx, group: string, shard: number): number {
  return readCursors(tx).seqs[shardKey(group, shard)] ?? 0;
}

/**
 * The layouts a welcome names. Groups the client held but no longer asks
 * for (or no longer reads) are dropped with their rows.
 */
export function takeLayouts(
  tx: StoreTx,
  overlay: Overlay,
  groups: GroupLayout[],
  touched: Set<string>,
): void {
  const keep = new Set(groups.map((g) => g.id));
  for (const g of readGroups(tx)) if (!keep.has(g.id)) dropGroup(tx, overlay, g.id, touched);
  const c = readCursors(tx);
  for (const k of Object.keys(c.layout)) if (!keep.has(k)) dropGroup(tx, overlay, k, touched);
  for (const g of groups) mapLayout(tx, g.id, g.layout_version, g.base_seqs);
  tx.setMeta(META.groups, groups);
}

/** A split or merge's cursor mapping: the new layout's shards start at their base seqs. */
function mapLayout(
  tx: StoreTx,
  group: string,
  layoutVersion: number,
  baseSeqs: Record<string, number> | undefined,
): void {
  const c = readCursors(tx);
  const known = c.layout[group];
  if (known === undefined || known >= layoutVersion || !baseSeqs) return;
  for (const k of Object.keys(c.seqs)) if (k.startsWith(`${group}/`)) delete c.seqs[k];
  for (const [shard, seq] of Object.entries(baseSeqs)) c.seqs[shardKey(group, Number(shard))] = seq;
  c.layout[group] = layoutVersion;
  tx.setMeta(META.cursors, c);
}

/** A `groups` frame. Returns the groups added (to be caught up). */
export function applyGroups(
  tx: StoreTx,
  overlay: Overlay,
  f: { add?: GroupLayout[]; update?: GroupUpdate[]; remove?: string[] },
  touched: Set<string>,
): GroupLayout[] {
  let groups = readGroups(tx);
  for (const id of f.remove ?? []) {
    dropGroup(tx, overlay, id, touched);
    groups = groups.filter((g) => g.id !== id);
  }
  for (const u of f.update ?? []) {
    mapLayout(tx, u.id, u.layout_version, u.base_seqs);
    groups = groups.map((g) =>
      g.id === u.id
        ? { ...g, shards: u.shards, layout_version: u.layout_version, base_seqs: u.base_seqs }
        : g,
    );
  }
  const added = f.add ?? [];
  for (const g of added) groups = [...groups.filter((x) => x.id !== g.id), g];
  tx.setMeta(META.groups, groups);
  return added;
}

/** The layout version a frame must carry to be applied: older is stale, newer means a missed `groups.update`. */
export function layoutCheck(
  tx: StoreTx,
  group: string,
  layoutVersion: number,
): "ok" | "stale" | "ahead" {
  const g = readGroups(tx).find((x) => x.id === group);
  if (!g) return "stale";
  if (layoutVersion < g.layout_version) return "stale";
  if (layoutVersion > g.layout_version) return "ahead";
  return "ok";
}
