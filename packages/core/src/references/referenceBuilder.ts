import type {
  EventArg,
  EventExport,
  EventInstruction,
  EventSymbol,
  MapEntitySymbol,
  MapExport,
  MapRegionSymbol,
  MsgExport,
  ParamExport,
  ParamRowSymbol,
  ReferenceConfidence,
  ReferenceEdge,
  ReferenceEvidence,
  SymbolBundle,
  TextEntrySymbol
} from '@soulforge/shared';

export interface ReferenceBuildOptions {
  /**
   * Medium/low confidence numeric matching can create noisy edges.
   * Keep it enabled for exploration, but never label it high confidence.
   */
  enableNumericFallback?: boolean;
  /**
   * If a numeric value matches more targets than this, the builder suppresses low-confidence edges.
   */
  maxAmbiguousNumericMatches?: number;
}

export interface ReferenceBuildResult {
  edges: ReferenceEdge[];
  stats: {
    high: number;
    medium: number;
    low: number;
    suppressedAmbiguousNumbers: number;
  };
}

interface SymbolIndexes {
  eventsById: Map<number, EventSymbol[]>;
  mapEntitiesByEntityId: Map<number, Array<MapEntitySymbol | MapRegionSymbol>>;
  paramRowsById: Map<number, ParamRowSymbol[]>;
  paramRowsByScopedId: Map<string, ParamRowSymbol[]>;
  textsById: Map<number, TextEntrySymbol[]>;
}

const DEFAULT_MAX_AMBIGUOUS_NUMERIC_MATCHES = 12;

export function buildReferenceGraph(bundle: SymbolBundle, options: ReferenceBuildOptions = {}): ReferenceBuildResult {
  const enableNumericFallback = options.enableNumericFallback ?? true;
  const maxAmbiguousNumericMatches = options.maxAmbiguousNumericMatches ?? DEFAULT_MAX_AMBIGUOUS_NUMERIC_MATCHES;
  const indexes = buildSymbolIndexes(bundle);
  const edges: ReferenceEdge[] = [];
  let suppressedAmbiguousNumbers = 0;

  for (const eventExport of bundle.events ?? []) {
    for (const event of eventExport.events) {
      for (const instruction of event.instructions) {
        for (const arg of instruction.args) {
          const numeric = toInteger(arg.value);
          if (numeric === null) continue;

          const role = arg.role ?? inferArgRole(arg, instruction);
          const evidence = makeInstructionEvidence(instruction, arg);

          if (role === 'eventId') {
            addEdges(edges, event.uri, indexes.eventsById.get(numeric), 'calls_event', 'high', reasonForRole(role, numeric), evidence);
            continue;
          }

          if (role === 'entityId') {
            addMapEntityEdges(edges, event, numeric, indexes.mapEntitiesByEntityId, 'references_map_entity', 'high', evidence);
            continue;
          }

          if (role === 'regionId') {
            addMapEntityEdges(edges, event, numeric, indexes.mapEntitiesByEntityId, 'references_region', 'high', evidence);
            continue;
          }

          if (role === 'paramId') {
            const targets = arg.paramName
              ? indexes.paramRowsByScopedId.get(makeParamKey(arg.paramName, numeric))
              : indexes.paramRowsById.get(numeric);
            addEdges(edges, event.uri, targets, 'references_param_row', arg.paramName ? 'high' : 'medium', reasonForRole(role, numeric, arg.paramName), evidence);
            continue;
          }

          if (role === 'textId') {
            addEdges(edges, event.uri, indexes.textsById.get(numeric), 'references_text', 'high', reasonForRole(role, numeric), evidence);
            continue;
          }

          if (role === 'flag') {
            edges.push({
              fromUri: event.uri,
              toUri: `flag://${numeric}`,
              kind: classifyFlagInstruction(instruction),
              confidence: 'high',
              reason: `Instruction argument is marked or inferred as event flag ${numeric}.`,
              evidence: [evidence]
            });
            continue;
          }

          if (!enableNumericFallback) continue;

          const fallbackTargets = collectFallbackTargets(numeric, indexes);
          if (fallbackTargets.length > maxAmbiguousNumericMatches) {
            suppressedAmbiguousNumbers += 1;
            continue;
          }

          for (const target of fallbackTargets) {
            edges.push({
              fromUri: event.uri,
              toUri: target.uri,
              kind: target.kind,
              confidence: target.confidence,
              reason: target.reason,
              evidence: [evidence]
            });
          }
        }
      }
    }
  }

  const dedupedEdges = dedupeEdges(edges);
  return {
    edges: dedupedEdges,
    stats: {
      high: dedupedEdges.filter((edge) => edge.confidence === 'high').length,
      medium: dedupedEdges.filter((edge) => edge.confidence === 'medium').length,
      low: dedupedEdges.filter((edge) => edge.confidence === 'low').length,
      suppressedAmbiguousNumbers
    }
  };
}

