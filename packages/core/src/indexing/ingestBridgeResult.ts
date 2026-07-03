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

  diagnostics.push({
    severity: 'info',
    code: 'INGEST_RESOURCE_KIND_SKIPPED',
    message: `Resource kind '${result.resourceKind}' is not a deep-ingest target for v0.1.`,
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
