/**
 * Deterministic Formatter for EMEVD DarkScript3 source code.
 *
 * Formats events, instructions, parameters, and indentation without modifying semantics.
 */

const INDENT = '    '; // 4 spaces

export function formatEventDocument(text: string): string {
  const lines = text.split('\n');
  const formatted: string[] = [];
  let inEvent = false;
  let inWaitFor = false;
  let waitForIndent = '';

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const trimmed = rawLine.trim();

    if (trimmed.length === 0) {
      // Avoid excessive blank lines (at most 1)
      if (formatted.length > 0 && formatted[formatted.length - 1] !== '') {
        formatted.push('');
      }
      continue;
    }

    // Comments: preserve as is with appropriate indent
    if (trimmed.startsWith('//') || trimmed.startsWith('/*')) {
      formatted.push(inEvent ? `${INDENT}${trimmed}` : trimmed);
      continue;
    }

    // $Event Header
    const eventHeaderMatch = /^\$Event\s*\(\s*(-?\d+)\s*,\s*([A-Za-z0-9_]+)\s*,\s*function\s*\(\s*\)\s*\{?/.exec(trimmed);
    if (eventHeaderMatch) {
      if (formatted.length > 0 && formatted[formatted.length - 1] !== '') {
        formatted.push('');
      }
      formatted.push(`$Event(${eventHeaderMatch[1]}, ${eventHeaderMatch[2]}, function() {`);
      inEvent = true;
      continue;
    }

    // Event Closing
    if (/^\}\s*\)\s*;/.test(trimmed)) {
      formatted.push('});');
      inEvent = false;
      continue;
    }

    // WaitFor start
    const waitStartMatch = /^WaitFor\s*\((.*)$/.exec(trimmed);
    if (waitStartMatch) {
      inWaitFor = true;
      waitForIndent = INDENT;
      formatted.push(`${INDENT}WaitFor(`);
      const rest = waitStartMatch[1]!.trim();
      if (rest.length > 0) {
        if (rest === ');' || rest === ')') {
          formatted.push(`${INDENT});`);
          inWaitFor = false;
        } else {
          formatted.push(`${INDENT}${INDENT}${formatInstructionCall(rest)}`);
        }
      }
      continue;
    }

    // Inside WaitFor
    if (inWaitFor) {
      if (/^\)\s*;?$/.test(trimmed)) {
        formatted.push(`${INDENT});`);
        inWaitFor = false;
        continue;
      }
      // Sub-predicate with && or ||
      const opMatch = /^(?:(&&|\|\|)\s*)?(.*)$/.exec(trimmed);
      if (opMatch) {
        const op = opMatch[1] ? `${opMatch[1]} ` : '';
        const body = opMatch[2]!.trim();
        formatted.push(`${INDENT}${INDENT}${op}${formatInstructionCall(body)}`);
      } else {
        formatted.push(`${INDENT}${INDENT}${trimmed}`);
      }
      continue;
    }

    // Regular instruction call
    if (inEvent) {
      formatted.push(`${INDENT}${formatInstructionCall(trimmed)}`);
    } else {
      formatted.push(trimmed);
    }
  }

  return formatted.join('\n').trimEnd() + '\n';
}

function formatInstructionCall(callText: string): string {
  const match = /^([A-Z][A-Za-z0-9_]*)\s*\(([\s\S]*)\)(\s*;?)$/.exec(callText);
  if (!match) return callText;

  const name = match[1]!;
  const rawArgs = match[2] ?? '';
  const semi = match[3]?.includes(';') ? ';' : '';

  const args = splitTopLevelArgs(rawArgs).map((a) => a.trim());
  return `${name}(${args.join(', ')})${semi}`;
}

function splitTopLevelArgs(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(raw.slice(start, i));
      start = i + 1;
    }
  }
  const last = raw.slice(start).trim();
  if (last.length > 0) parts.push(last);
  return parts;
}
