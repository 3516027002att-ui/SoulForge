import { randomUUID } from 'node:crypto';
import type {
  AgentPermissionMode,
  AgentRunResult,
  ChatMessage,
  ModelServiceConfig,
  StoredAgentPermissionMode
} from '../model-services/types.js';
import type { SqliteDatabase } from './sqliteDatabase.js';

export interface AppModelServiceRecord extends ModelServiceConfig {
  credentialCiphertext?: string;
  credentialKeyRef?: string;
  deletedAt?: string;
}

export interface AppPermissionGrant {
  grantId: string;
  serviceId: string;
  policyVersion: string;
  permissionMode: AgentPermissionMode;
  scope: unknown;
  grantedAt: string;
  revokedAt?: string;
}

export interface RecordAgentRunInput {
  runId?: string;
  conversationId?: string;
  workspaceKey?: string;
  serviceId: string;
  retentionMode?: 'thirty_days' | 'session' | 'forever';
  createdAt?: string;
  completedAt?: string;
  messages: ChatMessage[];
  result: AgentRunResult;
  outboundContextItems?: Array<{
    resourceUri?: string;
    contextKind: string;
    contentHash?: string;
    redactionSummary: unknown;
    payload: unknown;
  }>;
}

export interface RetentionCleanupResult {
  deletedConversations: number;
  deletedMessages: number;
  checkpointed: boolean;
}

export type AiHistoryRetentionMode = 'thirty_days' | 'session' | 'forever';

export const AI_HISTORY_RETENTION_SETTING_KEY = 'ai.history.retentionMode' as const;

export const DEFAULT_AI_HISTORY_RETENTION_MODE: AiHistoryRetentionMode = 'thirty_days';


export interface StoredAgentRunSummary {
  runId: string;
  conversationId: string;
  serviceId: string;
  workspaceKey?: string;
  permissionMode: AgentPermissionMode;
  status: string;
  finishReason?: string;
  createdAt: string;
  completedAt?: string;
  messageCount: number;
  stepCount: number;
  toolCallCount: number;
  outboundItemCount: number;
}

export interface StoredAgentRunDetail extends StoredAgentRunSummary {
  diagnostics: AgentRunResult["diagnostics"];
  audit: AgentRunResult["audit"];
  messages: ChatMessage[];
  steps: Array<{ stepId: string; stepIndex: number; status: string; summary?: string; diagnostics: unknown[]; createdAt: string }>;
  toolCalls: Array<{ toolCallId: string; toolName: string; ok: boolean; errorCode?: string; createdAt: string }>;
  outboundContextItems: Array<{ itemId: string; itemIndex: number; resourceUri?: string; contextKind: string; contentHash?: string; redactionSummary: unknown; payload: unknown; createdAt: string }>;
}

