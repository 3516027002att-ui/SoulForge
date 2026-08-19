import type {
  AiToolPermissionLevel,
  ConfirmationReceipt,
  IndexedFile,
  PatchMode,
  PatchProposal,
  ReferenceEdge,
  ResourceKind
} from '@soulforge/shared';
import { isAbsolute, join } from 'node:path';
import { commitPatchProposal, createPatchProposal, dryRunPatchProposal } from '../patch/patchEngine.js';
import { getDefaultOperationLogStore, type OperationLogStore } from '../patch/operationLog.js';
import { rollbackOperation } from '../patch/rollback.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';
import { buildGraphPatchFromProposal, summarizeGraphPatch } from '../patch/graphPatch.js';
import { assessEditRisk, evaluateWriterGate, resolveWriterContract } from '../patch/writerContract.js';
import type { RagChunkFamily, RagCorpus } from '@soulforge/shared';
import { RAG_CHUNK_FAMILIES } from '@soulforge/shared';
import type { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { ALL_RESOURCE_KINDS } from '../workspace/resourceKinds.js';
import { buildTextAiContext, renderTextAiPrompt } from './aiContextBuilder.js';
import { buildPlaintextScriptEdit } from '../script/plaintextScriptEdit.js';
import { nativeEditSessionFromContext } from '../editing/nativeEditSession.js';
import { readParamFields, setParamFields, type ParamFieldEdit } from '../param/containerParamEdit.js';
import { readFmgEntries, setFmgEntries, type FmgEntryEdit } from '../editing/fmgEdit.js';
import { applyEmevdDsl, readEmevdOutline } from '../editing/emevdEdit.js';
import { readTaeEvents, setTaeEventTimes } from '../editing/taeEdit.js';
import { readMsbParts, setMsbPartTransform, type MsbPartTransformEdit } from '../editing/msbEdit.js';
import { isAiToolPermissionAllowed, legacyPermissionToLevel } from './toolPermissions.js';
import { buildRagCorpus } from '../rag/chunkBuilder.js';
import { retrieveEvidence } from '../rag/retrieve.js';

/** @deprecated Prefer AiToolPermissionLevel. Kept for older UI labels. */
export type ToolPermission = 'read' | 'plan' | 'write' | AiToolPermissionLevel;

export interface ToolContext {
  workspaceIndex: WorkspaceIndex | null;
  mode: 'plan' | 'normal' | 'fullPermission';
  /** Optional durable/in-memory RAG corpus. Absent falls back to building from the index. */
  rag?: RagCorpus;
  /**
   * 主进程注入的「真实写/回滚」上下文。纯读工具不需要；写级工具（回滚等）
   * 缺省时干净失败（ROLLBACK_CONTEXT_REQUIRED），绝不用内存 store 冒充生产
   * 通道 —— 之前 rollback_operation 只带内存 store 且无 confirmation，恒以
   * EDIT_CONFIRMATION_REQUIRED 失败，属于半成品，本次接通。
   */
  session?: WorkspaceSession;
  operationLogStore?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
  /** 用户对本次具体写操作的确认凭据（main 原生对话框签发，绑定操作 ID）。 */
  confirmation?: ConfirmationReceipt;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  permission: ToolPermission;
  permissionLevel?: AiToolPermissionLevel;
  /**
   * Declared input contract, surfaced so callers (notably the agent loop
   * bridge) can project it into a model-facing JSON Schema. Absent means the
   * tool takes no arguments.
   */
  inputSchema?: ToolInputShape;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

type ToolHandler = (input: unknown, context: ToolContext) => Promise<ToolResult> | ToolResult;

/**
 * Declared input contract: field name -> expected type
 * ('string' | 'number' | 'boolean' | 'array' | 'object'; trailing '?' marks
 * the field optional; unrecognized type names pass through). Undeclared extra
 * fields are ignored — callers may attach context markers.
 *
 * Enumerations use `enum:a|b|c` (optional as `enum:a|b|c?`). Before this, a
 * field like `direction` was declared as bare `'string'` and the model was
 * told nothing about the three accepted values; a wrong value did not fail but
 * silently fell back to a default (`'sideways'` → `'both'`, `mode: 'destroy'`
 * → the session mode), so the model acted on a result it did not ask for.
 */
export type ToolInputShape = Record<string, string>;

const ENUM_PREFIX = 'enum:';

/** Split a declared type string into its bare type and optionality. */
function parseDeclaredType(declared: string): { bare: string; optional: boolean } {
  const optional = declared.endsWith('?');
  return { bare: optional ? declared.slice(0, -1) : declared, optional };
}

/** Accepted values for an `enum:a|b|c` declaration, or null if not an enum. */
function enumValues(bare: string): string[] | null {
  if (!bare.startsWith(ENUM_PREFIX)) return null;
  const values = bare.slice(ENUM_PREFIX.length).split('|').filter((value) => value.length > 0);
  return values.length > 0 ? values : null;
}

export interface RegisteredTool extends ToolDescriptor {
  inputSchema?: ToolInputShape;
  run: ToolHandler;
}

export function validateToolInput(
  shape: ToolInputShape | undefined,
  input: unknown
): { ok: true } | { ok: false; message: string } {
  if (!shape || Object.keys(shape).length === 0) return { ok: true };
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, message: '工具输入必须是 JSON 对象。' };
  }
  const record = input as Record<string, unknown>;
  const problems: string[] = [];
  for (const [key, declared] of Object.entries(shape)) {
    const { bare: expectedType, optional } = parseDeclaredType(declared);
    const value = record[key];
    if (value === undefined) {
      if (!optional) problems.push(`缺少必填字段 ${key}`);
      continue;
    }
    const allowed = enumValues(expectedType);
    if (allowed !== null) {
      // Enum values are enforced here rather than silently defaulted in the
      // handler, so a wrong value comes back naming the accepted set.
      if (typeof value !== 'string' || !allowed.includes(value)) {
        problems.push(`字段 ${key} 取值应为 ${allowed.join(' | ')} 之一`);
      }
      continue;
    }
    if (!matchesDeclaredType(value, expectedType)) {
      problems.push(`字段 ${key} 类型应为 ${expectedType}`);
    }
  }
  if (problems.length > 0) {
    return { ok: false, message: `INVALID_INPUT: ${problems.join('；')}。` };
  }
  return { ok: true };
}

