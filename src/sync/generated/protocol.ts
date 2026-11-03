// Protocol v1's frames and ops (app backends design 3, sync design 3.5), as
// atlas-core's `sync::frames` and `ops::Op` encode them. The SDK is public,
// so it carries its own copy and imports nothing from
// @remotehost/sync-protocol. Until that package's schemas land (REM-5443)
// this file follows `apps/atlas/crates/atlas-core/src/sync/frames.rs` by
// hand; REM-5443's schemas then generate it, and a currency test compares
// the two. Fields are only ever added within protocol 1: a client ignores
// what it does not know.

import type { IssuesOp } from "./issues.js";

export const PROTOCOL = 1;
/** atlas-core's `OP_VERSION`: every op this client pushes is encoded at it. */
export const OP_VERSION = 4;

export type Id = string;
export type GroupId = string;
/** A row's key: its id, or a link row's two ids. */
export type Key = string | [string, string];

export interface OpVersions {
  min: number;
  max: number;
}

export interface PublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

export type Origin = "app" | "window" | "cli_owner" | "local_agent";
export type GroupKind = "workspace" | "team" | "user" | "backend";
export type DeviceKind = "replica" | "ephemeral";

// ---- Ops -----------------------------------------------------------------

export interface PutRecord {
  op: "put_record";
  backend: string;
  type: string;
  id: Id;
  fields: Record<string, unknown>;
}

export interface UpdateRecord {
  op: "update_record";
  backend: string;
  type: string;
  id: Id;
  set: Record<string, unknown>;
  expect?: Record<string, unknown>;
}

export interface DeleteRecord {
  op: "delete_record";
  backend: string;
  type: string;
  id: Id;
}

export type RecordOp = PutRecord | UpdateRecord | DeleteRecord;

/** A blob field's value: content-addressed, never a storage key. */
export interface BlobRef {
  sha256: string;
  size: number;
  content_type: string;
}
export type Op = RecordOp | IssuesOp;

// ---- Client to server ----------------------------------------------------

export interface Cursors {
  layout: Record<GroupId, number>;
  seqs: Record<string, number>;
}

export interface PresentedDevice {
  id: Id;
  secret: string;
  generation: number;
  proof: string;
}

export interface HelloWorkspace {
  workspace: Id;
  device: PresentedDevice | null;
  device_key?: PublicJwk;
  proof?: string;
  next_device_seq: number;
  acked_upto: number;
  cursors: Cursors | null;
  backends?: string[];
  scopes?: Array<{ kind: GroupKind; id: Id }>;
  device_kind?: DeviceKind;
}

export interface Hello {
  protocol: number;
  app_version: string;
  op_versions: OpVersions;
  schema_version: number;
  profile: "full";
  workspaces: HelloWorkspace[];
}

export interface Base {
  group: GroupId;
  shard: number;
  seq: number;
}

export interface PushOp {
  device_seq: number;
  entry_nonce: string;
  op_version: number;
  batch?: Id;
  base?: Base;
  at_client: string;
  origin: Origin;
  /** The op's bytes as first encoded; the client sends them verbatim. */
  op: unknown;
}

export interface Push {
  workspace: Id;
  epoch: number;
  outbox_epoch: number;
  acked_upto: number;
  ops: PushOp[];
}

export type ClientFrame =
  | { method: "hello"; params: Hello }
  | { method: "push"; params: Push }
  | { method: "ack"; params: { workspace: Id; acked_upto: number; generation?: number } }
  | {
      method: "device.results";
      params: { workspace: Id; device_id: Id; from_seq: number; upto: number };
    }
  | { method: "layout_req"; params: { workspace: Id; group: GroupId } }
  | { method: "resume"; params: { workspace: Id; group: GroupId; shard: number; from_seq: number } }
  | { method: "auth"; params: { token: string; dpop?: string } }
  | { method: "auth.refresh"; params: { token: string; dpop?: string } }
  | { method: "ping"; params: Record<string, never> };

// ---- Server to client ----------------------------------------------------

export interface GroupLayout {
  id: GroupId;
  kind: GroupKind;
  scope: { kind: GroupKind; id: Id };
  shards: number;
  layout_version: number;
  base_seqs?: Record<string, number>;
}

export interface GroupUpdate {
  id: GroupId;
  shards: number;
  layout_version: number;
  base_seqs: Record<string, number>;
}

export interface Welcome {
  protocol: number;
  workspace: Id;
  subject: Id;
  agent_session?: Id;
  device: { id: Id; secret: string; generation: number };
  device_epoch: number;
  outbox_epoch: number;
  last_device_seq: number;
  op_versions: OpVersions;
  mode: "catch_up" | "reset" | "update_required";
  cut: Record<string, number>;
  groups: GroupLayout[];
  min_app_version?: string;
  max_frame_bytes?: number;
  features?: string[];
}

export type EntryState = "live" | "deleted" | "moved_out";

