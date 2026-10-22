/**
 * Compact TAE event for action search results and compact action reads (#52): the event's exact address, index,
 * type, timing and decoded values. Field layout (offsets, sizes, enum tables), padding that holds its asserted
 * value, per-event source identity and the raw copy stay in the full read. Pages hold a fixed number of events,
 * independent of their content, so a search preview and the read_tae_events continuation number the same pages.
 *
 * Page size from three Sekiro character anibnd (c0000, c5080, c5400; 95,859 events): a 64-event compact page was
 * at most 29.3 KB (p99 24.5 KB), well inside the 64 KiB tool-result bound, and 73-87% of actions fit on one page.
 */
export const TAE_COMPACT_PAGE_SIZE = 64;
const HEX_PREVIEW_CHARS = 256;

export interface TaeCompactField {
  name: string;
  value: string | number | boolean;
  /** Enum label, only when it is not just another spelling of value. */
  display?: string;
  /** Schema field index, only when the name repeats within the event (fieldName alone would be ambiguous). */
  index?: number;
  /** Padding kept because it does not hold its asserted value; not writable. */
  padding?: true;
}

export interface TaeCompactEvent {
  index: number;
  /** Exact event address for read_tae_events, mutations and insert templates. */
  address?: string;
  eventTypeId: number;
  typeName?: string;
  startFrame: number;
  endFrame: number;
  startTime: number;
  endTime: number;
  fields?: TaeCompactField[];
  decodeStatus?: 'partial' | 'unknown';
  /** Only when decoded fields do not represent the parameter body. */
  parameterBytesHex?: string;
  parameterBytesHexTruncated?: true;
  parameterByteLength?: number;
}

/** Either an indexed TaeEventSymbol (`index`, `uri`) or a read_tae_events snapshot (`eventIndex`, `address`). */
interface TaeEventLike {
  index?: number;
  eventIndex?: number;
  address?: string;
  uri?: string;
  eventTypeId: number;
  typeName?: string;
  startFrame: number;
  endFrame: number;
  startTime: number;
  endTime: number;
  fields?: Array<{ name: string; value: string | number | boolean; displayValue?: string; index?: number;
    isPadding?: boolean; assert?: number; assertValid?: boolean }>;
  decodeStatus?: 'decoded' | 'partial' | 'unknown';
  parameterBytesHex?: string;
}

type SourceField = NonNullable<TaeEventLike['fields']>[number];

// Padding is dropped only when the source marks it and it holds its asserted (or zero) value.
function isQuietPadding(field: SourceField): boolean {
  if (field.isPadding !== true || field.assertValid === false) return false;
  const expected = typeof field.assert === 'number' ? field.assert : 0;
  return field.value === expected || field.value === String(expected) || (expected === 0 && field.value === false);
}

// "False" for false or "2.8E-44" for 2.8e-44 restates the value; "Common Key Input" for 87 does not.
function isLabel(field: SourceField): boolean {
  const display = field.displayValue;
  if (display === undefined || display === String(field.value)) return false;
  if (typeof field.value === 'boolean') return display.toLowerCase() !== String(field.value);
  if (typeof field.value === 'number') return display.trim() === '' || Number(display) !== field.value;
  return true;
}

export function compactTaeEvent(event: TaeEventLike): TaeCompactEvent {
  const index = event.index ?? event.eventIndex;
  if (!Number.isSafeInteger(index)) throw Object.assign(new Error('TAE 词条缺少下标。'), { code: 'TAE_EVENT_INDEX_MISSING' });
  const kept = (event.fields ?? []).filter(field => !isQuietPadding(field));
  const names = new Map<string, number>();
  for (const field of kept) names.set(field.name, (names.get(field.name) ?? 0) + 1);
  const fields = kept.map(field => ({ name: field.name, value: field.value,
    ...(isLabel(field) ? { display: field.displayValue! } : {}),
    ...(names.get(field.name)! > 1 && Number.isSafeInteger(field.index) ? { index: field.index! } : {}),
    ...(field.isPadding === true ? { padding: true as const } : {}) }));
  const decodeStatus = event.decodeStatus === 'partial' || event.decodeStatus === 'unknown' ? event.decodeStatus : undefined;
  // Without a decode status (indexed symbols), decoded fields stand for the body; with one, only 'decoded' does.
  const bodyInFields = event.decodeStatus === undefined ? (event.fields?.length ?? 0) > 0 : event.decodeStatus === 'decoded';
  const hex = bodyInFields ? undefined : event.parameterBytesHex;
  const address = event.address ?? event.uri;
  return {
    index: index!, ...(address ? { address } : {}), eventTypeId: event.eventTypeId, ...(event.typeName ? { typeName: event.typeName } : {}),
    startFrame: event.startFrame, endFrame: event.endFrame, startTime: event.startTime, endTime: event.endTime,
    ...(fields.length ? { fields } : {}),
    ...(decodeStatus ? { decodeStatus } : {}),
    ...(hex ? { parameterBytesHex: hex.slice(0, HEX_PREVIEW_CHARS),
      ...(hex.length > HEX_PREVIEW_CHARS ? { parameterBytesHexTruncated: true as const, parameterByteLength: Math.ceil(hex.length / 2) } : {}) } : {})
  };
}