/**
 * Project a declared ToolInputShape into the JSON Schema the model sees.
 *
 * This is deliberately a *projection* of the same declaration that
 * validateToolInput enforces at runtime, not a second hand-written schema.
 * Two independent copies would drift silently: the model would be told about
 * fields the validator rejects, or vice versa, and nothing would fail.
 *
 * `additionalProperties` stays true on purpose — validateToolInput ignores
 * undeclared extras (callers attach context markers), so advertising a closed
 * object would misdescribe the runtime contract.
 */
export function toolInputShapeToJsonSchema(shape: ToolInputShape | undefined): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, declared] of Object.entries(shape ?? {})) {
    const { bare: declaredType, optional } = parseDeclaredType(declared);
    properties[key] = jsonSchemaForDeclaredType(declaredType);
    if (!optional) required.push(key);
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: true
  };
}

/**
 * Mirror of matchesDeclaredType's accepted type names. Unrecognized names pass
 * validation unchecked there, so they must project to an unconstrained schema
 * here — claiming a type the validator does not enforce would be a lie to the
 * model in the permissive direction.
 */
function jsonSchemaForDeclaredType(declaredType: string): Record<string, unknown> {
  const allowed = enumValues(declaredType);
  if (allowed !== null) return { type: 'string', enum: allowed };
  switch (declaredType) {
    case 'string':
      return { type: 'string' };
    case 'number':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'array':
      return { type: 'array' };
    case 'object':
      return { type: 'object' };
    default:
      return {};
  }
}

