import { createHash } from 'node:crypto';
import type {
  EventSymbol,
  Diagnostic,
  IndexedFile,
  MapEntitySymbol,
  MapRegionSymbol,
  ParamRowSymbol,
  RagChunk,
  RagChunkFamily,
  RagCorpus,
  ReferenceEdge,
  ResourceKind,
  TaeAnimSymbol,
  TaeEventSymbol,
  TaeExport,
  TextEntrySymbol
} from '@soulforge/shared';
import {
  formatActionAddress,
  formatAnimCode,
  formatMapAddress,
  formatMapArea,
  formatMapBlock,
  RAG_CHUNK_FAMILIES
} from '@soulforge/shared';
import type { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { attachLookupIndex } from './lookupIndex.js';
import {
  buildParamTextReferenceEdges,
  buildTextEntryLookup,
  collectParamTextLinks,
  paramTextLinkSearchText
} from '../references/paramTextReferences.js';

const MAX_BODY_CHARS = 1_800;
const MAX_INSTRUCTIONS = 24;
const MAX_FIELDS = 24;

/**
 * Controls whether corpus construction also materializes the in-memory
 * inverted lookup maps.  The default stays eager for every existing caller;
 * only explicitly marked intermediate corpora may defer that work until
 * retrieval calls `ensureLookupIndex`.
 */
export type RagCorpusLookupIndexMode = 'eager' | 'deferred';

export interface RagCorpusBuildOptions {
  lookupIndex?: RagCorpusLookupIndexMode;
  /**
   * Optional host-controlled projection.  File chunks remain included unless
   * the caller explicitly omits them; they carry the source identity needed
   * to prove persisted semantic chunks are still current.
   */
  families?: readonly RagChunkFamily[];
}

export function buildRagCorpus(
  index: WorkspaceIndex,
  now = new Date().toISOString(),
  diagnostics: readonly Diagnostic[] = [],
  sourceUris?: readonly string[],
  symbolUris?: readonly string[],
  options: RagCorpusBuildOptions = {}
): RagCorpus {
  const sourceFilter = sourceUris && sourceUris.length > 0 ? new Set(sourceUris) : null;
  const symbolFilter = symbolUris && symbolUris.length > 0 ? new Set(symbolUris) : null;
  const familyFilter = options.families ? new Set(options.families) : null;
  const includeFamily = (family: RagChunkFamily): boolean => (
    familyFilter === null || familyFilter.has(family) || family === 'file'
  );
  const includeSource = (sourceUri: string): boolean => sourceFilter === null || sourceFilter.has(sourceUri);
  const includeSymbol = (sourceUri: string, symbolUri: string): boolean => (
    includeSource(sourceUri) && (symbolFilter === null || symbolFilter.has(symbolUri))
  );
  const chunks: RagChunk[] = [];
  const fileIdentity = new Map(index.getFiles().map((file) => [file.sourceUri, file] as const));
  for (const file of index.getFiles()) {
    // A symbol-scoped refresh replaces only native rows/events. The existing
    // file catalog chunk must remain in the previous corpus; rebuilding it
    // here would make the caller drop unrelated symbols from the same source.
    if (includeFamily('file') && symbolFilter === null && includeSource(file.sourceUri)) {
      chunks.push(fileChunk(index.workspaceId, file));
    }
  }
  const symbols = index.toSymbolBundle();
  const textEntryLookup = buildTextEntryLookup(symbols.msgs ?? []);
  for (const eventExport of symbols.events ?? []) {
    if (!includeFamily('event')) continue;
    for (const event of eventExport.events) {
      if (!includeSymbol(event.sourceUri, event.uri)) continue;
      chunks.push(eventChunk(
        index.workspaceId,
        event,
        event.sourceHash ?? eventExport.sourceHash,
        event.outerFileHash ?? eventExport.outerFileHash,
        event.sourceRevision ?? eventExport.sourceRevision
      ));
    }
  }
  for (const mapExport of symbols.maps ?? []) {
    if (!includeFamily('map_entity') && !includeFamily('map_region')) continue;
    for (const entity of mapExport.entities) {
      if (!includeFamily('map_entity')) continue;
      if (!includeSymbol(entity.sourceUri, entity.uri)) continue;
      chunks.push(mapEntityChunk(
        index.workspaceId,
        entity,
        entity.sourceHash ?? mapExport.sourceHash,
        entity.outerFileHash ?? mapExport.outerFileHash,
        entity.sourceRevision ?? mapExport.sourceRevision
      ));
    }
    for (const region of mapExport.regions) {
      if (!includeFamily('map_region')) continue;
      if (!includeSymbol(region.sourceUri, region.uri)) continue;
      chunks.push(mapRegionChunk(
        index.workspaceId,
        region,
        region.sourceHash ?? mapExport.sourceHash,
        region.outerFileHash ?? mapExport.outerFileHash,
        region.sourceRevision ?? mapExport.sourceRevision
      ));
    }
  }
  for (const taeExport of symbols.tae ?? []) {
    if (!includeFamily('tae_event')) continue;
    if (!includeSource(taeExport.sourceUri)) continue;
    for (const anim of taeExport.animations) {
      for (const event of anim.events) {
        if (!includeSymbol(taeExport.sourceUri, event.uri)) continue;
        chunks.push(taeEventChunk(
          index.workspaceId,
          taeExport,
          anim,
          event,
          event.sourceHash ?? taeExport.sourceHash,
          event.outerFileHash ?? taeExport.outerFileHash,
          event.sourceRevision ?? taeExport.sourceRevision
        ));
      }
    }
  }
  for (const paramExport of symbols.params ?? []) {
    if (!includeFamily('param_row')) continue;
    for (const row of paramExport.rows) {
      if (!includeSymbol(row.sourceUri, row.uri)) continue;
      chunks.push(paramRowChunk(
        index.workspaceId,
        row,
        textEntryLookup,
        row.sourceHash ?? paramExport.sourceHash,
        row.outerFileHash ?? paramExport.outerFileHash,
        row.sourceRevision ?? paramExport.sourceRevision
      ));
    }
  }
  for (const msgExport of symbols.msgs ?? []) {
    if (!includeFamily('text_entry')) continue;
    for (const entry of msgExport.entries) {
      if (!includeSymbol(entry.sourceUri, entry.uri)) continue;
      chunks.push(textEntryChunk(
        index.workspaceId,
        entry,
        entry.sourceHash ?? msgExport.sourceHash,
        entry.outerFileHash ?? msgExport.outerFileHash,
        entry.sourceRevision ?? msgExport.sourceRevision
      ));
    }
  }

  // Native symbol envelopes from older/fixture readers may omit the packed
  // outer hash and physical revision even though the current catalog proves
  // both.  Fill only from the exact same sourceUri; never borrow identity
  // across files.  This lets stale-snapshot merging validate legacy rows
  // without treating an unbound symbol as current.
  const normalizedChunks = chunks.map((chunk) => {
    if (chunk.family === 'file') return chunk;
    const file = fileIdentity.get(chunk.sourceUri);
    if (!file) return chunk;
    return {
      ...chunk,
      ...(chunk.outerFileHash || !file.sha256 ? {} : { outerFileHash: file.sha256 }),
      ...(chunk.sourceRevision !== undefined || file.mtimeMs === undefined
        ? {}
        : { sourceRevision: file.mtimeMs })
    };
  });

  return createRagCorpus({
    workspaceId: index.workspaceId,
    builtAt: now,
    chunks: normalizedChunks,
    // Keep the current graph, but derive PARAM↔FMG edges from the same source
    // mapping in this snapshot as well. This makes a freshly assembled corpus
    // correct even when the caller has not yet published a reference rebuild.
    references: mergeReferenceEdges(
      index.listReferences(),
      includeFamily('param_row') && includeFamily('text_entry')
        ? buildParamTextReferenceEdges(symbols.params ?? [], symbols.msgs ?? [])
        : []
    ),
    diagnostics,
    ...(options.lookupIndex ? { lookupIndex: options.lookupIndex } : {})
  });
}

export function createRagCorpus(input: {
  workspaceId: string;
  builtAt: string;
  chunks: readonly RagChunk[];
  references?: readonly ReferenceEdge[];
  diagnostics?: readonly Diagnostic[];
  /** Defaults to eager; use deferred only for an intermediate, non-retrieval corpus. */
  lookupIndex?: RagCorpusLookupIndexMode;
}): RagCorpus {
  const byFamily = emptyFamilyCounts();
  for (const chunk of input.chunks) byFamily[chunk.family] += 1;
  // RAG availability is intentionally stricter than "there is some parsed
  // metadata".  A file catalog, map-region shell, or TAE export alone cannot
  // prove that the object-location families used by the agent are searchable.
  // Keep the four production lookup families as the fail-closed gate.
  const semanticCount = byFamily.event + byFamily.map_entity
    + byFamily.param_row + byFamily.text_entry;
  const diagnostics = (input.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.code !== 'RAG_SEMANTIC_CORPUS_EMPTY' || semanticCount === 0);
  if (semanticCount === 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'RAG_SEMANTIC_CORPUS_EMPTY',
      message: 'RAG 语义语料为空；仅有文件目录不能用于对象定位。'
    });
  }
  const corpus: RagCorpus = {
    workspaceId: input.workspaceId,
    builtAt: input.builtAt,
    chunks: [...input.chunks],
    references: [...(input.references ?? [])],
    stats: { total: input.chunks.length, byFamily },
    availability: semanticCount > 0 ? 'available' : 'unavailable',
    diagnostics
  };
  if (input.lookupIndex !== 'deferred') attachLookupIndex(corpus);
  return corpus;
}

