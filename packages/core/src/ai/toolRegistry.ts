import type {
  AiToolPermissionLevel,
  IndexedFile,
  PatchMode,
  PatchProposal,
  ReferenceEdge,
  ResourceKind
} from '@soulforge/shared';
import { createPatchProposal, dryRunPatchProposal } from '../patch/patchEngine.js';
import { getDefaultOperationLogStore } from '../patch/operationLog.js';
import { rollbackOperation } from '../patch/rollback.js';
import { buildGraphPatchFromProposal, summarizeGraphPatch } from '../patch/graphPatch.js';
import { assessEditRisk, evaluateWriterGate, resolveWriterContract } from '../patch/writerContract.js';
import type { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { ALL_RESOURCE_KINDS } from '../workspace/resourceKinds.js';
import { buildTextAiContext, renderTextAiPrompt } from './aiContextBuilder.js';
import { buildPlaintextScriptEdit } from '../script/plaintextScriptEdit.js';
import { isAiToolPermissionAllowed, legacyPermissionToLevel } from './toolPermissions.js';

/** @deprecated Prefer AiToolPermissionLevel. Kept for older UI labels. */
export type ToolPermission = 'read' | 'plan' | 'write' | AiToolPermissionLevel;

export interface ToolContext {
  workspaceIndex: WorkspaceIndex;
  mode: 'plan' | 'normal' | 'fullPermission';
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
    run: (_input, context) => ok(context.workspaceIndex.getStats())
  });

  registry.register({
    name: 'search_resources',
    description: 'Search indexed workspace files by path, extension, or resource kind.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string', limit: 'number?', kinds: 'array?' },
    run: (input, context) => {
      const value = asRecord(input);
      const query = asString(value.query, '');
      const limit = asNumber(value.limit, 50);
      const kinds = asResourceKinds(value.kinds);
      return ok(context.workspaceIndex.searchResources({ query, limit, ...(kinds ? { kinds } : {}) }));
    }
  });

  registry.register({
    name: 'search_events',
    description: 'Search parsed event symbols.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string', limit: 'number?' },
    run: (input, context) => {
      const value = asRecord(input);
      return ok(context.workspaceIndex.searchEvents(asString(value.query, ''), asNumber(value.limit, 50)));
    }
  });

  registry.register({
    name: 'search_map_entities',
    description: 'Search parsed map entities and regions.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string', limit: 'number?' },
    run: (input, context) => {
      const value = asRecord(input);
      return ok(context.workspaceIndex.searchMapEntities(asString(value.query, ''), asNumber(value.limit, 50)));
    }
  });

  registry.register({
    name: 'search_param_rows',
    description: 'Search parsed param rows.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string', limit: 'number?' },
    run: (input, context) => {
      const value = asRecord(input);
      return ok(context.workspaceIndex.searchParamRows(asString(value.query, ''), asNumber(value.limit, 50)));
    }
  });

  registry.register({
    name: 'search_text_entries',
    description: 'Search parsed text entries.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string', limit: 'number?' },
    run: (input, context) => {
      const value = asRecord(input);
      return ok(context.workspaceIndex.searchTextEntries(asString(value.query, ''), asNumber(value.limit, 50)));
    }
  });

  registry.register({
    name: 'lookup_text_id',
    description: 'Look up parsed text entries by numeric textId and optional category.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { textId: 'number', category: 'string?' },
    run: (input, context) => {
      const value = asRecord(input);
      const textId = asNumber(value.textId, Number.NaN);
      if (!Number.isFinite(textId)) return fail('INVALID_INPUT', 'lookup_text_id requires numeric textId.');
      const category = asOptionalString(value.category);
      const matches = context.workspaceIndex.lookupTextEntries(textId, category);
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
      const value = asRecord(input);
      const textId = asNumber(value.textId, Number.NaN);
      if (!Number.isFinite(textId)) return fail('INVALID_INPUT', 'find_text_references requires numeric textId.');
      const category = asOptionalString(value.category);
      const matches = context.workspaceIndex.lookupTextEntries(textId, category);
      if (matches.length === 0) return fail('TEXT_ENTRY_NOT_FOUND', `No text entry exists for textId ${textId}.`, { category });
      const items = matches.map((entry) => {
        const references = context.workspaceIndex.findReferences(entry.uri, 'to');
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
      const value = asRecord(input);
      const textId = asNumber(value.textId, Number.NaN);
      if (!Number.isFinite(textId)) return fail('INVALID_INPUT', 'explain_text_entry requires numeric textId.');
      const category = asOptionalString(value.category);
      const maxReferences = asNumber(value.maxReferences, 80);
      const maxMarkdownChars = asNumber(value.maxMarkdownChars, 24_000);
      const matches = context.workspaceIndex.lookupTextEntries(textId, category);
      if (matches.length === 0) return fail('TEXT_ENTRY_NOT_FOUND', `No text entry exists for textId ${textId}.`, { category });
      const contexts = matches.map((entry) => {
        const references = context.workspaceIndex.findReferences(entry.uri, 'to');
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
      const value = asRecord(input);
      const uri = asString(value.uri);
      if (!uri) return fail('INVALID_INPUT', 'find_references requires uri.');
      const direction = asReferenceDirection(value.direction);
      return ok(context.workspaceIndex.findReferences(uri, direction));
    }
  });

  registry.register({
    name: 'explain_event',
    description: 'Build an evidence-first explanation input for one event URI.',
    permission: 'analyze',
    permissionLevel: 'analyze',
    inputSchema: { uri: 'string' },
    run: (input, context) => {
      const value = asRecord(input);
      const uri = asString(value.uri);
      if (!uri) return fail('INVALID_INPUT', 'explain_event requires uri.');
      const explanation = context.workspaceIndex.buildEventExplanationInput(uri);
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
      const value = asRecord(input);
      const workspaceId = context.workspaceIndex.workspaceId;
      const targetUri = asString(value.targetUri);
      const targetPath = asString(value.targetPath);
      const newText = asString(value.newText);
      const title = asString(value.title, 'AI text patch proposal');
      const mode = asPatchMode(value.mode, context.mode);

      if (!targetUri || !targetPath || newText === undefined) {
        return fail('INVALID_INPUT', 'propose_text_patch requires targetUri, targetPath, and newText.');
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
    name: 'list_operations',
    description: 'List Patch Engine operation log / patch history entries for the active workspace.',
    permission: 'analyze',
    permissionLevel: 'analyze',
    run: async (_input, context) => {
      const store = getDefaultOperationLogStore();
      return ok({
        operations: await store.list(context.workspaceIndex.workspaceId),
        history: await store.history(context.workspaceIndex.workspaceId)
      });
    }
  });

  registry.register({
    name: 'rollback_operation',
    description: 'Rollback a committed operation from its backup. Requires full-permission mode.',
    permission: 'rollback',
    permissionLevel: 'rollback',
    inputSchema: { opId: 'string' },
    run: async (input) => {
      const value = asRecord(input);
      const opId = asString(value.opId);
      if (!opId) return fail('INVALID_INPUT', 'rollback_operation requires opId.');
      return ok(await rollbackOperation({
        opId,
        store: getDefaultOperationLogStore()
      }));
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
  // The handler passes any string through (`typeof === 'string'`), so all
  // declared values are accepted. The declaration is deliberately narrower
  // than the handler here: narrowing only under-promises to the model, which
  // is the safe direction. assessEditRisk itself only branches on
  // 'unsupported' / 'failed' (writerContract.ts:273).
  'assess_edit_risk.parseStatus': (value) => value,
  'assess_edit_risk.changeKind': (value) => (value === 'structured' || value === 'binary' ? value : 'text')
};
