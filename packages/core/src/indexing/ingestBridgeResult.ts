import type {
  BridgeResult,
  Diagnostic,
  EventExport,
  MapExport,
  MsgExport,
  ParamExport,
  ParamFieldSymbol,
  ParseStatus
} from '@soulforge/shared';
import type { WorkspaceIndex } from './workspaceIndex.js';
import { isKnownResourceKind } from '../workspace/resourceKinds.js';

export interface IngestResult {
  accepted: boolean;
  parseStatus: ParseStatus;
  diagnostics: Diagnostic[];
}

/**
 * Converts structured BridgeResult JSON into WorkspaceIndex symbols.
 *
 * This is intentionally defensive: the bridge is allowed to return partial or
 * unsupported results, but the index must not accept fake/malformed symbols.
 */
export function ingestBridgeResult(index: WorkspaceIndex, result: BridgeResult<unknown>): IngestResult {
  const diagnostics = [...result.diagnostics];

  if (result.parseStatus === 'failed' || result.parseStatus === 'unsupported' || result.parseStatus === 'unparsed') {
    return { accepted: false, parseStatus: result.parseStatus, diagnostics };
  }

  if (!result.data || typeof result.data !== 'object') {
    diagnostics.push({
      severity: 'warning',
      code: 'BRIDGE_RESULT_HAS_NO_DATA',
      message: 'Bridge reported a parsed/partial result without structured data.',
      sourceUri: result.sourceUri
    });
    return { accepted: false, parseStatus: 'partial', diagnostics };
  }

  // resourceKind 越界必须与「合法但不深度摄取」分开报。
  //
  // 实测（2026-08-08）：C# 侧发出的 resourceKind 含 "texture"
  // （BridgeCommandService 的 TPF 路径），而 TS 的 ResourceKind union
  // （packages/shared/src/types.ts:1-14）14 个值里没有它。两侧各写一份枚举、
  // 手工同步、无 codegen、无契约测试，TS 侧也没有任何一处校验 C# 送来的值
  // 是否在 union 内——于是越界值会一路走到下面那条
  // INGEST_RESOURCE_KIND_SKIPPED，与 chr/obj/sfx 这类「合法但 v0.1 不做深度
  // 摄取」的正当情形混成同一条 info 诊断。
  //
  // 两者处置完全不同：后者是设计如此，前者是契约漂移，意味着有一族资源在
  // 类型系统里根本不存在、任何按 union 穷举的下游逻辑都不会覆盖它。混报
  // 等于让漂移永久隐形（硬约束 8：不能静默丢弃，必须结构化诊断）。
  //
  // 判据用 isKnownResourceKind（workspace/resourceKinds.ts:21，权威列表在
  // @soulforge/shared），不自建清单——自建清单的门禁从不扫真实枚举，是本仓库
  // 已记录的假门禁形态。
  if (!isKnownResourceKind(result.resourceKind)) {
    diagnostics.push({
      severity: 'warning',
      code: 'INGEST_RESOURCE_KIND_OUT_OF_CONTRACT',
      message: `Bridge 送来的 resourceKind '${result.resourceKind}' 不在 TS ResourceKind 契约内。`
        + ' 这是 TS↔C# 契约漂移，不是「本版不摄取」：该值在类型系统里不存在，'
        + ' 任何按 union 穷举的下游逻辑都不会覆盖它。需裁定是补进 union 还是让 C# 不再发。',
      sourceUri: result.sourceUri
    });
    return { accepted: false, parseStatus: 'partial', diagnostics };
  }

  if (result.resourceKind === 'event') {
    const parsed = parseEventExport(result.data, result.sourceUri);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.value) index.upsertEventExport(parsed.value);
    return { accepted: Boolean(parsed.value), parseStatus: parsed.value ? result.parseStatus : 'partial', diagnostics };
  }

  if (result.resourceKind === 'map') {
    const parsed = parseMapExport(result.data, result.sourceUri);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.value) index.upsertMapExport(parsed.value);
    return { accepted: Boolean(parsed.value), parseStatus: parsed.value ? result.parseStatus : 'partial', diagnostics };
  }

  if (result.resourceKind === 'param') {
    const parsed = parseParamExport(result.data, result.sourceUri);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.value) index.upsertParamExport(parsed.value);
    return { accepted: Boolean(parsed.value), parseStatus: parsed.value ? result.parseStatus : 'partial', diagnostics };
  }

  if (result.resourceKind === 'msg') {
    const parsed = parseMsgExport(result.data, result.sourceUri);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.value) index.upsertMsgExport(parsed.value);
    return { accepted: Boolean(parsed.value), parseStatus: parsed.value ? result.parseStatus : 'partial', diagnostics };
  }

  // 到这里的 resourceKind 一定在契约内（越界已在上面失败关闭），所以这条
  // 诊断现在只表达一件事：合法资源族，但本版不做深度摄取。info 级是对的。
  diagnostics.push({
    severity: 'info',
    code: 'INGEST_RESOURCE_KIND_SKIPPED',
    message: `Resource kind '${result.resourceKind}' is in contract but not a deep-ingest target for v0.1.`,
    sourceUri: result.sourceUri
  });

  return { accepted: false, parseStatus: result.parseStatus, diagnostics };
}

