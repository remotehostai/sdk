// @remotehost/sdk/sync: the sync protocol v1 client (app backends design 4).
// `sqliteStore` is its own subpath, @remotehost/sdk/sync/sqlite, so this
// entry never names Node's SQLite module and a browser bundle never pulls it in.
// Only the launch backends' helpers are public (issues, tasks); others, such
// as checklist, stay generated for the SDK's own tests (generated/<name>.ts).

export { createSyncClient } from "./client.js";
export { memoryStore } from "./stores/memory.js";
export { deleteIndexedDbStores, indexedDbStore } from "./stores/indexeddb.js";
export { newId } from "./ids.js";
export { issues } from "./generated/issues.js";
export { tasks } from "./generated/tasks.js";
export type * from "./generated/issues.js";
export type {
  TasksAppSource,
  TasksArea,
  TasksAreaProject,
  TasksComment,
  TasksCustomization,
  TasksInitiative,
  TasksInitiativeDocument,
  TasksInitiativeFolder,
  TasksIssue,
  TasksIssueLabel,
  TasksLabel,
  TasksMilestone,
  TasksNotification,
  TasksProject,
  TasksRelation,
  TasksState,
  TasksTeam,
  TasksUpdate,
  TasksUser,
  TasksView,
  TasksWorkspaceApp,
} from "./generated/tasks.js";
export { PROTOCOL, OP_VERSION, REFUSAL_CODES } from "./generated/protocol.js";
export type {
  BlobRef,
  ClientFrame,
  Cursors,
  DeleteRecord,
  Op,
  PutRecord,
  RecordOp,
  RefusalCode,
  RejectionCode,
  ServerFrame,
  UpdateRecord,
} from "./generated/protocol.js";
export type { Declaration } from "./validate.js";
export type {
  HelloRefusal,
  LeaderEnvironment,
  OutboxEntry,
  PendingWrite,
  RecordChange,
  RecordRow,
  RecordSet,
  StoredRow,
  StoreTx,
  SyncClient,
  SyncClientOptions,
  SyncOp,
  SyncStatus,
  SyncStore,
  TokenGrant,
  WebSocketLike,
  WriteOutcome,
} from "./types.js";
