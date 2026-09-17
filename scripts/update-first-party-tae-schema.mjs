#!/usr/bin/env node
/*
 * Developer/validation boundary only.
 *
 * Adds native Sekiro TAE layout variants observed in the checked-in corpus to
 * the already-derived first-party payload. The script consumes no editor at
 * runtime and is not imported by the desktop application.
 */
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);
const bridgePayloadPath = new URL('bridge/SoulForge.Bridge/FormatRules/sekiro-tae-schema.v1.json.gz.base64', root);
const tsPayloadPath = new URL('packages/core/src/schema/sekiro/firstPartyTaeSchemaData.ts', root);
const csharpSchemaPath = new URL('bridge/SoulForge.Bridge/FirstParty/TaeFirstPartySchema.cs', root);

const payloadText = await readFile(bridgePayloadPath, 'utf8');
const document = JSON.parse(gunzipSync(Buffer.from(payloadText.replace(/\s+/gu, ''), 'base64')));
const characterBank = document.banks.find((bank) => bank.id === 14);
const objectBank = document.banks.find((bank) => bank.id === 13);
if (!characterBank || !objectBank) throw new Error('TAE schema 缺少 Characters_SDT/Objects_SDT bank。');

const findEvent = (bank, id) => bank.events.find((event) => event.id === id && !event.variant);
const clone = (value) => JSON.parse(JSON.stringify(value));

function decodeXmlAttribute(value) {
  return value
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&');
}

function parseXmlAttributes(text) {
  const attributes = {};
  for (const match of text.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/gu)) {
    attributes[match[1]] = decodeXmlAttribute(match[2]);
  }
  return attributes;
}

function parseReferenceTemplate(text) {
  const sizeByType = new Map([
    ['b', 1], ['u8', 1], ['s8', 1], ['u16', 2], ['s16', 2],
    ['u32', 4], ['s32', 4], ['s64', 8], ['f32', 4]
  ]);
  const events = [];
  const eventPattern = /<event\b([^>]*?)(?:\/>|>([\s\S]*?)<\/event>)/gu;
  for (const match of text.matchAll(eventPattern)) {
    const attributes = parseXmlAttributes(match[1]);
    const id = Number(attributes.id);
    if (!Number.isInteger(id)) continue;
    const body = match[2] ?? '';
    const fields = [];
    let offset = 0;
    const fieldPattern = /<(b|u8|s8|u16|s16|u32|s32|s64|f32)\b([^>]*)\/?\s*>/gu;
    for (const fieldMatch of body.matchAll(fieldPattern)) {
      const type = fieldMatch[1];
      const fieldAttributes = parseXmlAttributes(fieldMatch[2]);
      const size = sizeByType.get(type);
      if (!size) throw new Error(`TAE reference template 类型不受支持：${type}`);
      const entries = [];
      const fieldEnd = fieldMatch.index + fieldMatch[0].length;
      const nextField = body.slice(fieldEnd).search(/<(?:b|u8|s8|u16|s16|u32|s32|s64|f32)\b/iu);
      const fieldBody = nextField < 0
        ? body.slice(fieldEnd)
        : body.slice(fieldEnd, fieldEnd + nextField);
      for (const entryMatch of fieldBody.matchAll(/<entry\b([^>]*)\/?\s*>/gu)) {
        const entryAttributes = parseXmlAttributes(entryMatch[1]);
        const value = Number(entryAttributes.value);
        if (Number.isFinite(value) && entryAttributes.name !== undefined) {
          entries.push({ value, name: entryAttributes.name });
        }
      }
      fields.push({
        offset,
        size,
        type,
        name: fieldAttributes.name
          ?? (fieldAttributes.assert !== undefined
            ? `__padding_${String(fields.length).padStart(2, '0')}`
            : `Argument${String(fields.length).padStart(2, '0')}`),
        ...(fieldAttributes.assert !== undefined && Number.isFinite(Number(fieldAttributes.assert))
          ? { assert: Number(fieldAttributes.assert) }
          : {}),
        ...(entries.length > 0 ? { enum: entries } : {})
      });
      offset += size;
    }
    events.push({
      id,
      name: attributes.name ?? '',
      paramSize: offset,
      variant: false,
      fields
    });
  }
  const duplicateIds = events.filter((event, index) => events.findIndex((item) => item.id === event.id) !== index);
  if (duplicateIds.length > 0) {
    throw new Error(`TAE reference template 存在重复 event id：${[...new Set(duplicateIds.map((event) => event.id))].join(', ')}`);
  }
  return events;
}