interface ParsedValue<T> {
  value?: T;
  diagnostics: Diagnostic[];
}

function parseEventExport(value: unknown, sourceUri: string): ParsedValue<EventExport> {
  const diagnostics: Diagnostic[] = [];
  const record = asRecord(value);
  const eventsRaw = record.events;

  if (!Array.isArray(eventsRaw)) return { diagnostics: [missingField(sourceUri, 'events')] };

  const events = eventsRaw.flatMap((eventRaw, index) => {
    const event = asRecord(eventRaw);
    const eventId = asNumber(event.eventId);
    const uri = asString(event.uri) || `event://${sourceUri}/${String(eventId ?? index)}`;
    const instructionsRaw = event.instructions;

    if (eventId === null) {
      diagnostics.push(invalidField(sourceUri, `events[${index}].eventId`));
      return [];
    }

    return [{
      uri,
      sourceUri: asString(event.sourceUri) || sourceUri,
      ...(asString(event.mapId) ? { mapId: asString(event.mapId) } : {}),
      eventId,
      ...(asString(event.name) ? { name: asString(event.name) } : {}),
      instructions: Array.isArray(instructionsRaw) ? instructionsRaw.map((item, instructionIndex) => parseInstruction(item, uri, instructionIndex)) : [],
      ...(event.raw === undefined ? {} : { raw: event.raw })
    }];
  });

  return {
    value: {
      ...(asString(record.mapId) ? { mapId: asString(record.mapId) } : {}),
      events
    },
    diagnostics
  };
}

function parseInstruction(value: unknown, eventUri: string, index: number): EventExport['events'][number]['instructions'][number] {
  const record = asRecord(value);
  const argsRaw = record.args;
  return {
    uri: asString(record.uri) || `${eventUri}/instruction/${index}`,
    index: asNumber(record.index) ?? index,
    ...(asString(record.name) ? { name: asString(record.name) } : {}),
    ...(asString(record.category) ? { category: asString(record.category) } : {}),
    args: Array.isArray(argsRaw) ? argsRaw.map(parseArg) : [],
    ...(record.raw === undefined ? {} : { raw: record.raw })
  };
}

function parseArg(value: unknown): EventExport['events'][number]['instructions'][number]['args'][number] {
  const record = asRecord(value);
  return {
    ...(asString(record.name) ? { name: asString(record.name) } : {}),
    value: parseScalar(record.value),
    ...(isRole(record.role) ? { role: record.role } : {}),
    ...(asString(record.paramName) ? { paramName: asString(record.paramName) } : {}),
    ...(isConfidence(record.confidence) ? { confidence: record.confidence } : {})
  };
}

function parseMapExport(value: unknown, sourceUri: string): ParsedValue<MapExport> {
  const record = asRecord(value);
  const mapId = asString(record.mapId);
  if (!mapId) return { diagnostics: [missingField(sourceUri, 'mapId')] };

  return {
    value: {
      mapId,
      entities: Array.isArray(record.entities) ? record.entities.map((item, index) => parseMapEntity(item, sourceUri, mapId, index)) : [],
      regions: Array.isArray(record.regions) ? record.regions.map((item, index) => parseMapRegion(item, sourceUri, mapId, index)) : []
    },
    diagnostics: []
  };
}

function parseParamExport(value: unknown, sourceUri: string): ParsedValue<ParamExport> {
  const record = asRecord(value);
  const paramName = asString(record.paramName);
  if (!paramName) return { diagnostics: [missingField(sourceUri, 'paramName')] };

  return {
    value: {
      paramName,
      rows: Array.isArray(record.rows) ? record.rows.flatMap((item, index) => parseParamRow(item, sourceUri, paramName, index)) : []
    },
    diagnostics: []
  };
}

function parseMsgExport(value: unknown, sourceUri: string): ParsedValue<MsgExport> {
  const record = asRecord(value);
  return {
    value: {
      ...(asString(record.category) ? { category: asString(record.category) } : {}),
      entries: Array.isArray(record.entries) ? record.entries.flatMap((item, index) => parseTextEntry(item, sourceUri, index)) : []
    },
    diagnostics: []
  };
}

