import type { Diagnostic, MsgExport, TextEntrySymbol } from '@soulforge/shared';

export interface ParseMsgTextInput {
  sourceUri: string;
  sourcePath: string;
  text: string;
  category?: string;
}

export interface ParseMsgTextResult {
  export: MsgExport;
  diagnostics: Diagnostic[];
}

/**
 * Parses lightweight text fixtures and exported FMG-like text into MsgExport.
 *
 * Supported inputs:
 * - JSON array of { textId, text, category? }
 * - JSON object with { category?, entries: [...] }
 * - TSV/CSV-ish lines: 1000<TAB>Hello or 1000,Hello
 * - XML-ish FMG entries: <text id="1000">Hello</text>
 */
export function parseMsgText(input: ParseMsgTextInput): ParseMsgTextResult {
  const diagnostics: Diagnostic[] = [];
  const json = tryParseJson(input.text);
  const category = input.category ?? inferCategory(input.sourcePath);

  if (json !== null) {
    const parsed = parseJsonMsg(json, input.sourceUri, category);
    diagnostics.push(...parsed.diagnostics);
    return { export: parsed.export, diagnostics };
  }

  const xmlEntries = parseXmlEntries(input.text, input.sourceUri, category);
  if (xmlEntries.length > 0) {
    return { export: { ...(category ? { category } : {}), entries: xmlEntries }, diagnostics };
  }

  const lineEntries = parseDelimitedLines(input.text, input.sourceUri, category);
  if (lineEntries.length > 0) {
    return { export: { ...(category ? { category } : {}), entries: lineEntries }, diagnostics };
  }

  diagnostics.push({
    severity: 'warning',
    code: 'MSG_TEXT_NO_ENTRIES_FOUND',
    message: 'No text entries were recognized in message text source.',
    sourceUri: input.sourceUri
  });

  return { export: { ...(category ? { category } : {}), entries: [] }, diagnostics };
}

function parseJsonMsg(value: unknown, sourceUri: string, category?: string): ParseMsgTextResult {
  const diagnostics: Diagnostic[] = [];
  const record = asRecord(value);
  const rootCategory = asString(record.category) || category;
  const rawEntries = Array.isArray(value) ? value : Array.isArray(record.entries) ? record.entries : [];

  if (rawEntries.length === 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'MSG_JSON_NO_ENTRIES',
      message: 'JSON message source has no entries array.',
      sourceUri
    });
  }

  const entries = rawEntries.flatMap((item, index) => parseJsonEntry(item, sourceUri, rootCategory, index));
  return { export: { ...(rootCategory ? { category: rootCategory } : {}), entries }, diagnostics };
}

function parseJsonEntry(value: unknown, sourceUri: string, category: string | undefined, index: number): TextEntrySymbol[] {
  const record = asRecord(value);
  const textId = asNumber(record.textId ?? record.id);
  if (textId === null) return [];
  const entryCategory = asString(record.category) || category;
  return [{
    uri: asString(record.uri) || `msg://${entryCategory ?? 'default'}/${textId}`,
    sourceUri,
    ...(entryCategory ? { category: entryCategory } : {}),
    textId,
    text: asString(record.text ?? record.value, '')
  }];
}

function parseXmlEntries(text: string, sourceUri: string, category?: string): TextEntrySymbol[] {
  const entries: TextEntrySymbol[] = [];
  const pattern = /<text\s+[^>]*id=["']?(\d+)["']?[^>]*>([\s\S]*?)<\/text>/gi;
  for (const match of text.matchAll(pattern)) {
    const textId = Number.parseInt(match[1] ?? '', 10);
    if (!Number.isFinite(textId)) continue;
    entries.push({
      uri: `msg://${category ?? 'default'}/${textId}`,
      sourceUri,
      ...(category ? { category } : {}),
      textId,
      text: decodeXmlEntities((match[2] ?? '').trim())
    });
  }
  return entries;
}

function parseDelimitedLines(text: string, sourceUri: string, category?: string): TextEntrySymbol[] {
  const entries: TextEntrySymbol[] = [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    const match = /^(\d+)\s*(?:\t|,|=|:)\s*(.*)$/.exec(trimmed);
    if (!match?.[1]) continue;
    const textId = Number.parseInt(match[1], 10);
    entries.push({
      uri: `msg://${category ?? 'default'}/${textId}`,
      sourceUri,
      ...(category ? { category } : {}),
      textId,
      text: (match[2] ?? '').trim().replace(/^['"]|['"]$/g, '')
    });
  }

  return entries;
}

function inferCategory(sourcePath: string): string | undefined {
  const normalized = sourcePath.toLowerCase().replaceAll('\\', '/');
  if (normalized.includes('item') || normalized.includes('goods')) return 'Goods';
  if (normalized.includes('weapon')) return 'Weapon';
  if (normalized.includes('protector') || normalized.includes('armor')) return 'Protector';
  if (normalized.includes('npc') || normalized.includes('talk')) return 'Npc';
  if (normalized.includes('menu')) return 'Menu';
  return undefined;
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}