function buildSymbolIndexes(bundle: SymbolBundle): SymbolIndexes {
  const eventsById = new Map<number, EventSymbol[]>();
  const mapEntitiesByEntityId = new Map<number, Array<MapEntitySymbol | MapRegionSymbol>>();
  const paramRowsById = new Map<number, ParamRowSymbol[]>();
  const paramRowsByScopedId = new Map<string, ParamRowSymbol[]>();
  const textsById = new Map<number, TextEntrySymbol[]>();

  for (const eventExport of bundle.events ?? []) {
    for (const event of eventExport.events) {
      pushMapArray(eventsById, event.eventId, event);
    }
  }

  for (const mapExport of bundle.maps ?? []) {
    indexMapExport(mapExport, mapEntitiesByEntityId);
  }

  for (const paramExport of bundle.params ?? []) {
    indexParamExport(paramExport, paramRowsById, paramRowsByScopedId);
  }

  for (const msgExport of bundle.msgs ?? []) {
    indexMsgExport(msgExport, textsById);
  }

  return {
    eventsById,
    mapEntitiesByEntityId,
    paramRowsById,
    paramRowsByScopedId,
    textsById
  };
}

function indexMapExport(mapExport: MapExport, mapEntitiesByEntityId: Map<number, Array<MapEntitySymbol | MapRegionSymbol>>): void {
  for (const entity of mapExport.entities) {
    if (typeof entity.entityId === 'number') pushMapArray(mapEntitiesByEntityId, entity.entityId, entity);
  }

  for (const region of mapExport.regions) {
    if (typeof region.entityId === 'number') pushMapArray(mapEntitiesByEntityId, region.entityId, region);
  }
}

function indexParamExport(
  paramExport: ParamExport,
  paramRowsById: Map<number, ParamRowSymbol[]>,
  paramRowsByScopedId: Map<string, ParamRowSymbol[]>
): void {
  for (const row of paramExport.rows) {
    pushMapArray(paramRowsById, row.rowId, row);
    pushMapArray(paramRowsByScopedId, makeParamKey(row.paramName, row.rowId), row);
  }
}

function indexMsgExport(msgExport: MsgExport, textsById: Map<number, TextEntrySymbol[]>): void {
  for (const entry of msgExport.entries) {
    pushMapArray(textsById, entry.textId, entry);
  }
}

function addMapEntityEdges(
  edges: ReferenceEdge[],
  event: EventSymbol,
  entityId: number,
  index: Map<number, Array<MapEntitySymbol | MapRegionSymbol>>,
  kind: 'references_map_entity' | 'references_region',
  confidence: ReferenceConfidence,
  evidence: ReferenceEvidence
): void {
  const targets = index.get(entityId);
  if (!targets?.length) return;

  const sameMapTargets = event.mapId ? targets.filter((target) => target.mapId === event.mapId) : targets;
  const finalTargets = sameMapTargets.length > 0 ? sameMapTargets : targets;
  const finalConfidence: ReferenceConfidence = sameMapTargets.length > 0 || !event.mapId ? confidence : 'medium';

  for (const target of finalTargets) {
    edges.push({
      fromUri: event.uri,
      toUri: target.uri,
      kind,
      confidence: finalConfidence,
      reason: sameMapTargets.length > 0
        ? `Instruction argument matches entity/region id ${entityId} in map ${target.mapId}.`
        : `Instruction argument matches entity/region id ${entityId}, but event map scope is unknown or different.`,
      evidence: [evidence]
    });
  }
}

function addEdges(
  edges: ReferenceEdge[],
  fromUri: string,
  targets: Array<{ uri: string }> | undefined,
  kind: ReferenceEdge['kind'],
  confidence: ReferenceConfidence,
  reason: string,
  evidence: ReferenceEvidence
): void {
  if (!targets?.length) return;

  for (const target of targets) {
    if (target.uri === fromUri) continue;
    edges.push({
      fromUri,
      toUri: target.uri,
      kind,
      confidence,
      reason,
      evidence: [evidence]
    });
  }
}

