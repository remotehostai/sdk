# @remotehost/sdk

## 0.4.0

### Minor Changes

- ab4f66b: Add the agent-session conversation transcript (`getAgentTranscript`): user messages, replies, tool calls with status, output and diffs, reasoning summaries, and turn and approval markers. The event stream now also carries `conversation` events and reply `itemId`s.
- 4350f94: Add agent-session event streaming types: `streamAgentSessionEvents` (server-sent events with resumable output cursors) and `waitForAgentSession` (long-poll that returns when a reply, turn transition or approval request arrives).
- 7e65ee8: Add managed agent-session release types and terminal resume instructions for Claude Code and Codex. Session state now includes released and releasing flags.

### Patch Changes

- e06d6a9: Document every generated API operation: each now carries a summary, and the sandbox lifecycle, command and file operations describe their behavior. Types are unchanged.

## 0.3.0

### Minor Changes

- 91b9f42: Expose agent-independent communication capabilities and setup/restart requirements
  on agent sessions. Session agent IDs are extensible strings; supported operations
  are reported separately from caller permissions.
- ba2f505: Add typed agent-session discovery, creation, output, messaging, approvals,
  interruption and Codex recovery endpoints, plus personal agent-token management
  for access across authorized projects and organizations.
- 177ef49: Add optional agent-message request keys and replay responses so clients can retry lost responses without creating another turn.

## 0.2.0

### Minor Changes

- 20b7ee5: Add generated REST types for managed agent-session discovery, creation, output, messages, approvals, and interruption.
- f2a81fe: Add typed caller identity, usage reporting, API-key management and filesystem
  tree operations to the raw API client. Serve the deployed OpenAPI contract at
  `/openapi.json` and document the complete core sandbox workflow.

## 0.1.1

### Patch Changes

- a88e5d9: License the SDK under MIT and publish its implementation, tests, and standalone
  build configuration at https://github.com/remotehostai/sdk.

## 0.1.0

### Minor Changes

- 2cbed35: Release the first public RemoteHost TypeScript SDK with generated API types and
  resource-oriented sandbox, command, file, preview, metrics, and lifecycle APIs.