interface ModelServiceRow {
  service_id: string;
  service_kind: string;
  display_name: string;
  base_url: string;
  api_mode: string;
  model_name: string;
  credential_ciphertext: Buffer | null;
  credential_key_ref: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export class AppDataRepository {
  constructor(private readonly database: SqliteDatabase) {}

  listModelServices(): AppModelServiceRecord[] {
    const rows = this.database.prepare(`
SELECT service_id, service_kind, display_name, base_url, api_mode, model_name,
       credential_ciphertext, credential_key_ref, created_at, updated_at, deleted_at
FROM model_services
WHERE deleted_at IS NULL
ORDER BY updated_at DESC, service_id
`).all() as ModelServiceRow[];
    return rows.map(mapModelService);
  }

  getModelService(serviceId: string, includeDeleted = false): AppModelServiceRecord | undefined {
    const row = this.database.prepare(`
SELECT service_id, service_kind, display_name, base_url, api_mode, model_name,
       credential_ciphertext, credential_key_ref, created_at, updated_at, deleted_at
FROM model_services
WHERE service_id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}
`).get(serviceId) as ModelServiceRow | undefined;
    return row ? mapModelService(row) : undefined;
  }

  upsertModelService(record: AppModelServiceRecord): AppModelServiceRecord {
    this.writeModelService(record);
    return this.getModelService(record.id, true)!;
  }

  importModelServices(records: AppModelServiceRecord[]): number {
    const importAll = this.database.transaction(() => {
      let imported = 0;
      for (const record of records) {
        if (this.getModelService(record.id, true)) continue;
        this.writeModelService(record);
        imported += 1;
      }
      return imported;
    });
    return importAll.immediate();
  }

  private writeModelService(record: AppModelServiceRecord): void {
    this.database.prepare(`
INSERT INTO model_services (
  service_id, service_kind, display_name, base_url, api_mode, model_name,
  credential_ciphertext, credential_key_ref, created_at, updated_at, deleted_at
) VALUES (
  @serviceId, @protocol, @displayName, @baseUrl, @apiMode, @model,
  @credentialCiphertext, @credentialKeyRef, @createdAt, @updatedAt, @deletedAt
)
ON CONFLICT(service_id) DO UPDATE SET
  service_kind = excluded.service_kind,
  display_name = excluded.display_name,
  base_url = excluded.base_url,
  api_mode = excluded.api_mode,
  model_name = excluded.model_name,
  credential_ciphertext = excluded.credential_ciphertext,
  credential_key_ref = excluded.credential_key_ref,
  updated_at = excluded.updated_at,
  deleted_at = excluded.deleted_at
`).run({
      serviceId: record.id,
      protocol: record.protocol,
      displayName: record.displayName,
      baseUrl: record.baseUrl,
      apiMode: record.protocol === 'openai-compatible' ? 'chat-completions' : 'messages',
      model: record.model,
      credentialCiphertext: record.credentialCiphertext
        ? Buffer.from(record.credentialCiphertext, 'base64')
        : null,
      credentialKeyRef: record.credentialKeyRef ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      deletedAt: record.deletedAt ?? null
    });
  }

  softDeleteModelService(serviceId: string, deletedAt = new Date().toISOString()): void {
    this.database.prepare(`
UPDATE model_services
SET deleted_at = ?, credential_ciphertext = NULL, credential_key_ref = NULL, updated_at = ?
WHERE service_id = ?
`).run(deletedAt, deletedAt, serviceId);
  }

  replacePermissionGrant(grant: AppPermissionGrant): AppPermissionGrant {
    const replace = this.database.transaction(() => {
      const revoke = this.database.prepare(`
UPDATE permission_grants SET revoked_at = ?
WHERE service_id = ? AND permission_mode = ? AND revoked_at IS NULL
`);
      for (const mode of permissionModeAliases(grant.permissionMode)) {
        revoke.run(grant.grantedAt, grant.serviceId, mode);
      }
      this.database.prepare(`
INSERT INTO permission_grants (
  grant_id, service_id, policy_version, permission_mode, scope_json, granted_at, revoked_at
) VALUES (@grantId, @serviceId, @policyVersion, @permissionMode, @scopeJson, @grantedAt, @revokedAt)
`).run({
        ...grant,
        scopeJson: JSON.stringify(grant.scope),
        revokedAt: grant.revokedAt ?? null
      });
    });
    replace.immediate();
    return structuredClone(grant);
  }

  getActivePermissionGrant(
    serviceId: string,
    permissionMode: AppPermissionGrant['permissionMode'] | StoredAgentPermissionMode,
    policyVersion: string
  ): AppPermissionGrant | undefined {
    const aliases = permissionModeAliases(permissionMode);
    const row = this.database.prepare(`
SELECT grant_id, service_id, policy_version, permission_mode, scope_json, granted_at, revoked_at
FROM permission_grants
WHERE service_id = ?
  AND permission_mode IN (${aliases.map(() => '?').join(', ')})
  AND policy_version = ?
  AND revoked_at IS NULL
ORDER BY granted_at DESC
LIMIT 1
`).get(serviceId, ...aliases, policyVersion) as {
      grant_id: string;
      service_id: string;
      policy_version: string;
      permission_mode: string;
      scope_json: string;
      granted_at: string;
      revoked_at: string | null;
    } | undefined;
    return row ? {
      grantId: row.grant_id,
      serviceId: row.service_id,
      policyVersion: row.policy_version,
      permissionMode: normalizePermissionMode(row.permission_mode),
      scope: parseJson(row.scope_json),
      grantedAt: row.granted_at,
      ...(row.revoked_at ? { revokedAt: row.revoked_at } : {})
    } : undefined;
  }

  revokePermissionGrant(grantId: string, revokedAt = new Date().toISOString()): void {
    this.database.prepare('UPDATE permission_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL')
      .run(revokedAt, grantId);
  }

  recordAgentRun(input: RecordAgentRunInput): { runId: string; conversationId: string } {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const completedAt = input.completedAt ?? new Date().toISOString();
    const runId = input.runId ?? randomUUID();
    const conversationId = input.conversationId ?? randomUUID();
    const retentionMode = input.retentionMode ?? this.getAiHistoryRetentionMode();
    // thirty_days: expire after 30d; session: expire at createdAt so next cleanup (e.g. app restart) removes it;
    // forever: null expires_at (never matched by cleanup).
    const expiresAt = retentionMode === 'thirty_days'
      ? new Date(Date.parse(createdAt) + 30 * 24 * 60 * 60 * 1_000).toISOString()
      : retentionMode === 'session'
        ? createdAt
        : null;
    const write = this.database.transaction(() => {
      this.database.prepare(`
INSERT INTO ai_conversations (
  conversation_id, workspace_key, service_id, retention_mode, created_at, updated_at, expires_at
) VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(conversationId, input.workspaceKey ?? null, input.serviceId, retentionMode, createdAt, completedAt, expiresAt);
      const insertMessage = this.database.prepare(`
INSERT INTO ai_messages (
  message_id, conversation_id, role, body_text, tool_json, usage_json,
  created_at, expires_at, redaction_summary, provider_response_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
      for (const message of input.messages) {
        insertMessage.run(
          randomUUID(),
          conversationId,
          message.role,
          message.content,
          message.toolCalls ? JSON.stringify(message.toolCalls) : null,
          null,
          createdAt,
          expiresAt,
          JSON.stringify({ redacted: true }),
          null
        );
      }
      this.database.prepare(`
INSERT INTO app_agent_runs (
  run_id, conversation_id, service_id, workspace_key, permission_mode, status,
  finish_reason, diagnostics_json, audit_json, created_at, completed_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
        runId,
        conversationId,
        input.serviceId,
        input.workspaceKey ?? null,
        input.result.audit.permissionMode,
        input.result.finishReason === 'error' ? 'failed' : 'completed',
        input.result.finishReason,
        JSON.stringify(input.result.diagnostics),
        JSON.stringify(input.result.audit),
        createdAt,
        completedAt
      );
      const insertStep = this.database.prepare(`
INSERT INTO agent_steps (
  step_id, run_id, step_index, status, summary, diagnostics_json, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?)
`);
      for (let index = 0; index < input.result.steps; index += 1) {
        insertStep.run(randomUUID(), runId, index, 'completed', null, '[]', createdAt);
      }
      const insertTool = this.database.prepare(`
INSERT INTO tool_calls (
  tool_call_id, run_id, step_index, tool_name, permission, ok, code,
  arguments_json, result_json, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
      input.result.audit.toolCalls.forEach((call, index) => {
        insertTool.run(
          randomUUID(), runId, null, call.name, 'unknown', call.ok ? 1 : 0,
          call.code ?? null, null, null, createdAt
        );
      });
      const insertContext = this.database.prepare(`
INSERT INTO outbound_context_items (
  context_item_id, run_id, item_index, resource_uri, context_kind,
  content_hash, redaction_summary, payload_json, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
      (input.outboundContextItems ?? []).forEach((item, index) => {
        insertContext.run(
          randomUUID(), runId, index, item.resourceUri ?? null, item.contextKind,
          item.contentHash ?? null, JSON.stringify(item.redactionSummary),
          JSON.stringify(item.payload), createdAt
        );
      });
    });
    write.immediate();
    return { runId, conversationId };
  }



  getAiHistoryRetentionMode(): AiHistoryRetentionMode {
    const row = this.database.prepare(
      'SELECT value_json FROM app_settings WHERE setting_key = ?'
    ).get(AI_HISTORY_RETENTION_SETTING_KEY) as { value_json: string } | undefined;
    if (!row) return DEFAULT_AI_HISTORY_RETENTION_MODE;
    try {
      const value = parseJson(row.value_json);
      if (value === 'thirty_days' || value === 'session' || value === 'forever') {
        return value;
      }
    } catch {
      // fall through to default
    }
    return DEFAULT_AI_HISTORY_RETENTION_MODE;
  }

  setAiHistoryRetentionMode(
    mode: AiHistoryRetentionMode,
    updatedAt = new Date().toISOString()
  ): AiHistoryRetentionMode {
    if (mode !== 'thirty_days' && mode !== 'session' && mode !== 'forever') {
      throw new Error('INVALID_AI_HISTORY_RETENTION_MODE');
    }
    this.database.prepare(`
INSERT INTO app_settings (setting_key, value_json, updated_at)
VALUES (?, ?, ?)
ON CONFLICT(setting_key) DO UPDATE SET
  value_json = excluded.value_json,
  updated_at = excluded.updated_at
`).run(AI_HISTORY_RETENTION_SETTING_KEY, JSON.stringify(mode), updatedAt);
    return mode;
  }

  getAgentRun(runId: string): StoredAgentRunDetail | undefined {
    const row = this.database.prepare(`
SELECT run_id, conversation_id, service_id, workspace_key, permission_mode, status,
       finish_reason, diagnostics_json, audit_json, created_at, completed_at
FROM app_agent_runs
WHERE run_id = ?
`).get(runId) as {
      run_id: string;
      conversation_id: string;
      service_id: string;
      workspace_key: string | null;
      permission_mode: string;
      status: string;
      finish_reason: string | null;
      diagnostics_json: string;
      audit_json: string;
      created_at: string;
      completed_at: string | null;
    } | undefined;
    if (!row) return undefined;

    const messages = this.database.prepare(`
SELECT role, body_text, tool_json, created_at
FROM ai_messages
WHERE conversation_id = ?
ORDER BY created_at ASC, message_id ASC
`).all(row.conversation_id) as Array<{
      role: string;
      body_text: string;
      tool_json: string | null;
      created_at: string;
    }>;

    const steps = this.database.prepare(`
SELECT step_id, step_index, status, summary, diagnostics_json, created_at
FROM agent_steps
WHERE run_id = ?
ORDER BY step_index ASC
`).all(runId) as Array<{
      step_id: string;
      step_index: number;
      status: string;
      summary: string | null;
      diagnostics_json: string;
      created_at: string;
    }>;

    const toolCalls = this.database.prepare(`
SELECT tool_call_id, tool_name, ok, code, created_at
FROM tool_calls
WHERE run_id = ?
ORDER BY created_at ASC
`).all(runId) as Array<{
      tool_call_id: string;
      tool_name: string;
      ok: number;
      code: string | null;
      created_at: string;
    }>;

    const outbound = this.database.prepare(`
SELECT context_item_id, item_index, resource_uri, context_kind, content_hash, redaction_summary, payload_json, created_at
FROM outbound_context_items
WHERE run_id = ?
ORDER BY item_index ASC
`).all(runId) as Array<{
      context_item_id: string;
      item_index: number;
      resource_uri: string | null;
      context_kind: string;
      content_hash: string | null;
      redaction_summary: string;
      payload_json: string;
      created_at: string;
    }>;

    const detail: StoredAgentRunDetail = {
      runId: row.run_id,
      conversationId: row.conversation_id,
      serviceId: row.service_id,
      permissionMode: row.permission_mode as AgentPermissionMode,
      status: row.status,
      createdAt: row.created_at,
      messageCount: messages.length,
      stepCount: steps.length,
      toolCallCount: toolCalls.length,
      outboundItemCount: outbound.length,
      diagnostics: parseJson(row.diagnostics_json) as AgentRunResult["diagnostics"],
      audit: parseJson(row.audit_json) as AgentRunResult["audit"],
      messages: messages.map((message) => ({
        role: message.role as ChatMessage["role"],
        content: message.body_text
      })),
      steps: steps.map((step) => ({
        stepId: step.step_id,
        stepIndex: step.step_index,
        status: step.status,
        createdAt: step.created_at,
        ...(step.summary ? { summary: step.summary } : {}),
        diagnostics: parseJson(step.diagnostics_json) as unknown[],
      })),
      toolCalls: toolCalls.map((call) => ({
        toolCallId: call.tool_call_id,
        toolName: call.tool_name,
        ok: Number(call.ok) === 1,
        createdAt: call.created_at,
        ...(call.code ? { errorCode: call.code } : {})
      })),
      outboundContextItems: outbound.map((item) => ({
        itemId: item.context_item_id,
        itemIndex: item.item_index,
        contextKind: item.context_kind,
        redactionSummary: parseJson(item.redaction_summary),
        payload: parseJson(item.payload_json),
        createdAt: item.created_at,
        ...(item.resource_uri ? { resourceUri: item.resource_uri } : {}),
        ...(item.content_hash ? { contentHash: item.content_hash } : {})
      }))
    };
    if (row.workspace_key) detail.workspaceKey = row.workspace_key;
    if (row.finish_reason) detail.finishReason = row.finish_reason;
    if (row.completed_at) detail.completedAt = row.completed_at;
    return detail;
  }

  listAgentRuns(options: {
    workspaceKey?: string;
    serviceId?: string;
    limit?: number;
  } = {}): StoredAgentRunSummary[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.workspaceKey) {
      clauses.push("workspace_key = ?");
      params.push(options.workspaceKey);
    }
    if (options.serviceId) {
      clauses.push("service_id = ?");
      params.push(options.serviceId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    params.push(limit);
    const rows = this.database.prepare(`
SELECT run_id, conversation_id, service_id, workspace_key, permission_mode, status,
       finish_reason, created_at, completed_at
FROM app_agent_runs
${where}
ORDER BY created_at DESC
LIMIT ?
`).all(...params) as Array<{
      run_id: string;
      conversation_id: string;
      service_id: string;
      workspace_key: string | null;
      permission_mode: string;
      status: string;
      finish_reason: string | null;
      created_at: string;
      completed_at: string | null;
    }>;

    return rows.map((row) => {
      const messageCount = (this.database.prepare(
        "SELECT COUNT(*) AS count FROM ai_messages WHERE conversation_id = ?"
      ).get(row.conversation_id) as { count: number }).count;
      const stepCount = (this.database.prepare(
        "SELECT COUNT(*) AS count FROM agent_steps WHERE run_id = ?"
      ).get(row.run_id) as { count: number }).count;
      const toolCallCount = (this.database.prepare(
        "SELECT COUNT(*) AS count FROM tool_calls WHERE run_id = ?"
      ).get(row.run_id) as { count: number }).count;
      const outboundItemCount = (this.database.prepare(
        "SELECT COUNT(*) AS count FROM outbound_context_items WHERE run_id = ?"
      ).get(row.run_id) as { count: number }).count;
      const summary: StoredAgentRunSummary = {
        runId: row.run_id,
        conversationId: row.conversation_id,
        serviceId: row.service_id,
        permissionMode: row.permission_mode as AgentPermissionMode,
        status: row.status,
        createdAt: row.created_at,
        messageCount,
        stepCount,
        toolCallCount,
        outboundItemCount
      };
      if (row.workspace_key) summary.workspaceKey = row.workspace_key;
      if (row.finish_reason) summary.finishReason = row.finish_reason;
      if (row.completed_at) summary.completedAt = row.completed_at;
      return summary;
    });
  }

  cleanupExpiredHistory(now = new Date().toISOString()): RetentionCleanupResult {
    const cleanup = this.database.transaction(() => {
      const messages = this.database.prepare(
        'SELECT COUNT(*) AS count FROM ai_messages WHERE expires_at IS NOT NULL AND expires_at <= ?'
      ).get(now) as { count: number };
      const conversations = this.database.prepare(
        'SELECT COUNT(*) AS count FROM ai_conversations WHERE expires_at IS NOT NULL AND expires_at <= ?'
      ).get(now) as { count: number };
      this.database.prepare('DELETE FROM ai_conversations WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now);
      return { deletedConversations: conversations.count, deletedMessages: messages.count };
    });
    const result = cleanup.immediate();
    this.database.pragma('wal_checkpoint(PASSIVE)');
    return { ...result, checkpointed: true };
  }
}

function mapModelService(row: ModelServiceRow): AppModelServiceRecord {
  const credentialCiphertext = row.credential_ciphertext?.toString('base64');
  return {
    id: row.service_id,
    displayName: row.display_name,
    protocol: row.service_kind as AppModelServiceRecord['protocol'],
    baseUrl: row.base_url,
    model: row.model_name,
    hasCredential: Boolean(credentialCiphertext || row.credential_key_ref),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(credentialCiphertext ? { credentialCiphertext } : {}),
    ...(row.credential_key_ref ? { credentialKeyRef: row.credential_key_ref } : {}),
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {})
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('APP_DATABASE_JSON_CORRUPT');
  }
}

function permissionModeAliases(
  mode: AppPermissionGrant['permissionMode'] | StoredAgentPermissionMode
): string[] {
  if (mode === 'fullPermission' || mode === 'full') {
    return ['fullPermission', 'full'];
  }
  return [mode];
}

function normalizePermissionMode(
  mode: string
): AppPermissionGrant['permissionMode'] {
  if (mode === 'full' || mode === 'fullPermission') return 'fullPermission';
  if (mode === 'plan' || mode === 'normal') return mode;
  // Fail closed to the lowest mode rather than inventing elevated access.
  return 'plan';
}