/**
 * A row's fields as JSON values: a native entity's columns as its store
 * keeps them (flags 0 or 1), a declared record's fields as their types
 * say (a bool as a bool, a json field or a blob's descriptor as its
 * object or array; REM-5490).
 */
export interface RowImage {
  entity: string;
  id: Key;
  rev: number;
  row: Record<string, unknown>;
}

export interface Tombstone {
  entity: string;
  id: Key;
  rev: number;
  state: EntryState;
  moved_to?: GroupId;
}

export interface ChangedRow {
  entity: string;
  id: Key;
  rev: number;
  row: Record<string, unknown> | null;
  state?: EntryState;
  moved_to?: GroupId;
}

export type RefusalCode =
  "not_found" | "forbidden" | "invalid" | "text_conflict" | "precondition_failed" | "claimed";
export type RejectionCode =
  | "rate_limited"
  | "gap"
  | "window_full"
  | "superseded"
  | "device_conflict"
  | "update_required"
  | "retry"
  | "paused";

export const REFUSAL_CODES: readonly RefusalCode[] = [
  "not_found",
  "forbidden",
  "invalid",
  "text_conflict",
  "precondition_failed",
  "claimed",
];

export type OpResult =
  | { status: "applied"; device_seq: number; writes: Base[]; created?: unknown }
  | {
      status: "refused";
      device_seq: number;
      code: RefusalCode;
      reason?: string;
      message: string;
      current?: unknown;
      field?: string;
    }
  | {
      status: "rejected";
      device_seq: number;
      code: RejectionCode;
      retry_after_ms?: number;
      expected?: number;
    };

export interface DeviceResults {
  workspace: Id;
  device_id: Id;
  from_seq: number;
  upto: number;
  applied: Array<{ device_seq: number; op_hash: string }>;
  refused: Array<{
    device_seq: number;
    op_hash: string;
    code: RefusalCode;
    reason?: string;
    message: string;
  }>;
  next_from_seq: number | null;
}

/**
 * A workspace's `hello` refused for what it asks (REM-5490): `invalid`
 * with `field` `backends` (a backend the copy does not serve) or `scopes`
 * (a scope of another kind than `team`). Final for that hello.
 */
export interface HelloRefused {
  workspace: Id;
  code: RefusalCode;
  field?: string;
  message: string;
}

export type ServerFrame =
  | { event: "challenge"; nonce: string; subject?: Id; agent_session?: Id }
  | ({ event: "welcome" } & Welcome)
  | {
      event: "device_conflict";
      workspace: Id;
      device_id: Id;
      reason: "stale_secret" | "rollback" | "seq";
    }
  | {
      event: "rows";
      workspace: Id;
      group: GroupId;
      shard: number;
      layout_version: number;
      rows: RowImage[];
      tombstones: Tombstone[];
    }
  | {
      event: "rows_end";
      workspace: Id;
      group: GroupId;
      shard: number;
      layout_version: number;
      upto_seq: number;
      coverage: { complete: boolean; filter?: string };
    }
  | {
      event: "change";
      workspace: Id;
      group: GroupId;
      shard: number;
      layout_version: number;
      from_seq: number;
      to_seq: number;
      rows: ChangedRow[];
    }
  | { event: "push_result"; workspace: Id; results: OpResult[] }
  | {
      event: "rejected";
      workspace: Id;
      code: RejectionCode;
      from_device_seq: number;
      expected?: number;
      retry_after_ms?: number;
      reason?: string;
    }
  | { event: "caught_up"; workspace: Id; group: GroupId; shard: number; seq: number }
  | {
      event: "groups";
      workspace: Id;
      add?: GroupLayout[];
      update?: GroupUpdate[];
      remove?: GroupId[];
    }
  | { event: "reset"; workspace: Id; group?: GroupId; reason: string }
  | { event: "superseded"; workspace: Id }
  | ({ event: "device_results" } & DeviceResults)
  | {
      event: "device_results_refused";
      workspace: Id;
      device_id: Id;
      from_seq: number;
      upto: number;
      code: RefusalCode;
      field?: string;
    }
  | { event: "ack_ok"; workspace: Id; generation: number }
  | { event: "forbidden"; workspace: Id; device_id?: Id; reason: string }
  | ({ event: "hello_refused" } & HelloRefused)
  | { event: "reconnect"; after_ms: number; reason: string }
  | { event: "pong" };

/** A request's answer, for the frames that have one (`auth`, `auth.refresh`). */
export type Reply = { id: number; result: unknown } | { id: number; error: unknown };

/** `{"id","method","params"}`, as atlasd's socket shape takes it. */
export function encodeClient(id: number, frame: ClientFrame): string {
  return JSON.stringify({ id, method: frame.method, params: frame.params });
}

/** A server frame or a request's answer; anything else is `null`. */
export function decodeServer(text: string): ServerFrame | Reply | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.event === "string") return v as unknown as ServerFrame;
  if (typeof v.id === "number" && ("result" in v || "error" in v)) return v as unknown as Reply;
  return null;
}