function applyReferenceTemplate(bank, referenceEvents) {
  const existingIndexes = new Map(bank.events
    .map((event, index) => [event.variant ? undefined : event.id, index])
    .filter(([id]) => id !== undefined));
  for (const referenceEvent of referenceEvents) {
    const existingIndex = existingIndexes.get(referenceEvent.id);
    if (existingIndex === undefined) bank.events.push(referenceEvent);
    else bank.events[existingIndex] = referenceEvent;
  }
}

const referenceTemplatePath = process.env.SOULFORGE_TAE_REFERENCE_TEMPLATE?.trim();
if (referenceTemplatePath) {
  const referenceTemplate = await readFile(referenceTemplatePath, 'utf8');
  applyReferenceTemplate(characterBank, parseReferenceTemplate(referenceTemplate));
}

const addVariant = (bank, id, paramSize) => {
  const existingIndex = bank.events.findIndex((event) => event.id === id
    && event.variant
    && event.paramSize === paramSize);
  if (existingIndex >= 0) bank.events.splice(existingIndex, 1);
  const base = findEvent(bank, id);
  if (!base) throw new Error(`TAE schema 找不到 bank=${bank.id} event=${id} 的 canonical layout。`);
  if (base.paramSize === paramSize) return;
  const fields = base.fields.filter((field) => Number(field.offset) + Number(field.size) <= paramSize);
  const coveredSize = fields.length === 0 ? 0 : Math.max(...fields.map((field) => Number(field.offset) + Number(field.size)));
  if (coveredSize > paramSize) {
    throw new Error(`TAE schema 变体 bank=${bank.id} event=${id} size=${paramSize} 不是字段边界（covered=${coveredSize}）。`);
  }
  // Native TAE spans in the Sekiro corpus are sometimes the canonical
  // template followed by an 8/16-byte reserved tail.  Model that tail as
  // explicit byte fields so it is decoded, displayed, and preserved instead
  // of being silently counted as an opaque length gap.
  const completedFields = [...clone(fields)];
  let offset = coveredSize;
  let tailIndex = 0;
  while (offset < paramSize) {
    const size = Math.min(4, paramSize - offset);
    completedFields.push({
      offset,
      size,
      type: size === 4 ? 's32' : 'u8',
      name: `__padding_tail_${String(tailIndex).padStart(2, '0')}`,
      assert: 0
    });
    offset += size;
    tailIndex += 1;
  }
  bank.events.push({
    ...clone(base),
    paramSize,
    fields: completedFields,
    variant: true,
    variantOf: base.paramSize,
    variantKind: paramSize >= base.paramSize ? 'native-tail' : 'short-native'
  });
};

// These are native layouts observed in Sekiro 1.6.x TAE files. The omitted
// suffix is either a reserved/assert tail or a later optional field; the
// bytes remain preserved by the Bridge writer.
for (const [id, sizes] of [
  [0, [24]],
  [1, [24]],
  [2, [24]],
  [5, [8]],
  [66, [8]],
  [67, [8]],
  [138, [8]],
  [193, [8]],
  [225, [8]],
  [226, [8]],
  [231, [8]],
  [302, [8]],
  [313, [16]],
  [401, [8]],
  [705, [8]],
  [730, [8]],
  [932, [8]],
  [953, [8]],
  [960, [8]],
  [16, [8]],
  [96, [32]],
  [112, [16, 24]],
  [114, [32]],
  [118, [24]],
  [130, [32]],
  [131, [24]],
  [144, [24]],
  [146, [16]],
  [151, [32, 40]],
  [156, [24]],
  [193, [8, 16]],
  [228, [24]],
  [233, [40]],
  [238, [24, 32]],
  [304, [16]],
  [601, [24]],
  [603, [24]],
  [607, [24]],
  [700, [48]],
  [711, [40]],
  [713, [40]],
  [715, [40]],
  [730, [8]],
  [740, [24]],
  [792, [24]],
  [800, [24]],
  [900, [16]],
  [901, [16]],
  [920, [24]],
  [932, [8]],
  [953, [8]],
  [960, [8]],
  [128, [8]],
  [129, [24]],
  [224, [8]],
  [943, [0]],
  [708, [40, 48]],
  [944, [8]],
  [951, [8]],
  [145, [8]],
  [153, [24]],
  [790, [8]],
  [930, [8]],
  [32, [8]],
  [152, [16]],
  [936, [8]]
]) {
  for (const size of sizes) addVariant(characterBank, id, size);
}
addVariant(objectBank, 128, 8);
addVariant(objectBank, 193, 8);

