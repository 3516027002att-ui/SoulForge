/**
 * Original static Lua subset scanner for SoulForge script reference collection.
 *
 * Scope is intentionally narrow: token boundaries, comments/strings/long-brackets,
 * function definitions, call occurrences, and local-name shadowing. It does NOT
 * parse full Lua, execute scripts, or invent script existence from naming patterns.
 * Calls that appear only inside comments or string literals are never reported.
 */

export interface LuaCallOccurrence {
  name: string;
  argsRaw: string;
  start: number;
  end: number;
  line: number;
  column: number;
  /** True when the callee expression is not a plain identifier (index/call result). */
  dynamicCallee: boolean;
  /** True when at least one call argument is non-literal (identifier/index/call). */
  dynamicArgs: boolean;
  /** First argument text when it is a quoted string or long-string literal. */
  stringLiteralArg?: string;
}

export interface LuaFunctionDefOccurrence {
  name: string;
  start: number;
  end: number;
  line: number;
  column: number;
}

export interface LuaStaticSubsetScan {
  calls: LuaCallOccurrence[];
  diagnostics: string[];
  /** Local bindings observed anywhere in the file (shadow game globals if same name). */
  localNames: Set<string>;
  functionDefs: LuaFunctionDefOccurrence[];
}

export type ParseLuaCallOccurrencesResult = Pick<LuaStaticSubsetScan, 'calls' | 'diagnostics'> & LuaStaticSubsetScan;

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

function isIdentStart(ch: string): boolean {
  return IDENT_START.test(ch);
}

function isIdentPart(ch: string): boolean {
  return IDENT_PART.test(ch);
}

function advancePosition(text: string, index: number, line: number, column: number): { line: number; column: number } {
  if (text.charCodeAt(index) === 10) {
    return { line: line + 1, column: 1 };
  }
  return { line, column: column + 1 };
}

/** Read a long-bracket opener at `index` (`[=*[`). Returns level + opener length. */
function readLongBracketOpen(text: string, index: number): { level: number; length: number } | null {
  if (text[index] !== '[') return null;
  let i = index + 1;
  let level = 0;
  while (i < text.length && text[i] === '=') {
    level += 1;
    i += 1;
  }
  if (text[i] !== '[') return null;
  return { level, length: i - index + 1 };
}

/** Read a long-bracket closer at `index` for the given level (`]=*]`). */
function readLongBracketClose(text: string, index: number, level: number): number | null {
  if (text[index] !== ']') return null;
  let i = index + 1;
  for (let n = 0; n < level; n += 1) {
    if (text[i] !== '=') return null;
    i += 1;
  }
  if (text[i] !== ']') return null;
  return i - index + 1;
}

interface SkipResult {
  next: number;
  line: number;
  column: number;
  /** Literal payload for strings/long-strings (without surrounding brackets/quotes). */
  literal?: string;
}

function skipLineComment(text: string, index: number, line: number, column: number): SkipResult {
  let i = index;
  let l = line;
  let c = column;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\n') break;
    i += 1;
    const pos = advancePosition(text, i - 1, l, c);
    l = pos.line;
    c = pos.column;
  }
  return { next: i, line: l, column: c };
}

function skipLongBracket(
  text: string,
  index: number,
  line: number,
  column: number,
  level: number,
  openLength: number
): SkipResult {
  let i = index + openLength;
  let l = line;
  let c = column;
  for (let k = 0; k < openLength; k += 1) {
    const pos = advancePosition(text, index + k, l, c);
    l = pos.line;
    c = pos.column;
  }
  const contentStart = i;
  while (i < text.length) {
    const closeLen = readLongBracketClose(text, i, level);
    if (closeLen !== null) {
      const literal = text.slice(contentStart, i);
      for (let k = 0; k < closeLen; k += 1) {
        const pos = advancePosition(text, i + k, l, c);
        l = pos.line;
        c = pos.column;
      }
      return { next: i + closeLen, line: l, column: c, literal };
    }
    const pos = advancePosition(text, i, l, c);
    l = pos.line;
    c = pos.column;
    i += 1;
  }
  return { next: i, line: l, column: c, literal: text.slice(contentStart) };
}

function skipQuotedString(
  text: string,
  index: number,
  line: number,
  column: number,
  quote: string
): SkipResult {
  let i = index + 1;
  let l = line;
  let c = column;
  const openPos = advancePosition(text, index, l, c);
  l = openPos.line;
  c = openPos.column;
  const contentStart = i;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\' && i + 1 < text.length) {
      const escPos = advancePosition(text, i, l, c);
      l = escPos.line;
      c = escPos.column;
      i += 1;
      const escPos2 = advancePosition(text, i, l, c);
      l = escPos2.line;
      c = escPos2.column;
      i += 1;
      continue;
    }
    if (ch === quote) {
      const closePos = advancePosition(text, i, l, c);
      return { next: i + 1, line: closePos.line, column: closePos.column, literal: text.slice(contentStart, i) };
    }
    const pos = advancePosition(text, i, l, c);
    l = pos.line;
    c = pos.column;
    i += 1;
  }
  return { next: i, line: l, column: c, literal: text.slice(contentStart) };
}