function matchesDeclaredType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    const permissionLevel = tool.permissionLevel ?? normalizePermissionLevel(tool.permission);
    this.tools.set(tool.name, { ...tool, permissionLevel, permission: permissionLevel });
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()].map(({ name, description, permission, permissionLevel, inputSchema }) => ({
      name,
      description,
      permission,
      permissionLevel: permissionLevel ?? normalizePermissionLevel(permission),
      // Surfaced verbatim (not cloned-and-renamed) so the model-facing schema
      // and the runtime validateToolInput check can never disagree: both read
      // this same declaration.
      ...(inputSchema && Object.keys(inputSchema).length > 0 ? { inputSchema } : {})
    }));
  }

  async run(name: string, input: unknown, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return fail('TOOL_NOT_FOUND', `Unknown tool: ${name}`);

    const level = tool.permissionLevel ?? normalizePermissionLevel(tool.permission);
    if (!isAiToolPermissionAllowed(level, context.mode)) {
      return fail('TOOL_PERMISSION_DENIED', `Tool '${name}' requires ${level} permission in ${context.mode} mode.`);
    }

    const inputCheck = validateToolInput(tool.inputSchema, input);
    if (!inputCheck.ok) {
      return fail('INVALID_INPUT', inputCheck.message);
    }

    try {
      return await tool.run(input, context);
    } catch (error) {
      return fail('TOOL_EXCEPTION', error instanceof Error ? error.message : String(error));
    }
  }
}

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register({
    name: 'workspace_stats',
    description: 'Return indexed workspace counts for files, symbols, and references.',
    permission: 'read',
    permissionLevel: 'read',
    run: (_input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      return ok(ws.getStats());
    }
  });

  registry.register({
    name: 'retrieve_evidence',
    description:
      'Hybrid retrieve over the workspace evidence index: exact IDs, lexical text, and one-hop reference expansion. '
        + 'Addresses are param-like: cXXXX / cXXXX#AXXXX(.eN) for actions, MXX / mAA_BB_CC_DD '
        + '(or mAA_BB_CC_DD#partName) for maps. Use this before specialized search_* tools when the '
        + 'question names a flag, entity, event, textId, unknown resource, anim code, or map block.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: {
      query: 'string',
      limit: 'number?',
      families: 'array?',
      expandReferences: 'boolean?'
    },
    run: (input, context) => {
      const corpus = resolveRagCorpus(context);
      if (corpus === null && context.workspaceIndex === null) {
        return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      }
      const value = asRecord(input);
      const query = asString(value.query);
      if (!query.trim()) return fail('INVALID_INPUT', 'retrieve_evidence 需要非空 query。');
      const families = asRagFamilies(value.families);
      const result = retrieveEvidence(corpus, query, {
        limit: asNumber(value.limit, 8),
        ...(value.expandReferences === undefined ? {} : { expandReferences: value.expandReferences === true }),
        ...(families ? { families } : {})
      });
      if (!result.ok) return fail(result.code, result.message);
      return ok(result);
    }
  });

  registry.register({
    name: 'search_resources',
    description: 'Search indexed workspace files by path, extension, or resource kind.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string', limit: 'number?', kinds: 'array?' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      const query = asString(value.query, '');
      const limit = asNumber(value.limit, 50);
      const kinds = asResourceKinds(value.kinds);
      return ok(ws.searchResources({ query, limit, ...(kinds ? { kinds } : {}) }));
    }
  });

  registry.register({
    name: 'search_events',
    description: 'Search parsed event symbols.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string', limit: 'number?' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      return ok(ws.searchEvents(asString(value.query, ''), asNumber(value.limit, 50)));
    }
  });

  registry.register({
    name: 'search_map_entities',
    description: 'Search parsed map entities and regions.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string', limit: 'number?' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      return ok(ws.searchMapEntities(asString(value.query, ''), asNumber(value.limit, 50)));
    }
  });

  registry.register({
    name: 'search_tae_events',
    description: 'Search parsed TAE animation events by address (c1050#A0200.e0), anim code, '
      + 'frame, SoundID, or type name. TAE events live inside anibnd; do not unpack BND or '
      + 'treat anibnd as text.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string', limit: 'number?' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      return ok(ws.searchTaeEvents(asString(value.query, ''), asNumber(value.limit, 50)));
    }
  });

  registry.register({
    name: 'search_param_rows',
    description: 'Search parsed param rows.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string', limit: 'number?' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      return ok(ws.searchParamRows(asString(value.query, ''), asNumber(value.limit, 50)));
    }
  });

  registry.register({
    name: 'search_text_entries',
    description: 'Search parsed text entries.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string', limit: 'number?' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      return ok(ws.searchTextEntries(asString(value.query, ''), asNumber(value.limit, 50)));
    }
  });

  registry.register({
    name: 'lookup_text_id',
    description: 'Look up parsed text entries by numeric textId and optional category.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { textId: 'number', category: 'string?' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      const textId = asNumber(value.textId, Number.NaN);
      if (!Number.isFinite(textId)) return fail('INVALID_INPUT', 'lookup_text_id requires numeric textId.');
      const category = asOptionalString(value.category);
      const matches = ws.lookupTextEntries(textId, category);
      if (matches.length === 0) return fail('TEXT_ENTRY_NOT_FOUND', `No text entry exists for textId ${textId}.`, { category });
      return ok({ textId, category, matches });
    }
  });

  registry.register({
    name: 'find_text_references',
    description: 'Find events or other symbols that reference a parsed textId.',
    permission: 'analyze',
    permissionLevel: 'analyze',
    inputSchema: { textId: 'number', category: 'string?' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      const textId = asNumber(value.textId, Number.NaN);
      if (!Number.isFinite(textId)) return fail('INVALID_INPUT', 'find_text_references requires numeric textId.');
      const category = asOptionalString(value.category);
      const matches = ws.lookupTextEntries(textId, category);
      if (matches.length === 0) return fail('TEXT_ENTRY_NOT_FOUND', `No text entry exists for textId ${textId}.`, { category });
      const items = matches.map((entry) => {
        const references = ws.findReferences(entry.uri, 'to');
        return { entry, references, referenceStats: summarizeReferences(references) };
      });
      return ok({ textId, category, matches: items, totalReferences: items.reduce((sum, item) => sum + item.references.length, 0) });
    }
  });

  registry.register({
    name: 'explain_text_entry',
    description: 'Build evidence-first AI explanation contexts for a parsed textId.',
    permission: 'analyze',
    permissionLevel: 'analyze',
    inputSchema: {
      textId: 'number',
      category: 'string?',
      maxReferences: 'number?',
      maxMarkdownChars: 'number?'
    },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      const textId = asNumber(value.textId, Number.NaN);
      if (!Number.isFinite(textId)) return fail('INVALID_INPUT', 'explain_text_entry requires numeric textId.');
      const category = asOptionalString(value.category);
      const maxReferences = asNumber(value.maxReferences, 80);
      const maxMarkdownChars = asNumber(value.maxMarkdownChars, 24_000);
      const matches = ws.lookupTextEntries(textId, category);
      if (matches.length === 0) return fail('TEXT_ENTRY_NOT_FOUND', `No text entry exists for textId ${textId}.`, { category });
      const contexts = matches.map((entry) => {
        const references = ws.findReferences(entry.uri, 'to');
        const aiContext = buildTextAiContext(entry, references, { maxReferences, maxMarkdownChars });
        return { context: aiContext, prompt: renderTextAiPrompt(aiContext) };
      });
      return ok({ textId, category, contexts });
    }
  });

  registry.register({
    name: 'find_references',
    description: 'Find evidence graph references connected to a URI.',
    permission: 'analyze',
    permissionLevel: 'analyze',
    inputSchema: { uri: 'string', direction: 'enum:from|to|both?' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      const uri = asString(value.uri);
      if (!uri) return fail('INVALID_INPUT', 'find_references requires uri.');
      const direction = asReferenceDirection(value.direction);
      return ok(ws.findReferences(uri, direction));
    }
  });

  registry.register({
    name: 'explain_event',
    description: 'Build an evidence-first explanation input for one event URI.',
    permission: 'analyze',
    permissionLevel: 'analyze',
    inputSchema: { uri: 'string' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      const uri = asString(value.uri);
      if (!uri) return fail('INVALID_INPUT', 'explain_event requires uri.');
      const explanation = ws.buildEventExplanationInput(uri);
      if (!explanation) return fail('EVENT_NOT_FOUND', `No event exists for URI: ${uri}`);
      return ok(explanation);
    }
  });

  registry.register({
    name: 'propose_text_patch',
    description: 'Create a text-only patch proposal. It does not save files.',
    permission: 'propose',
    permissionLevel: 'propose',
    inputSchema: {
      targetUri: 'string',
      targetPath: 'string',
      newText: 'string',
      title: 'string?',
      mode: 'enum:plan|normal|fullPermission?'
    },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      const workspaceId = ws.workspaceId;
      const targetUri = asString(value.targetUri);
      const targetPath = asString(value.targetPath);
      const newText = asString(value.newText);
      const title = asString(value.title, 'AI text patch proposal');
      const mode = asPatchMode(value.mode, context.mode);

      if (!targetUri || !targetPath || newText === undefined) {
        return fail('INVALID_INPUT', 'propose_text_patch requires targetUri, targetPath, and newText.');
      }
      const nativeHint = nativeFormatHint(targetUri, targetPath);
      if (nativeHint) {
        return fail('USE_NATIVE_EDIT_FACADE', nativeHint);
      }

      const proposal = createPatchProposal({
        workspaceId,
        title,
        author: 'ai',
        mode,
        changes: [
          {
            targetUri,
            targetPath,
            kind: 'text',
            structuredEdit: { newText }
          }
        ]
      });

      return ok(proposal);
    }
  });

  registry.register({
    name: 'propose_plaintext_script_edit',
    description: 'Propose a source-level edit to a plain-text script entry (goal_list.lua, '
      + '*_battle.lua, *nameid.txt). Verifies the target is really plain text from its bytes, '
      + 'preserves the original encoding and trailing padding, and returns a patch proposal. '
      + 'It does not save files. Bytecode entries are rejected.',
    permission: 'propose',
    permissionLevel: 'propose',
    inputSchema: {
      containerUri: 'string',
      childPath: 'string',
      entryIndex: 'number',
      /** 目标条目当前字节的 base64。调用方须经 read 类工具取得,不是猜的。 */
      currentBytesBase64: 'string',
      expectedContainerHash: 'string',
      find: 'string',
      replace: 'string',
      containerFormat: 'string?'
    },
    run: (input) => {
      const value = asRecord(input);
      const containerUri = asString(value.containerUri);
      const childPath = asString(value.childPath);
      const currentBytesBase64 = asString(value.currentBytesBase64);
      const expectedContainerHash = asString(value.expectedContainerHash);
      const find = asString(value.find);
      const replace = asString(value.replace);
      const entryIndex = asNumber(value.entryIndex, Number.NaN);
      if (!containerUri || !childPath || !currentBytesBase64 || !expectedContainerHash || !find) {
        return fail(
          'INVALID_INPUT',
          'propose_plaintext_script_edit 需要 containerUri、childPath、currentBytesBase64、'
            + 'expectedContainerHash 与 find。'
        );
      }
      if (!Number.isInteger(entryIndex) || entryIndex < 0) {
        return fail('INVALID_INPUT', 'entryIndex 必须是非负整数。');
      }
      let currentBytes: Uint8Array;
      try {
        currentBytes = new Uint8Array(Buffer.from(currentBytesBase64, 'base64'));
      } catch {
        return fail('INVALID_INPUT', 'currentBytesBase64 不是合法 base64。');
      }
      if (currentBytes.length === 0) {
        return fail('INVALID_INPUT', 'currentBytesBase64 解出零字节。');
      }
      // 全部判定与编排复用已端到端验证过的那一层:明文按真实字节判定、
      // 编码保持、尾部对齐填充保留、锚点唯一性强制、写后哈希。
      // 工具层不重写任何一条 —— 重写就会出现两套会漂移的规则。
      const result = buildPlaintextScriptEdit({
        containerUri,
        childPath,
        entryIndex,
        currentBytes,
        expectedContainerHash,
        ...(asOptionalString(value.containerFormat)
          ? { containerFormat: asOptionalString(value.containerFormat)! }
          : {}),
        actions: [{ kind: 'replace-once', find, replace }]
      });
      if (!result.ok) {
        return fail(result.code, result.message, { diagnostics: result.diagnostics });
      }
      return ok({
        operation: result.operation,
        encoding: result.encoding,
        beforeBytes: result.beforeBytes,
        afterBytes: result.afterBytes,
        beforeHash: result.beforeHash,
        afterHash: result.afterHash,
        diagnostics: result.diagnostics,
        note: '已生成 PatchIR 操作,尚未写入任何文件。提交需经 Patch Engine,'
          + '且写后应用 checkPlaintextWriteback 复验重读字节。'
      });
    }
  });

  registry.register({
    name: 'validate_patch',
    description: 'Run Patch Engine validation in staging on a full PatchProposal. It does not save files.',
    permission: 'validate',
    permissionLevel: 'validate',
    // The whole input *is* the PatchProposal, so every required proposal field
    // must be declared. Declaring only `changes` told the model the rest was
    // unnecessary: dryRunPatchProposal then returned ok:true at the tool layer
    // with an inner PATCH_IR_MISSING_WORKSPACE failure, which the agent loop
    // reads as a successful call.
    inputSchema: {
      opId: 'string',
      workspaceId: 'string',
      changes: 'array',
      title: 'string?',
      author: 'string?',
      mode: 'string?',
      createdAt: 'string?'
    },
    run: async (input) => {
      const proposal = input as PatchProposal;
      if (!proposal || typeof proposal !== 'object' || !Array.isArray(proposal.changes)) {
        return fail('INVALID_INPUT', 'validate_patch requires a PatchProposal object.');
      }
      return ok(await dryRunPatchProposal(proposal));
    }
  });

  registry.register({
    name: 'build_patch_graph',
    description: 'Project a full PatchProposal into the v0.5 graph patch IR for review.',
    permission: 'analyze',
    permissionLevel: 'analyze',
    // Same whole-input-is-the-proposal contract as validate_patch. With only
    // `changes` declared, a proposal missing opId produced ok:true carrying
    // node id "op:undefined" and summary "op=undefined files=1" — polluted
    // output with no error anywhere in the chain.
    inputSchema: {
      opId: 'string',
      workspaceId: 'string',
      changes: 'array',
      title: 'string?',
      author: 'string?',
      mode: 'string?',
      createdAt: 'string?'
    },
    run: (input) => {
      const proposal = input as PatchProposal;
      if (!proposal || typeof proposal !== 'object' || !Array.isArray(proposal.changes)) {
        return fail('INVALID_INPUT', 'build_patch_graph requires a PatchProposal object.');
      }
      const graph = buildGraphPatchFromProposal(proposal);
      return ok({ graph, summaryText: summarizeGraphPatch(graph) });
    }
  });

  registry.register({
    name: 'assess_edit_risk',
    description: 'Assess Files-mode edit risk and resolve writer contract for an indexed file snapshot.',
    permission: 'analyze',
    permissionLevel: 'analyze',
    inputSchema: {
      // `file` can only be declared as a bare object: ToolInputShape is
      // Record<string, string> and cannot express nested required fields.
      // The run body checks them explicitly and names what is missing.
      file: 'object',
      truncated: 'boolean?',
      structuredEditable: 'boolean?',
      parseStatus: 'enum:unparsed|parsed|partial|unsupported|failed?',
      changeKind: 'enum:text|structured|binary?'
    },
    run: (input) => {
      const value = asRecord(input);
      const file = value.file as IndexedFile | undefined;
      if (!file || typeof file !== 'object' || typeof file.sourceUri !== 'string') {
        return fail('INVALID_INPUT', 'assess_edit_risk requires an IndexedFile in { file }.');
      }
      // ToolInputShape is Record<string, string>: it can say `file: 'object'`
      // but cannot express which inner fields are required. Checking only
      // sourceUri let a half-built file through, and isTextLikeIndexedFile
      // then threw on extension.toLowerCase() — surfacing as a bare
      // TOOL_EXCEPTION that named no field. Hard constraint: failures must
      // return structured diagnostics, not swallowed or anonymous exceptions.
      const missingFileFields = (['extension', 'compoundExtension'] as const)
        .filter((field) => typeof file[field] !== 'string');
      if (missingFileFields.length > 0) {
        return fail(
          'INVALID_INPUT',
          `assess_edit_risk 的 file 缺少必要字段:${missingFileFields.join('、')}。`
            + ' 请传入完整的 IndexedFile(search_resources 的返回项即为完整形态)。',
          { missingFileFields, requiredFileFields: ['sourceUri', 'extension', 'compoundExtension'] }
        );
      }
      const riskOptions = {
        ...(value.truncated === true ? { truncated: true as const } : {}),
        ...(typeof value.structuredEditable === 'boolean' ? { structuredEditable: value.structuredEditable } : {}),
        ...(typeof value.parseStatus === 'string' ? { parseStatus: value.parseStatus } : {})
      };
      const risk = assessEditRisk(file, riskOptions);
      const contract = resolveWriterContract(file);
      const gate = evaluateWriterGate({
        file,
        changeKind: value.changeKind === 'structured' || value.changeKind === 'binary' ? value.changeKind : 'text',
        riskOptions
      });
      return ok({ risk, contract, gate });
    }
  });

  registry.register({
    name: 'read_param_fields',
    description: 'Read live PARAM field values from the opened gameparam container. '
      + 'Pass table name, row ids and field ids. Do not parse Smithbox XML or unpack BND yourself.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: {
      table: 'string',
      rowIds: 'array',
      fieldIds: 'array',
      containerPath: 'string?'
    },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'read');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const table = asString(value.table);
      const rowIds = asIdList(value.rowIds);
      const fieldIds = asStringList(value.fieldIds);
      if (!table || rowIds.length === 0 || fieldIds.length === 0) {
        return fail('INVALID_INPUT', 'read_param_fields 需要 table、rowIds、fieldIds。');
      }
      const containerPath = asOptionalString(value.containerPath);
      const result = await readParamFields({
        edit: edit.session,
        queries: [{ table, rowIds, fieldIds }],
        ...(containerPath ? { containerPath } : {})
      });
      if (!result.ok) return fail(result.error.code, result.error.message, result.error.details);
      return ok(result);
    }
  });

  registry.register({
    name: 'mutate_param_fields',
    description: 'Set absolute PARAM field values through Patch Engine (write-param + write-bnd4). '
      + 'edits: [{ table, rowId, fieldId, value }]. Never multiply current values. '
      + 'Do not parse Smithbox XML, scan BND, or write file_replace by hand.',
    permission: 'commit',
    permissionLevel: 'commit',
    inputSchema: {
      edits: 'array',
      containerPath: 'string?'
    },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'write');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const edits = asParamEdits(value.edits);
      if (!edits.ok) return fail(edits.code, edits.message);
      const containerPath = asOptionalString(value.containerPath);
      const result = await setParamFields({
        edit: edit.session,
        edits: edits.edits,
        ...(containerPath ? { containerPath } : {})
      });
      if (!result.ok) return fail(result.error.code, result.error.message, result.error.details);
      return ok(result);
    }
  });

  registry.register({
    name: 'read_fmg_entries',
    description: 'Read live FMG text entries from a confirmed msgbnd table. '
      + 'Pass table name (logical, e.g. Title) and entry ids. Do not treat FMG as UTF-8.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: {
      table: 'string',
      ids: 'array',
      containerPath: 'string?',
      lang: 'string?'
    },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'read');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const table = asString(value.table);
      const ids = asIdList(value.ids);
      if (!table || ids.length === 0) {
        return fail('INVALID_INPUT', 'read_fmg_entries 需要 table、ids。');
      }
      const containerPath = asOptionalString(value.containerPath);
      const lang = asOptionalString(value.lang);
      const result = await readFmgEntries({
        edit: edit.session,
        table,
        ids,
        ...(containerPath ? { containerPath } : {}),
        ...(lang ? { lang } : {})
      });
      if (!result.ok) return fail(result.error.code, result.error.message, result.error.details);
      return ok(result);
    }
  });

  registry.register({
    name: 'mutate_fmg_entries',
    description: 'Set FMG entry text through Patch Engine (write-fmg mutations[]). '
      + 'edits: [{ table, id, text }]. One table per call. Do not propose_text_patch on .fmg/.msgbnd.',
    permission: 'commit',
    permissionLevel: 'commit',
    inputSchema: {
      edits: 'array',
      containerPath: 'string?',
      lang: 'string?'
    },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'write');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const edits = asFmgEdits(value.edits);
      if (!edits.ok) return fail(edits.code, edits.message);
      const containerPath = asOptionalString(value.containerPath);
      const lang = asOptionalString(value.lang);
      const result = await setFmgEntries({
        edit: edit.session,
        edits: edits.edits,
        ...(containerPath ? { containerPath } : {}),
        ...(lang ? { lang } : {})
      });
      if (!result.ok) return fail(result.error.code, result.error.message, result.error.details);
      return ok(result);
    }
  });

  registry.register({
    name: 'read_emevd_outline',
    description: 'Read event IDs and instruction counts from an overlay EMEVD file. '
      + 'Does not parse a second native format; uses Bridge read-emevd-document.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { file: 'string' },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'read');
      if (!('session' in edit)) return edit;
      const file = asString(asRecord(input).file);
      if (!file) return fail('INVALID_INPUT', 'read_emevd_outline 需要 file。');
      const result = await readEmevdOutline({ edit: edit.session, file });
      if (!result.ok) return fail(result.error?.code ?? 'EMEVD_READ_FAILED', result.error?.message ?? '读取失败。');
      return ok(result);
    }
  });

  registry.register({
    name: 'apply_emevd_dsl',
    description: 'Compile and commit an EMEVD DSL (patch or DarkScript) through the existing '
      + 'four-view submit path. Do not overwrite .emevd.dcx as text. Requires imported EMEDF.',
    permission: 'commit',
    permissionLevel: 'commit',
    inputSchema: {
      file: 'string',
      dsl: 'string',
      mode: 'enum:patch|dark-script?',
      emedfPath: 'string?'
    },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'write');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const file = asString(value.file);
      const dsl = asString(value.dsl);
      if (!file || !dsl) return fail('INVALID_INPUT', 'apply_emevd_dsl 需要 file 与 dsl。');
      const mode = value.mode === 'dark-script' ? 'dark-script' as const : 'patch' as const;
      const emedfPath = asOptionalString(value.emedfPath);
      const result = await applyEmevdDsl({
        edit: edit.session,
        file,
        dsl,
        mode,
        ...(emedfPath ? { emedfPath } : {})
      });
      if (!result.ok) return fail(result.error?.code ?? 'EMEVD_DSL_REJECTED', result.error?.message ?? '提交失败。');
      return ok(result);
    }
  });

  registry.register({
    name: 'read_tae_events',
    description: 'Read TAE animation events by address strings (c1050#A0200.e0; one per file). '
      + 'Events live inside anibnd; do not unpack BND or treat anibnd as text.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { file: 'string', /* 可选地址过滤 */ addresses: 'array?' },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'read');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const file = asString(value.file);
      const addresses = asStringList(value.addresses);
      if (!file) return fail('INVALID_INPUT', 'read_tae_events 需要 file。');
      const result = await readTaeEvents({ edit: edit.session, file, ...(addresses.length > 0 ? { addresses } : {}) });
      if (!result.ok) return fail(result.error.code, result.error.message, result.error.details);
      return ok(result);
    }
  });

  registry.register({
    name: 'mutate_tae_event_times',
    description: 'Set TAE event start/end frames through Patch Engine (write-tae-document '
      + 'update-event-times). edits: [{ address: c1050#A0200.e0, startFrame?, endFrame? }]. '
      + 'Frames are 30fps; converting to seconds happens in the facade. Undecoded param fields are not settable.',
    permission: 'commit',
    permissionLevel: 'commit',
    inputSchema: { file: 'string', edits: 'array' },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'write');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const file = asString(value.file);
      const edits = asTaeTimeEdits(value.edits);
      if (!file) return fail('INVALID_INPUT', 'mutate_tae_event_times 需要 file。');
      if (!edits.ok) return fail(edits.code, edits.message);
      if (edits.edits.length === 0) return fail('INVALID_INPUT', 'mutate_tae_event_times 需要非空 edits 数组。');
      const result = await setTaeEventTimes({ edit: edit.session, file, edits: edits.edits });
      if (!result.ok) return fail(result.error.code, result.error.message, result.error.details);
      return ok(result);
    }
  });

  registry.register({
    name: 'read_msb_parts',
    description: 'Read MSB map parts by address strings (m11_01_00_00#c1050_0000; one per file). '
      + 'Returns part position/rotation/scale. Do not feed msb to propose_text_patch.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { file: 'string', /* 可选地址过滤 */ addresses: 'array?' },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'read');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const file = asString(value.file);
      const addresses = asStringList(value.addresses);
      if (!file) return fail('INVALID_INPUT', 'read_msb_parts 需要 file。');
      const result = await readMsbParts({ edit: edit.session, file, ...(addresses.length > 0 ? { addresses } : {}) });
      if (!result.ok) return fail(result.error.code, result.error.message, result.error.details);
      return ok(result);
    }
  });

  registry.register({
    name: 'mutate_msb_part_transform',
    description: 'Set MSB part position/rotation/scale through Patch Engine (write-msb '
      + 'msb_set_part_position / msb_set_part_transform). edits: [{ address: m11_01_00_00#c1050_0000, posX?, posY?, posZ?, rotX?, rotY?, rotZ?, scaleX?, scaleY?, scaleZ? }].',
    permission: 'commit',
    permissionLevel: 'commit',
    inputSchema: { file: 'string', edits: 'array' },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'write');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const file = asString(value.file);
      const edits = asMsbTransformEdits(value.edits);
      if (!file) return fail('INVALID_INPUT', 'mutate_msb_part_transform 需要 file。');
      if (!edits.ok) return fail(edits.code, edits.message);
      if (edits.edits.length === 0) return fail('INVALID_INPUT', 'mutate_msb_part_transform 需要非空 edits 数组。');
      const result = await setMsbPartTransform({ edit: edit.session, file, edits: edits.edits });
      if (!result.ok) return fail(result.error.code, result.error.message, result.error.details);
      return ok(result);
    }
  });

  registry.register({
    name: 'commit_patch',
    description: 'Commit a PatchProposal through Patch Engine (staging, backup, hash check, rollback metadata). '
      + 'Pass the object returned by propose_text_patch. Does not write until the user approves in the Agent panel.',
    permission: 'commit',
    permissionLevel: 'commit',
    inputSchema: {
      opId: 'string',
      workspaceId: 'string',
      changes: 'array',
      title: 'string?',
      author: 'string?',
      mode: 'string?',
      createdAt: 'string?'
    },
    run: async (input, context) => {
      const proposal = input as PatchProposal;
      if (!proposal || typeof proposal !== 'object' || !Array.isArray(proposal.changes)) {
        return fail('INVALID_INPUT', 'commit_patch requires a PatchProposal object.');
      }
      if (!context.session || !context.operationLogStore || !context.backupBaseDir) {
        return fail(
          'COMMIT_CONTEXT_REQUIRED',
          '提交需要主进程注入的生产上下文（session / operationLogStore / backupBaseDir）。'
        );
      }
      if (!context.confirmation?.id || context.confirmation.subjects.length === 0) {
        return fail(
          'EDIT_CONFIRMATION_REQUIRED',
          '提交需要用户在 Agent 审批卡确认后签发的写入回执。'
        );
      }
      const overlayRoot = context.session.layers.overlayRoot;
      const resolvedChanges = [];
      for (const change of proposal.changes) {
        if (typeof change.targetPath !== 'string' || change.targetPath.trim() === '') {
          return fail('INVALID_INPUT', 'commit_patch 的每条 change 都需要 targetPath。');
        }
        const absolute = isAbsolute(change.targetPath)
          ? change.targetPath
          : join(overlayRoot, change.targetPath);
        const writable = context.session.resolveWritablePath(absolute, change.layer ?? 'overlay');
        if (!writable.ok || !writable.absolutePath) {
          const diagnostic = writable.diagnostics[0];
          return fail(
            diagnostic?.code ?? 'WRITE_OUTSIDE_OVERLAY',
            diagnostic?.message ?? '目标不在当前打开的工作区里，无法写入。',
            { targetPath: change.targetPath }
          );
        }
        resolvedChanges.push({ ...change, targetPath: writable.absolutePath });
      }
      const result = await commitPatchProposal(
        { ...proposal, changes: resolvedChanges, author: proposal.author === 'user' ? 'user' : 'ai' },
        {
          session: context.session,
          operationLog: context.operationLogStore,
          workspaceRoot: overlayRoot,
          backupRoot: context.backupBaseDir,
          ...(context.recoveryDir ? { recoveryDir: context.recoveryDir } : {})
        }
      );
      const failed = result.diagnostics.some((item) => item.severity === 'error')
        || result.changedFiles.length === 0;
      if (failed) {
        const diagnostic = result.diagnostics.find((item) => item.severity === 'error');
        return fail(
          diagnostic?.code ?? 'COMMIT_FAILED',
          diagnostic?.message ?? 'Patch Engine 提交失败，工作区未被修改。',
          { opId: result.opId, diagnostics: result.diagnostics }
        );
      }
      return ok(result);
    }
  });

  registry.register({
    name: 'list_operations',
    description: 'List Patch Engine operation log / patch history entries for the active workspace.',
    permission: 'analyze',
    permissionLevel: 'analyze',
    run: async (_input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      // 优先用主进程注入的生产 SQLite store；没有注入时退回内存 store（测试/离线
      // 形态），不再把「内存空日志」冒充生产日志 —— 主进程 ai.runAgent 已注入。
      const store = context.operationLogStore ?? getDefaultOperationLogStore();
      return ok({
        operations: await store.list(ws.workspaceId),
        history: await store.history(ws.workspaceId)
      });
    }
  });

  registry.register({
    name: 'rollback_operation',
    description: 'Rollback a committed operation from its backup. Requires full-permission mode.',
    permission: 'rollback',
    permissionLevel: 'rollback',
    inputSchema: { opId: 'string' },
    run: async (input, context) => {
      const value = asRecord(input);
      const opId = asString(value.opId);
      if (!opId) return fail('INVALID_INPUT', 'rollback_operation requires opId.');
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      // 回滚必须走生产上下文：session（可写路径权威校验）、持久 store（幂等与
      // 审计）、备份/恢复目录（逆向事务的还原点）。缺任一即干净失败，绝不回退
      // 到内存 store —— 那会把「没有备份」伪装成「已回滚」。
      if (!context.session || !context.operationLogStore || !context.backupBaseDir || !context.recoveryDir) {
        return fail(
          'ROLLBACK_CONTEXT_REQUIRED',
          '回滚需要主进程注入的生产上下文（session / operationLogStore / backupBaseDir / recoveryDir）。'
        );
      }
      const result = await rollbackOperation({
        opId,
        store: context.operationLogStore,
        session: context.session,
        backupBaseDir: context.backupBaseDir,
        recoveryDir: context.recoveryDir,
        author: 'ai',
        ...(context.confirmation ? { confirmation: context.confirmation } : {})
      });
      // rollbackOperation 返回自带 ok 字段的结果对象，不能再用 ok() 整体包装
      // —— 那会把失败状态（EDIT_CONFIRMATION_REQUIRED 等）吞成 ToolResult.ok=true。
      if (!result.ok) {
        const diagnostic = result.diagnostics[0];
        return fail(
          diagnostic?.code ?? 'ROLLBACK_FAILED',
          diagnostic?.message ?? '回滚失败。',
          { opId: result.opId }
        );
      }
      return ok(result);
    }
  });

  return registry;
}

