// The declared-record validator (app backends design 2.2, 2.3): a port of
// atlas-core's `records::plan_record`, held to the same cases
// (`apps/atlas/backends/cases/records.json`). The order of the checks is the
// contract's: the first that fails is the refusal.

import type { RecordOp, RefusalCode } from "./generated/protocol.js";

export type FieldType =
  | { type: "text"; max?: number }
  | { type: "long_text"; max?: number }
  | { type: "int" }
  | { type: "real" }
  | { type: "bool" }
  | { type: "date" }
  | { type: "time" }
  | { type: "enum"; values: string[] }
  | { type: "uuid" }
  | { type: "ref"; to: string; on_delete: "cascade" | "set_null" | "restrict" }
  | { type: "sort_key" }
  | { type: "json"; max_bytes?: number }
  | { type: "blob"; max_bytes: number }
  | { type: "actor" };

export type FieldDecl = FieldType & { required?: boolean; default?: unknown; unique?: boolean };

export interface TypeDecl {
  fields: Record<string, FieldDecl>;
  unique?: string[];
  index?: string[][];
}

export interface Declaration {
  backend: string;
  version: number;
  kind: "native" | "declared" | "adapter";
  title?: string;
  permissions?: { read: string; write: string };
  types: Record<string, TypeDecl>;
  ops?: Array<{ name: string; schema: unknown }>;
  [extra: string]: unknown;
}

export type RecordImage = Record<string, unknown>;

/** A store's answer: found (a live image, or none ever), absent (deleted), or unknown (a partial store). */
export type Answer<T> = { found: T } | "absent" | "unknown";

export interface RecordStore {
  get(type: string, id: string): Answer<RecordImage | null>;
  find(type: string, field: string, value: unknown): Answer<RecordImage[]>;
  referrers(type: string, field: string, id: string, limit: number): Answer<string[]>;
}

export type Deferred =
  | { check: "row"; type: string; id: string }
  | { check: "unique"; type: string; field: string }
  | { check: "referrers"; type: string; field: string; id: string };

export interface RecordEffects {
  puts: Array<[string, RecordImage]>;
  deletes: Array<[string, string]>;
  deferred?: Deferred[];
}

export interface Refusal {
  code: RefusalCode;
  reason?: string;
  field?: string;
  message: string;
  current?: unknown;
}

export type Planned = { ok: true; effects: RecordEffects } | { ok: false; refusal: Refusal };

export const CASCADE_MAX = 1000;
const FRAME_BYTES = 1 << 20;
export const MAX_ROW_BYTES = FRAME_BYTES - 1024;
const TIMES_BYTES =
  ',"created_at":"0000-00-00T00:00:00.000Z","updated_at":"0000-00-00T00:00:00.000Z","deleted_at":"0000-00-00T00:00:00.000Z"'
    .length;
const RESERVED_NAMES = [
  "id",
  "org_id",
  "workspace_id",
  "rev",
  "created_at",
  "updated_at",
  "deleted_at",
];
const MAX_TEXT = 8192;
const INT_MAX = 2n ** 63n - 1n;
const INT_MIN = -(2n ** 63n);

class Refused extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message);
  }
}

function invalid(field: string | undefined, reason: string | undefined, message: string): Refused {
  return new Refused({
    code: "invalid",
    ...(reason ? { reason } : {}),
    ...(field ? { field } : {}),
    message,
  });
}

function notFound(field: string, message: string): Refused {
  return new Refused({ code: "not_found", field, message });
}

/** A backend's declarations by name: what `planRecord` reads. */
export type Registry = Record<string, Declaration>;

/** The effects of a record op against `store`, or why it is refused. Writes nothing. */
export function planRecord(op: RecordOp, registry: Registry, store: RecordStore): Planned {
  try {
    const decl = registry[op.backend];
    if (!decl)
      throw invalid("backend", "unknown_backend", `no backend is declared as \`${op.backend}\``);
    if (decl.kind === "native")
      throw invalid("backend", "unknown_backend", `${op.backend} is written through its own ops`);
    const ty = Object.hasOwn(decl.types, op.type) ? decl.types[op.type] : undefined;
    if (!ty) throw invalid("type", "unknown_type", `${op.backend} declares no type \`${op.type}\``);
    if (!isRowId(op.id))
      throw invalid("id", undefined, "a record's id is a UUIDv7 (or v4), lowercase and hyphenated");
    const p = new Planner(decl, `${op.backend}.${op.type}`, ty, op.id, store);
    if (op.op === "put_record") p.put(op.fields);
    else if (op.op === "update_record") p.update(op.set, op.expect);
    else p.delete();
    return { ok: true, effects: p.effects };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, refusal: e.refusal };
    throw e;
  }
}