function skipWhitespaceAndComments(
  text: string,
  index: number,
  line: number,
  column: number
): SkipResult & { sawComment: boolean } {
  let i = index;
  let l = line;
  let c = column;
  let sawComment = false;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1;
      const pos = advancePosition(text, i - 1, l, c);
      l = pos.line;
      c = pos.column;
      continue;
    }
    if (ch === '-' && text[i + 1] === '-') {
      sawComment = true;
      const afterDash = i + 2;
      const longOpen = readLongBracketOpen(text, afterDash);
      if (longOpen) {
        const skipped = skipLongBracket(text, afterDash, l, c, longOpen.level, longOpen.length);
        i = skipped.next;
        l = skipped.line;
        c = skipped.column;
      } else {
        const skipped = skipLineComment(text, afterDash, l, c);
        i = skipped.next;
        l = skipped.line;
        c = skipped.column;
      }
      continue;
    }
    break;
  }
  return { next: i, line: l, column: c, sawComment };
}

function readIdentifier(text: string, index: number): { name: string; next: number } {
  let i = index;
  if (i >= text.length || !isIdentStart(text[i]!)) {
    return { name: '', next: index };
  }
  i += 1;
  while (i < text.length && isIdentPart(text[i]!)) {
    i += 1;
  }
  return { name: text.slice(index, i), next: i };
}

function positionAt(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    const pos = advancePosition(text, i, line, column);
    line = pos.line;
    column = pos.column;
  }
  return { line, column };
}

function argsLookDynamic(argsRaw: string): boolean {
  // Strip string/long-string literals; any remaining identifier-like token is dynamic.
  let i = 0;
  let stripped = '';
  while (i < argsRaw.length) {
    const ch = argsRaw[i]!;
    if (ch === '"' || ch === "'") {
      const skipped = skipQuotedString(argsRaw, i, 1, 1, ch);
      i = skipped.next;
      continue;
    }
    const longOpen = readLongBracketOpen(argsRaw, i);
    if (longOpen) {
      const skipped = skipLongBracket(argsRaw, i, 1, 1, longOpen.level, longOpen.length);
      i = skipped.next;
      continue;
    }
    stripped += ch;
    i += 1;
  }
  return /[A-Za-z_]/.test(stripped) || stripped.includes('..') || stripped.includes('[') || stripped.includes('(');
}

function firstStringLiteral(argsRaw: string): string | undefined {
  const trimmed = argsRaw.trim();
  if (trimmed.length === 0) return undefined;
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const skipped = skipQuotedString(trimmed, 0, 1, 1, quote);
    return skipped.literal;
  }
  const longOpen = readLongBracketOpen(trimmed, 0);
  if (longOpen) {
    const skipped = skipLongBracket(trimmed, 0, 1, 1, longOpen.level, longOpen.length);
    return skipped.literal;
  }
  return undefined;
}

function matchCallArgs(
  text: string,
  startIndex: number
): { argsRaw: string; end: number; open: string } | null {
  let i = startIndex;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1;
  const ch = text[i];
  if (ch === undefined) return null;

  if (ch === '(') {
    let depth = 1;
    let j = i + 1;
    while (j < text.length && depth > 0) {
      const c = text[j]!;
      if (c === '"' || c === "'") {
        const skipped = skipQuotedString(text, j, 1, 1, c);
        j = skipped.next;
        continue;
      }
      const longOpen = readLongBracketOpen(text, j);
      if (longOpen) {
        const skipped = skipLongBracket(text, j, 1, 1, longOpen.level, longOpen.length);
        j = skipped.next;
        continue;
      }
      if (c === '-' && text[j + 1] === '-') {
        const after = j + 2;
        const commentOpen = readLongBracketOpen(text, after);
        if (commentOpen) {
          const skipped = skipLongBracket(text, after, 1, 1, commentOpen.level, commentOpen.length);
          j = skipped.next;
          continue;
        }
        const skipped = skipLineComment(text, after, 1, 1);
        j = skipped.next;
        continue;
      }
      if (c === '(') depth += 1;
      if (c === ')') depth -= 1;
      j += 1;
    }
    return { argsRaw: text.slice(i + 1, Math.max(i + 1, j - 1)), end: j, open: 'paren' };
  }

  if (ch === '{') {
    let depth = 1;
    let j = i + 1;
    while (j < text.length && depth > 0) {
      const c = text[j]!;
      if (c === '"' || c === "'") {
        const skipped = skipQuotedString(text, j, 1, 1, c);
        j = skipped.next;
        continue;
      }
      const longOpen = readLongBracketOpen(text, j);
      if (longOpen) {
        const skipped = skipLongBracket(text, j, 1, 1, longOpen.level, longOpen.length);
        j = skipped.next;
        continue;
      }
      if (c === '{') depth += 1;
      if (c === '}') depth -= 1;
      j += 1;
    }
    return { argsRaw: text.slice(i, j), end: j, open: 'brace' };
  }

  if (ch === '"' || ch === "'") {
    const skipped = skipQuotedString(text, i, 1, 1, ch);
    return { argsRaw: text.slice(i, skipped.next), end: skipped.next, open: 'string' };
  }

  const longOpen = readLongBracketOpen(text, i);
  if (longOpen) {
    const skipped = skipLongBracket(text, i, 1, 1, longOpen.level, longOpen.length);
    return { argsRaw: text.slice(i, skipped.next), end: skipped.next, open: 'longstring' };
  }

  return null;
}