export function summarizeReferences(edges: ReferenceEdge[]): { high: number; medium: number; low: number; total: number } {
  return {
    high: edges.filter((edge) => edge.confidence === 'high').length,
    medium: edges.filter((edge) => edge.confidence === 'medium').length,
    low: edges.filter((edge) => edge.confidence === 'low').length,
    total: edges.length
  };
}

function normalizePermissionLevel(permission: ToolPermission): AiToolPermissionLevel {
  if (
    permission === 'read'
    || permission === 'analyze'
    || permission === 'propose'
    || permission === 'stage'
    || permission === 'validate'
    || permission === 'commit'
    || permission === 'rollback'
  ) {
    return permission;
  }
  if (permission === 'plan' || permission === 'write') {
    return legacyPermissionToLevel(permission);
  }
  return 'read';
}

function ok<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

function fail(code: string, message: string, details?: unknown): ToolResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details })
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function asString(value: unknown, fallback?: string): string {
  return typeof value === 'string' ? value : fallback ?? '';
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requireEditSession(
  context: ToolContext,
  purpose: 'read' | 'write'
): { ok: true; session: ReturnType<typeof nativeEditSessionFromContext> } | ToolResult<never> {
  if (!context.session) {
    return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
  }
  if (purpose === 'write') {
    if (!context.operationLogStore || !context.backupBaseDir || !context.recoveryDir) {
      return fail(
        'COMMIT_CONTEXT_REQUIRED',
        '提交需要主进程注入的生产上下文（session / operationLogStore / backupBaseDir / recoveryDir）。'
      );
    }
    if (!context.confirmation?.id || context.confirmation.subjects.length === 0) {
      return fail('EDIT_CONFIRMATION_REQUIRED', '提交需要用户在 Agent 审批卡确认后签发的写入回执。');
    }
  }
  const backupBaseDir = context.backupBaseDir ?? join(context.session.layers.overlayRoot, '.soulforge-staging', 'backups');
  const recoveryDir = context.recoveryDir ?? join(context.session.layers.overlayRoot, '.soulforge-staging', 'recovery');
  return {
    ok: true,
    session: nativeEditSessionFromContext({
      session: context.session,
      operationLog: context.operationLogStore ?? getDefaultOperationLogStore(),
      backupBaseDir,
      recoveryDir,
      ...(context.confirmation ? { confirmation: context.confirmation } : {})
    })
  };
}

function nativeFormatHint(targetUri: string, targetPath: string): string | null {
  const haystack = `${targetUri} ${targetPath}`.toLowerCase();
  if (/\.(parambnd|param)(\.dcx)?(\b|$)/.test(haystack) || haystack.includes('gameparam')) {
    return '这是 PARAM 容器，请用 read_param_fields / mutate_param_fields，不要走文本补丁。';
  }
  if (/\.(fmg|msgbnd)(\.dcx)?(\b|$)/.test(haystack)) {
    return '这是 FMG 文本表，请用 FMG 门面（mutate_fmg_entries），不要把词条当 UTF-8 文件覆盖。';
  }
  if (/\.emevd(\.dcx)?(\b|$)/.test(haystack)) {
    return '这是 EMEVD 事件，请用 apply_emevd_dsl，不要把二进制当文本补丁。';
  }
  if (/\.(anibnd|tae)(\.dcx)?(\b|$)/.test(haystack)) {
    return '这是 TAE 动作文档，请用 read_tae_events / mutate_tae_event_times，不要把 anibnd/tae 当文本补丁。';
  }
  if (/\.msb(\.dcx)?(\b|$)/.test(haystack)) {
    return '这是 MSB 地图文档，请用 read_msb_parts / mutate_msb_part_transform，不要把 msb 当文本补丁。';
  }
  if (/\.(dcx|bnd)\b/.test(haystack)) {
    return '这是打包原生格式，禁止 propose_text_patch。请用对应的 PARAM / FMG / EMEVD / 明文脚本门面。';
  }
  return null;
}

function asIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'number' ? item : Number(item)))
    .filter((item) => Number.isInteger(item));
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function asParamEdits(value: unknown): { ok: true; edits: ParamFieldEdit[] } | { ok: false; code: string; message: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, code: 'INVALID_INPUT', message: 'mutate_param_fields 需要非空 edits 数组。' };
  }
  const edits: ParamFieldEdit[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const table = asString(record.table);
    const fieldId = asString(record.fieldId);
    const rowId = asNumber(record.rowId, Number.NaN);
    if (!table || !fieldId || !Number.isInteger(rowId)) {
      return { ok: false, code: 'INVALID_INPUT', message: '每条 edit 需要 table、rowId、fieldId、value。' };
    }
    const raw = record.value;
    if (typeof raw !== 'number' && typeof raw !== 'string' && typeof raw !== 'boolean') {
      return { ok: false, code: 'INVALID_INPUT', message: `${table}#${rowId}.${fieldId} 的 value 必须是数字、字符串或布尔。` };
    }
    edits.push({ table, rowId, fieldId, value: raw });
  }
  return { ok: true, edits };
}

