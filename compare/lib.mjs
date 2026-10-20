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
  const list = (node, name) => {
    const items = deref(member(node, name))?.$items;
    if (!Array.isArray(items)) throw new Error(`${node.$type} ${name} has no items`);
    return items.map(deref);
  };
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