/**
 * Scan Lua-ish source for call occurrences.
 *
 * Extra scan fields (`localNames`, `functionDefs`) are additive for the script
 * provider; the required shape is `{ calls, diagnostics }`.
 */
export function parseLuaCallOccurrences(text: string): ParseLuaCallOccurrencesResult {
  const calls: LuaCallOccurrence[] = [];
  const diagnostics: string[] = [];
  const localNames = new Set<string>();
  const functionDefs: LuaFunctionDefOccurrence[] = [];

  if (typeof text !== 'string' || text.length === 0) {
    diagnostics.push('lua_scan_empty_source');
    return { calls, diagnostics, localNames, functionDefs };
  }

  let i = 0;
  let line = 1;
  let column = 1;
  /** Names of local bindings whose declaration we have already seen (file-wide conservative set). */
  const pendingLocals: string[] = [];

  const bump = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) {
      const pos = advancePosition(text, k, line, column);
      line = pos.line;
      column = pos.column;
    }
  };

  while (i < text.length) {
    const skipped = skipWhitespaceAndComments(text, i, line, column);
    bump(i, skipped.next);
    i = skipped.next;

    if (i >= text.length) break;

    const ch = text[i]!;

    // Strings / long strings: content is never a relation.
    if (ch === '"' || ch === "'") {
      const skippedStr = skipQuotedString(text, i, line, column, ch);
      bump(i, skippedStr.next);
      i = skippedStr.next;
      continue;
    }

    const longOpen = readLongBracketOpen(text, i);
    if (longOpen) {
      const skippedLong = skipLongBracket(text, i, line, column, longOpen.level, longOpen.length);
      bump(i, skippedLong.next);
      i = skippedLong.next;
      continue;
    }

    // Numbers: consume so `1.foo` does not produce a call.
    if (DIGIT.test(ch)) {
      while (i < text.length && (DIGIT.test(text[i]!) || text[i] === '.' || text[i] === 'e' || text[i] === 'E')) {
        i += 1;
        const pos = advancePosition(text, i - 1, line, column);
        line = pos.line;
        column = pos.column;
      }
      continue;
    }

    if (!isIdentStart(ch)) {
      i += 1;
      const pos = advancePosition(text, i - 1, line, column);
      line = pos.line;
      column = pos.column;
      continue;
    }

    const nameStart = i;
    const namePos = { line, column };
    const id = readIdentifier(text, i);
    if (id.name.length === 0) {
      i += 1;
      const pos = advancePosition(text, i - 1, line, column);
      line = pos.line;
      column = pos.column;
      continue;
    }
    bump(i, id.next);
    i = id.next;

    // local declarations: `local a`, `local a, b`, `local function f`
    if (id.name === 'local') {
      let j = i;
      let jl = line;
      let jc = column;
      const afterLocal = skipWhitespaceAndComments(text, j, jl, jc);
      j = afterLocal.next;
      jl = afterLocal.line;
      jc = afterLocal.column;
      if (text.startsWith('function', j) && !isIdentPart(text[j + 8] ?? '')) {
        bump(i, j + 8);
        i = j + 8;
        const afterFn = skipWhitespaceAndComments(text, i, line, column);
        bump(i, afterFn.next);
        i = afterFn.next;
        const fnName = readIdentifier(text, i);
        if (fnName.name) {
          localNames.add(fnName.name);
          functionDefs.push({
            name: fnName.name,
            start: nameStart,
            end: fnName.next,
            line: namePos.line,
            column: namePos.column
          });
          bump(i, fnName.next);
          i = fnName.next;
        }
        continue;
      }
      // Collect local names in this declaration list until `=` or statement end.
      while (j < text.length) {
        const ws = skipWhitespaceAndComments(text, j, jl, jc);
        j = ws.next;
        jl = ws.line;
        jc = ws.column;
        if (j >= text.length) break;
        const c = text[j]!;
        if (c === '=' || c === '\n' || c === ';') break;
        if (!isIdentStart(c)) break;
        const localId = readIdentifier(text, j);
        if (!localId.name) break;
        localNames.add(localId.name);
        pendingLocals.push(localId.name);
        j = localId.next;
        const after = skipWhitespaceAndComments(text, j, jl, jc);
        j = after.next;
        jl = after.line;
        jc = after.column;
        if (text[j] === ',') {
          j += 1;
          continue;
        }
        break;
      }
      bump(i, j);
      i = j;
      continue;
    }

    // function definition: `function name(` / `function M.name(` / `function M:name(`
    if (id.name === 'function') {
      const afterFn = skipWhitespaceAndComments(text, i, line, column);
      bump(i, afterFn.next);
      i = afterFn.next;
      let qualified = readIdentifier(text, i);
      if (qualified.name) {
        bump(i, qualified.next);
        i = qualified.next;
        for (;;) {
          const sep = text[i];
          if (sep !== '.' && sep !== ':') break;
          i += 1;
          const pos = advancePosition(text, i - 1, line, column);
          line = pos.line;
          column = pos.column;
          const nextPart = readIdentifier(text, i);
          if (!nextPart.name) break;
          qualified = { name: `${qualified.name}${sep}${nextPart.name}`, next: nextPart.next };
          bump(i, nextPart.next);
          i = nextPart.next;
        }
        functionDefs.push({
          name: qualified.name,
          start: nameStart,
          end: qualified.next,
          line: namePos.line,
          column: namePos.column
        });
        const root = qualified.name.split(/[.:]/)[0];
        if (root && qualified.name.includes(':')) {
          // method defs bind `self`, not the root table name as a free local.
        }
      }
      continue;
    }

    // Possible dotted/index callee chain: name(.name)* or name[index]
    let callName = id.name;
    let dynamicCallee = false;
    let scan = i;
    for (;;) {
      const peek = skipWhitespaceAndComments(text, scan, line, column);
      const c = text[peek.next];
      if (c === '.') {
        let k = peek.next + 1;
        const posDot = advancePosition(text, peek.next, line, column);
        // Do not fully track columns for the dotted tail beyond bump().
        void posDot;
        const nextId = readIdentifier(text, k);
        if (!nextId.name) break;
        callName = `${callName}.${nextId.name}`;
        bump(scan, nextId.next);
        scan = nextId.next;
        continue;
      }
      if (c === ':') {
        const nextId = readIdentifier(text, peek.next + 1);
        if (!nextId.name) break;
        callName = `${callName}:${nextId.name}`;
        bump(scan, nextId.next);
        scan = nextId.next;
        continue;
      }
      if (c === '[') {
        dynamicCallee = true;
        // Skip bracket expression conservatively to matching `]`.
        let k = peek.next + 1;
        let depth = 1;
        while (k < text.length && depth > 0) {
          const bc = text[k]!;
          if (bc === '"' || bc === "'") {
            const skippedB = skipQuotedString(text, k, 1, 1, bc);
            k = skippedB.next;
            continue;
          }
          if (bc === '[') depth += 1;
          if (bc === ']') depth -= 1;
          k += 1;
        }
        callName = `${callName}[…]`;
        bump(scan, k);
        scan = k;
        continue;
      }
      break;
    }

    i = scan;
    const argsMatch = matchCallArgs(text, i);
    if (!argsMatch) continue;

    const sliceStart = i;
    const argsRaw = argsMatch.argsRaw;
    const end = argsMatch.end;
    bump(sliceStart, end);
    i = end;

    const dynamicArgs = argsLookDynamic(argsRaw);
    const stringLiteralArg = firstStringLiteral(argsRaw);
    const occurrence: LuaCallOccurrence = {
      name: callName,
      argsRaw,
      start: nameStart,
      end,
      line: namePos.line,
      column: namePos.column,
      dynamicCallee,
      dynamicArgs
    };
    if (stringLiteralArg !== undefined) {
      occurrence.stringLiteralArg = stringLiteralArg;
    }
    calls.push(occurrence);
  }

  if (i < text.length && text.charCodeAt(i) === 10) {
    // trailing newline already handled by bump loop conditions
  }

  for (const name of pendingLocals) {
    localNames.add(name);
  }

  return { calls, diagnostics, localNames, functionDefs };
}

/** Helper exported for script provider certainty decisions. */
export function luaIsShadowedByLocal(name: string, localNames: ReadonlySet<string>): boolean {
  const root = name.split(/[.:]/)[0];
  if (localNames.has(name)) return true;
  if (root && localNames.has(root)) return true;
  return false;
}

export function luaIsDynamicCall(call: LuaCallOccurrence): boolean {
  return call.dynamicCallee || call.dynamicArgs;
}
