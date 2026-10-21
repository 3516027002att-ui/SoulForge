// Pure comparison logic for compare/run.mjs. No environment, filesystem or process access here, so the
// gate can test the oracle itself (compare/compare.test.mjs) without game files.
import { createHash } from 'node:crypto';

export const STATUSES = Object.freeze(['match', 'diff', 'known-diff', 'reference-unsupported', 'reference-unavailable']);

// Ordered element-wise comparison. The digest covers every difference, so a recorded known difference stops
// matching as soon as any part of it changes.
export function compareOrdered(expected, actual, keyOf = value => JSON.stringify(value)) {
  const hash = createHash('sha256');
  const differences = [];
  let count = 0;
  for (let index = 0; index < Math.max(expected.length, actual.length); index++) {
    const reference = index < expected.length ? keyOf(expected[index]) : '<missing>';
    const soulforge = index < actual.length ? keyOf(actual[index]) : '<missing>';
    if (reference === soulforge) continue;
    count++;
    hash.update(`${index}\0${reference}\0${soulforge}\n`);
    if (differences.length < 5) differences.push({ index, reference, soulforge });
  }
  return { equal: count === 0, referenceCount: expected.length, soulforgeCount: actual.length,
    differenceCount: count, differences, fingerprint: count ? hash.digest('hex').slice(0, 16) : null };
}

// SoulForge failed to produce output for an input the reference read: that is a difference, not a skip.
export function failedComparison(code) {
  const fingerprint = createHash('sha256').update(`soulforge-failed\0${code}`).digest('hex').slice(0, 16);
  return { equal: false, differenceCount: 1, differences: [{ soulforge: code }], fingerprint };
}

// A large reference result does not fit refcli's stdout: it prints a summary with fullResultInManifest and moves the
// full response, including source/identity, into the result manifest. Read it only when its sha256 and request id
// match the summary, so a stale or swapped manifest cannot supply the identity. readManifest(path) returns bytes.
export function resolveReferenceResponse(summary, readManifest) {
  if (summary?.fullResultInManifest !== true) return summary;
  const pointer = summary.resultManifest;
  if (typeof pointer?.path !== 'string' || !/^[0-9a-f]{64}$/u.test(pointer.sha256 ?? '')) {
    throw new Error('reference summary points at no result manifest');
  }
  const bytes = readManifest(pointer.path);
  if (createHash('sha256').update(bytes).digest('hex') !== pointer.sha256) throw new Error('reference result manifest hash mismatch');
  const full = JSON.parse(bytes.toString('utf8').replace(/^﻿/u, ''));
  if (full.requestId !== summary.requestId || full.status !== summary.status) {
    throw new Error('reference result manifest belongs to another request');
  }
  return full;
}

// A difference is only "known" while its exact fingerprint is recorded with a reason and an issue.
export function classify(item, knownDiffs) {
  if (item.reference !== 'ok') return item.reference === 'unsupported' ? 'reference-unsupported' : 'reference-unavailable';
  if (item.comparison.equal) return 'match';
  const known = knownDiffs.find(entry => entry.key === item.key);
  return known && known.fingerprint === item.comparison.fingerprint && known.reason && known.issue ? 'known-diff' : 'diff';
}

// One status per game x format x operation: any diff wins, then any unavailable reference, then known-diff.
export function groupStatus(statuses) {
  for (const status of ['diff', 'reference-unavailable', 'reference-unsupported', 'known-diff']) {
    if (statuses.includes(status)) return status;
  }
  return statuses.length ? 'match' : 'reference-unavailable';
}

// Recorded differences that this run compared and no longer observed must be removed from known-diffs.json.
export function staleKnownDiffs(items, knownDiffs) {
  return knownDiffs.filter(entry => {
    const item = items.find(candidate => candidate.key === entry.key);
    return item && item.status !== 'known-diff';
  }).map(entry => entry.key);
}