export function mergeCatalogAndPersisted(
  catalog: RagCorpus,
  persisted: RagCorpus,
  options: { lookupIndex?: RagCorpusLookupIndexMode } = {}
): RagCorpus {
  const liveSources = new Set(catalog.chunks.map((chunk) => chunk.sourceUri));
  const liveSourceRevisions = new Map(
    catalog.chunks
      .filter((chunk) => chunk.family === 'file')
      .map((chunk) => [chunk.sourceUri, {
        outerFileHash: chunk.outerFileHash,
        sourceRevision: chunk.sourceRevision
      }] as const)
  );
  const keptSymbols = persisted.chunks.filter(
    (chunk) => {
      if (chunk.family === 'file' || !liveSources.has(chunk.sourceUri)) return false;
      const current = liveSourceRevisions.get(chunk.sourceUri);
      // Persisted semantic data is usable only when the current file catalog
      // proves both content and revision. Missing provenance is stale, never
      // an invitation to merge an old row/event under a new export hash.
      if (!current) return false;
      // Older durable semantic chunks only carried the leaf/source hash and
      // cannot be proven current against a packed catalog file. Rebuild them
      // instead of treating the outer catalog hash as their missing leaf hash.
      if (current.outerFileHash === undefined || current.sourceRevision === undefined
        || chunk.sourceRevision === undefined) return false;
      return chunk.outerFileHash === current.outerFileHash
        && chunk.sourceRevision === current.sourceRevision;
    }
  );
  // The freshly built catalog is the current semantic authority.  The old
  // implementation returned only catalog file chunks plus persisted symbols,
  // silently discarding every newly decoded PARAM/MAP/MSG/EVENT row.  Keep
  // current semantic chunks first; valid persisted chunks fill only gaps.
  const currentSymbols = catalog.chunks.filter((chunk) => chunk.family !== 'file');
  // A pre-fix PARAM corpus may contain one durable collision row under the old
  // `sourceUri + row.uri` chunk ID.  The new child-aware ID cannot match that
  // legacy key, so remove only IDs that are provably one of those old PARAM
  // identities.  Do not match by logical URI: a symbol-scoped refresh may
  // contain child A while the durable corpus already contains fresh child B
  // for the same logical PARAM URI, and B must survive the merge.
  const legacyParamRowIds = new Set(
    currentSymbols
      .filter((chunk) => chunk.family === 'param_row')
      .map((chunk) => legacyParamRowChunkId(chunk))
  );
  const symbolsById = new Map<string, RagChunk>();
  for (const chunk of currentSymbols) symbolsById.set(chunk.chunkId, chunk);
  for (const chunk of keptSymbols) {
    if (chunk.family === 'param_row' && legacyParamRowIds.has(chunk.chunkId)) continue;
    if (!symbolsById.has(chunk.chunkId)) symbolsById.set(chunk.chunkId, chunk);
  }
  const symbols = [...symbolsById.values()];
  const symbolUris = new Set(symbols.map((chunk) => chunk.symbolUri));
  const seenReferences = new Set<string>();
  const references = [...catalog.references, ...persisted.references].filter((edge) => {
    if (!symbolUris.has(edge.fromUri) && !symbolUris.has(edge.toUri)) return false;
    const key = `${edge.fromUri}\u0000${edge.toUri}\u0000${edge.kind}\u0000${edge.confidence}`;
    if (seenReferences.has(key)) return false;
    seenReferences.add(key);
    return true;
  });
  return createRagCorpus({
    workspaceId: catalog.workspaceId,
    builtAt: catalog.builtAt,
    chunks: [...catalog.chunks.filter((chunk) => chunk.family === 'file'), ...symbols],
    references,
    diagnostics: catalog.diagnostics,
    ...(options.lookupIndex ? { lookupIndex: options.lookupIndex } : {})
  });
}

