export { RemoteHost, type RemoteHostOptions } from "./client.js";
export { SandboxCommands, type CommandResult, type RunCommandOptions } from "./commands.js";
export {
  EnvironmentTemplates,
  type CreateEnvironmentTemplateBody,
  type CreateEnvironmentTemplateOptions,
  type EgressPropagation,
  type EnvironmentTemplate,
  type EnvironmentTemplateDeleteResult,
  type EnvironmentTemplateRequestOptions,
  type EnvironmentTemplateWriteResult,
  type UpdateEnvironmentTemplateBody,
  type UpdateEnvironmentTemplateOptions,
} from "./environment-templates.js";
export {
  Environments,
  type AttachEnvironmentOptions,
  type CreateEnvironmentOptions,
  type Environment,
  type EnvironmentAttachResult,
  type EnvironmentDeleteResult,
  type EnvironmentDetachResult,
  type EnvironmentForkResult,
  type EnvironmentLease,
  type EnvironmentLifetimePolicy,
  type EnvironmentRecovery,
  type EnvironmentRequestOptions,
  type EnvironmentStatus,
  type EnvironmentUpdateResult,
  type ForkEnvironmentOptions,
  type ListEnvironmentsOptions,
  type UpdateEnvironmentOptions,
} from "./environments.js";
export {
  RemoteHostAPIError,
  RemoteHostConfigurationError,
  RemoteHostConnectionError,
  RemoteHostError,
  RemoteHostTimeoutError,
} from "./errors.js";
export {
  SandboxFiles,
  type FileEncoding,
  type FilesystemEntry,
  type ListFilesResult,
  type ReadFileResult,
  type WriteFileResult,
} from "./files.js";
export { SandboxMetricsResource, type LiveSandboxMetrics, type SandboxMetrics } from "./metrics.js";
export {
  SandboxPreviews,
  type CreatePreviewOptions,
  type Preview,
  type PreviewLink,
} from "./previews.js";
export type { RequestOptions } from "./request-options.js";
export { VERSION } from "./version.js";
export {
  Sandbox,
  Sandboxes,
  type CreateSandboxBody,
  type CreateSandboxOptions,
  type ListSandboxesOptions,
  type ResizeSandboxBody,
  type SandboxData,
  type SandboxResizeResult,
  type WaitForSandboxOptions,
} from "./sandboxes.js";
export {
  Workspaces,
  type CreateWorkspaceBody,
  type CreateWorkspaceOptions,
  type UpdateWorkspaceBody,
  type UpdateWorkspaceOptions,
  type Workspace,
  type WorkspaceKind,
  type WorkspaceRequestOptions,
} from "./workspaces.js";

export { RemoteHost as default } from "./client.js";
