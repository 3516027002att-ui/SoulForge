import { createHash } from 'node:crypto';
import type {
  EventSymbol,
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
import { sourceRevisionForFile, sourceRevisionForFiles } from '../semantic/sourceRevision.js';

const MAX_BODY_CHARS = 1_800;
const MAX_INSTRUCTIONS = 24;
const MAX_FIELDS = 24;

export function buildRagCorpus(index: WorkspaceIndex, now = new Date().toISOString()): RagCorpus {
  const chunks: RagChunk[] = [];
  for (const file of index.getFiles()) {
    chunks.push(fileChunk(index.workspaceId, file));
  }
  const symbols = index.toSymbolBundle();
  for (const eventExport of symbols.events ?? []) {
    for (const event of eventExport.events) {
      chunks.push(eventChunk(index.workspaceId, event));
    }
  }
  for (const mapExport of symbols.maps ?? []) {
    for (const entity of mapExport.entities) chunks.push(mapEntityChunk(index.workspaceId, entity));
    for (const region of mapExport.regions) chunks.push(mapRegionChunk(index.workspaceId, region));
  }
  for (const taeExport of symbols.tae ?? []) {
    for (const anim of taeExport.animations) {
      for (const event of anim.events) chunks.push(taeEventChunk(index.workspaceId, taeExport, anim, event));
    }
  }
  for (const paramExport of symbols.params ?? []) {
    for (const row of paramExport.rows) chunks.push(paramRowChunk(index.workspaceId, row));
  }
  for (const msgExport of symbols.msgs ?? []) {
    for (const entry of msgExport.entries) chunks.push(textEntryChunk(index.workspaceId, entry));
  }

  // Every projected symbol inherits the revision of its native source.  A
  // persisted symbol without this match is never allowed to survive a catalog
  // rebuild, even when sourceUri is unchanged.
  const sourceByUri = new Map(index.getFiles().map((file) => [
    file.sourceUri,
    sourceRevisionForFile(file)
  ]));
  for (const chunk of chunks) {
    const revision = sourceByUri.get(chunk.sourceUri);
    if (revision) chunk.sourceRevision = revision;
  }

  const files = index.getFiles();
  const failed = files.filter((file) => file.parseStatus === 'failed' || file.parseStatus === 'unsupported').length;
  const partial = files.filter((file) => file.parseStatus === 'partial').length;
  const pending = files.filter((file) => file.parseStatus === 'unparsed').length;
  const successful = Math.max(0, files.length - failed - partial - pending);
  const coverageSourceRevision = sourceRevisionForFiles(files);

  const sourceBySymbolUri = new Map(chunks
    .filter((chunk) => chunk.sourceRevision)
    .map((chunk) => [chunk.symbolUri, chunk.sourceRevision!]));
  const references = index.listReferences().map((edge) => {
    const revisions = [...new Set([
      sourceBySymbolUri.get(edge.fromUri) ?? sourceByUri.get(edge.fromUri),
      sourceBySymbolUri.get(edge.toUri) ?? sourceByUri.get(edge.toUri)
    ].filter((value): value is string => typeof value === 'string'))].sort();
    return revisions.length > 0 ? { ...edge, sourceRevision: revisions.join('|') } : edge;
  });

  return createRagCorpus({
    workspaceId: index.workspaceId,
    builtAt: now,
    chunks,
    references,
    coverage: {
      status: files.length === 0
        ? 'SOURCE_UNAVAILABLE'
        : failed > 0 || partial > 0 || pending > 0 ? 'PARTIALLY_INDEXED' : 'FOUND',
      scope: 'rag',
      indexed: chunks.length,
      expected: files.length,
      successful,
      failed,
      ...(partial > 0 ? { partial } : {}),
      ...(coverageSourceRevision
        ? { sourceRevision: coverageSourceRevision }
        : {}),
      completenessRatio: files.length === 0 ? 0 : successful / files.length,
      resultCount: 0
    }
  });
}

export function createRagCorpus(input: {
  workspaceId: string;
  builtAt: string;
  chunks: readonly RagChunk[];
  references?: readonly ReferenceEdge[];
  coverage?: RagCorpus['coverage'];
}): RagCorpus {
  const byFamily = emptyFamilyCounts();
  for (const chunk of input.chunks) byFamily[chunk.family] += 1;
  const corpus: RagCorpus = {
    workspaceId: input.workspaceId,
    builtAt: input.builtAt,
    chunks: [...input.chunks],
    references: [...(input.references ?? [])],
    stats: { total: input.chunks.length, byFamily },
    coverage: input.coverage ?? {
      // A caller that only supplies chunks has not proven source coverage.
      // buildRagCorpus supplies the live scan coverage explicitly; persisted
      // or synthetic corpora must remain non-complete until a live source is
      // reconciled.
      status: input.chunks.length > 0 ? 'NOT_INDEXED' : 'SOURCE_UNAVAILABLE',
      scope: 'rag',
      indexed: input.chunks.length,
      expected: input.chunks.length,
      successful: 0,
      failed: 0,
      completenessRatio: 0,
      resultCount: 0
    }
  };
  attachLookupIndex(corpus);
  return corpus;
}

export function mergeCatalogAndPersisted(catalog: RagCorpus, persisted: RagCorpus): RagCorpus {
  const liveSources = new Map(catalog.chunks
    .filter((chunk) => chunk.family === 'file' && chunk.sourceRevision)
    .map((chunk) => [chunk.sourceUri, chunk.sourceRevision!]));
  const keptSymbols = persisted.chunks.filter(
    (chunk) => chunk.family !== 'file'
      && liveSources.get(chunk.sourceUri) !== undefined
      && chunk.sourceRevision !== undefined
      && liveSources.get(chunk.sourceUri) === chunk.sourceRevision
  );
  const mergedSymbols = [
    ...catalog.chunks.filter((chunk) => chunk.family !== 'file'),
    ...keptSymbols.filter((chunk) => !catalog.chunks.some((live) => live.symbolUri === chunk.symbolUri))
  ];
  const currentRevisions = new Map<string, string>();
  for (const chunk of [...catalog.chunks, ...keptSymbols]) {
    if (chunk.sourceRevision) currentRevisions.set(chunk.symbolUri, chunk.sourceRevision);
    if (chunk.sourceRevision) currentRevisions.set(chunk.sourceUri, chunk.sourceRevision);
  }
  const keptUris = new Set([
    ...catalog.chunks.map((chunk) => chunk.symbolUri),
    ...mergedSymbols.map((chunk) => chunk.symbolUri)
  ]);
  const isFreshPersistedReference = (edge: ReferenceEdge): boolean => {
    if (!edge.sourceRevision) return false;
    const revisions = [...new Set([
      currentRevisions.get(edge.fromUri),
      currentRevisions.get(edge.toUri)
    ].filter((value): value is string => typeof value === 'string'))].sort();
    return revisions.length > 0 && revisions.join('|') === edge.sourceRevision;
  };
  const keptReferences = persisted.references.filter(
    (edge) => (keptUris.has(edge.fromUri) || keptUris.has(edge.toUri)) && isFreshPersistedReference(edge)
  );
  const references = deduplicateReferences([...catalog.references, ...keptReferences]);
  return createRagCorpus({
    workspaceId: catalog.workspaceId,
    builtAt: catalog.builtAt,
    chunks: [...catalog.chunks.filter((chunk) => chunk.family === 'file'), ...mergedSymbols],
    references,
    coverage: catalog.coverage
  });
}

function deduplicateReferences(edges: readonly ReferenceEdge[]): ReferenceEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.fromUri}|${edge.toUri}|${edge.kind}|${edge.sourceRevision ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
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
    resourceKind: file.resourceKind
  });
}