function isUnique(ty: TypeDecl, field: string): boolean {
  return Boolean(ty.fields[field]?.unique) || (ty.unique ?? []).includes(field);
}

/** Every (type, field, on_delete) that refers to `type`, types and fields in name order. */
function referring(
  decl: Declaration,
  type: string,
): Array<[string, string, "cascade" | "set_null" | "restrict"]> {
  const out: Array<[string, string, "cascade" | "set_null" | "restrict"]> = [];
  for (const tname of Object.keys(decl.types).sort()) {
    const t = decl.types[tname]!;
    for (const fname of Object.keys(t.fields).sort()) {
      const f = t.fields[fname]!;
      if (f.type === "ref" && f.to === type) out.push([tname, fname, f.on_delete]);
    }
  }
  return out;
}

function sortedEntries(map: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

class Planner {
  readonly effects: RecordEffects = { puts: [], deletes: [] };

  constructor(
    readonly decl: Declaration,
    readonly t: string,
    readonly ty: TypeDecl,
    readonly id: string,
    readonly store: RecordStore,
  ) {}

  private defer(d: Deferred): void {
    (this.effects.deferred ??= []).push(d);
  }

  put(fields: Record<string, unknown>): void {
    this.given(fields);
    const image: RecordImage = { id: this.id };
    for (const [name, field] of Object.entries(this.ty.fields)) {
      const given = fields[name];
      const value =
        given !== undefined && given !== null
          ? given
          : field.default !== undefined
            ? field.default
            : null;
      if (value === null && field.required && field.type !== "actor")
        throw invalid(name, undefined, `${name} is required`);
      image[name] = value;
    }
    const current = this.store.get(this.t, this.id);
    if (current === "absent")
      throw invalid(
        "id",
        undefined,
        `the ${this.t} with id ${this.id} was deleted: an id is never taken again`,
      );
    if (current === "unknown") this.defer({ check: "row", type: this.t, id: this.id });
    else if (current.found) {
      const row = current.found;
      const unchanged = Object.entries(image).every(
        ([k, v]) => this.ty.fields[k]?.type === "actor" || same(row[k] ?? null, v),
      );
      if (unchanged) return;
      throw invalid("id", undefined, `a ${this.t} with id ${this.id} exists with other content`);
    }
    const names = Object.keys(this.ty.fields);
    for (const name of names) this.unique(name, image[name]);
    for (const name of names) this.reference(name, image[name]);
    this.size(image);
    this.effects.puts.push([this.t, image]);
  }

  update(set: Record<string, unknown>, expect: Record<string, unknown> | undefined): void {
    if (Object.keys(set).length === 0)
      throw invalid("set", undefined, "an update sets at least one field");
    this.given(set);
    for (const [name, value] of sortedEntries(set)) {
      if (value === null && this.ty.fields[name]!.required)
        throw invalid(name, undefined, `${name} is required: it cannot be cleared`);
    }
    if (expect) {
      for (const [name] of sortedEntries(expect)) {
        if (!Object.hasOwn(this.ty.fields, name))
          throw invalid(name, "unknown_field", `${this.t} declares no field \`${name}\``);
      }
    }
    const answer = this.store.get(this.t, this.id);
    let current: RecordImage | null = null;
    if (answer === "unknown") this.defer({ check: "row", type: this.t, id: this.id });
    else if (answer === "absent" || !answer.found)
      throw notFound("id", `no ${this.t} has id ${this.id}`);
    else current = answer.found;
    if (current && expect) {
      const held = (name: string) => (current[name] === undefined ? null : current[name]);
      if (Object.entries(expect).some(([name, want]) => !same(held(name), want))) {
        const now: Record<string, unknown> = {};
        for (const [name] of sortedEntries(expect)) now[name] = held(name);
        throw new Refused({
          code: "precondition_failed",
          message: `the ${this.t} changed since: its expected fields differ`,
          current: now,
        });
      }
    }
    for (const [name, value] of sortedEntries(set)) {
      const unchanged = current !== null && same(current[name] ?? null, value);
      if (!unchanged) this.unique(name, value);
    }
    for (const [name, value] of sortedEntries(set)) this.reference(name, value);
    if (!current) return;
    const image: RecordImage = { id: this.id };
    for (const name of Object.keys(this.ty.fields)) {
      const v = Object.hasOwn(set, name) ? set[name] : current[name];
      image[name] = v === undefined ? null : v;
    }
    this.size(image);
    this.effects.puts.push([this.t, image]);
  }

  delete(): void {
    const answer = this.store.get(this.t, this.id);
    if (answer === "absent" || (answer !== "unknown" && !answer.found))
      throw notFound("id", `no ${this.t} has id ${this.id}`);
    if (answer === "unknown") this.defer({ check: "row", type: this.t, id: this.id });
    const key = (t: string, id: string) => `${t}\u0000${id}`;
    const deleted = new Set([key(this.t, this.id)]);
    const deletes: Array<[string, string]> = [[this.t, this.id]];
    const cleared = new Map<string, [string, RecordImage]>();
    const restricted: Array<[string, string, string]> = [];
    const queue: Array<[string, string]> = [[this.t, this.id]];
    const backend = this.decl.backend;
    while (queue.length) {
      const [at, atId] = queue.shift()!;
      const atType = at.slice(backend.length + 1);
      for (const [rtName, field, onDelete] of referring(this.decl, atType)) {
        const rt = `${backend}.${rtName}`;
        const found = this.store.referrers(rt, field, atId, CASCADE_MAX + 1);
        if (found === "absent") continue;
        if (found === "unknown") {
          this.defer({ check: "referrers", type: rt, field, id: atId });
          continue;
        }
        for (const r of [...found.found].sort()) {
          const k = key(rt, r);
          if (onDelete === "restrict") restricted.push([rt, field, r]);
          else if (onDelete === "cascade") {
            if (!deleted.has(k)) {
              deleted.add(k);
              deletes.push([rt, r]);
              queue.push([rt, r]);
            }
          } else {
            const held = cleared.get(k);
            if (held) held[1][field] = null;
            else {
              const row = this.store.get(rt, r);
              if (row === "unknown") this.defer({ check: "row", type: rt, id: r });
              else if (row !== "absent" && row.found) {
                const image = declared(this.decl.types[rtName]!, row.found);
                image[field] = null;
                cleared.set(k, [rt, image]);
              }
            }
          }
          const reached =
            deletes.length - 1 + [...cleared.keys()].filter((c) => !deleted.has(c)).length;
          if (reached > CASCADE_MAX)
            throw invalid(
              undefined,
              "cascade_too_large",
              `the delete would reach more than ${CASCADE_MAX} other records`,
            );
        }
      }
    }
    const blocking = restricted.find(([rt, , r]) => !deleted.has(key(rt, r)));
    if (blocking)
      throw invalid(
        blocking[1],
        "restricted",
        `a ${blocking[0]} still refers to it through ${blocking[1]}`,
      );
    this.effects.deletes = deletes;
    this.effects.puts = [...cleared.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .filter(([k]) => !deleted.has(k))
      .map(([, v]) => v);
  }

  private given(fields: Record<string, unknown>): void {
    for (const [name, value] of sortedEntries(fields)) {
      if (RESERVED_NAMES.includes(name) || name.startsWith("_"))
        throw invalid(name, undefined, `${name} is the store's: a client never writes it`);
      const field = Object.hasOwn(this.ty.fields, name) ? this.ty.fields[name] : undefined;
      if (!field) throw invalid(name, "unknown_field", `${this.t} declares no field \`${name}\``);
      if (field.type === "actor")
        throw invalid(name, undefined, `${name} names who acted, which the server fills`);
      if (value !== null && value !== undefined) checkValue(name, field, value);
    }
  }

  private unique(name: string, value: unknown): void {
    if (value === null || value === undefined || !isUnique(this.ty, name)) return;
    const found = this.store.find(this.t, name, value);
    if (found === "absent") return;
    if (found === "unknown") {
      this.defer({ check: "unique", type: this.t, field: name });
      return;
    }
    if (found.found.some((r) => r.id !== this.id))
      throw invalid(name, undefined, `another ${this.t} has this ${name}`);
  }

  private reference(name: string, value: unknown): void {
    const field = this.ty.fields[name]!;
    if (field.type !== "ref" || typeof value !== "string") return;
    const rt = `${this.decl.backend}.${field.to}`;
    const answer = this.store.get(rt, value);
    if (answer === "unknown") this.defer({ check: "row", type: rt, id: value });
    else if (answer === "absent" || !answer.found) throw notFound(name, `no ${rt} has id ${value}`);
  }

  private size(image: RecordImage): void {
    const bytes = jsonBytes(image) + TIMES_BYTES;
    if (bytes <= MAX_ROW_BYTES) return;
    let largest: string | undefined;
    let most = -1;
    for (const [k, v] of Object.entries(image)) {
      const n = jsonBytes(v);
      if (n >= most) {
        most = n;
        largest = k;
      }
    }
    throw invalid(
      largest,
      "too_large",
      `the record would be ${bytes} bytes, over ${MAX_ROW_BYTES}`,
    );
  }
}

function declared(ty: TypeDecl, row: RecordImage): RecordImage {
  const image: RecordImage = { id: row.id ?? null };
  for (const name of Object.keys(ty.fields))
    image[name] = row[name] === undefined ? null : row[name];
  return image;
}

/** JSON text, with a bigint as its digits. */
export function encodeJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v !== "bigint") return v;
    const raw = (JSON as unknown as { rawJSON?: (s: string) => unknown }).rawJSON;
    if (raw) return raw(v.toString());
    if (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER))
      return Number(v);
    throw new TypeError(
      "this runtime cannot encode an integer past 2^53 exactly (JSON.rawJSON is missing)",
    );
  });
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(encodeJson(value)).length;
}

