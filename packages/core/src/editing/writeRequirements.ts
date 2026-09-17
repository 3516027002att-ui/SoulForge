/** T09 写入要求：从实际修改 payload 逐项提取目标及所需读取形状；未分类工具失败关闭。 */
import { resolveGameparamContainer } from '../param/containerParamEdit.js';
import { ProofError } from './nativeReadProofStore.js';
import { paramObjectKey, paramOuterKey, emevdObjectKey } from './proofIdentities.js';
import {
  outerFileKey, fmgObjectKey, fmgContainerKey,
  taeObjectKey, parseTaeAddress,
  msbObjectKey, msbAddressKey, msbModifiedFields
} from './proofIdentities.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';
import type { HostResolvedEmevdEventTarget } from '../ai/toolRegistry.js';

export type WriteRequiredShape = 'fields' | 'full-event' | 'full-script';

export interface WriteTargetRequirement {
  objectKey: string;
  outerSourceKey: string;
  requiredFields?: string[];
  requiredShape?: WriteRequiredShape;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function intOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function paramEdits(input: unknown, outerSourceKey: string): WriteTargetRequirement[] {
  const edits = recordOf(input).edits;
  if (!Array.isArray(edits) || edits.length === 0) throw new Error('WRITE_REQUIREMENT_EMPTY_EDITS');
  return edits.map((edit) => {
    const record = recordOf(edit);
    const table = stringOf(record.table) ?? '?';
    const rowId = intOf(record.rowId);
    const rowIndex = intOf(record.rowIndex);
    const fieldId = stringOf(record.fieldId);
    if (!fieldId || rowId === undefined) throw new Error('WRITE_REQUIREMENT_MISSING_FIELD');
    const fields = [fieldId];
    const requirement: WriteTargetRequirement = {
      objectKey: paramObjectKey({
        outerKey: outerSourceKey, table, rowId,
        ...(rowIndex === undefined ? {} : { rowIndex }),
        fieldId
      }),
      outerSourceKey,
      requiredFields: fields,
      requiredShape: 'fields'
    };
    return requirement;
  });
}

/**
 * 从实际修改 payload 构建写入要求。不从模型填写的 task target 取目标。
 * 未覆盖的修改/提交工具一律抛错（失败关闭），不得默认放行。
 */
export function buildWriteRequirement(toolName: string, input: unknown, outerSourceKey: string): WriteTargetRequirement[] {
  switch (toolName) {
    case 'mutate_param_fields':
      return paramEdits(input, outerSourceKey);
    case 'mutate_fmg_entries': {
      const entries = recordOf(input).entries;
      if (!Array.isArray(entries) || entries.length === 0) throw new Error('WRITE_REQUIREMENT_EMPTY_EDITS');
      return entries.map((entry) => {
        const record = recordOf(entry);
        const textId = intOf(record.textId);
        if (textId === undefined) throw new Error('WRITE_REQUIREMENT_MISSING_FIELD');
        return {
          objectKey: `fmg|${stringOf(record.table) ?? '?'}|${textId}`,
          outerSourceKey,
          requiredFields: ['text'],
          requiredShape: 'fields' as const
        };
      });
    }
    case 'apply_emevd_dsl': {
      const events = recordOf(input).events ?? recordOf(input).changes;
      const list = Array.isArray(events) ? events : [input];
      return list.map((event) => {
        const record = recordOf(event);
        const eventId = intOf(record.eventId);
        if (eventId === undefined) throw new Error('WRITE_REQUIREMENT_MISSING_FIELD');
        return { objectKey: `emevd|${eventId}`, outerSourceKey, requiredShape: 'full-event' as const };
      });
    }
    case 'mutate_luabnd_script': {
      const record = recordOf(input);
      const chain = Array.isArray(record.childChain) ? record.childChain.join('/') : '?';
      return [{ objectKey: `script|${chain}`, outerSourceKey, requiredShape: 'full-script' as const }];
    }
    case 'mutate_tae_event_times': {
      const record = recordOf(input);
      const animId = intOf(record.animId);
      const eventIndex = intOf(record.eventIndex);
      if (animId === undefined || eventIndex === undefined) throw new Error('WRITE_REQUIREMENT_MISSING_FIELD');
      return [{
        objectKey: `tae|${intOf(record.taeEntryIndex) ?? '?'}|${animId}|${eventIndex}`,
        outerSourceKey,
        requiredFields: ['start', 'end'],
        requiredShape: 'fields' as const
      }];
    }
    case 'mutate_tae_event_fields': {
      const edits = recordOf(input).edits;
      const rawEdits: unknown[] = Array.isArray(edits) ? edits : [input];
      if (rawEdits.length === 0) throw new Error('WRITE_REQUIREMENT_EMPTY_EDITS');
      return rawEdits.map((edit: unknown) => {
        const record = recordOf(edit);
        const parsed = parseTaeAddress(stringOf(record.address) ?? '');
        if (!parsed) throw new Error('WRITE_REQUIREMENT_MISSING_FIELD');
        const fieldName = stringOf(record.fieldName);
        const fieldIndex = intOf(record.fieldIndex);
        if (!fieldName && fieldIndex === undefined) throw new Error('WRITE_REQUIREMENT_MISSING_FIELD');
        return {
          objectKey: taeObjectKey(outerSourceKey, parsed.chrId, parsed.animId, parsed.eventIndex, parsed),
          outerSourceKey,
          requiredFields: [
            ...(fieldName ? [fieldName] : []),
            ...(fieldIndex === undefined ? [] : [`fieldIndex:${fieldIndex}`])
          ],
          requiredShape: 'fields' as const
        };
      });
    }
    case 'mutate_msb_part_transform':
    case 'batch_transform_map_objects': {
      const parts = recordOf(input).parts ?? recordOf(input).transforms ?? [input];
      const list = Array.isArray(parts) ? parts : [parts];
      return list.map((part) => {
        const record = recordOf(part);
        const key = stringOf(record.nativeObjectKey);
        if (!key) throw new Error('WRITE_REQUIREMENT_MISSING_FIELD');
        return { objectKey: `map|${key}`, outerSourceKey, requiredFields: ['transform'], requiredShape: 'fields' as const };
      });
    }
    case 'import_map_from_blender': {
      return [{ objectKey: 'map|blender-import', outerSourceKey, requiredFields: ['mapping'], requiredShape: 'fields' as const }];
    }
    case 'commit_patch': {
      const changes = recordOf(input).changes;
      if (!Array.isArray(changes) || changes.length === 0) throw new Error('WRITE_REQUIREMENT_EMPTY_EDITS');
      // 通用 proposal 不能成为旁路：展开每个 change 的实际目标递归构建。
      return changes.flatMap((change) => {
        const record = recordOf(change);
        const nestedTool = stringOf(record.tool);
        if (!nestedTool) throw new Error('WRITE_REQUIREMENT_MISSING_TOOL');
        return buildWriteRequirement(nestedTool, record.args ?? {}, outerSourceKey);
      });
    }
    default:
      throw new Error(`WRITE_REQUIREMENT_UNCLASSIFIED_TOOL:${toolName}`);
  }
}

/** 注册表级断言：全部生产写入工具都必须有明确 requirement。 */
export function assertAllMutatingToolsClassified(mutatingTools: Iterable<string>): void {
  for (const tool of mutatingTools) {
    buildWriteRequirement(tool, probeInputFor(tool), 'probe-outer');
  }
}

export interface SessionWriteRequirement {
  objectKey: string;
  outerSourceKey: string;
  requiredFields?: string[];
  requiredShape?: WriteRequiredShape;
  /** 主键缺席时回退（仅 FMG 新增条目凭容器读取授权）。 */
  fallback?: SessionWriteRequirement;
}

/** 新边界无法表达时回退旧边界（非 {tool,args} 形态的通用 proposal）。 */
export class LegacyFallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyFallbackError';
  }
}

