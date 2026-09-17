/**
 * 受限 Lua 词法 + 静态子集解析（执行指令 §T06 步骤 4/5/6/7）。
 *
 * 这里是源码引用图的静态语法补充层；HKS 字节码的完整反编译/回编译由 Bridge
 * 内置 first-party dialect 负责，本模块不执行 Lua，也不把源码引用分析冒充 native
 * 字节码覆盖。`scriptContainerEvidence` 只做容器级 magic 清点，因此这里新增一个**只读静态
 * 子集**解析器。它不执行 Lua、不引入解释器，也不试图覆盖完整语法：解析不了的
 * 位置显式记为诊断，绝不静默当作“没有调用”。
 *
 * 子集必须区分（§T06 步骤 5）：行注释、长注释、单/双引号字符串、长字符串、
 * 数字、标识符、函数定义、调用表达式、局部声明、成员调用。所有调用节点由
 * token + source span 构造 —— 生产证明禁止用全文件正则抓 `name(number)`。
 *
 * 遮蔽语义（§T06 步骤 6）：
 * - `function NAME(...)` / `local function NAME(...)` 是定义，不是调用。
 * - 字符串与注释里的函数名不产生调用（词法层已排除）。
 * - 块作用域内的 `local` 同名声明遮蔽全局 API：被遮蔽的调用标 `isLocal`，
 *   永不生成“已确认游戏 API 引用”。
 */

export type LuaTokenType = 'name' | 'number' | 'string' | 'keyword' | 'punct';

export interface LuaToken {
  type: LuaTokenType;
  /** Raw source slice for the token (strings keep their quotes). */
  value: string;
  /** Zero-based absolute character offset of the first token character. */
  start: number;
  /** Zero-based absolute character offset one past the last character. */
  end: number;
}

export interface LuaSpan {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  startOffset: number;
  endOffset: number;
}

export interface LuaParseDiagnostic {
  severity: 'warning' | 'error';
  code: string;
  message: string;
  span?: LuaSpan;
}

export type LuaArgKind = 'literal' | 'name' | 'member' | 'table' | 'expression';

export interface LuaArg {
  kind: LuaArgKind;
  /** Exact source slice of this argument — never rewritten. */
  text: string;
  span: LuaSpan;
  /** Present only when the argument is a bare literal token. */
  literal?: string | number | boolean | null;
}

export interface LuaCall {
  /** Dotted/colon callee chain as written, e.g. `a.b.c`. */
  callee: string;
  /** First identifier of the chain — the symbol looked up for shadowing. */
  rootName: string;
  calleeSpan: LuaSpan;
  /** Span of the whole call expression, including parentheses. */
  span: LuaSpan;
  args: LuaArg[];
  /** True when the callee root is a local symbol in scope at the call site. */
  isLocal: boolean;
  /** True when a local in scope shadows a global of the same name. */
  shadowedGlobal: boolean;
  /** True for a `require`-style module-load call. */
  isRequire: boolean;
}

export interface LuaLocalBinding {
  name: string;
  /** Literal value when `local NAME = <literal>`; absent for other forms. */
  literal?: string | number | boolean | null;
  /** True when the binding is a function definition. */
  isFunction: boolean;
  /** Set when the name is re-assigned later — the literal is no longer unique. */
  modified: boolean;
  /** Depth of the scope frame the binding lives in (for shadow lookups). */
  depth: number;
  span: LuaSpan;
}

export interface LuaParseResult {
  calls: LuaCall[];
  /** Every local binding recorded during the scan, with its declaring scope. */
  bindings: LuaLocalBinding[];
  /** Statements we deliberately did not interpret (bounded static subset). */
  diagnostics: LuaParseDiagnostic[];
  /** True when the file could not be lexed to completion. */
  lexTruncated: boolean;
}

const LUA_KEYWORDS: ReadonlySet<string> = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto',
  'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while'
]);

/** Keywords that open a lexical scope closed by `end`/`until`. */
const SCOPE_OPENERS: ReadonlySet<string> = new Set(['do', 'then', 'function', 'repeat']);

const MAX_LEX_DIAGNOSTICS = 50;

/* ------------------------------------------------------------------ */
/*  Lexer                                                              */
/* ------------------------------------------------------------------ */