/** Whether two JSON values are the same value: numbers by value, objects whatever their key order. */
export function same(a: unknown, b: unknown): boolean {
  if (
    (typeof a === "number" || typeof a === "bigint") &&
    (typeof b === "number" || typeof b === "bigint")
  ) {
    if (typeof a === "bigint" || typeof b === "bigint") {
      try {
        return BigInt(a) === BigInt(b);
      } catch {
        return Number(a) === Number(b);
      }
    }
    return a === b;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => same(x, b[i]))
    );
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = b as Record<string, unknown>;
    return (
      ka.length === Object.keys(b).length &&
      ka.every((k) => Object.hasOwn(kb, k) && same((a as Record<string, unknown>)[k], kb[k]))
    );
  }
  return a === b;
}

/** Whether `value` (not null) is one of `field`'s type (design 2.2). */
export function checkValue(name: string, field: FieldDecl, value: unknown): void {
  const bad = (what: string) => {
    throw invalid(name, undefined, `${name} must be ${what}`);
  };
  switch (field.type) {
    case "text":
    case "long_text": {
      const max = field.max ?? MAX_TEXT;
      if (typeof value !== "string") return bad("text");
      if ([...value].length > max) return bad(`at most ${max} characters`);
      return;
    }
    case "int": {
      if (typeof value === "bigint") {
        if (value < INT_MIN || value > INT_MAX) bad("an integer from -2^63 to 2^63-1");
        return;
      }
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < -(2 ** 63) ||
        value >= 2 ** 63
      )
        bad("an integer from -2^63 to 2^63-1");
      return;
    }
    case "real":
      if (typeof value !== "number" && typeof value !== "bigint") bad("a number");
      return;
    case "bool":
      if (typeof value !== "boolean") bad("true or false");
      return;
    case "date":
      if (typeof value !== "string" || !isDate(value)) bad("a date, YYYY-MM-DD");
      return;
    case "time":
      if (typeof value !== "string" || !isTime(value))
        bad("an instant in UTC with milliseconds, YYYY-MM-DDTHH:MM:SS.sssZ");
      return;
    case "enum":
      if (typeof value !== "string" || !field.values.includes(value))
        bad(`one of: ${field.values.join(", ")}`);
      return;
    case "uuid":
    case "ref":
      if (typeof value !== "string" || !isUuid(value)) bad("a UUID, lowercase and hyphenated");
      return;
    case "sort_key": {
      const ok =
        typeof value === "string" &&
        value.length >= 1 &&
        value.length <= 255 &&
        /^[\x21-\x7e]+$/.test(value);
      if (!ok) bad("a sort key: 1 to 255 printable ASCII characters, no spaces");
      return;
    }
    case "json": {
      const max = field.max_bytes ?? 65536;
      if (jsonBytes(value) > max) bad(`JSON of at most ${max} bytes`);
      return;
    }
    case "blob":
      return checkBlob(name, field.max_bytes, value);
    case "actor":
      throw invalid(name, undefined, `${name} names who acted, which the server fills`);
  }
}