// SoulsFormats.FMG structure graph (refcli GraphWriter projection) -> ordered [{ id, text }].
export function fmgEntriesFromReferenceGraph(graph) {
  if (graph?.$type !== 'SoulsFormats.FMG') throw new Error(`expected SoulsFormats.FMG, got ${graph?.$type}`);
  const items = member(graph, 'Entries').$items;
  if (!Array.isArray(items)) throw new Error('SoulsFormats.FMG Entries has no items');
  return items.map(entry => ({ id: member(entry, 'ID'), text: member(entry, 'Text') ?? null }));
}

// Bridge read-text-catalog entries omit a null text field; normalise to the same shape.
export function fmgEntriesFromBridge(entries) {
  return entries.map(entry => ({ id: entry.id, text: entry.text ?? null }));
}

// FMG comparison keys. The read rule and the write round trip use the same entry key, so both decide "equal" alike.
export const fmgEntryKey = entry => `${entry.id} ${JSON.stringify(entry.text)}`;
export const fmgTableKey = table => JSON.stringify([table.ordinal, table.id, table.name]);

// Write round trip edit target: the first table (in listing order) holding an entry whose id occurs once in that table
// and whose text is a non-empty string. An id-only upsert then touches exactly one slot. tables: [{ ordinal, entries }].
export function pickFmgEditTarget(tables) {
  for (const table of tables) {
    const counts = new Map();
    for (const entry of table.entries) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
    const entry = table.entries.find(item => counts.get(item.id) === 1 && typeof item.text === 'string' && item.text !== '');
    if (entry) return { ordinal: table.ordinal, id: entry.id, text: entry.text };
  }
  throw new Error('no FMG table has a unique-id entry with text');
}

// Expected entries after setting one entry's text, computed from the reference read of the source, never from the
// writer. The id must occur exactly once, and the new text must differ, so an edit that changes nothing cannot pass.
export function applyFmgTextEdit(entries, id, text) {
  const slots = entries.flatMap((entry, index) => entry.id === id ? [index] : []);
  if (slots.length !== 1) throw new Error(`FMG edit target id ${id} occurs ${slots.length} times`);
  if (typeof text !== 'string') throw new Error('FMG edit text must be a string');
  if (entries[slots[0]].text === text) throw new Error(`FMG edit of id ${id} does not change its text`);
  return entries.map((entry, index) => index === slots[0] ? { id: entry.id, text } : { id: entry.id, text: entry.text });
}

// Write round trip, both sides read by the same reference build: the source (with the edit applied when there is one)
// is the expectation, the writer's output is compared with it. source/output: { tables: [{ ordinal, id, name }],
// entries: Map(ordinal -> [{ id, text }]) }; edit: null (L0 identity) or { ordinal, id, text } (L1). Every table is
// compared, so a change outside the edited table, or in another entry of it, is a difference.
export function fmgRoundtripComparisons(source, output, edit) {
  const comparisons = { tables: compareOrdered(source.tables, output.tables, fmgTableKey) };
  if (edit && !source.entries.has(edit.ordinal)) throw new Error(`FMG edit table ${edit.ordinal} is not in the source`);
  for (const table of source.tables) {
    const before = source.entries.get(table.ordinal);
    if (!before) throw new Error(`FMG source table ${table.ordinal} was not read`);
    const expected = edit && edit.ordinal === table.ordinal ? applyFmgTextEdit(before, edit.id, edit.text) : before;
    const actual = output.entries.get(table.ordinal);
    comparisons[table.ordinal] = actual ? compareOrdered(expected, actual, fmgEntryKey) : failedComparison('ROUNDTRIP_OUTPUT_TABLE_MISSING');
  }
  return comparisons;
}

// SoulsFormats.TAE graph -> ordered [{ id, file, events }]. IDs are Int64 graph values; keep their decimal text.
export function taeAnimationsFromReferenceGraph(graph) {
  if (graph?.$type !== 'SoulsFormats.TAE') throw new Error(`expected SoulsFormats.TAE, got ${graph?.$type}`);
  const items = member(graph, 'Animations').$items;
  if (!Array.isArray(items)) throw new Error('SoulsFormats.TAE Animations has no items');
  // An animation without an hkx is "" in SoulsFormats and null in the Bridge: both mean no file name.
  return items.map(animation => ({ id: integerText(member(animation, 'ID')), file: member(animation, 'AnimFileName') || null,
    events: member(animation, 'Events')?.$items?.length ?? 0 }));
}