/**
 * 会话级写入要求：读写两侧用同一外层源推导，保证证明键一致。
 * 仅覆盖证明已生产的读取形态（PARAM 字段、整事件）；其余工具抛
 * ProofError，由调用方回退旧边界或失败关闭。
 */
export async function buildSessionWriteRequirements(
  toolName: string,
  input: unknown,
  session: WorkspaceSession | undefined,
  resolvedEmevdTarget?: HostResolvedEmevdEventTarget,
  depth = 0
): Promise<SessionWriteRequirement[]> {
  const record = typeof input === 'object' && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown> : {};
  const overlayRoot = session?.layers.overlayRoot;
  if (toolName === 'commit_patch') {
    if (depth > 2) throw new ProofError('NATIVE_READ_COVERAGE_INCOMPLETE', 'proposal 嵌套过深。');
    const changes = record.changes;
    if (!Array.isArray(changes) || changes.length === 0) {
      throw new ProofError('NATIVE_READ_COVERAGE_INCOMPLETE', '空 proposal 无写入目标。');
    }
    const nested: SessionWriteRequirement[] = [];
    for (const change of changes) {
      const item = typeof change === 'object' && change !== null ? change as Record<string, unknown> : {};
      const nestedTool = typeof item.tool === 'string' ? item.tool : '';
      // 文本提案等非工具形态 change 走旧边界检查（门禁层回退），不绕过、不误杀。
      if (!nestedTool) throw new LegacyFallbackError('proposal change 不是工具调用形态，回退旧边界。');
      nested.push(...await buildSessionWriteRequirements(nestedTool, item.args ?? {}, session, resolvedEmevdTarget, depth + 1));
    }
    return nested;
  }
  if (toolName === 'mutate_param_fields') {
    if (!overlayRoot) throw new ProofError('NATIVE_READ_REQUIRED', '写入需要工作区会话解析容器身份。');
    const container = await resolveGameparamContainer(
      overlayRoot,
      typeof record.containerPath === 'string' ? record.containerPath : undefined
    );
    if (!container.ok) throw new ProofError('NATIVE_READ_REQUIRED', `写入需要先解析容器：${container.error.message}`);
    const outerKey = paramOuterKey(container.path);
    const edits = record.edits;
    if (!Array.isArray(edits) || edits.length === 0) throw new ProofError('NATIVE_READ_COVERAGE_INCOMPLETE', '空修改无写入目标。');
    return edits.map((edit) => {
      const item = typeof edit === 'object' && edit !== null ? edit as Record<string, unknown> : {};
      const table = typeof item.table === 'string' ? item.table : '';
      const rowId = typeof item.rowId === 'number' ? item.rowId : NaN;
      const fieldId = typeof item.fieldId === 'string' ? item.fieldId : '';
      const rowIndex = typeof item.rowIndex === 'number' ? item.rowIndex : undefined;
      if (!table || !Number.isSafeInteger(rowId) || !fieldId) {
        throw new ProofError('NATIVE_READ_COVERAGE_INCOMPLETE', '修改目标缺少表/行/字段，无法匹配读取证明。');
      }
      return {
        objectKey: paramObjectKey({
          outerKey, table, rowId,
          ...(rowIndex === undefined ? {} : { rowIndex }),
          fieldId
        }),
        outerSourceKey: outerKey,
        requiredFields: [fieldId],
        requiredShape: 'fields' as const
      };
    });
  }
  if (toolName === 'apply_emevd_dsl' && resolvedEmevdTarget?.canonical === true) {
    return [{
      objectKey: emevdObjectKey(resolvedEmevdTarget.sourceUri, resolvedEmevdTarget.eventId),
      outerSourceKey: resolvedEmevdTarget.sourceUri,
      requiredShape: 'full-event' as const
    }];
  }
  if (toolName === 'mutate_fmg_entries') {
    const rawEdits = Array.isArray(record.edits) ? record.edits : [record];
    const topTable = typeof record.table === 'string' ? record.table : '';
    let outerKey: string;
    try {
      outerKey = outerFileKey(overlayRoot, typeof record.containerPath === 'string' ? record.containerPath : undefined);
    } catch {
      throw new ProofError('NATIVE_READ_REQUIRED', 'FMG 写入需要显式容器路径（与读取返回的 containerPath 一致）。');
    }
    if (rawEdits.length === 0) throw new ProofError('NATIVE_READ_COVERAGE_INCOMPLETE', '空修改无写入目标。');
    return rawEdits.map((edit) => {
      const item = typeof edit === 'object' && edit !== null ? edit as Record<string, unknown> : {};
      // 每条 edit 自带表名（工具层允许多表）；无则回退顶层 table。
      const table = typeof item.table === 'string' && item.table.trim() !== '' ? item.table : topTable;
      if (!table) throw new ProofError('NATIVE_READ_COVERAGE_INCOMPLETE', 'FMG 修改缺少表名。');
      const id = typeof item.id === 'number' ? item.id : NaN;
      if (!Number.isSafeInteger(id)) throw new ProofError('NATIVE_READ_COVERAGE_INCOMPLETE', 'FMG 修改缺少条目 id。');
      return {
        objectKey: fmgObjectKey(outerKey, table, id),
        outerSourceKey: outerKey,
        requiredFields: ['text'],
        requiredShape: 'fields' as const,
        fallback: {
          objectKey: fmgContainerKey(outerKey, table),
          outerSourceKey: outerKey,
          requiredFields: [],
          requiredShape: 'fields' as const
        }
      };
    });
  }
  if (toolName === 'mutate_tae_event_times') {
    const rawEdits = Array.isArray(record.edits) ? record.edits : [record];
    let outerKey: string;
    try {
      outerKey = outerFileKey(overlayRoot, typeof record.file === 'string' ? record.file : undefined);
    } catch {
      throw new ProofError('NATIVE_READ_REQUIRED', 'TAE 写入需要显式 file（与读取返回的文件一致）。');
    }
    if (rawEdits.length === 0) throw new ProofError('NATIVE_READ_COVERAGE_INCOMPLETE', '空修改无写入目标。');
    return rawEdits.map((edit) => {
      const item = typeof edit === 'object' && edit !== null ? edit as Record<string, unknown> : {};
      const address = typeof item.address === 'string' ? item.address : '';
      const parsed = parseTaeAddress(address);
      if (!parsed) throw new ProofError('NATIVE_READ_COVERAGE_INCOMPLETE', `TAE 地址无法解析：${address}`);
      const requiredFields = [
        ...(typeof item.startFrame === 'number' ? ['startFrame'] : []),
        ...(typeof item.endFrame === 'number' ? ['endFrame'] : [])
      ];
      if (requiredFields.length === 0) throw new ProofError('NATIVE_READ_COVERAGE_INCOMPLETE', 'TAE 修改未指定时间字段。');
      return {
        objectKey: taeObjectKey(outerKey, parsed.chrId, parsed.animId, parsed.eventIndex, parsed),
        outerSourceKey: outerKey,
        requiredFields,
        requiredShape: 'fields' as const
      };
    });
  }
  if (toolName === 'mutate_tae_event_fields') {
    const rawEdits = Array.isArray(record.edits) ? record.edits : [record];
    let outerKey: string;
    try {
      outerKey = outerFileKey(overlayRoot, typeof record.file === 'string' ? record.file : undefined);
    } catch {
      throw new ProofError('NATIVE_READ_REQUIRED', 'TAE 字段写入需要显式 file（与读取返回的文件一致）。');
    }
    if (rawEdits.length === 0) throw new ProofError('NATIVE_READ_COVERAGE_INCOMPLETE', '空修改无写入目标。');
    return rawEdits.map((edit) => {
      const item = typeof edit === 'object' && edit !== null ? edit as Record<string, unknown> : {};
      const address = typeof item.address === 'string' ? item.address : '';
      const parsed = parseTaeAddress(address);
      if (!parsed) throw new ProofError('NATIVE_READ_COVERAGE_INCOMPLETE', `TAE 地址无法解析：${address}`);
      const fieldName = typeof item.fieldName === 'string' && item.fieldName.trim() !== ''
        ? item.fieldName
        : undefined;
      const fieldIndex = typeof item.fieldIndex === 'number' && Number.isSafeInteger(item.fieldIndex) && item.fieldIndex >= 0
        ? item.fieldIndex
        : undefined;
      if (fieldName === undefined && fieldIndex === undefined) {
        throw new ProofError('NATIVE_READ_COVERAGE_INCOMPLETE', `TAE 字段修改缺少 fieldName/fieldIndex：${address}`);
      }
      return {
        objectKey: taeObjectKey(outerKey, parsed.chrId, parsed.animId, parsed.eventIndex, parsed),
        outerSourceKey: outerKey,
        requiredFields: [
          ...(fieldName === undefined ? [] : [fieldName]),
          ...(fieldIndex === undefined ? [] : [`fieldIndex:${fieldIndex}`])
        ],
        requiredShape: 'fields' as const
      };
    });
  }
  if (toolName === 'mutate_msb_part_transform' || toolName === 'batch_transform_map_objects') {
    let outerKey: string;
    try {
      outerKey = outerFileKey(overlayRoot, typeof record.file === 'string' ? record.file : undefined);
    } catch {
      throw new ProofError('NATIVE_READ_REQUIRED', '地图写入需要显式 file（与读取返回的文件一致）。');
    }
    if (toolName === 'batch_transform_map_objects') {
      const targets = Array.isArray(record.targets) ? record.targets : [];
      if (targets.length === 0) throw new ProofError('NATIVE_READ_COVERAGE_INCOMPLETE', '空 targets 无写入目标。');
      const shared = {
        ...(typeof record.deltaX === 'number' ? { posX: record.deltaX } : {}),
        ...(typeof record.deltaY === 'number' ? { posY: record.deltaY } : {}),
        ...(typeof record.deltaZ === 'number' ? { posZ: record.deltaZ } : {}),
        ...(typeof record.rotDeltaX === 'number' ? { rotX: record.rotDeltaX } : {}),
        ...(typeof record.rotDeltaY === 'number' ? { rotY: record.rotDeltaY } : {}),
        ...(typeof record.rotDeltaZ === 'number' ? { rotZ: record.rotDeltaZ } : {}),
        ...(typeof record.scaleMultiplier === 'number'
          ? { scaleX: record.scaleMultiplier, scaleY: record.scaleMultiplier, scaleZ: record.scaleMultiplier } : {})
      };
      const requiredFields = msbModifiedFields(shared);
      if (requiredFields.length === 0) throw new ProofError('NATIVE_READ_COVERAGE_INCOMPLETE', '批量变换未指定变换字段。');
      return targets.map((target) => {
        if (typeof target !== 'string' || target.trim() === '') {
          throw new ProofError('NATIVE_READ_COVERAGE_INCOMPLETE', '批量变换目标地址缺失。');
        }
        return {
          objectKey: msbAddressKey(outerKey, target),
          outerSourceKey: outerKey,
          requiredFields: [...requiredFields],
          requiredShape: 'fields' as const
        };
      });
    }
    const rawEdits = Array.isArray(record.edits) ? record.edits : [record];
    if (rawEdits.length === 0) throw new ProofError('NATIVE_READ_COVERAGE_INCOMPLETE', '空修改无写入目标。');
    return rawEdits.map((edit) => {
      const item = typeof edit === 'object' && edit !== null ? edit as Record<string, unknown> : {};
      const requiredFields = msbModifiedFields(item);
      if (requiredFields.length === 0) throw new ProofError('NATIVE_READ_COVERAGE_INCOMPLETE', '地图修改未指定变换字段。');
      const nativeOffset = typeof item.nativeOffset === 'number' ? item.nativeOffset : undefined;
      const address = typeof item.address === 'string' ? item.address : '';
      if (nativeOffset !== undefined && Number.isSafeInteger(nativeOffset)) {
        return {
          objectKey: msbObjectKey(outerKey, nativeOffset),
          outerSourceKey: outerKey,
          requiredFields,
          requiredShape: 'fields' as const
        };
      }
      if (address.trim() !== '') {
        return {
          objectKey: msbAddressKey(outerKey, address),
          outerSourceKey: outerKey,
          requiredFields,
          requiredShape: 'fields' as const
        };
      }
      throw new ProofError('NATIVE_READ_COVERAGE_INCOMPLETE', '地图修改缺少 nativeOffset 或 address。');
    });
  }
  throw new ProofError(
    'NATIVE_READ_REQUIRED',
    `工具 ${toolName} 的新证明边界尚未覆盖其读取形态；请使用旧边界或先补充对应读取证明。`
  );
}

function probeInputFor(tool: string): unknown {
  switch (tool) {
    case 'mutate_param_fields': return { edits: [{ table: 'T', rowId: 1, fieldId: 'f', value: 1 }] };
    case 'mutate_fmg_entries': return { entries: [{ table: 'T', textId: 1 }] };
    case 'apply_emevd_dsl': return { events: [{ eventId: 1 }] };
    case 'mutate_luabnd_script': return { childChain: ['a.lua'] };
    case 'mutate_tae_event_times': return { taeEntryIndex: 0, animId: 1, eventIndex: 0 };
    case 'mutate_tae_event_fields': return { taeEntryIndex: 0, animId: 1, eventIndex: 0, fieldIndex: 0, value: 1 };
    case 'mutate_msb_part_transform': return { parts: [{ nativeObjectKey: 'k' }] };
    case 'batch_transform_map_objects': return { parts: [{ nativeObjectKey: 'k' }] };
    case 'import_map_from_blender': return {};
    case 'commit_patch': return { changes: [{ tool: 'mutate_param_fields', args: { edits: [{ table: 'T', rowId: 1, fieldId: 'f', value: 1 }] } }] };
    default: return {};
  }
}