function asFmgEdits(value: unknown): { ok: true; edits: FmgEntryEdit[] } | { ok: false; code: string; message: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, code: 'INVALID_INPUT', message: 'mutate_fmg_entries 需要非空 edits 数组。' };
  }
  const edits: FmgEntryEdit[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const table = asString(record.table);
    const text = typeof record.text === 'string' ? record.text : '';
    const id = asNumber(record.id, Number.NaN);
    if (!table || !Number.isInteger(id)) {
      return { ok: false, code: 'INVALID_INPUT', message: '每条 edit 需要 table、id、text。' };
    }
    if (typeof record.text !== 'string') {
      return { ok: false, code: 'INVALID_INPUT', message: `${table}#${id} 的 text 必须是字符串。` };
    }
    edits.push({ table, id, text });
  }
  return { ok: true, edits };
}

function asTaeTimeEdits(value: unknown): { ok: true; edits: Array<{ address: string; startFrame?: number; endFrame?: number }> } | { ok: false; code: string; message: string } {
  if (!Array.isArray(value)) {
    return { ok: false, code: 'INVALID_INPUT', message: 'mutate_tae_event_times 的 edits 必须是数组。' };
  }
  const edits: Array<{ address: string; startFrame?: number; endFrame?: number }> = [];
  for (const item of value) {
    const record = asRecord(item);
    const address = asString(record.address);
    if (!address) {
      return { ok: false, code: 'INVALID_INPUT', message: '每条 edit 需要 address（格式 c1050#A0200.e0）。' };
    }
    const edit: { address: string; startFrame?: number; endFrame?: number } = { address };
    if (record.startFrame !== undefined) {
      const frame = asNumber(record.startFrame, Number.NaN);
      if (!Number.isFinite(frame)) return { ok: false, code: 'INVALID_INPUT', message: `${address}.startFrame 必须是有限数字。` };
      edit.startFrame = frame;
    }
    if (record.endFrame !== undefined) {
      const frame = asNumber(record.endFrame, Number.NaN);
      if (!Number.isFinite(frame)) return { ok: false, code: 'INVALID_INPUT', message: `${address}.endFrame 必须是有限数字。` };
      edit.endFrame = frame;
    }
    edits.push(edit);
  }
  return { ok: true, edits };
}