// Bridge read-tae-document aggregates every TAE of an anibnd; select one TAE entry by its binder ordinal.
export function taeAnimationsFromBridge(animations, entryIndex) {
  return animations.filter(animation => animation.taeEntryIndex === entryIndex)
    .map(animation => ({ id: integerText(animation.animId), file: animation.hkxName || null, events: animation.eventCount }));
}

// SoulsFormats.EMEVD graph -> { events, instructions, parameters }. GraphWriter writes each reference-type object once
// with $id and every later occurrence as { $ref: id }, so nodes are resolved before they are read.
export function emevdFromReferenceGraph(graph) {
  if (graph?.$type !== 'SoulsFormats.EMEVD') throw new Error(`expected SoulsFormats.EMEVD, got ${graph?.$type}`);
  const deref = graphRefResolver(graph);
  const list = (node, name) => memberItems(node, name, deref);
  const events = [], instructions = [], parameters = [];
  for (const event of list(graph, 'Events')) {
    const eventId = integerText(member(event, 'ID'));
    const eventInstructions = list(event, 'Instructions');
    const eventParameters = list(event, 'Parameters');
    // RestBehavior is an enum graph value { name, value: "<underlying integer as text>" }.
    events.push({ id: eventId, restBehavior: integerText(member(event, 'RestBehavior')),
      instructions: eventInstructions.length, parameters: eventParameters.length });
    eventInstructions.forEach((instruction, index) => {
      const args = deref(member(instruction, 'ArgData'));
      if (args?.$type !== 'System.Byte[]' || !/^[0-9a-f]{64}$/u.test(args.sha256 ?? '')) throw new Error(`event ${eventId} instruction ${index} ArgData is not a blob`);
      // Layer is uint? in SoulsFormats: null means no layer. Only its presence is compared.
      instructions.push({ event: eventId, index, bank: integerText(member(instruction, 'Bank')), id: integerText(member(instruction, 'ID')),
        argsLength: integerText(args.length), args: args.sha256, layer: member(instruction, 'Layer') !== null });
    });
    eventParameters.forEach((parameter, index) => parameters.push({ event: eventId, index,
      instruction: integerText(member(parameter, 'InstructionIndex')), target: integerText(member(parameter, 'TargetStartByte')),
      source: integerText(member(parameter, 'SourceStartByte')), bytes: integerText(member(parameter, 'ByteCount')),
      unk: integerText(member(parameter, 'UnkID')) }));
  }
  return { events, instructions, parameters };
}

// Bridge read-emevd-document pages -> the same shape. The pages must be one parse (same source hash, pages 0..n-1 that
// agree on the totals) and together hold every instruction; an event's instructions are its
// [instructionStartIndex, +instructionCount) slice of the concatenated list.
export function emevdFromBridgePages(pages) {
  const first = pages[0];
  if (!first || pages.length !== first.instructionPageCount || pages.some((page, index) => page.instructionPage !== index
    || page.sourceHash !== first.sourceHash || page.instructionPageCount !== first.instructionPageCount
    || page.instructionTotal !== first.instructionTotal)) {
    throw new Error('Bridge EMEVD pages are incomplete or come from different sources');
  }
  const all = pages.flatMap(page => page.instructionsSample);
  if (all.length !== first.instructionTotal) throw new Error(`Bridge EMEVD returned ${all.length} of ${first.instructionTotal} instructions`);
  all.forEach((instruction, index) => { if (instruction.index !== index) throw new Error(`Bridge EMEVD instruction ${index} has index ${instruction.index}`); });
  const events = [], instructions = [], parameters = [];
  for (const event of first.events) {
    const eventId = integerText(event.id);
    const own = event.instructionCount === 0 ? [] : all.slice(event.instructionStartIndex, event.instructionStartIndex + event.instructionCount);
    if (event.instructionCount > 0 && (event.instructionStartIndex < 0 || own.length !== event.instructionCount)) {
      throw new Error(`Bridge EMEVD event ${eventId} instruction range is outside the document`);
    }
    if ((event.parameters ?? []).length !== event.parameterCount) throw new Error(`Bridge EMEVD event ${eventId} parameter count mismatch`);
    events.push({ id: eventId, restBehavior: integerText(event.restBehavior), instructions: own.length, parameters: event.parameterCount });
    own.forEach((instruction, index) => {
      const bytes = Buffer.from(instruction.argsBase64, 'base64');
      if (bytes.length !== instruction.argsLength) throw new Error(`Bridge EMEVD instruction ${instruction.index} args length mismatch`);
      // layerOffset -1 means no layer.
      instructions.push({ event: eventId, index, bank: integerText(instruction.bank), id: integerText(instruction.id),
        argsLength: String(bytes.length), args: createHash('sha256').update(bytes).digest('hex'), layer: instruction.layerOffset !== -1 });
    });
    (event.parameters ?? []).forEach((parameter, index) => parameters.push({ event: eventId, index,
      instruction: integerText(parameter.instructionIndex), target: integerText(parameter.targetStartByte),
      source: integerText(parameter.sourceStartByte), bytes: integerText(parameter.byteCount), unk: integerText(parameter.unkId) }));
  }
  return { events, instructions, parameters };
}