function parseMapEntity(value: unknown, sourceUri: string, mapId: string, index: number): MapExport['entities'][number] {
  const record = asRecord(value);
  const entityId = asNumber(record.entityId);
  const position = asVector3(record.position);
  const rotation = asVector3(record.rotation);
  return {
    uri: asString(record.uri) || `map://${mapId}/entity/${String(entityId ?? index)}`,
    sourceUri: asString(record.sourceUri) || sourceUri,
    mapId,
    ...(entityId === null ? {} : { entityId }),
    name: asString(record.name, `entity_${index}`),
    kind: isMapEntityKind(record.kind) ? record.kind : 'unknown',
    ...(asString(record.model) ? { model: asString(record.model) } : {}),
    ...(position ? { position } : {}),
    ...(rotation ? { rotation } : {}),
    ...(record.raw === undefined ? {} : { raw: record.raw })
  };
}

function parseMapRegion(value: unknown, sourceUri: string, mapId: string, index: number): MapExport['regions'][number] {
  const record = asRecord(value);
  const entityId = asNumber(record.entityId);
  const position = asVector3(record.position);
  const rotation = asVector3(record.rotation);
  return {
    uri: asString(record.uri) || `map://${mapId}/region/${String(entityId ?? index)}`,
    sourceUri: asString(record.sourceUri) || sourceUri,
    mapId,
    ...(entityId === null ? {} : { entityId }),
    name: asString(record.name, `region_${index}`),
    ...(asString(record.shape) ? { shape: asString(record.shape) } : {}),
    ...(position ? { position } : {}),
    ...(rotation ? { rotation } : {}),
    ...(record.size === undefined ? {} : { size: record.size }),
    ...(record.raw === undefined ? {} : { raw: record.raw })
  };
}

function parseParamRow(value: unknown, sourceUri: string, paramName: string, index: number): ParamExport['rows'][number][] {
  const record = asRecord(value);
  const rowId = asNumber(record.rowId);
  if (rowId === null) return [];

  return [{
    uri: asString(record.uri) || `param://${paramName}/${rowId}`,
    sourceUri: asString(record.sourceUri) || sourceUri,
    paramName,
    rowId,
    ...(asString(record.rowName) ? { rowName: asString(record.rowName) } : {}),
    ...(Array.isArray(record.fields) ? { fields: record.fields.map(parseParamField) } : {}),
    ...(record.raw === undefined ? {} : { raw: record.raw })
  }];
}

function parseParamField(value: unknown): ParamFieldSymbol {
  const record = asRecord(value);
  return {
    name: asString(record.name, 'unknown'),
    ...(asString(record.type) ? { type: asString(record.type) } : {}),
    value: parseNullableScalar(record.value)
  };
}

function parseTextEntry(value: unknown, sourceUri: string, index: number): MsgExport['entries'][number][] {
  const record = asRecord(value);
  const textId = asNumber(record.textId);
  const raw = asRecord(record.raw);
  const confidence = isConfidence(record.confidence) ? record.confidence : isConfidence(raw.confidence) ? raw.confidence : undefined;
  if (textId === null) return [];
  return [{
    uri: asString(record.uri) || `msg://${asString(record.category, 'default')}/${textId}`,
    sourceUri: asString(record.sourceUri) || sourceUri,
    ...(asString(record.category) ? { category: asString(record.category) } : {}),
    textId,
    text: asString(record.text, ''),
    ...(confidence ? { confidence } : {}),
    ...(record.raw === undefined ? {} : { raw: record.raw })
  }];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseScalar(value: unknown): string | number | boolean {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value ?? '');
}

function parseNullableScalar(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

function asVector3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [x, y, z] = value;
  return typeof x === 'number' && typeof y === 'number' && typeof z === 'number' ? [x, y, z] : null;
}

function isRole(value: unknown): value is NonNullable<EventExport['events'][number]['instructions'][number]['args'][number]['role']> {
  return value === 'flag' || value === 'eventId' || value === 'entityId' || value === 'regionId' || value === 'paramId' || value === 'textId' || value === 'unknown';
}

function isConfidence(value: unknown): value is 'high' | 'medium' | 'low' {
  return value === 'high' || value === 'medium' || value === 'low';
}

function isMapEntityKind(value: unknown): value is MapExport['entities'][number]['kind'] {
  return value === 'character' || value === 'object' || value === 'asset' || value === 'collision' || value === 'mapPiece' || value === 'unknown';
}

function missingField(sourceUri: string, field: string): Diagnostic {
  return { severity: 'error', code: 'INGEST_MISSING_FIELD', message: `Bridge result is missing required field: ${field}.`, sourceUri };
}

function invalidField(sourceUri: string, field: string): Diagnostic {
  return { severity: 'warning', code: 'INGEST_INVALID_FIELD', message: `Bridge result has invalid field: ${field}.`, sourceUri };
}