const MSB_TRANSFORM_FIELDS = ['posX', 'posY', 'posZ', 'rotX', 'rotY', 'rotZ', 'scaleX', 'scaleY', 'scaleZ'] as const;

function asMsbTransformEdits(value: unknown): { ok: true; edits: MsbPartTransformEdit[] } | { ok: false; code: string; message: string } {
  if (!Array.isArray(value)) {
    return { ok: false, code: 'INVALID_INPUT', message: 'mutate_msb_part_transform 的 edits 必须是数组。' };
  }
  const edits: MsbPartTransformEdit[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const address = asString(record.address);
    if (!address) {
      return { ok: false, code: 'INVALID_INPUT', message: '每条 edit 需要 address（格式 m11_01_00_00#c1050_0000）。' };
    }
    const edit: MsbPartTransformEdit = { address };
    for (const field of MSB_TRANSFORM_FIELDS) {
      if (record[field] === undefined) continue;
      const raw = record[field];
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return { ok: false, code: 'INVALID_INPUT', message: `${address}.${field} 必须是有限数字。` };
      }
      Object.assign(edit, { [field]: raw });
    }
    edits.push(edit);
  }
  return { ok: true, edits };
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asResourceKinds(value: unknown): ResourceKind[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed = new Set<ResourceKind>(ALL_RESOURCE_KINDS);
  const kinds = value.filter((item): item is ResourceKind => typeof item === 'string' && allowed.has(item as ResourceKind));
  return kinds.length > 0 ? kinds : undefined;
}