export const emevdKeys = Object.freeze({
  events: event => `${event.id} ${event.restBehavior} ${event.instructions} ${event.parameters}`,
  instructions: instruction => `${instruction.event}/${instruction.index} ${instruction.bank}[${instruction.id}] ${instruction.argsLength}:${instruction.args} layer=${instruction.layer}`,
  parameters: parameter => `${parameter.event}/${parameter.index} ${parameter.instruction} ${parameter.target} ${parameter.source} ${parameter.bytes} ${parameter.unk}`
});

// GraphWriter $id -> node map; the returned function replaces a { $ref } node with its target.
export function graphRefResolver(graph) {
  const byId = new Map();
  const stack = [graph];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) { for (const item of node) stack.push(item); continue; }
    if (node.$id !== undefined) {
      if (byId.has(node.$id)) throw new Error(`duplicate $id ${node.$id}`);
      byId.set(node.$id, node);
    }
    for (const value of Object.values(node)) stack.push(value);
  }
  return node => {
    if (!node || typeof node !== 'object' || !('$ref' in node)) return node;
    const target = byId.get(node.$ref);
    if (!target) throw new Error(`unresolved $ref ${node.$ref}`);
    return target;
  };
}

// A graph member's collection: the resolved node must carry an $items array; every item is resolved too.
export function memberItems(node, name, deref) {
  if (typeof deref !== 'function') throw new Error('memberItems needs a graphRefResolver');
  const items = deref(member(node, name))?.$items;
  if (!Array.isArray(items)) throw new Error(`${node.$type} ${name} has no items`);
  return items.map(deref);
}

// Int64 graph value { $type: "System.Int64", value: "<decimal>" } -> canonical decimal text, range-checked.
export function int64Text(value) {
  if (value?.$type !== 'System.Int64') throw new Error(`expected System.Int64, got ${JSON.stringify(value)}`);
  const text = value.value;
  if (typeof text !== 'string' || !/^(0|-?[1-9]\d*)$/u.test(text)) throw new Error(`not an Int64 decimal: ${JSON.stringify(value)}`);
  const big = BigInt(text);
  if (big < -(2n ** 63n) || big >= 2n ** 63n) throw new Error(`Int64 out of range: ${text}`);
  return text;
}

// IEEE-754 single bits as 8 upper-case hex digits. Exact: no tolerance, -0 differs from +0, one ulp is a difference.
export function float32Bits(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`not a finite float: ${JSON.stringify(value)}`);
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value);
  return view.getUint32(0).toString(16).toUpperCase().padStart(8, '0');
}

// GraphWriter System.Single { $type, value, bits } -> its recorded bits; the decimal text is display only.
export function referenceFloatBits(node) {
  if (node?.$type !== 'System.Single' || typeof node.bits !== 'string' || !/^[0-9A-Fa-f]{8}$/u.test(node.bits)) {
    throw new Error(`expected a System.Single with bits, got ${JSON.stringify(node)}`);
  }
  return node.bits.toUpperCase();
}