export function emptyFamilyCounts(): Record<RagChunkFamily, number> {
  return Object.fromEntries(RAG_CHUNK_FAMILIES.map((family) => [family, 0])) as Record<RagChunkFamily, number>;
}

function fileChunk(workspaceId: string, file: IndexedFile): RagChunk {
  const body = [
    `path ${file.relativePath}`,
    `kind ${file.resourceKind}`,
    `format ${file.formatKind} ${file.formatLabel}`,
    `extension ${file.compoundExtension || file.extension}`,
    `status ${file.parseStatus}`,
    `size ${file.size}`
  ].join('\n');
  return makeChunk({
    workspaceId,
    sourceUri: file.sourceUri,
    symbolUri: file.sourceUri,
    family: 'file',
    title: file.relativePath,
    body,
    numericIds: [],
    relativePath: file.relativePath,
    resourceKind: file.resourceKind,
    ...(file.sha256 ? { sourceHash: file.sha256 } : {}),
    ...(file.sha256 ? { outerFileHash: file.sha256 } : {}),
    sourceRevision: file.mtimeMs
  });
}

function eventChunk(workspaceId: string, event: EventSymbol, sourceHash?: string, outerFileHash?: string, sourceRevision?: number): RagChunk {
  const instructions = event.instructions.slice(0, MAX_INSTRUCTIONS).map((instruction) => {
    const args = instruction.args
      .map((arg) => `${arg.name ?? 'arg'}=${stringifyValue(arg.value)}${arg.role ? `@${arg.role}` : ''}`)
      .join(' ');
    return `${instruction.index} ${instruction.name ?? 'instruction'} ${args}`.trim();
  });
  const truncated = event.instructions.length > MAX_INSTRUCTIONS
    ? `\n… ${event.instructions.length - MAX_INSTRUCTIONS} more instructions`
    : '';
  const restBehavior = recordNumber(event.raw, 'restBehavior');
  const instructionCount = recordNumber(event.raw, 'instructionCount');
  const parameterCount = recordNumber(event.raw, 'parameterCount');
  const body = [
    `event ${event.eventId}`,
    event.name ? `name ${event.name}` : '',
    event.mapId ? `map ${event.mapId}` : '',
    restBehavior !== undefined ? `restBehavior ${restBehavior}` : '',
    instructionCount !== undefined ? `instructionCount ${instructionCount}` : '',
    parameterCount !== undefined ? `parameterCount ${parameterCount}` : '',
    ...instructions,
    truncated
  ].filter(Boolean).join('\n');
  return makeChunk({
    workspaceId,
    sourceUri: event.sourceUri,
    symbolUri: event.uri,
    family: 'event',
    title: event.name ? `event ${event.eventId} ${event.name}` : `event ${event.eventId}`,
    body,
    numericIds: collectNumbers([
      event.eventId,
      ...event.instructions.flatMap((instruction) => instruction.args.map((arg) => arg.value))
    ]),
    resourceKind: 'event',
    ...(sourceRevision !== undefined ? { sourceRevision } : {}),
    ...(outerFileHash ? { outerFileHash } : {}),
    ...(sourceHash ? { sourceHash } : {})
  });
}

function recordNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
}

function mapEntityChunk(workspaceId: string, entity: MapEntitySymbol, sourceHash?: string, outerFileHash?: string, sourceRevision?: number): RagChunk {
  const block = formatMapBlock(entity.mapId) ?? entity.mapId.toLowerCase();
  const area = formatMapArea(block) || entity.areaId || '';
  const modelSuffix = entity.modelIndex !== undefined ? ` modelIndex ${entity.modelIndex}` : '';
  const body = [
    area ? `area ${area}` : '',
    `map ${block}`,
    `part ${entity.name} kind ${entity.kind}`,
    entity.model ? `model ${entity.model}${modelSuffix}` : (entity.modelIndex !== undefined ? `modelIndex ${entity.modelIndex}` : ''),
    entity.position ? `pos ${entity.position.join(' ')}` : '',
    [entity.rotation ? `rot ${entity.rotation.join(' ')}` : '', entity.scale ? `scale ${entity.scale.join(' ')}` : '']
      .filter(Boolean).join(' '),
    entity.sourceUri ? `source ${relativeSourcePath(entity.sourceUri)}` : '',
    `address ${formatMapAddress({ block, name: entity.name })}`
  ].filter(Boolean).join('\n');
  return makeChunk({
    workspaceId,
    sourceUri: entity.sourceUri,
    symbolUri: entity.uri,
    // Map names/URIs are not globally unique across physical MSB sources
    // (overlays and alternate map containers can expose the same mapId/name).
    // Keep the native source in the chunk identity so persistence cannot
    // overwrite one source with another.
    identityKey: `${entity.sourceUri}\u0000${entity.uri}`,
    family: 'map_entity',
    title: formatMapAddress({ block, name: entity.name }),
    body,
    numericIds: collectNumbers([entity.entityId]),
    resourceKind: 'map',
    ...(sourceRevision !== undefined ? { sourceRevision } : {}),
    ...(outerFileHash ? { outerFileHash } : {}),
    ...(sourceHash ? { sourceHash } : {})
  });
}