export function tokenizeLua(text: string): { tokens: LuaToken[]; diagnostics: LuaParseDiagnostic[] } {
  const tokens: LuaToken[] = [];
  const diagnostics: LuaParseDiagnostic[] = [];
  const pushDiagnostic = (diagnostic: LuaParseDiagnostic): void => {
    if (diagnostics.length < MAX_LEX_DIAGNOSTICS) diagnostics.push(diagnostic);
  };
  let i = 0;
  const length = text.length;

  const isNameStart = (ch: string): boolean => /[A-Za-z_]/u.test(ch);
  const isNamePart = (ch: string): boolean => /[A-Za-z0-9_]/u.test(ch);

  /** Read a `[=*[` long-bracket opener at `pos`; returns level and content start, or null. */
  const readLongBracket = (pos: number): { level: number; contentStart: number } | null => {
    if (text[pos] !== '[') return null;
    let cursor = pos + 1;
    let level = 0;
    while (text[cursor] === '=') { level += 1; cursor += 1; }
    if (text[cursor] !== '[') return null;
    return { level, contentStart: cursor + 1 };
  };

  const skipLongBracket = (pos: number, level: number): number => {
    const closer = `]${'='.repeat(level)}]`;
    const found = text.indexOf(closer, pos);
    return found === -1 ? -1 : found + closer.length;
  };

  while (i < length) {
    const ch = text[i]!;

    if (ch === '\r' || ch === '\n' || ch === ' ' || ch === '\t' || ch === '\f' || ch === '\v') {
      i += 1;
      continue;
    }

    // Comments (line and long).
    if (ch === '-' && text[i + 1] === '-') {
      const bracket = readLongBracket(i + 2);
      if (bracket) {
        const end = skipLongBracket(bracket.contentStart, bracket.level);
        if (end === -1) {
          pushDiagnostic({
            severity: 'error',
            code: 'LUA_UNTERMINATED_LONG_COMMENT',
            message: `起始于偏移 ${i} 的长注释没有闭合，词法分析在此停止。`,
            span: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0, startOffset: i, endOffset: length }
          });
          return { tokens, diagnostics };
        }
        i = end;
        continue;
      }
      const newline = text.indexOf('\n', i);
      i = newline === -1 ? length : newline + 1;
      continue;
    }

    // Long strings.
    if (ch === '[') {
      const bracket = readLongBracket(i);
      if (bracket) {
        const end = skipLongBracket(bracket.contentStart, bracket.level);
        if (end === -1) {
          pushDiagnostic({
            severity: 'error',
            code: 'LUA_UNTERMINATED_LONG_STRING',
            message: `起始于偏移 ${i} 的长字符串没有闭合，词法分析在此停止。`,
            span: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0, startOffset: i, endOffset: length }
          });
          return { tokens, diagnostics };
        }
        tokens.push({ type: 'string', value: text.slice(i, end), start: i, end });
        i = end;
        continue;
      }
    }

    // Quoted strings.
    if (ch === '"' || ch === "'") {
      let cursor = i + 1;
      let closed = false;
      while (cursor < length) {
        const current = text[cursor]!;
        if (current === '\\') { cursor += 2; continue; }
        if (current === '\n') break;
        if (current === ch) { closed = true; cursor += 1; break; }
        cursor += 1;
      }
      if (!closed) {
        pushDiagnostic({
          severity: 'error',
          code: 'LUA_UNTERMINATED_STRING',
          message: `起始于偏移 ${i} 的字符串字面量未闭合，词法分析在此停止。`,
          span: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0, startOffset: i, endOffset: length }
        });
        return { tokens, diagnostics };
      }
      tokens.push({ type: 'string', value: text.slice(i, cursor), start: i, end: cursor });
      i = cursor;
      continue;
    }

    // Numbers (decimal, float, exponent, hex).
    if (/[0-9]/u.test(ch) || (ch === '.' && /[0-9]/u.test(text[i + 1] ?? ''))) {
      const rest = text.slice(i);
      const numeric = /^(?:0[xX][0-9a-fA-F]+|(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?)/u.exec(rest);
      if (numeric) {
        tokens.push({ type: 'number', value: numeric[0], start: i, end: i + numeric[0].length });
        i += numeric[0].length;
        continue;
      }
    }

    // Names and keywords.
    if (isNameStart(ch)) {
      let cursor = i + 1;
      while (cursor < length && isNamePart(text[cursor]!)) cursor += 1;
      const value = text.slice(i, cursor);
      tokens.push({
        type: LUA_KEYWORDS.has(value) ? 'keyword' : 'name',
        value,
        start: i,
        end: cursor
      });
      i = cursor;
      continue;
    }

    if (text.slice(i, i + 3) === '...') {
      tokens.push({ type: 'punct', value: '...', start: i, end: i + 3 });
      i += 3;
      continue;
    }

    // Multi-character operators before single punctuation.
    const two = text.slice(i, i + 2);
    if (two === '==' || two === '~=' || two === '<=' || two === '>=' || two === '..' || two === '::' || two === '//') {
      tokens.push({ type: 'punct', value: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if ('(){}[],;.:+-*/%^<>=#'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }

    // Anything else is outside the supported subset: stop rather than guess.
    pushDiagnostic({
      severity: 'error',
      code: 'LUA_UNSUPPORTED_CHARACTER',
      message: `偏移 ${i} 处的字符「${ch}」不在受限 Lua 子集内，解析在此停止。`,
      span: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0, startOffset: i, endOffset: i + 1 }
    });
    return { tokens, diagnostics };
  }

  return { tokens, diagnostics };
}

/* ------------------------------------------------------------------ */
/*  Spans                                                              */
/* ------------------------------------------------------------------ */

/** Line start offsets computed once; spans are derived, never guessed. */
export function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

export function spanFromOffsets(text: string, start: number, end: number, offsets: number[]): LuaSpan {
  const lineOf = (offset: number): { line: number; column: number } => {
    let low = 0;
    let high = offsets.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (offsets[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low, column: offset - offsets[low]! };
  };
  const from = lineOf(start);
  const to = lineOf(end);
  return {
    startLine: from.line,
    startColumn: from.column,
    endLine: to.line,
    endColumn: to.column,
    startOffset: start,
    endOffset: end
  };
}

/* ------------------------------------------------------------------ */
/*  Statement walker (calls, locals, shadowing)                        */
/* ------------------------------------------------------------------ */

interface Frame {
  bindings: Map<string, LuaLocalBinding>;
}

/**
 * Parse the bounded static subset. The walker is statement-oriented and
 * deliberately conservative: anything it cannot classify is recorded in
 * `diagnostics` instead of being silently skipped.
 */
export function parseLuaStaticSubset(text: string): LuaParseResult {
  const { tokens, diagnostics } = tokenizeLua(text);
  const offsets = lineOffsets(text);
  const calls: LuaCall[] = [];
  const frames: Frame[] = [{ bindings: new Map() }];
  const bindings: LuaLocalBinding[] = [];
  const lexTruncated = diagnostics.some((item) => item.severity === 'error');

  const declare = (name: string, token: LuaToken, extra: {
    literal?: string | number | boolean | null;
    isFunction: boolean;
    modified: boolean;
  }): void => {
    const record: LuaLocalBinding = {
      name,
      depth: frames.length - 1,
      span: spanFromOffsets(text, token.start, token.end, offsets),
      ...extra
    };
    frames[frames.length - 1]!.bindings.set(name, record);
    bindings.push(record);
  };

  const lookup = (name: string): LuaLocalBinding | undefined => {
    for (let index = frames.length - 1; index >= 0; index -= 1) {
      const found = frames[index]!.bindings.get(name);
      if (found) return found;
    }
    return undefined;
  };

  const pushFrame = (): void => { frames.push({ bindings: new Map() }); };
  const popFrame = (): void => { if (frames.length > 1) frames.pop(); };

  const isPunct = (token: LuaToken | undefined, value: string): boolean =>
    token !== undefined && token.type === 'punct' && token.value === value;
  const isKeyword = (token: LuaToken | undefined, value: string): boolean =>
    token !== undefined && token.type === 'keyword' && token.value === value;
  const isName = (token: LuaToken | undefined): boolean => token?.type === 'name';

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;

    if (token.type === 'keyword') {
      if (token.value === 'local') {
        const next = tokens[i + 1];
        if (isKeyword(next, 'function')) {
          const name = tokens[i + 2];
          if (name && isName(name)) {
            // Definition, not a call; its name shadows a global from here on.
            declare(name.value, name, { isFunction: true, modified: false });
            pushFrame();
            i += 2;
            continue;
          }
        }
        if (isName(next)) {
          // `local a[, b]... [= <literal | expr>]` — a literal binding is only
          // recorded for a single name with a single literal initialiser.
          let cursor = i + 1;
          const names: LuaToken[] = [];
          while (isName(tokens[cursor])) {
            names.push(tokens[cursor]!);
            cursor += 1;
            if (isPunct(tokens[cursor], ',')) { cursor += 1; continue; }
            break;
          }
          const hasValue = isPunct(tokens[cursor], '=');
          const valueToken = hasValue ? tokens[cursor + 1] : undefined;
          const literal = valueToken ? literalOf(valueToken) : undefined;
          const single = names.length === 1;
          for (const name of names) {
            declare(name.value, name, {
              ...(single && literal !== undefined ? { literal } : {}),
              isFunction: false,
              modified: hasValue && !(single && literal !== undefined)
            });
          }
          if (hasValue && !(single && literal !== undefined)) {
            diagnostics.push({
              severity: 'warning',
              code: 'LUA_LOCAL_NON_LITERAL',
              message: `局部 ${names.map((item) => item.value).join(', ')} 的初始值不是可静态解析的字面量，按动态值处理。`,
              span: valueToken
                ? spanFromOffsets(text, valueToken.start, valueToken.end, offsets)
                : spanFromOffsets(text, token.start, token.end, offsets)
            });
          }
          // Resume right after `local`; the RHS (which may itself contain
          // calls like `local x = compute()`) is re-scanned, never skipped.
          i = cursor - 1;
          continue;
        }
        diagnostics.push({
          severity: 'warning',
          code: 'LUA_UNSUPPORTED_LOCAL_FORM',
          message: `偏移 ${token.start} 的 local 声明形式不在受限子集内，其作用域影响未计入。`,
          span: spanFromOffsets(text, token.start, token.end, offsets)
        });
        continue;
      }
      if (token.value === 'function') {
        // `function NAME(` / `function a.b:c(` — the name is a definition.
        pushFrame();
        continue;
      }
      if (SCOPE_OPENERS.has(token.value)) { pushFrame(); continue; }
      if (token.value === 'end' || token.value === 'until') { popFrame(); continue; }
      continue;
    }

    if (token.type !== 'name') continue;

    // Plain assignment `NAME = ...` invalidates a unique literal binding.
    if (isPunct(tokens[i + 1], '=') && !isPunct(tokens[i + 2], '=')) {
      const binding = lookup(token.value);
      if (binding) binding.modified = true;
      continue;
    }

    // Call expression: NAME (. NAME | : NAME)* ( args ) | string | table
    let cursor = i + 1;
    const chain: string[] = [token.value];
    let chainEnd = token.end;
    while ((isPunct(tokens[cursor], '.') || isPunct(tokens[cursor], ':')) && isName(tokens[cursor + 1])) {
      chain.push(tokens[cursor + 1]!.value);
      chainEnd = tokens[cursor + 1]!.end;
      cursor += 2;
    }
    const callee = chain.join('.');
    const rootName = chain[0]!;
    const binding = lookup(rootName);
    const isLocal = binding !== undefined;

    const open = tokens[cursor];
    let args: LuaArg[] = [];
    let callEnd = chainEnd;

    if (isPunct(open, '(')) {
      const parsed = readArguments(tokens, cursor + 1, text, offsets);
      args = parsed.args;
      cursor = parsed.next;
      callEnd = tokens[cursor - 1]?.end ?? chainEnd;
    } else if (open && (open.type === 'string' || isPunct(open, '{'))) {
      const parsed = open.type === 'string'
        ? { args: [classifyArgSegment([open], text, offsets)!], next: cursor + 1 }
        : readTableArg(tokens, cursor, text, offsets);
      args = parsed.args;
      cursor = parsed.next;
      callEnd = tokens[cursor - 1]?.end ?? chainEnd;
    } else {
      continue;
    }

    calls.push({
      callee,
      rootName,
      calleeSpan: spanFromOffsets(text, token.start, chainEnd, offsets),
      span: spanFromOffsets(text, token.start, callEnd, offsets),
      args,
      isLocal,
      shadowedGlobal: isLocal && chain.length === 1,
      isRequire: chain.length === 1 && rootName === 'require'
    });
    i = cursor - 1;
  }

  return { calls, bindings, diagnostics, lexTruncated };
}

function literalOf(token: LuaToken): string | number | boolean | null | undefined {
  if (token.type === 'string') return decodeLuaString(token.value);
  if (token.type === 'number') return parseLuaNumber(token.value);
  if (token.type === 'keyword' && token.value === 'true') return true;
  if (token.type === 'keyword' && token.value === 'false') return false;
  if (token.type === 'keyword' && token.value === 'nil') return null;
  return undefined;
}

interface ArgParse { args: LuaArg[]; next: number }

/**
 * Read a comma-separated argument list up to its matching `)`. Nested
 * parens/braces/brackets are tracked by depth; a bare name becomes `name`, a
 * dotted chain becomes `member`, a literal token becomes `literal`, anything
 * else is `expression` — never guessed.
 */
function readArguments(tokens: LuaToken[], start: number, text: string, offsets: number[]): ArgParse {
  const args: LuaArg[] = [];
  let cursor = start;
  let depth = 0;
  let segmentStart = cursor;

  const flush = (): void => {
    if (segmentStart >= cursor) { segmentStart = cursor; return; }
    const arg = classifyArgSegment(tokens.slice(segmentStart, cursor), text, offsets);
    if (arg) args.push(arg);
    segmentStart = cursor;
  };

  while (cursor < tokens.length) {
    const token = tokens[cursor]!;
    if (depth === 0 && isPunctToken(token, ')')) { flush(); return { args, next: cursor + 1 }; }
    if (isPunctToken(token, '(') || isPunctToken(token, '{') || isPunctToken(token, '[')) depth += 1;
    else if (isPunctToken(token, ')') || isPunctToken(token, '}') || isPunctToken(token, ']')) depth -= 1;
    else if (depth === 0 && isPunctToken(token, ',')) { flush(); cursor += 1; segmentStart = cursor; continue; }
    cursor += 1;
  }

  flush();
  return { args, next: cursor };
}

function readTableArg(tokens: LuaToken[], start: number, text: string, offsets: number[]): ArgParse {
  let cursor = start;
  let depth = 0;
  while (cursor < tokens.length) {
    const token = tokens[cursor]!;
    if (isPunctToken(token, '{')) depth += 1;
    else if (isPunctToken(token, '}')) depth -= 1;
    cursor += 1;
    if (depth === 0) break;
  }
  const arg = classifyArgSegment(tokens.slice(start, cursor), text, offsets);
  return { args: arg ? [arg] : [], next: cursor };
}

function classifyArgSegment(segment: LuaToken[], text: string, offsets: number[]): LuaArg | null {
  if (segment.length === 0) return null;
  const first = segment[0]!;
  const last = segment[segment.length - 1]!;
  const span = spanFromOffsets(text, first.start, last.end, offsets);
  const sourceText = text.slice(first.start, last.end);

  if (segment.length === 1) {
    const literal = literalOf(first);
    if (first.type === 'string' || first.type === 'number'
      || (first.type === 'keyword' && (first.value === 'true' || first.value === 'false' || first.value === 'nil'))) {
      return { kind: 'literal', text: sourceText, span, ...(literal !== undefined ? { literal } : {}) };
    }
    if (first.type === 'name') return { kind: 'name', text: sourceText, span };
  }

  const dottedChain = segment.length > 1 && segment.every((token, index) =>
    index % 2 === 0 ? token.type === 'name' : isPunctToken(token, '.'));
  if (dottedChain) return { kind: 'member', text: sourceText, span };
  if (isPunctToken(first, '{')) return { kind: 'table', text: sourceText, span };
  return { kind: 'expression', text: sourceText, span };
}

function isPunctToken(token: LuaToken, value: string): boolean {
  return token.type === 'punct' && token.value === value;
}

/** Decode a quoted or long-bracket Lua string literal to its content. */
export function decodeLuaString(raw: string): string {
  const open = /^\[=*\[/.exec(raw);
  if (open) {
    const closer = `]${open[0].slice(1, -1)}]`;
    return raw.slice(open[0].length, raw.length - closer.length);
  }
  const body = raw.slice(1, -1);
  if (!body.includes('\\')) return body;
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (ch !== '\\') { out += ch; continue; }
    const next = body[i + 1];
    i += 1;
    switch (next) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '\\': out += '\\'; break;
      case '"': out += '"'; break;
      case "'": out += "'"; break;
      case undefined: break;
      default: out += next; break;
    }
  }
  return out;
}

export function parseLuaNumber(raw: string): number | null {
  if (/^0[xX][0-9a-fA-F]+$/u.test(raw)) {
    const parsed = Number.parseInt(raw, 16);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