// MSBS type ids -> SoulsFormats class names, copied from the pinned SoulsFormatsNEXT (ee1dd619) enums, in declaration
// order. Every concrete class overrides Type with the enum member of its own name, so a graph $type class name is the id.
//   ModelType:  SoulsFormats/Formats/MSB/MSBS/ModelParam.cs:10-17
//   PartType:   SoulsFormats/Formats/MSB/MSBS/PartsParam.cs:10-20
//   RegionType: SoulsFormats/Formats/MSB/MSBS/PointParam.cs:10-39 (Other = 0xFFFFFFFF; the Bridge reports it as int32 -1)
//   EventType:  SoulsFormats/Formats/MSB/MSBS/EventParam.cs:10-38 (Other = 0xFFFFFFFF)
//   ShapeType:  SoulsFormats/Formats/MSB/Shape.cs:10-20
export const MSBS_TYPES = Object.freeze({
  model: [[0, 'MapPiece'], [1, 'Object'], [2, 'Enemy'], [4, 'Player'], [5, 'Collision']],
  part: [[0, 'MapPiece'], [1, 'Object'], [2, 'Enemy'], [4, 'Player'], [5, 'Collision'], [9, 'DummyObject'], [10, 'DummyEnemy'],
    [11, 'ConnectCollision']],
  region: [[1, 'InvasionPoint'], [2, 'EnvironmentMapPoint'], [4, 'Sound'], [5, 'SFX'], [6, 'WindSFX'], [8, 'SpawnPoint'],
    [11, 'PatrolRoute'], [13, 'WarpPoint'], [14, 'ActivationArea'], [15, 'Event'], [0, 'Logic'], [17, 'EnvironmentMapEffectBox'],
    [18, 'WindArea'], [20, 'MufflingBox'], [21, 'MufflingPortal'], [23, 'SoundSpaceOverride'], [24, 'MufflingPlane'],
    [25, 'PartsGroupArea'], [26, 'AutoDrawGroupPoint'], [0xFFFFFFFF, 'Other']],
  event: [[4, 'Treasure'], [5, 'Generator'], [7, 'ObjAct'], [9, 'MapOffset'], [14, 'PatrolInfo'], [15, 'PlatoonInfo'],
    [17, 'ResourceItemInfo'], [18, 'GrassLodParam'], [20, 'SkitInfo'], [21, 'PlacementGroup'], [22, 'PartsGroup'], [23, 'Talk'],
    [24, 'AutoDrawGroupCollision'], [0xFFFFFFFF, 'Other']],
  shape: [[0, 'Point'], [1, 'Circle'], [2, 'Sphere'], [3, 'Cylinder'], [4, 'Rectangle'], [5, 'Box'], [6, 'Composite']]
});
const MSB_FAMILIES = [['models', 'Models', 'Model', 'model'], ['parts', 'Parts', 'Part', 'part'],
  ['regions', 'Regions', 'Region', 'region'], ['events', 'Events', 'Event', 'event']];
const msbTypeByClass = family => new Map(MSBS_TYPES[family].map(([id, name], order) => [name, { id, name, order }]));
const msbTypeById = family => new Map(MSBS_TYPES[family].map(([id, name], order) => [id, { id, name, order }]));
// Both sides are ordered the same way: the enum declaration order, then the file order inside one type. The interleaving
// of types in the file is not compared (SoulsFormats does not keep it either).
const orderByType = rows => rows.map((row, index) => ({ row, index }))
  .sort((a, b) => a.row.typeOrder - b.row.typeOrder || a.index - b.index).map(({ row }) => { const { typeOrder, ...rest } = row; return rest; });