function mapRegionChunk(workspaceId: string, region: MapRegionSymbol, sourceHash?: string, outerFileHash?: string, sourceRevision?: number): RagChunk {
  const block = formatMapBlock(region.mapId) ?? region.mapId.toLowerCase();
  const area = formatMapArea(block);
  const body = [
    area ? `area ${area}` : '',
    `map ${block}`,
    `region ${region.name}${region.shape ? ` shape ${region.shape}` : ''}`,
    region.position ? `pos ${region.position.join(' ')}` : '',
    region.rotation ? `rot ${region.rotation.join(' ')}` : '',
    region.sourceUri ? `source ${relativeSourcePath(region.sourceUri)}` : '',
    `address ${formatMapAddress({ block, name: region.name })}`
  ].filter(Boolean).join('\n');
  return makeChunk({
    workspaceId,
    sourceUri: region.sourceUri,
    symbolUri: region.uri,
    identityKey: `${region.sourceUri}\u0000${region.uri}`,
    family: 'map_region',
    title: formatMapAddress({ block, name: region.name }),
    body,
    numericIds: collectNumbers([region.entityId]),
    resourceKind: 'map',
    ...(sourceRevision !== undefined ? { sourceRevision } : {}),
    ...(outerFileHash ? { outerFileHash } : {}),
    ...(sourceHash ? { sourceHash } : {})
  });
}

