import type {
  BridgeResult,
  Diagnostic,
  EventExport,
  MapExport,
  MsgExport,
  ParamExport,
  ParamFieldSymbol,
  ParseStatus,
  TaeExport,
  TaeEventSymbol
} from '@soulforge/shared';
import { formatAnimCode, formatChrId, formatMapArea } from '@soulforge/shared';
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

  if (result.resourceKind === 'action') {
    const parsed = parseTaeExport(result.data, result.sourceUri, result.sourcePath);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.value) index.upsertTaeExport(parsed.value);
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

/**
 * 把 read-tae-document 信封投影成 TaeExport（问题 6-C）。
 *
 * 拒绝条件（缺口 4）：animationsTruncated / eventsTruncated 为 true 时索引必须
 * 拒绝该文档 —— 缺失的 anims / events 无法被地址点名，把残缺当完整会在检索里
 * 假装整份动画都被索引了。拒绝返回 partial / 空 value，不吞异常。
 */
function parseTaeExport(value: unknown, sourceUri: string, sourcePath: string | undefined): ParsedValue<TaeExport> {
  const record = asRecord(value);
  const chrId = formatChrId(sourcePath ?? '') ?? formatChrId(sourceUri) ?? null;
  if (!chrId) {
    return {
      diagnostics: [{
        severity: 'error',
        code: 'TAE_CHR_ID_UNKNOWN',
        message: 'TAE 文档无法从路径提取角色 id（期望 cXXXX）。缺少 chr 的 TAE 不可地址点名。',
        sourceUri
      }]
    };
  }
  const animationsRaw = record.animations;
  if (!Array.isArray(animationsRaw)) {
    return { diagnostics: [missingField(sourceUri, 'animations')] };
  }
  if (record.animationsTruncated === true) {
    return {
      diagnostics: [{
        severity: 'error',
        code: 'TAE_INDEX_TRUNCATED',
        message: 'TAE 动画采样被截断（animationsTruncated），禁止把残缺当完整索引。',
        sourceUri
      }]
    };
  }

  const animations: TaeExport['animations'] = [];
  for (let animIndex = 0; animIndex < animationsRaw.length; animIndex += 1) {
    const anim = asRecord(animationsRaw[animIndex]);
    const animId = asNumber(anim.animId);
    if (animId === null) {
      return { diagnostics: [invalidField(sourceUri, `animations[${animIndex}].animId`)] };
    }
    const eventsRaw = anim.events;
    if (!Array.isArray(eventsRaw) || anim.eventsTruncated === true) {
      return {
        diagnostics: [{
          severity: 'error',
          code: 'TAE_INDEX_TRUNCATED',
          message: `动画 animId=${animId} 的事件表被截断或缺失（eventsTruncated），禁止把残缺当完整索引。`,
          sourceUri
        }]
      };
    }
    const code = formatAnimCode(animId);
    const events: TaeEventSymbol[] = eventsRaw.map((eventRaw, eventIndex) => {
      const event = asRecord(eventRaw);
      const startTime = asNumber(event.startTime) ?? 0;
      const endTime = asNumber(event.endTime) ?? startTime;
      const eventTypeId = asNumber(event.eventTypeId);
      const templateFields = Array.isArray(event.templateFields) ? event.templateFields : null;
      const fields = templateFields
        ? templateFields.flatMap((field) => {
          const fieldRecord = asRecord(field);
          const name = asString(fieldRecord.name);
          if (!name) return [];
          return [{ name, value: parseScalar(fieldRecord.value) }];
        })
        : [];
      const result: TaeEventSymbol = {
        uri: `action://${chrId}/${code}/e${String(eventIndex)}`,
        index: eventIndex,
        eventTypeId: eventTypeId ?? 0,
        ...(asString(event.typeName) ? { typeName: asString(event.typeName) } : {}),
        startTime,
        endTime,
        startFrame: frameFromSeconds(startTime),
        endFrame: frameFromSeconds(endTime),
        ...(fields.length > 0 ? { fields } : {}),
        ...(asString(event.parameterBytesHex) ? { parameterBytesHex: asString(event.parameterBytesHex) } : {})
      };
      return result;
    });
    animations.push({
      animId,
      code,
      ...(asString(anim.hkxName) ? { hkxName: asString(anim.hkxName) } : {}),
      events
    });
  }

  return {
    value: { chrId, sourceUri, animations },
    diagnostics: []
  };
}

/**
 * 把 read-msb-document 的 parts[] / regions[] 投影成 MapExport 需要的 data 形状
 * （问题 6-B：生产 analyze 走 export-map，而 export-map 未实现，故在桌面打开 MSB
 * 时用 read-msb-document 喂 MapExport，不要实现 C# export-map）。
 */