// SoulsFormats.MSBS graph -> { models, parts, regions, events }, each ordered by MSBS_TYPES. Region scale is not compared:
// MSBS regions have no Scale, and the Bridge MsbRegion ScaleX/Y/Z (MsbNativeDocument.cs:858-863, constant 1) are not
// in the read-msb-document envelope.
export function msbFromReferenceGraph(graph) {
  if (graph?.$type !== 'SoulsFormats.MSBS') throw new Error(`expected SoulsFormats.MSBS, got ${graph?.$type}`);
  const deref = graphRefResolver(graph);
  const result = {};
  for (const [key, paramName, familyClass, family] of MSB_FAMILIES) {
    const param = deref(member(graph, paramName));
    const types = msbTypeByClass(family);
    const pattern = new RegExp(`^SoulsFormats\\.MSBS\\+${familyClass}\\+(\\w+)$`, 'u');
    const rows = [];
    for (const { name } of param?.$members ?? []) {
      if (!Array.isArray(deref(member(param, name))?.$items)) continue;
      for (const item of memberItems(param, name, deref)) {
        const type = types.get(pattern.exec(item?.$type ?? '')?.[1]);
        if (!type) throw new Error(`unknown MSBS ${family} class ${item?.$type} in ${paramName}.${name}`);
        rows.push({ typeOrder: type.order, type: type.name, ...msbReferenceRow(family, item, deref) });
      }
    }
    result[key] = orderByType(rows);
  }
  return result;
}

function msbReferenceRow(family, item, deref) {
  const get = name => deref(member(item, name));
  const vector = name => { const value = get(name); return ['X', 'Y', 'Z'].map(axis => referenceFloatBits(member(value, axis))).join(','); };
  if (family === 'model') return { name: get('Name'), sibPath: get('SibPath') };
  if (family === 'part') return { name: get('Name'), model: get('ModelName'), position: vector('Position'), rotation: vector('Rotation'),
    scale: vector('Scale'), entityId: integerText(get('EntityID')) };
  if (family === 'region') {
    const shapeType = get('Shape')?.$type;
    const shape = /^SoulsFormats\.MSB\+Shape\+(\w+)$/u.exec(shapeType ?? '')?.[1];
    if (!msbTypeByClass('shape').has(shape)) throw new Error(`unknown MSB shape ${shapeType}`);
    return { name: get('Name'), shape, position: vector('Position'), rotation: vector('Rotation'), entityId: integerText(get('EntityID')) };
  }
  return { name: get('Name'), eventId: integerText(get('EventID')) };
}

export const msbKeys = Object.freeze({
  models: model => JSON.stringify([model.type, model.name, model.sibPath]),
  parts: part => JSON.stringify([part.type, part.name, part.model, part.position, part.rotation, part.scale, part.entityId]),
  regions: region => JSON.stringify([region.type, region.name, region.shape, region.position, region.rotation, region.entityId]),
  events: event => JSON.stringify([event.type, event.name, event.eventId])
});

// Line-by-line port of SoulsFormatsNEXT ee1dd619 SoulsFormats/Formats/MSB/MSB.cs:48-76 DisambiguateNames, over a list of
// names in entry order. Repeats whole passes until one pass renames nothing; "" is pre-counted (nameCounts[""] = 0, :58),
// so every blank name is renamed " {n}". A non-string name fails, as the C# dictionary lookup would.
export function msbDisambiguateNames(input, className = '') {
  const names = [...input];
  let ambiguous;
  do {
    ambiguous = false;
    const nameCounts = new Map();
    nameCounts.set('', 0);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (typeof name !== 'string') throw new Error(`MSB entry name is not a string: ${JSON.stringify(name)}`);
      if (!nameCounts.has(name) && name !== '') {
        nameCounts.set(name, 1);
      } else {
        ambiguous = true;
        nameCounts.set(name, nameCounts.get(name) + 1);
        names[i] = `${className}${name} {${nameCounts.get(name)}}`;
      }
    }
  } while (ambiguous);
  return names;
}