function checkBlob(name: string, maxBytes: number, value: unknown): void {
  const bad = () =>
    invalid(
      name,
      undefined,
      `${name} must be {sha256, size, content_type}: the object's hash, length and type`,
    );
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad();
  const map = value as Record<string, unknown>;
  if (Object.keys(map).length !== 3) throw bad();
  const hash = map.sha256;
  const hashOk = typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash);
  const ct = map.content_type;
  const typeOk =
    typeof ct === "string" &&
    ct.length >= 3 &&
    ct.length <= 255 &&
    /^[\x20-\x7e]+$/.test(ct) &&
    ct.trim() === ct &&
    (() => {
      const media = ct.split(";")[0]!;
      const slash = media.indexOf("/");
      if (slash < 0) return false;
      const a = media.slice(0, slash);
      const b = media.slice(slash + 1);
      return a.length > 0 && b.trim().length > 0 && !a.includes(" ");
    })();
  const size = map.size;
  const sizeOk =
    (typeof size === "number" && Number.isInteger(size) && size >= 0) ||
    (typeof size === "bigint" && size >= 0n);
  if (!sizeOk) throw bad();
  if (!hashOk || !typeOk) throw bad();
  if (BigInt(size as number | bigint) > BigInt(maxBytes)) {
    throw invalid(name, "blob_too_large", `${name} is ${String(size)} bytes, over its ${maxBytes}`);
  }
}