export function mapExportFromMsbDocument(input: {
  mapId: string;
  sourceUri: string;
  parts?: Array<{
    name?: string | number;
    typeId?: number;
    modelIndex?: number;
    posX?: number;
    posY?: number;
    posZ?: number;
    rotX?: number;
    rotY?: number;
    rotZ?: number;
    scaleX?: number;
    scaleY?: number;
    scaleZ?: number;
  }>;
  regions?: Array<{
    name?: string | number;
    typeId?: number;
    posX?: number;
    posY?: number;
    posZ?: number;
  }>;
}): MapExport {
  const entities: MapExport['entities'] = (input.parts ?? []).map((part) => {
    const name = String(part.name ?? '');
    const kind = mapKindFromTypeId(part.typeId);
    const position = vector3(part.posX, part.posY, part.posZ);
    const rotation = vector3(part.rotX, part.rotY, part.rotZ);
    const scale = vector3(part.scaleX, part.scaleY, part.scaleZ);
    return {
      uri: `map://${input.mapId}/part/${name}`,
      sourceUri: input.sourceUri,
      mapId: input.mapId,
      name,
      kind,
      ...(part.modelIndex === undefined ? {} : { modelIndex: part.modelIndex }),
      ...(position ? { position } : {}),
      ...(rotation ? { rotation } : {}),
      ...(scale ? { scale } : {}),
      ...(formatMapArea(input.mapId) ? { areaId: formatMapArea(input.mapId) } : {})
    };
  });
  const regions: MapExport['regions'] = (input.regions ?? []).map((region) => {
    const name = String(region.name ?? '');
    return {
      uri: `map://${input.mapId}/region/${name}`,
      sourceUri: input.sourceUri,
      mapId: input.mapId,
      name,
      ...(vector3(region.posX, region.posY, region.posZ) ? { position: vector3(region.posX, region.posY, region.posZ)! } : {})
    };
  });
  return { mapId: input.mapId, entities, regions };
}

/** MSB part typeId → MapEntitySymbol.kind（Sekiro 通用布局；未知回落 unknown）。 */
function mapKindFromTypeId(typeId: number | undefined): MapExport['entities'][number]['kind'] {
  if (typeId === undefined) return 'unknown';
  if (typeId >= 1000 && typeId < 1100) return 'mapPiece';
  if (typeId >= 1100 && typeId < 1200) return 'object';
  if (typeId >= 1200 && typeId < 1300) return 'character';
  if (typeId >= 1300 && typeId < 1400) return 'collision';
  if (typeId === 1410) return 'asset';
  return 'unknown';
}

function vector3(x: number | undefined, y: number | undefined, z: number | undefined): [number, number, number] | null {
  if (x === undefined || y === undefined || z === undefined) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

/** 对外帧 = Math.round(seconds * 30)。非有限秒数返回 0，不编造。 */
function frameFromSeconds(seconds: number): number {
  return Number.isFinite(seconds) ? Math.round(seconds * 30) : 0;
}

function parseMapEntity(value: unknown, sourceUri: string, mapId: string, index: number): MapExport['entities'][number] {
  const record = asRecord(value);
  const entityId = asNumber(record.entityId);
  const position = asVector3(record.position);
  const rotation = asVector3(record.rotation);
  const scale = asVector3(record.scale) ?? asScalarVector3(record.scaleX, record.scaleY, record.scaleZ);
  const name = asString(record.name, `entity_${index}`);
  // 问题 6-B：默认 uri 优先 `map://<mapId>/part/<name>`（新代码只写 /part/ 与 /region/）。
  const uri = asString(record.uri) || `map://${mapId}/part/${name}`;
  const areaFromRecord = asString(record.areaId);
  const area = areaFromRecord || formatMapArea(mapId);
  return {
    uri,
    sourceUri: asString(record.sourceUri) || sourceUri,
    mapId,
    ...(entityId === null ? {} : { entityId }),
    name,
    kind: isMapEntityKind(record.kind) ? record.kind : 'unknown',
    ...(asString(record.model) ? { model: asString(record.model) } : {}),
    ...(asNumber(record.modelIndex) === null ? {} : { modelIndex: asNumber(record.modelIndex) as number }),
    ...(position ? { position } : {}),
    ...(rotation ? { rotation } : {}),
    ...(scale ? { scale } : {}),
    ...(area ? { areaId: area } : {}),
    ...(record.raw === undefined ? {} : { raw: record.raw })
  };
}

function parseMapRegion(value: unknown, sourceUri: string, mapId: string, index: number): MapExport['regions'][number] {
  const record = asRecord(value);
  const entityId = asNumber(record.entityId);
  const position = asVector3(record.position);
  const rotation = asVector3(record.rotation);
  return {
    uri: asString(record.uri) || `map://${mapId}/region/${asString(record.name, `region_${index}`)}`,
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

/** MSB parts 的 scaleX/scaleY/scaleZ 独立字段合成向量（全缺返回 null）。 */
function asScalarVector3(
  x: unknown,
  y: unknown,
  z: unknown
): [number, number, number] | null {
  if (x === undefined && y === undefined && z === undefined) return null;
  const nx = asNumber(x);
  const ny = asNumber(y);
  const nz = asNumber(z);
  if (nx === null || ny === null || nz === null) return null;
  return [nx, ny, nz];
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