/**
 * TAE 词条块（问题 6-C）。家族 tae_event（EMEVD 仍叫 event，勿改旧含义）。
 * 字段给全、不套 MAX_FIELDS / MAX_INSTRUCTIONS —— 词条字段通常很少。
 * numericIds 收 animId、eventTypeId、帧、以及所有可 Number.isFinite 的字段值
 * （SoundID 必须在）。
 */
function taeEventChunk(
  workspaceId: string,
  taeExport: TaeExport,
  anim: TaeAnimSymbol,
  event: TaeEventSymbol,
  sourceHash?: string,
  outerFileHash?: string,
  sourceRevision?: number
): RagChunk {
  const address = formatActionAddress({ chr: taeExport.chrId, animId: anim.animId, eventIndex: event.index });
  const lines = [
    `chr ${taeExport.chrId}`,
    `anim ${anim.code} animId ${anim.animId}${anim.hkxName ? ` hkx ${anim.hkxName}` : ''}`,
    ...(anim.taeGroup
      ? [`taeSection ${anim.taeGroup}${anim.taeEntryName ? ` entry ${anim.taeEntryName}` : ''}${anim.taeEntryId !== undefined ? ` entryId ${anim.taeEntryId}` : ''}`]
      : []),
    `event e${event.index} type ${event.eventTypeId}${event.typeName ? ` ${event.typeName}` : ''}`,
    `startFrame ${event.startFrame} endFrame ${event.endFrame} startTime ${trimNumber(event.startTime)} endTime ${trimNumber(event.endTime)}`,
    ...(event.fields ?? []).map((field) => `${field.name} ${field.value}`),
    ...(event.fields && event.fields.length > 0 ? [] : event.parameterBytesHex ? [`undecoded hex=${event.parameterBytesHex}`] : []),
    taeExport.sourceUri ? `source ${relativeSourcePath(taeExport.sourceUri)}` : '',
    `address ${address}`,
    ...(event.uri !== `action://${taeExport.chrId}/${anim.code}/e${String(event.index)}` ? [`identity ${event.uri}`] : [])
  ].filter(Boolean);
  const numericFieldValues = (event.fields ?? []).map((field) => field.value);
  return makeChunk({
    workspaceId,
    sourceUri: taeExport.sourceUri,
    symbolUri: event.uri,
    family: 'tae_event',
    title: address,
    body: lines.join('\n'),
    numericIds: collectNumbers([
      anim.animId,
      event.eventTypeId,
      event.startFrame,
      event.endFrame,
      anim.taeEntryIndex,
      anim.taeEntryId,
      ...numericFieldValues
    ]),
    resourceKind: 'action',
    ...(sourceRevision !== undefined ? { sourceRevision } : {}),
    ...(outerFileHash ? { outerFileHash } : {}),
    ...(sourceHash ? { sourceHash } : {})
  });
}

function trimNumber(value: number): string {
  return Number.isFinite(value) ? String(Number(value.toFixed(3))) : '0';
}

/** 把 file:// uri 降级为相对路径样式的 source 文本（渲染器安全：不泄漏绝对路径）。 */
function relativeSourcePath(sourceUri: string): string {
  if (sourceUri.startsWith('file://')) return sourceUri.slice('file://'.length);
  return sourceUri;
}