/** A canonical UUID: lowercase hex, hyphens at 8, 13, 18, 23. */
export function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
}

/** A row id: a canonical UUIDv4 or v7 (atlas-core `ids::is_row_id`). */
export function isRowId(s: string): boolean {
  return isUuid(s) && (s[14] === "4" || s[14] === "7") && "89ab".includes(s[19]!);
}

function isDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  const days = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  return d <= days;
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function isTime(s: string): boolean {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}Z$/.exec(s);
  if (!m || !isDate(m[1]!)) return false;
  return Number(m[2]) <= 23 && Number(m[3]) <= 59 && Number(m[4]) <= 60;
}

/** A `RecordStore` over images by type: live rows, deleted ones (`deleted_at` set), and, if partial, nothing else known. */
export function memoryRecords(
  rows: Iterable<[string, RecordImage]>,
  partial: boolean,
): RecordStore {
  const byType = new Map<string, Map<string, RecordImage>>();
  for (const [t, image] of rows) {
    let m = byType.get(t);
    if (!m) byType.set(t, (m = new Map()));
    m.set(String(image.id), image);
  }
  const live = (image: RecordImage) => image.deleted_at === undefined || image.deleted_at === null;
  const liveOf = (t: string) => [...(byType.get(t)?.values() ?? [])].filter(live);
  return {
    get(t, id) {
      const image = byType.get(t)?.get(id);
      if (image) return live(image) ? { found: image } : "absent";
      return partial ? "unknown" : { found: null };
    },
    find(t, field, value) {
      if (partial) return "unknown";
      return { found: liveOf(t).filter((r) => r[field] !== undefined && same(r[field], value)) };
    },
    referrers(t, field, id, limit) {
      if (partial) return "unknown";
      return {
        found: liveOf(t)
          .filter((r) => r[field] === id)
          .map((r) => String(r.id))
          .slice(0, limit),
      };
    },
  };
}
