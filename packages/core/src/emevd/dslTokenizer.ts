import type {
  EmevdDslDiagnostic,
  EmevdDslSourcePosition,
  EmevdDslSourceSpan
} from '@soulforge/shared';

export const EMEVD_DSL_MAX_SOURCE_BYTES = 256 * 1024;
export const EMEVD_DSL_MAX_TOKENS = 20_000;
export const EMEVD_DSL_MAX_NESTING_DEPTH = 16;

export type EmevdDslTokenKind =
  | 'identifier'
  | 'number'
  | 'string'
  | 'anchor'
  | 'lbrace'
  | 'rbrace'
  | 'equals'
  | 'semicolon'
  | 'eof';

export interface EmevdDslToken {
  kind: EmevdDslTokenKind;
  value: string;
  span: EmevdDslSourceSpan;
}

export function createEmevdDslDiagnostic(
  code: string,
  message: string,
  span: EmevdDslSourceSpan,
  extra?: { resourceUri?: string; targetAnchor?: string }
): EmevdDslDiagnostic {
  return {
    severity: 'error',
    code,
    message,
    span,
    ...(extra?.resourceUri !== undefined ? { resourceUri: extra.resourceUri } : {}),
    ...(extra?.targetAnchor !== undefined ? { targetAnchor: extra.targetAnchor } : {})
  };
}

export function compareEmevdDslDiagnostics(a: EmevdDslDiagnostic, b: EmevdDslDiagnostic): number {
  return a.span.start.offset - b.span.start.offset
    || a.code.localeCompare(b.code)
    || a.message.localeCompare(b.message);
}

export function tokenizeEmevdDsl(source: string): {
  tokens: EmevdDslToken[];
  diagnostics: EmevdDslDiagnostic[];
} {
  const diagnostics: EmevdDslDiagnostic[] = [];
  const tokens: EmevdDslToken[] = [];
  let offset = 0;
  let line = 1;
  let column = 1;

  const position = (): EmevdDslSourcePosition => ({ offset, line, column });
  const advance = (): string => {
    const char = source[offset] ?? '';
    offset += 1;
    if (char === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    return char;
  };
  const push = (
    kind: EmevdDslTokenKind,
    value: string,
    start: EmevdDslSourcePosition
  ): void => {
    tokens.push({ kind, value, span: { start, end: position() } });
  };
  const zero: EmevdDslSourcePosition = { offset: 0, line: 1, column: 1 };

  if (Buffer.from(source, 'utf8').length > EMEVD_DSL_MAX_SOURCE_BYTES) {
    diagnostics.push(createEmevdDslDiagnostic(
      'EMEVD_DSL_SOURCE_TOO_LARGE',
      `DSL source exceeds ${EMEVD_DSL_MAX_SOURCE_BYTES} bytes.`,
      { start: zero, end: zero }
    ));
    return { tokens, diagnostics };
  }

  while (offset < source.length) {
    if (tokens.length >= EMEVD_DSL_MAX_TOKENS) {
      const at = position();
      diagnostics.push(createEmevdDslDiagnostic(
        'EMEVD_DSL_TOKEN_LIMIT_EXCEEDED',
        `DSL token count exceeds ${EMEVD_DSL_MAX_TOKENS}.`,
        { start: at, end: at }
      ));
      break;
    }
    const char = source[offset]!;
    if (/\s/.test(char)) {
      advance();
      continue;
    }
    if (char === '/' && source[offset + 1] === '/') {
      while (offset < source.length && source[offset] !== '\n') advance();
      continue;
    }

    const start = position();
    if (char === '{' || char === '}' || char === '=' || char === ';') {
      advance();
      push(
        char === '{' ? 'lbrace'
          : char === '}' ? 'rbrace'
            : char === '=' ? 'equals'
              : 'semicolon',
        char,
        start
      );
      continue;
    }

    if (char === '"') {
      let raw = advance();
      let escaped = false;
      while (offset < source.length) {
        const next = advance();
        raw += next;
        if (escaped) escaped = false;
        else if (next === '\\') escaped = true;
        else if (next === '"') break;
      }
      if (!raw.endsWith('"') || raw.length === 1) {
        diagnostics.push(createEmevdDslDiagnostic(
          'EMEVD_DSL_SYNTAX_ERROR',
          'Unterminated string literal.',
          { start, end: position() }
        ));
        continue;
      }
      try {
        push('string', JSON.parse(raw) as string, start);
      } catch {
        diagnostics.push(createEmevdDslDiagnostic(
          'EMEVD_DSL_SYNTAX_ERROR',
          'Invalid string escape.',
          { start, end: position() }
        ));
      }
      continue;
    }

    if (char === '@') {
      let value = advance();
      while (offset < source.length && /[A-Za-z0-9_:-]/.test(source[offset]!)) {
        value += advance();
      }
      if (/^@[ei]:[A-Za-z0-9_-]+$/.test(value)) push('anchor', value, start);
      else diagnostics.push(createEmevdDslDiagnostic(
        'EMEVD_DSL_SYNTAX_ERROR',
        `Invalid anchor ${value}.`,
        { start, end: position() }
      ));
      continue;
    }

    if (char === '-' || /[0-9]/.test(char)) {
      let value = '';
      if (char === '-') value += advance();
      while (offset < source.length && /[0-9]/.test(source[offset]!)) value += advance();
      if (source[offset] === '.') {
        value += advance();
        while (offset < source.length && /[0-9]/.test(source[offset]!)) value += advance();
      }
      if (source[offset] === 'e' || source[offset] === 'E') {
        value += advance();
        if (source[offset] === '+' || source[offset] === '-') value += advance();
        while (offset < source.length && /[0-9]/.test(source[offset]!)) value += advance();
      }
      if (/^-?(?:\d+\.?\d*|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
        push('number', value, start);
      } else {
        diagnostics.push(createEmevdDslDiagnostic(
          'EMEVD_DSL_SYNTAX_ERROR',
          `Invalid number ${value}.`,
          { start, end: position() }
        ));
      }
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      let value = advance();
      while (offset < source.length && /[A-Za-z0-9_-]/.test(source[offset]!)) {
        value += advance();
      }
      push('identifier', value, start);
      continue;
    }

    advance();
    diagnostics.push(createEmevdDslDiagnostic(
      'EMEVD_DSL_SYNTAX_ERROR',
      `Unexpected character ${JSON.stringify(char)}.`,
      { start, end: position() }
    ));
  }

  const eof = position();
  tokens.push({ kind: 'eof', value: '', span: { start: eof, end: eof } });
  return { tokens, diagnostics };
}
