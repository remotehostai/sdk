// Optimistic writes (app backends design 4.3; sync design 3.11): the store
// keeps confirmed rows by `rev`, and the overlay applies the outbox's
// predicted effects on top. A read is confirmed rows plus the overlay; the
// overlay is recomputed from the remaining outbox whenever confirmed rows or
// the outbox change, so a refused op's effect disappears.

import type { RecordOp } from "./generated/protocol.js";
import type { OutboxEntry, StoredRow } from "./types.js";
import {
  planRecord,
  type Answer,
  type Declaration,
  type RecordImage,
  type RecordStore,
} from "./validate.js";
import { predictIssues } from "./predict/issues.js";

/** One predicted row: an image, or `null` for a delete. */
export interface Effect {
  entity: string;
  id: string;
  row: Record<string, unknown> | null;
}

export interface ViewReader {
  get(entity: string, id: string): Record<string, unknown> | undefined;
  rows(entity: string): Iterable<[string, Record<string, unknown>]>;
}

/** The wire entity of a backend's type: a native backend's own name, else `"<backend>.<type>"`. */
export function entityOf(
  backend: string,
  type: string,
  declarations?: Record<string, Declaration>,
): string {
  const native = backend === "issues" || declarations?.[backend]?.kind === "native";
  return native ? type : `${backend}.${type}`;
}

/** A row's key as the store keeps it: a link row's two ids joined by `/`. */
export function keyOf(id: string | [string, string]): string {
  return Array.isArray(id) ? id.join("/") : id;
}

const KEY = (entity: string, id: string) => `${entity}\u0000${id}`;

export class Overlay {
  /** Confirmed rows, mirrored from the store. */
  readonly confirmed = new Map<string, Map<string, StoredRow>>();
  /** entity -> id -> predicted image or `null` (deleted). */
  private predicted = new Map<string, Map<string, Record<string, unknown> | null>>();

  constructor(
    private readonly declarations: Record<string, Declaration> | undefined,
    private readonly subject: () => string | null,
  ) {}

  load(rows: Iterable<StoredRow>): void {
    this.confirmed.clear();
    for (const r of rows) this.setConfirmed(r);
  }

  setConfirmed(r: StoredRow): void {
    let m = this.confirmed.get(r.entity);
    if (!m) this.confirmed.set(r.entity, (m = new Map()));
    m.set(r.id, r);
  }

  dropConfirmed(entity: string, id: string): void {
    this.confirmed.get(entity)?.delete(id);
  }

  confirmedRow(entity: string, id: string): Record<string, unknown> | undefined {
    return this.confirmed.get(entity)?.get(id)?.row ?? undefined;
  }

  /** Whether the overlay changes this row. */
  touches(entity: string, id: string): boolean {
    return this.predicted.get(entity)?.has(id) ?? false;
  }

  get(entity: string, id: string): Record<string, unknown> | undefined {
    const p = this.predicted.get(entity);
    if (p?.has(id)) return p.get(id) ?? undefined;
    return this.confirmedRow(entity, id);
  }

  *rows(entity: string): Iterable<[string, Record<string, unknown>]> {
    const p = this.predicted.get(entity);
    for (const [id, r] of this.confirmed.get(entity) ?? []) {
      if (p?.has(id)) continue;
      if (r.row) yield [id, r.row];
    }
    for (const [id, row] of p ?? []) if (row) yield [id, row];
  }

  /** Every (entity, id) the overlay touches now. */
  keys(): Set<string> {
    const out = new Set<string>();
    for (const [e, m] of this.predicted) for (const id of m.keys()) out.add(KEY(e, id));
    return out;
  }

  /** Recomputes the overlay from `outbox`; returns the keys touched before or after. */
  recompute(outbox: OutboxEntry[]): Set<string> {
    const before = this.keys();
    this.predicted = new Map();
    for (const e of outbox) {
      for (const effect of this.predict(
        JSON.parse(e.op) as Record<string, unknown>,
        e.enqueuedAt,
      )) {
        let m = this.predicted.get(effect.entity);
        if (!m) this.predicted.set(effect.entity, (m = new Map()));
        m.set(effect.id, effect.row);
      }
    }
    for (const k of this.keys()) before.add(k);
    return before;
  }

  predict(op: Record<string, unknown>, at: string): Effect[] {
    switch (op.op) {
      case "put_record":
      case "update_record":
      case "delete_record":
        return this.predictRecord(op as unknown as RecordOp);
      default:
        return predictIssues(op, this, at, this.subject());
    }
  }

  private predictRecord(op: RecordOp): Effect[] {
    const entity = (type: string) => entityOf(op.backend, type, this.declarations);
    if (this.declarations?.[op.backend]) {
      const planned = planRecord(op, this.declarations, this.recordStore(op.backend));
      if (!planned.ok) return [];
      return [
        ...planned.effects.puts.map(([type, image]) => ({
          entity: entity(type),
          id: String(image.id),
          row: image,
        })),
        ...planned.effects.deletes.map(([type, id]) => ({ entity: entity(type), id, row: null })),
      ];
    }
    const e = entity(op.type);
    switch (op.op) {
      case "put_record":
        return [{ entity: e, id: op.id, row: { ...op.fields, id: op.id } }];
      case "update_record": {
        const row = this.get(e, op.id);
        return row ? [{ entity: e, id: op.id, row: { ...row, ...op.set } }] : [];
      }
      case "delete_record":
        return [{ entity: e, id: op.id, row: null }];
    }
  }

  /** The validator's view of one backend: what this client holds, read as complete. */
  recordStore(backend: string): RecordStore {
    const entity = (type: string) => entityOf(backend, type, this.declarations);
    const live = (type: string) => Array.from(this.rows(entity(type)), ([, r]) => r as RecordImage);
    return {
      get: (type, id): Answer<RecordImage | null> => {
        const row = this.get(entity(type), id);
        if (row) return { found: row as RecordImage };
        return this.confirmed.get(entity(type))?.has(id) ? "absent" : { found: null };
      },
      find: (type, field, value) => ({
        found: live(type).filter((r) => JSON.stringify(r[field]) === JSON.stringify(value)),
      }),
      referrers: (type, field, id, limit) => ({
        found: live(type)
          .filter((r) => r[field] === id)
          .slice(0, limit)
          .map((r) => String(r.id)),
      }),
    };
  }
}

export function splitKey(key: string): [string, string] {
  const i = key.indexOf("\u0000");
  return [key.slice(0, i), key.slice(i + 1)];
}

export { KEY as overlayKey };
