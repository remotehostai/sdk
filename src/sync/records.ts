// `RecordSet`: one backend type's rows, confirmed rows with the overlay
// applied, exactly as the service sends them (atlas-core's names; a row
// without an `id` field, a link row, carries its store key as `id`).

import type { RecordChange, RecordSet } from "./types.js";
import type { Overlay } from "./overlay.js";

type Listener = (change: RecordChange<unknown>) => void;

export class Subscriptions {
  private byEntity = new Map<string, Set<Listener>>();

  add(entity: string, listener: Listener): () => void {
    let s = this.byEntity.get(entity);
    if (!s) this.byEntity.set(entity, (s = new Set()));
    s.add(listener);
    return () => s!.delete(listener);
  }

  /** Tells each subscriber of `entity` what the row now reads as. */
  emit(entity: string, id: string, overlay: Overlay): void {
    const s = this.byEntity.get(entity);
    if (!s?.size) return;
    const row = overlay.get(entity, id);
    const confirmed = !overlay.touches(entity, id);
    const change: RecordChange<unknown> = row
      ? { kind: "upsert", row: withId(id, row), confirmed }
      : { kind: "delete", id, confirmed };
    for (const l of s) l(change);
  }
}

function withId(id: string, row: Record<string, unknown>): Record<string, unknown> {
  return "id" in row ? row : { id, ...row };
}

export function recordSet<T>(entity: string, overlay: Overlay, subs: Subscriptions): RecordSet<T> {
  return {
    get(id) {
      const row = overlay.get(entity, id);
      return row ? (withId(id, row) as T) : undefined;
    },
    all(filter) {
      const out: T[] = [];
      for (const [id, row] of overlay.rows(entity)) {
        const r = withId(id, row) as T;
        if (!filter || filter(r)) out.push(r);
      }
      return out;
    },
    subscribe(listener) {
      return subs.add(entity, listener as Listener);
    },
  };
}