function eventChunk(workspaceId: string, event: EventSymbol): RagChunk {
  const instructions = event.instructions.slice(0, MAX_INSTRUCTIONS).map((instruction) => {
    const args = instruction.args
      .map((arg) => `${arg.name ?? 'arg'}=${stringifyValue(arg.value)}${arg.role ? `@${arg.role}` : ''}`)
      .join(' ');
    return `${instruction.index} ${instruction.name ?? 'instruction'} ${args}`.trim();
  });
  const truncated = event.instructions.length > MAX_INSTRUCTIONS
    ? `\n… ${event.instructions.length - MAX_INSTRUCTIONS} more instructions`
    : '';
  const body = [
    `event ${event.eventId}`,
    event.name ? `name ${event.name}` : '',
    event.mapId ? `map ${event.mapId}` : '',
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
    resourceKind: 'event'
  });
}

function mapEntityChunk(workspaceId: string, entity: MapEntitySymbol): RagChunk {
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
    family: 'map_entity',
    title: formatMapAddress({ block, name: entity.name }),
    body,
    numericIds: collectNumbers([entity.entityId]),
    resourceKind: 'map'
  });
}

function mapRegionChunk(workspaceId: string, region: MapRegionSymbol): RagChunk {
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
    family: 'map_region',
    title: formatMapAddress({ block, name: region.name }),
    body,
    numericIds: collectNumbers([region.entityId]),
    resourceKind: 'map'
  });
}

