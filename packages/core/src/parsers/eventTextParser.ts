import type { Diagnostic, EventArg, EventExport, EventInstruction } from '@soulforge/shared';
import { extractMapIdFromPath } from '../workspace/gameProfiles.js';

export interface ParseEventTextInput {
  sourceUri: string;
  sourcePath: string;
  text: string;
  mapId?: string;
}

export interface ParseEventTextResult {
  export: EventExport;
  diagnostics: Diagnostic[];
}

interface MutableEvent {
  eventId: number;
  name?: string;
  startLine: number;
  instructions: EventInstruction[];
}

const EVENT_PATTERNS = [
  /^\s*\$?Event\s*\(\s*(\d+)\s*(?:,\s*([^,\)]+))?/i,
  /^\s*Event\s+(\d+)\b\s*(.*)$/i,
  /^\s*def\s+Event_(\d+)\b/i,
  /^\s*event\s+(\d+)\b\s*(.*)$/i
];

const INSTRUCTION_PATTERN = /^\s*([A-Za-z_][A-Za-z0-9_\.]*)\s*\((.*)\)\s*;?\s*$/;

/**
 * Parses decompiled or hand-written event text into SoulForge's event symbol model.
 *
 * This parser is intentionally heuristic. It is not a binary EMEVD parser and must
 * not be treated as authoritative. Its job is to make text-based event projects,
 * mock fixtures, and DarkScript/EVS-like sources useful before SoulsFormats is wired.
 */
export function parseEventText(input: ParseEventTextInput): ParseEventTextResult {
  const diagnostics: Diagnostic[] = [];
  const mapId = input.mapId ?? extractMapIdFromPath(input.sourcePath) ?? extractMapIdFromPath(input.sourceUri);
  const lines = input.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const events: MutableEvent[] = [];
  let current: MutableEvent | null = null;
  let braceDepth = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const rawLine = lines[index] ?? '';
    const line = stripLineComment(rawLine).trim();
    if (!line) continue;

    const eventHeader = parseEventHeader(line);
    if (eventHeader) {
      current = {
        eventId: eventHeader.eventId,
        ...(eventHeader.name ? { name: eventHeader.name } : {}),
        startLine: lineNumber,
        instructions: []
      };
      events.push(current);
      braceDepth = countBraceDelta(line);
      continue;
    }

    if (!current) continue;

    braceDepth += countBraceDelta(line);
    const instruction = parseInstructionLine(line, input.sourceUri, current.eventId, current.instructions.length, lineNumber);
    if (instruction) {
      current.instructions.push(instruction);
      continue;
    }

    if (braceDepth < 0 || /^\s*}\s*\)?\s*;?\s*$/.test(line)) {
      current = null;
      braceDepth = 0;
    }
  }

  if (events.length === 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'EVENT_TEXT_NO_EVENTS_FOUND',
      message: 'No event blocks were recognized in text source.',
      sourceUri: input.sourceUri
    });
  }

  return {
    export: {
      ...(mapId ? { mapId } : {}),
      events: events.map((event) => ({
        uri: `event://${mapId ?? 'unknown'}/${event.eventId}`,
        sourceUri: input.sourceUri,
        ...(mapId ? { mapId } : {}),
        eventId: event.eventId,
        ...(event.name ? { name: event.name } : {}),
        instructions: event.instructions,
        raw: { startLine: event.startLine }
      }))
    },
    diagnostics
  };
}

function parseEventHeader(line: string): { eventId: number; name?: string } | null {
  for (const pattern of EVENT_PATTERNS) {
    const match = pattern.exec(line);
    if (!match?.[1]) continue;
    const eventId = Number.parseInt(match[1], 10);
    const nameCandidate = cleanName(match[2]);
    return {
      eventId,
      ...(nameCandidate ? { name: nameCandidate } : {})
    };
  }
  return null;
}

function parseInstructionLine(line: string, sourceUri: string, eventId: number, index: number, lineNumber: number): EventInstruction | null {
  if (line.startsWith('if ') || line.startsWith('while ') || line.startsWith('for ')) return null;
  if (line === '{' || line === '}') return null;

  const match = INSTRUCTION_PATTERN.exec(line);
  if (!match?.[1]) return null;

  const name = match[1];
  const argText = match[2] ?? '';
  const args = splitArguments(argText).map((arg, argIndex) => parseArgument(arg, name, argIndex));

  return {
    uri: `instruction://${eventId}/${lineNumber}/${index}`,
    index,
    name,
    args,
    raw: { lineNumber, text: line, sourceUri }
  };
}

function parseArgument(text: string, instructionName: string, index: number): EventArg {
  const [nameRaw, valueRaw] = splitNamedArgument(text);
  const name = nameRaw ? cleanName(nameRaw) : undefined;
  const value = parseArgumentValue(valueRaw ?? text);
  const role = inferRole(name, instructionName, value);

  return {
    ...(name ? { name } : { name: `arg${index}` }),
    value,
    ...(role ? { role } : {})
  };
}

function splitNamedArgument(text: string): [string | null, string] {
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (char === '=' && depth === 0) return [text.slice(0, i).trim(), text.slice(i + 1).trim()];
  }
  return [null, text.trim()];
}

function splitArguments(text: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote: string | null = null;
  let depth = 0;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    if (quote) {
      current += char;
      if (char === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === '(' || char === '[' || char === '{') depth += 1;
    if (char === ')' || char === ']' || char === '}') depth -= 1;

    if (char === ',' && depth === 0) {
      if (current.trim()) result.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) result.push(current.trim());
  return result;
}

function parseArgumentValue(text: string): string | number | boolean {
  const trimmed = text.trim();
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);
  if (trimmed === 'true' || trimmed === 'True') return true;
  if (trimmed === 'false' || trimmed === 'False') return false;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function inferRole(name: string | undefined, instructionName: string, value: string | number | boolean): EventArg['role'] | undefined {
  const token = `${name ?? ''} ${instructionName}`.toLowerCase();
  if (token.includes('flag')) return 'flag';
  if (token.includes('eventid') || token.includes('event id')) return 'eventId';
  if (token.includes('entity') || token.includes('character') || token.includes('chr') || token.includes('asset') || token.includes('object')) return 'entityId';
  if (token.includes('region') || token.includes('area')) return 'regionId';
  if (token.includes('text') || token.includes('message') || token.includes('msg') || token.includes('dialog')) return 'textId';
  if (token.includes('speffect') || token.includes('param') || token.includes('row')) return 'paramId';

  if (typeof value === 'number' && instructionName.toLowerCase().startsWith('initializeevent') && name === 'arg0') return 'eventId';
  return undefined;
}

function stripLineComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length - 1; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (quote) {
      if (char === quote && line[i - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '/' && next === '/') return line.slice(0, i);
  }
  return line;
}

function countBraceDelta(line: string): number {
  let delta = 0;
  for (const char of line) {
    if (char === '{') delta += 1;
    if (char === '}') delta -= 1;
  }
  return delta;
}

function cleanName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().replace(/^['"]|['"]$/g, '').replace(/\s*\{\s*$/, '');
  if (!cleaned || cleaned === 'Default') return undefined;
  return cleaned;
}