// Bridge read-msb-document envelope -> the same shape. A truncated or self-inconsistent envelope throws; an unregistered
// type id or shape is kept as a visible "<unknown ...>" value so it shows up as a difference rather than being dropped.
export function msbFromBridge(envelope) {
  if (envelope?.format !== 'MSB') throw new Error(`expected a Bridge MSB envelope, got ${envelope?.format}`);
  for (const [key] of MSB_FAMILIES) {
    if (envelope[`${key}Truncated`] !== false) throw new Error(`Bridge MSB ${key} are truncated`);
    const count = envelope[`${key.slice(0, -1)}Count`];
    if (!Array.isArray(envelope[key]) || envelope[key].length !== count) throw new Error(`Bridge MSB ${key} length does not match its count`);
  }
  const typed = (family, entry) => {
    if (!Number.isInteger(entry.typeId)) throw new Error(`Bridge MSB ${family} typeId is not an integer: ${JSON.stringify(entry.typeId)}`);
    const type = msbTypeById(family).get(entry.typeId >>> 0);
    return type ? { typeOrder: type.order, type: type.name } : { typeOrder: MSBS_TYPES[family].length, type: `<unknown typeId ${entry.typeId}>` };
  };
  const vector = (entry, prefix) => ['X', 'Y', 'Z'].map(axis => float32Bits(entry[`${prefix}${axis}`])).join(',');
  // SoulsFormats renames duplicate and blank names after reading (MSBS/MSBS.cs:112-114: Models, Regions, Parts; not Events),
  // before parts resolve ModelName (MSBS.cs:120). The Bridge arrays follow each param's entry offset table, the same order
  // SoulsFormats reads (MSBS.cs:193-213 Param.Read; MsbNativeDocument.cs ReadModels/ReadRegions/ReadParts), so the same
  // forward transform is applied to them here; reference names are never stripped.
  const names = key => msbDisambiguateNames(envelope[key].map(entry => entry.name));
  const modelNames = names('models'), partNames = names('parts'), regionNames = names('regions');
  // SoulsFormats MSB.FindName (MSB/MSB.cs:83-91): index -1 or past the end resolves to no model name.
  const modelName = index => {
    if (!Number.isInteger(index)) throw new Error(`Bridge MSB modelIndex is not an integer: ${JSON.stringify(index)}`);
    if (index === -1 || index >= modelNames.length) return null;
    return index < 0 ? `<invalid modelIndex ${index}>` : modelNames[index];
  };
  const shape = value => msbTypeById('shape').get(value)?.name ?? `<unknown shapeType ${value}>`;
  return {
    models: orderByType(envelope.models.map((model, i) => ({ ...typed('model', model), name: modelNames[i], sibPath: model.sibPath ?? null }))),
    parts: orderByType(envelope.parts.map((part, i) => ({ ...typed('part', part), name: partNames[i], model: modelName(part.modelIndex),
      position: vector(part, 'pos'), rotation: vector(part, 'rot'), scale: vector(part, 'scale'), entityId: integerText(part.entityId) }))),
    regions: orderByType(envelope.regions.map((region, i) => ({ ...typed('region', region), name: regionNames[i], shape: shape(region.shapeType),
      position: vector(region, 'pos'), rotation: vector(region, 'rot'), entityId: integerText(region.entityId) }))),
    events: orderByType(envelope.events.map(event => ({ ...typed('event', event), name: event.name, eventId: integerText(event.eventId) })))
  };
}

// A refcli diagnostic that means the reference did not read the document the way the rule asked, whatever the status says.
// PARAMDEF_REQUIRED_OR_MISMATCH was measured with status "partial"; PARAMDEF_AMBIGUOUS has no measured status, so any
// PARAMDEF_* code is treated as unsupported even next to status "ok" instead of letting the status alone decide.
export function referenceBlockingDiagnostic(response) {
  return (response?.diagnostics ?? []).map(item => item?.code).find(code => typeof code === 'string' && code.startsWith('PARAMDEF_')) ?? null;
}

// PARAM row names. SoulsFormats gives null for a row without a name; the Bridge omits the field. "" is folded into null on
// both sides: the Bridge name decoders (ParamNativeIndex.cs DecodeStandardName / ScanZLength / TryDecodeUtf16LeName) return
// null for a zero-length name, so the Bridge cannot express "" and an empty name vs no name is outside what v0 compares.
// On the mods gameparam no reference row name is "" (measured), so the fold hides nothing there. Any other type fails.
function paramRowName(name) {
  if (name === undefined || name === null || name === '') return null;
  if (typeof name !== 'string') throw new Error(`PARAM row name is not a string: ${JSON.stringify(name)}`);
  return name;
}