/**
 * TAE 词条块（问题 6-C）。家族 tae_event（EMEVD 仍叫 event，勿改旧含义）。
 * 字段给全、不套 MAX_FIELDS / MAX_INSTRUCTIONS —— 词条字段通常很少。
 * numericIds 收 animId、eventTypeId、帧、以及所有可 Number.isFinite 的字段值
 * （SoundID 必须在）。
 */
function taeEventChunk(workspaceId: string, taeExport: TaeExport, anim: TaeAnimSymbol, event: TaeEventSymbol): RagChunk {
  const address = formatActionAddress({ chr: taeExport.chrId, animId: anim.animId, eventIndex: event.index });
  const lines = [
    `chr ${taeExport.chrId}`,
    `anim ${anim.code} animId ${anim.animId}${anim.hkxName ? ` hkx ${anim.hkxName}` : ''}`,
    `event e${event.index} type ${event.eventTypeId}${event.typeName ? ` ${event.typeName}` : ''}`,
    `startFrame ${event.startFrame} endFrame ${event.endFrame} startTime ${trimNumber(event.startTime)} endTime ${trimNumber(event.endTime)}`,
    ...(event.fields ?? []).map((field) => `${field.name} ${field.value}`),
    ...(event.fields && event.fields.length > 0 ? [] : event.parameterBytesHex ? [`undecoded hex=${event.parameterBytesHex}`] : []),
    taeExport.sourceUri ? `source ${relativeSourcePath(taeExport.sourceUri)}` : '',
    `address ${address}`
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
      ...numericFieldValues
    ]),
    resourceKind: 'action'
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

function paramRowChunk(workspaceId: string, row: ParamRowSymbol): RagChunk {
  const fields = (row.fields ?? []).slice(0, MAX_FIELDS)
    .map((field) => `${field.name}=${stringifyValue(field.value)}`);
  const truncated = (row.fields?.length ?? 0) > MAX_FIELDS
    ? `\n… ${(row.fields?.length ?? 0) - MAX_FIELDS} more fields`
    : '';
  const body = [
    `param ${row.paramName}`,
    `row ${row.rowId}`,
    row.rowName ? `name ${row.rowName}` : '',
    ...fields,
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
    resourceKind: 'param'
  });
}

function textEntryChunk(workspaceId: string, entry: TextEntrySymbol): RagChunk {
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
    ...(entry.confidence ? { confidence: entry.confidence } : {})
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
  sourceRevision?: string;
  sourceHash?: string;
  relativePath?: string;
  resourceKind?: ResourceKind;
  confidence?: RagChunk['confidence'];
}): RagChunk {
  const body = truncateBody(input.body);
  return {
    chunkId: `rag:${input.family}:${stableId(input.symbolUri)}`,
    workspaceId: input.workspaceId,
    sourceUri: input.sourceUri,
    symbolUri: input.symbolUri,
    family: input.family,
    title: input.title,
    body,
    numericIds: input.numericIds,
    contentHash: sha256(body),
    ...(input.sourceRevision !== undefined ? { sourceRevision: input.sourceRevision } : {}),
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