function asRagFamilies(value: unknown): RagChunkFamily[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed = new Set<RagChunkFamily>(RAG_CHUNK_FAMILIES);
  const families = value.filter((item): item is RagChunkFamily => typeof item === 'string' && allowed.has(item as RagChunkFamily));
  return families.length > 0 ? families : undefined;
}

function resolveRagCorpus(context: ToolContext): RagCorpus | null {
  if (context.rag && context.rag.chunks.length > 0) return context.rag;
  if (context.workspaceIndex) return buildRagCorpus(context.workspaceIndex);
  return null;
}

function asReferenceDirection(value: unknown): 'from' | 'to' | 'both' {
  return value === 'from' || value === 'to' || value === 'both' ? value : 'both';
}

function asPatchMode(value: unknown, fallback: ToolContext['mode']): PatchMode {
  if (value === 'plan' || value === 'normal' || value === 'fullPermission') return value;
  return fallback;
}

/**
 * Handler-side normalizers for every `enum:`-declared field, keyed
 * `toolName.fieldName`. Exported so the schema gate can prove each declared
 * value is actually accepted rather than silently defaulted.
 *
 * A declaration is free to list a value the handler does not accept — that
 * costs nothing at compile time and nothing at runtime, but it makes the model
 * pass a value it believes is legal and receive a different one. Reading the
 * real normalizers (instead of restating the accepted sets in the gate) keeps
 * that check from becoming a second copy that drifts.
 */
export const ENUM_FIELD_NORMALIZERS: Record<string, (value: string) => string> = {
  'find_references.direction': (value) => asReferenceDirection(value),
  // asPatchMode falls back to the session mode. Probing with a sentinel
  // fallback keeps every declared value testable — using a real mode as the
  // fallback would make that one value indistinguishable between "accepted"
  // and "rejected then defaulted".
  'propose_text_patch.mode': (value) => asPatchMode(value, '__unaccepted__' as PatchMode),
  'apply_emevd_dsl.mode': (value) => (value === 'patch' || value === 'dark-script' ? value : '__unaccepted__'),
  // The handler passes any string through (`typeof === 'string'`), so all
  // declared values are accepted. The declaration is deliberately narrower
  // than the handler here: narrowing only under-promises to the model, which
  // is the safe direction. assessEditRisk itself only branches on
  // 'unsupported' / 'failed' (writerContract.ts:273).
  'assess_edit_risk.parseStatus': (value) => value,
  'assess_edit_risk.changeKind': (value) => (value === 'structured' || value === 'binary' ? value : 'text')
};