function paramRowChunk(
  workspaceId: string,
  row: ParamRowSymbol,
  textEntryLookup: ReturnType<typeof buildTextEntryLookup>,
  sourceHash?: string,
  outerFileHash?: string,
  sourceRevision?: number
): RagChunk {
  const linkedText = collectParamTextLinks(row, textEntryLookup);
  const fields = (row.fields ?? []).slice(0, MAX_FIELDS)
    .map((field) => [
      field.fieldId,
      field.name,
      field.description,
      `value=${stringifyValue(field.value)}`
    ].filter(Boolean).join(' '));
  const truncated = (row.fields?.length ?? 0) > MAX_FIELDS
    ? `\n… ${(row.fields?.length ?? 0) - MAX_FIELDS} more fields`
    : '';
  const body = [
    `param ${row.paramName}`,
    row.entryName ? `entry ${row.entryName}` : '',
    row.entryIndex !== undefined ? `entryIndex ${row.entryIndex}` : '',
    `row ${row.rowId}`,
    row.rowName ? `name ${row.rowName}` : '',
    ...fields,
    linkedText.length > 0 ? `linkedText\n${paramTextLinkSearchText(linkedText)}` : '',
    truncated
  ].filter(Boolean).join('\n');
  return makeChunk({
    workspaceId,
    sourceUri: row.sourceUri,
    symbolUri: row.uri,
    family: 'param_row',
    title: row.rowName ? `${row.paramName} ${row.rowId} ${row.rowName}` : `${row.paramName} ${row.rowId}`,
    body,
    numericIds: collectNumbers([
      row.rowId,
      ...(row.fields ?? []).map((field) => field.value)
    ]),
    resourceKind: 'param',
    // A native PARAM container can contain several entries with the same
    // typeName (for example multiple ATK_PARAM_ST tables). Keep the physical
    // source in the chunk identity so one table cannot overwrite another in
    // SQLite/RAG merely because rowId and typeName match.
    // `row.uri` is a logical PARAM type/id address and is intentionally kept
    // stable for native read/write routing.  A packed PARAM container may,
    // however, contain several children with the same typeName and row ID
    // (for example AtkParam_Npc and AtkParam_Pc).  Include the already
    // ingested physical child identity in the RAG key so SQLite cannot make
    // one child overwrite another.  The raw row index is only a fallback for
    // legacy/synthetic envelopes which omit both child fields.
    identityKey: paramRowChunkIdentity(row),
    ...(sourceRevision !== undefined ? { sourceRevision } : {}),
    ...(outerFileHash ? { outerFileHash } : {}),
    ...(sourceHash ? { sourceHash } : {})
  });
}

function paramRowChunkIdentity(row: ParamRowSymbol): string {
  const raw = row.raw && typeof row.raw === 'object' && !Array.isArray(row.raw)
    ? row.raw as Record<string, unknown>
    : undefined;
  const rawRowIndex = typeof raw?.rowIndex === 'number' && Number.isInteger(raw.rowIndex)
    && Number.isSafeInteger(raw.rowIndex) && raw.rowIndex >= 0
    ? raw.rowIndex
    : undefined;
  const entryName = typeof row.entryName === 'string' && row.entryName.trim() !== ''
    ? row.entryName
    : undefined;
  const entryIndex = typeof row.entryIndex === 'number'
    && Number.isSafeInteger(row.entryIndex) && row.entryIndex >= 0
    ? row.entryIndex
    : undefined;
  if (entryName !== undefined && entryIndex !== undefined && rawRowIndex !== undefined) {
    // This is the stable physical identity shared by the first native
    // projection and the later semantic refresh.  Their display/type name
    // and logical URI may legitimately differ (NPC_PARAM_ST vs NpcParam),
    // while child name/index + complete-table rowIndex + rowId do not.
    return JSON.stringify([row.sourceUri, entryName, entryIndex, rawRowIndex, row.rowId]);
  }
  if (entryName !== undefined || entryIndex !== undefined || rawRowIndex !== undefined) {
    // Old durable rows may expose only part of the physical locator.  Retain
    // the prior five-slot JSON identity (including nulls and the logical URI)
    // so child isolation is not lost while waiting for a complete reread.
    return JSON.stringify([
      row.sourceUri,
      row.entryName ?? null,
      row.entryIndex ?? null,
      rawRowIndex ?? null,
      row.uri
    ]);
  }
  return `${row.sourceUri}\u0000${row.uri}`;
}