// SDT's public action template is shared by the character and object TAE
// banks.  Keep object-bank names that are more specific, but copy missing
// canonical layouts into the first-party object registry so object TAE files
// do not become an accidental "unknown event" subset.
for (const base of characterBank.events.filter((event) => !event.variant)) {
  if (findEvent(objectBank, base.id)) continue;
  objectBank.events.push({ ...clone(base), fields: clone(base.fields) });
}
for (const [id, sizes] of [
  [0, [24]], [1, [24]], [2, [24]], [5, [8]], [16, [8]], [67, [8]], [96, [32]],
  [112, [16, 24]], [114, [32]], [118, [24]], [130, [32]], [131, [24]], [144, [24]],
  [146, [16]], [151, [32, 40]], [156, [24]], [193, [8, 16]], [224, [8]], [225, [8]],
  [228, [24]], [233, [40]], [238, [24, 32]], [304, [16]], [401, [8]], [601, [24]],
  [603, [24]], [607, [24]], [700, [48]], [705, [8]], [708, [40, 48]], [711, [40]],
  [713, [40]], [715, [40]], [730, [8]], [740, [24]], [792, [24]], [800, [24]],
  [900, [16]], [901, [16]], [920, [24]], [932, [8]], [953, [8]], [960, [8]]
]) {
  for (const size of sizes) addVariant(objectBank, id, size);
}

const addObservedEvent = (id, name, assertZero = false) => {
  if (findEvent(characterBank, id)) return;
  characterBank.events.push({
    id,
    name,
    paramSize: 16,
    variant: false,
    fields: [0, 4, 8, 12].map((offset, index) => ({
      offset,
      size: 4,
      type: 's32',
      name: `${name}_value_${index}`,
      ...(assertZero ? { assert: 0 } : {})
    }))
  });
};
// The public TAE registries for later FromSoftware games use the same four
// signed 32-bit slots for these event ids. Sekiro corpus inspection confirms
// the same 16-byte native shape; keep them explicit instead of treating the
// bytes as an opaque unknown event.
addObservedEvent(340, 'UnkAction340_ResetsGlobalTimestep', true);
addObservedEvent(341, 'ChrSlotSys_341');
addObservedEvent(350, 'Event_350');

for (const bank of document.banks) {
  bank.events.sort((left, right) => left.id - right.id
    || Number(Boolean(left.variant)) - Number(Boolean(right.variant))
    || left.paramSize - right.paramSize);
}
document.eventCount = document.banks.reduce((sum, bank) => sum + bank.events.length, 0);
document.fieldCount = document.banks.reduce(
  (sum, bank) => sum + bank.events.reduce((inner, event) => inner + event.fields.length, 0),
  0
);
const unsigned = { ...document };
delete unsigned.contentDigest;
document.contentDigest = `sha256:${createHash('sha256').update(stableJson(unsigned), 'utf8').digest('hex')}`;

const encoded = gzipSync(Buffer.from(JSON.stringify(document), 'utf8'), { mtime: 0 }).toString('base64');
await writeFile(bridgePayloadPath, `${encoded}\n`, 'utf8');
const tsSource = await readFile(tsPayloadPath, 'utf8');
const tsPattern = /const COMPRESSED_SCHEMA = `[^`]*`;/su;
if (!tsPattern.test(tsSource)) throw new Error('没有在 firstPartyTaeSchemaData.ts 找到压缩 schema。');
const updatedTs = tsSource.replace(
  tsPattern,
  `const COMPRESSED_SCHEMA = \`\n${encoded}\n\`;`
);
await writeFile(tsPayloadPath, updatedTs, 'utf8');

const csharpSource = await readFile(csharpSchemaPath, 'utf8');
const csharpPattern = /public const string ContentDigest = "[^"]+";/u;
if (!csharpPattern.test(csharpSource)) throw new Error('没有在 TaeFirstPartySchema.cs 找到 ContentDigest。');
const updatedCsharp = csharpSource.replace(
  csharpPattern,
  `public const string ContentDigest = "${document.contentDigest}";`
);
await writeFile(csharpSchemaPath, updatedCsharp, 'utf8');

console.log(JSON.stringify({
  ok: true,
  contentDigest: document.contentDigest,
  eventCount: document.eventCount,
  fieldCount: document.fieldCount,
  banks: document.banks.map((bank) => ({ id: bank.id, events: bank.events.length }))
}, null, 2));

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}
