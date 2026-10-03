# Database upgrades and execution boundaries

## Upgrade and rollback

Workspace schema 16 and app schema 4 retire unused tables. Before upgrading an
existing database, the migration engine uses SQLite `VACUUM INTO` to preserve a
consistent sibling file named `<database>.pre-schema-<version>-<unique-id>.db`.
The snapshot is integrity-checked before destructive SQL begins. A failed
snapshot aborts the upgrade; a failed migration leaves its snapshot available.
New empty databases do not need a pre-upgrade snapshot.

Older applications refuse to open the upgraded schema. To roll back, close all
application instances and restore the matching pre-upgrade snapshot, retaining
the upgraded database separately. Changes made after the snapshot are not in that
snapshot. Do not copy an active database and its WAL files independently.

The application does not automatically delete old user databases, snapshots,
legacy JSON files, or upgrade backups.

## Table-by-table retirement review

The following 24 tables have no production SQL readers or writers outside their
historical schema migrations:

- Workspace: event_symbols, event_instructions, event_text_fts, map_entities,
  map_regions, param_rows, param_fields, param_rows_fts, text_entries,
  text_entries_fts, operation_logs, workspace_layers, agent_runs
- App: model_services, permission_grants, ai_conversations, ai_messages,
  adaptation_packages, trusted_signers, app_settings, app_agent_runs, agent_steps,
  tool_calls, outbound_context_items

Names in tool contracts such as `search_param_rows` are tool names, not database
access. Production dynamic SQL was also reviewed: the variable table in
`deleteRagFtsRows` is limited to rag_chunks_fts/rag_chunks_fts_trigram; the variable
suffix in file search does not change its files/workspaces tables. Parameter-list
expansion only operates on rag_chunks.

The three additional tables resource_nodes, resource_edges, and
resource_graph_snapshots had one production writer, importLegacySemanticSnapshot,
and no production reader. That path now validates and archives the original JSON
with a legacy_imports receipt instead of materializing an unread graph. Live
semantic and knowledge projections continue to rebuild from workspace resources.
The full pre-upgrade database preserves any historical rows in these tables.

Operation truth remains in patch_history, file_operations, transaction_journal,
recovery_points, resource_entry_changes, and audit_events. Provider accounting
remains in provider_usage_events. Index/RAG/knowledge tables remain operational.

## Writer, reader, and transport outcomes

One utility process owns writes. An independent utility process opens read-only
SQLite connections after the writer completes migration and legacy archival.
Reads can observe the last committed WAL snapshot during a synchronous long
write. A caller needing a write's result awaits its receipt or queries its opId;
absence during an in-flight write does not prove the write will not commit.

Queued RPC deadlines prevent requests from being sent after expiration. A
dispatched write timeout or process/transport loss reports an unknown outcome,
its opId when available, and retryable=false. Explicit restart reopens the bound
database without replaying pending requests. Session request cancellation is
separate from persistent transaction status and retains a returned commit receipt.

For Patch Engine writes, the existing transaction_journal state also records the
session name, request ID, and a SHA-256 payload hash before any resource is
replaced. Every phase retains that correlation. After restart,
`__host_request_status` can recover operation IDs from the caller's original
session/request identity. A repeated correlated request is refused rather than
executed again. The recovered request state remains unknown because a durable
commit does not prove the executor response was delivered. Legacy operations
without correlation and an absent request lookup are not evidence of nonexecution.

## Build isolation

Desktop smoke runners own unique output/desktop-smoke-builds directories and
SQLite native bindings, cleaned on success, failure, and captured cancellation.
Smoke entries cannot target production out. Electron packaging disables the
default repository native rebuild and uses the separately prepared .native
binding. Worktrees must own actual node_modules copies rather than deletion-
sensitive links into another worktree.

Other mutable artifacts are worktree-owned too: packages/shared/dist and
packages/core/dist (TypeScript writers, core/desktop consumers), Bridge bin/obj
(dotnet writers, native validation/desktop consumers), apps/desktop/out and its
production manifest (desktop-build writers, packaged/runtime consumers), and
output/desktop-smoke-builds (smoke-runner writers and consumers). A smoke runner
allocates a unique root for each invocation, while production builds remain
serialized within one worktree. Only read-only SDK installations may be shared.

These boundaries have synthetic Node/SQLite regression coverage. They do not
substitute for Windows Electron ABI, packaging, native-corpus, or UI E2E validation.