function legacyParamRowChunkId(chunk: Pick<RagChunk, 'sourceUri' | 'symbolUri'>): string {
  return `rag:param_row:${stableId(`${chunk.sourceUri}\u0000${chunk.symbolUri}`)}`;
}

function mergeReferenceEdges(primary: readonly ReferenceEdge[], derived: readonly ReferenceEdge[]): ReferenceEdge[] {
  const merged: ReferenceEdge[] = [];
  const seen = new Set<string>();
  for (const edge of [...primary, ...derived]) {
    const key = `${edge.fromUri}\u0000${edge.toUri}\u0000${edge.kind}\u0000${edge.confidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(edge);
  }
  return merged;
}

function textEntryChunk(workspaceId: string, entry: TextEntrySymbol, sourceHash?: string, outerFileHash?: string, sourceRevision?: number): RagChunk {
  const body = [
    `textId ${entry.textId}`,
    entry.category ? `category ${entry.category}` : '',
    entry.text
  ].filter(Boolean).join('\n');
  return makeChunk({
    workspaceId,
    sourceUri: entry.sourceUri,
    symbolUri: entry.uri,
    family: 'text_entry',
    title: entry.category ? `${entry.category} ${entry.textId}` : `text ${entry.textId}`,
    body,
    numericIds: [entry.textId],
    resourceKind: 'msg',
    ...(entry.confidence ? { confidence: entry.confidence } : {}),
    ...(sourceRevision !== undefined ? { sourceRevision } : {}),
    ...(outerFileHash ? { outerFileHash } : {}),
    ...(sourceHash ? { sourceHash } : {})
  });
}

function makeChunk(input: {
  workspaceId: string;
  sourceUri: string;
  symbolUri: string;
  family: RagChunkFamily;
  title: string;
  body: string;
  numericIds: number[];
  sourceRevision?: number;
  outerFileHash?: string;
  sourceHash?: string;
  relativePath?: string;
  resourceKind?: ResourceKind;
  confidence?: RagChunk['confidence'];
  identityKey?: string;
}): RagChunk {
  const body = truncateBody(input.body);
  return {
    chunkId: `rag:${input.family}:${stableId(input.identityKey ?? input.symbolUri)}`,
    workspaceId: input.workspaceId,
    sourceUri: input.sourceUri,
    symbolUri: input.symbolUri,
    family: input.family,
    title: input.title,
    body,
    numericIds: input.numericIds,
    contentHash: sha256(body),
    ...(input.sourceRevision !== undefined ? { sourceRevision: input.sourceRevision } : {}),
    ...(input.outerFileHash ? { outerFileHash: input.outerFileHash } : {}),
    ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
    ...(input.relativePath ? { relativePath: input.relativePath } : {}),
    ...(input.resourceKind ? { resourceKind: input.resourceKind } : {}),
    ...(input.confidence ? { confidence: input.confidence } : {})
  };
}

function collectNumbers(values: readonly unknown[]): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    ids.push(value);
  }
  return ids;
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return '';
}

function truncateBody(body: string): string {
  if (body.length <= MAX_BODY_CHARS) return body;
  return `${body.slice(0, MAX_BODY_CHARS)}\n… truncated`;
}

function stableId(value: string): string {
  return sha256(value).slice(0, 24);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