function collectFallbackTargets(numeric: number, indexes: SymbolIndexes): Array<{
  uri: string;
  kind: ReferenceEdge['kind'];
  confidence: ReferenceConfidence;
  reason: string;
}> {
  const targets: Array<{ uri: string; kind: ReferenceEdge['kind']; confidence: ReferenceConfidence; reason: string }> = [];

  for (const target of indexes.eventsById.get(numeric) ?? []) {
    targets.push({ uri: target.uri, kind: 'calls_event', confidence: 'low', reason: `Numeric fallback: value ${numeric} matches an event id.` });
  }

  for (const target of indexes.mapEntitiesByEntityId.get(numeric) ?? []) {
    targets.push({ uri: target.uri, kind: 'numeric_match', confidence: 'low', reason: `Numeric fallback: value ${numeric} matches a map entity or region id.` });
  }

  for (const target of indexes.paramRowsById.get(numeric) ?? []) {
    targets.push({ uri: target.uri, kind: 'numeric_match', confidence: 'low', reason: `Numeric fallback: value ${numeric} matches a param row id.` });
  }

  for (const target of indexes.textsById.get(numeric) ?? []) {
    targets.push({ uri: target.uri, kind: 'numeric_match', confidence: 'low', reason: `Numeric fallback: value ${numeric} matches a text id.` });
  }

  return targets;
}

function inferArgRole(arg: EventArg, instruction: EventInstruction): EventArg['role'] {
  const argName = (arg.name ?? '').toLowerCase();
  const instructionName = (instruction.name ?? '').toLowerCase();

  if (argName.includes('flag') || instructionName.includes('flag')) return 'flag';
  if (argName.includes('event')) return 'eventId';
  if (argName.includes('entity') || argName.includes('chr') || argName.includes('character')) return 'entityId';
  if (argName.includes('region') || instructionName.includes('region')) return 'regionId';
  if (argName.includes('text') || argName.includes('msg')) return 'textId';
  if (argName.includes('speffect') || argName.includes('param') || argName.includes('row')) return 'paramId';

  if (instructionName.includes('event') && instructionName.includes('initialize')) return 'eventId';
  if (instructionName.includes('character') || instructionName.includes('asset') || instructionName.includes('object')) return 'entityId';
  if (instructionName.includes('message') || instructionName.includes('dialog')) return 'textId';

  return 'unknown';
}

function classifyFlagInstruction(instruction: EventInstruction): 'reads_flag' | 'writes_flag' {
  const name = (instruction.name ?? '').toLowerCase();
  if (name.includes('set') || name.includes('enable') || name.includes('disable') || name.includes('clear')) return 'writes_flag';
  return 'reads_flag';
}

function makeInstructionEvidence(instruction: EventInstruction, arg: EventArg): ReferenceEvidence {
  return {
    sourceUri: instruction.uri,
    instructionUri: instruction.uri,
    fieldName: arg.name,
    value: arg.value,
    excerpt: makeInstructionExcerpt(instruction, arg)
  };
}

function makeInstructionExcerpt(instruction: EventInstruction, arg: EventArg): string {
  const argLabel = arg.name ? `${arg.name}=` : '';
  return `${instruction.name ?? 'instruction'}#${instruction.index}(${argLabel}${String(arg.value)})`;
}

function reasonForRole(role: NonNullable<EventArg['role']>, value: number, scope?: string): string {
  if (scope) return `Instruction argument is marked or inferred as ${role} ${value} in ${scope}.`;
  return `Instruction argument is marked or inferred as ${role} ${value}.`;
}

function makeParamKey(paramName: string, rowId: number): string {
  return `${paramName.toLowerCase()}#${rowId}`;
}

function toInteger(value: string | number | boolean): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return null;
}

function pushMapArray<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
    return;
  }
  map.set(key, [value]);
}

function dedupeEdges(edges: ReferenceEdge[]): ReferenceEdge[] {
  const seen = new Set<string>();
  const output: ReferenceEdge[] = [];

  for (const edge of edges) {
    const evidenceKey = edge.evidence.map((item) => `${item.instructionUri ?? item.sourceUri}:${String(item.value ?? '')}`).join('|');
    const key = `${edge.fromUri}|${edge.toUri}|${edge.kind}|${edge.confidence}|${evidenceKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(edge);
  }

  return output;
}