// SoulsFormats.PARAM graph decoded without a paramdef (header and row index only; Cells stay null) -> { header, rows }.
export function paramFromReferenceGraph(graph) {
  if (graph?.$type !== 'SoulsFormats.PARAM') throw new Error(`expected SoulsFormats.PARAM, got ${graph?.$type}`);
  const deref = graphRefResolver(graph);
  const paramType = deref(member(graph, 'ParamType'));
  if (typeof paramType !== 'string') throw new Error(`SoulsFormats.PARAM ParamType is not a string: ${JSON.stringify(paramType)}`);
  const rows = memberItems(graph, 'Rows', deref).map(row => ({ id: integerText(member(row, 'ID')), name: paramRowName(member(row, 'Name')) }));
  return { header: { paramType, rowCount: String(rows.length) }, rows };
}

// One param through the production reader (paramBridgeCommit.ts readParamDocumentViaBridge): it asks the Bridge without a
// width, and only on PARAM_ROW_SIZE_REQUIRED (single-row 32-bit params) reads the header and retries with
// resolveRowDataSize's width. maxRows is lifted past its 500-row default so every row comes back; paramFromBridgeRead
// still rejects a short result. readDocument is injected so the wiring is testable without the Bridge.
export async function readBridgeParam(readDocument, { sourcePath, allowedRoots, resolveRowDataSize, timeoutMs = 120_000 }) {
  const read = await readDocument({ sourcePath, allowedRoots, timeoutMs, maxRows: Number.MAX_SAFE_INTEGER,
    maxFrameBytes: 32 * 1024 * 1024, resolveRowDataSize });
  if (!read?.ok) {
    const codes = [...new Set((read?.diagnostics ?? []).map(item => item?.code).filter(Boolean))];
    return { error: codes.join('+') || 'BRIDGE_READ_FAILED' };
  }
  try { return { data: paramFromBridgeRead(read.data) }; }
  catch (error) { return { error: `BRIDGE_PARAM_INCONSISTENT: ${error.message}` }; }
}

// readParamDocumentViaBridge data -> { header, rows }. A short, reordered or untyped result throws.
export function paramFromBridgeRead(data) {
  if (typeof data?.typeName !== 'string') throw new Error(`Bridge PARAM typeName is not a string: ${JSON.stringify(data?.typeName)}`);
  const rows = data.rows;
  if (!Array.isArray(rows) || !Number.isInteger(data.rowCount) || rows.length !== data.rowCount) {
    throw new Error(`Bridge PARAM returned ${rows?.length} of ${data.rowCount} rows`);
  }
  rows.forEach((row, index) => { if (row.rowIndex !== index) throw new Error(`Bridge PARAM row ${index} has rowIndex ${row.rowIndex}`); });
  return { header: { paramType: data.typeName, rowCount: String(data.rowCount) },
    rows: rows.map(row => ({ id: integerText(row.id), name: paramRowName(row.name) })) };
}

export const paramKeys = Object.freeze({
  // refcli entries.json has ordinal; Bridge read-dcx-document nested entries have index.
  entries: entry => JSON.stringify([integerText(entry.ordinal ?? entry.index), integerText(entry.id), entry.name]),
  header: header => JSON.stringify([header.paramType, header.rowCount]),
  rows: row => JSON.stringify([row.id, row.name])
});

function integerText(value) {
  const raw = value && typeof value === 'object' ? value.value : value;
  if (typeof raw === 'number' ? !Number.isSafeInteger(raw) : !/^-?\d+$/u.test(String(raw))) throw new Error(`not an integer: ${JSON.stringify(value)}`);
  return String(raw);
}

function member(node, name) {
  const found = node?.$members?.find(item => item.name === name);
  if (!found) throw new Error(`member ${name} missing on ${node?.$type}`);
  return found.value;
}
