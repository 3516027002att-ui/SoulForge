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
  TextEntrySymbol
} from '@soulforge/shared';
import { RAG_CHUNK_FAMILIES } from '@soulforge/shared';
import type { WorkspaceIndex } from '../indexing/workspaceIndex.js';

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
  for (const paramExport of symbols.params ?? []) {
    for (const row of paramExport.rows) chunks.push(paramRowChunk(index.workspaceId, row));
  }
  for (const msgExport of symbols.msgs ?? []) {
    for (const entry of msgExport.entries) chunks.push(textEntryChunk(index.workspaceId, entry));
  }

  return createRagCorpus({
    workspaceId: index.workspaceId,
    builtAt: now,
    chunks,
    references: index.listReferences()
  });
}

export function createRagCorpus(input: {
  workspaceId: string;
  builtAt: string;
  chunks: readonly RagChunk[];
  references?: readonly ReferenceEdge[];
}): RagCorpus {
  const byFamily = emptyFamilyCounts();
  for (const chunk of input.chunks) byFamily[chunk.family] += 1;
  return {
    workspaceId: input.workspaceId,
    builtAt: input.builtAt,
    chunks: [...input.chunks],
    references: [...(input.references ?? [])],
    stats: { total: input.chunks.length, byFamily }
  };
}

export function mergeCatalogAndPersisted(catalog: RagCorpus, persisted: RagCorpus): RagCorpus {
  const liveSources = new Set(catalog.chunks.map((chunk) => chunk.sourceUri));
  const keptSymbols = persisted.chunks.filter(
    (chunk) => chunk.family !== 'file' && liveSources.has(chunk.sourceUri)
  );
  const keptUris = new Set(keptSymbols.map((chunk) => chunk.symbolUri));
  const keptReferences = persisted.references.filter(
    (edge) => keptUris.has(edge.fromUri) || keptUris.has(edge.toUri)
  );
  return createRagCorpus({
    workspaceId: catalog.workspaceId,
    builtAt: catalog.builtAt,
    chunks: [...catalog.chunks.filter((chunk) => chunk.family === 'file'), ...keptSymbols],
    references: keptReferences
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
  const body = [
    `entity ${entity.entityId ?? 'unnamed'}`,
    `name ${entity.name}`,
    `kind ${entity.kind}`,
    entity.model ? `model ${entity.model}` : '',
    `map ${entity.mapId}`,
    entity.position ? `position ${entity.position.join(' ')}` : ''
  ].filter(Boolean).join('\n');
  return makeChunk({
    workspaceId,
    sourceUri: entity.sourceUri,
    symbolUri: entity.uri,
    family: 'map_entity',
    title: `${entity.mapId} ${entity.name}`,
    body,
    numericIds: collectNumbers([entity.entityId]),
    resourceKind: 'map'
  });
}

function mapRegionChunk(workspaceId: string, region: MapRegionSymbol): RagChunk {
  const body = [
    `region ${region.entityId ?? 'unnamed'}`,
    `name ${region.name}`,
    region.shape ? `shape ${region.shape}` : '',
    `map ${region.mapId}`,
    region.position ? `position ${region.position.join(' ')}` : ''
  ].filter(Boolean).join('\n');
  return makeChunk({
    workspaceId,
    sourceUri: region.sourceUri,
    symbolUri: region.uri,
    family: 'map_region',
    title: `${region.mapId} region ${region.name}`,
    body,
    numericIds: collectNumbers([region.entityId]),
    resourceKind: 'map'
  });
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
