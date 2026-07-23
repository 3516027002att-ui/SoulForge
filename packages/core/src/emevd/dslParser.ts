import type {
  EmevdDslDiagnostic,
  EmevdDslDocument,
  EmevdDslEventPatch,
  EmevdDslInstructionPatch,
  EmevdDslLiteral,
  EmevdDslSourceSpan
} from '@soulforge/shared';
import {
  compareEmevdDslDiagnostics,
  createEmevdDslDiagnostic,
  EMEVD_DSL_MAX_NESTING_DEPTH,
  tokenizeEmevdDsl,
  type EmevdDslToken,
  type EmevdDslTokenKind
} from './dslTokenizer.js';

class Parser {
  private index = 0;
  private depth = 0;
  readonly diagnostics: EmevdDslDiagnostic[] = [];

  constructor(private readonly tokens: EmevdDslToken[]) {}

  parse(): EmevdDslDocument | undefined {
    const start = this.current().span.start;
    if (!this.keyword('resource')) return undefined;
    const resource = this.expect('string', 'Expected resource URI string.');
    if (!this.keyword('base')) return undefined;
    if (!this.keyword('revision')) return undefined;
    const revision = this.expect('number', 'Expected base revision number.');
    if (!this.keyword('schema')) return undefined;
    const schema = this.expect('string', 'Expected schema fingerprint string.');
    const events: EmevdDslEventPatch[] = [];

    while (!this.at('eof')) {
      if (!this.isKeyword('event')) {
        this.error('Expected event block.', this.current().span);
        this.advance();
        continue;
      }
      const event = this.parseEvent();
      if (event) events.push(event);
    }
    if (!resource || !revision || !schema) return undefined;

    const baseRevision = Number(revision.value);
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
      this.error('Base revision must be a non-negative safe integer.', revision.span);
    }
    return {
      schemaVersion: 1,
      resourceUri: resource.value,
      baseRevision,
      emedfSchemaFingerprint: schema.value,
      events,
      span: { start, end: this.current().span.end }
    };
  }

  private parseEvent(): EmevdDslEventPatch | undefined {
    const start = this.current().span.start;
    this.keyword('event');
    const anchor = this.expect('anchor', 'Expected event anchor.');
    if (anchor && !anchor.value.startsWith('@e:')) {
      this.error('Event block requires @e: anchor.', anchor.span);
    }
    if (!this.openBrace()) return undefined;

    const operations: EmevdDslEventPatch['operations'] = [];
    const instructions: EmevdDslInstructionPatch[] = [];
    while (!this.at('rbrace') && !this.at('eof')) {
      if (this.isKeyword('set')) {
        const operation = this.parseEventSet();
        if (operation) operations.push(operation);
      } else if (this.isKeyword('instruction')) {
        const instruction = this.parseInstruction();
        if (instruction) instructions.push(instruction);
      } else {
        this.error('Expected set or instruction statement.', this.current().span);
        this.advance();
      }
    }
    const end = this.closeBrace();
    if (!anchor || !end) return undefined;
    return { anchor: anchor.value, operations, instructions, span: { start, end: end.end } };
  }

  private parseEventSet(): EmevdDslEventPatch['operations'][number] | undefined {
    const start = this.current().span.start;
    this.keyword('set');
    const field = this.expect('identifier', 'Expected event field.');
    this.expect('equals', 'Expected =.');
    const value = this.expect('number', 'Expected numeric event value.');
    this.optionalSemicolon();
    if (!field || !value) return undefined;
    if (field.value !== 'id' && field.value !== 'rest') {
      this.error(`Unsupported event field ${field.value}.`, field.span);
      return undefined;
    }
    return {
      kind: 'set_event_field',
      field: field.value,
      value: Number(value.value),
      span: { start, end: value.span.end }
    };
  }

  private parseInstruction(): EmevdDslInstructionPatch | undefined {
    const start = this.current().span.start;
    this.keyword('instruction');
    const anchor = this.expect('anchor', 'Expected instruction anchor.');
    if (anchor && !anchor.value.startsWith('@i:')) {
      this.error('Instruction block requires @i: anchor.', anchor.span);
    }
    if (!this.openBrace()) return undefined;

    const operations: EmevdDslInstructionPatch['operations'] = [];
    while (!this.at('rbrace') && !this.at('eof')) {
      const operation = this.parseInstructionSet();
      if (operation) operations.push(operation);
      else if (!this.at('rbrace') && !this.at('eof')) this.advance();
    }
    const end = this.closeBrace();
    if (!anchor || !end) return undefined;
    return { anchor: anchor.value, operations, span: { start, end: end.end } };
  }

  private parseInstructionSet(): EmevdDslInstructionPatch['operations'][number] | undefined {
    const start = this.current().span.start;
    if (!this.keyword('set')) return undefined;
    if (!this.keyword('arg')) return undefined;
    const argument = this.expect('identifier', 'Expected argument name.');
    this.expect('equals', 'Expected =.');
    const literal = this.parseLiteral();
    this.optionalSemicolon();
    if (!argument || !literal) return undefined;
    return {
      kind: 'set_instruction_arg',
      argument: argument.value,
      value: literal.value,
      span: { start, end: literal.span.end }
    };
  }

  private parseLiteral(): { value: EmevdDslLiteral; span: EmevdDslSourceSpan } | undefined {
    const token = this.current();
    if (token.kind === 'number') {
      this.advance();
      return { value: Number(token.value), span: token.span };
    }
    if (token.kind === 'identifier' && (token.value === 'true' || token.value === 'false')) {
      this.advance();
      return { value: token.value === 'true', span: token.span };
    }
    this.error('Expected number or boolean literal.', token.span);
    return undefined;
  }

  private openBrace(): boolean {
    const token = this.expect('lbrace', 'Expected {.');
    if (!token) return false;
    this.depth += 1;
    if (this.depth > EMEVD_DSL_MAX_NESTING_DEPTH) {
      this.diagnostics.push(createEmevdDslDiagnostic(
        'EMEVD_DSL_NESTING_LIMIT_EXCEEDED',
        `Nesting exceeds ${EMEVD_DSL_MAX_NESTING_DEPTH}.`,
        token.span
      ));
    }
    return true;
  }

  private closeBrace(): EmevdDslSourceSpan | undefined {
    const token = this.expect('rbrace', 'Expected }.');
    if (!token) return undefined;
    this.depth = Math.max(0, this.depth - 1);
    return token.span;
  }

  private keyword(value: string): boolean {
    const token = this.current();
    if (token.kind === 'identifier' && token.value === value) {
      this.advance();
      return true;
    }
    this.error(`Expected keyword ${value}.`, token.span);
    return false;
  }

  private isKeyword(value: string): boolean {
    const token = this.current();
    return token.kind === 'identifier' && token.value === value;
  }

  private expect(kind: EmevdDslTokenKind, message: string): EmevdDslToken | undefined {
    const token = this.current();
    if (token.kind === kind) {
      this.advance();
      return token;
    }
    this.error(message, token.span);
    return undefined;
  }

  private optionalSemicolon(): void {
    if (this.at('semicolon')) this.advance();
  }

  private current(): EmevdDslToken {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1]!;
  }

  private at(kind: EmevdDslTokenKind): boolean {
    return this.current().kind === kind;
  }

  private advance(): void {
    if (this.index < this.tokens.length - 1) this.index += 1;
  }

  private error(message: string, span: EmevdDslSourceSpan): void {
    this.diagnostics.push(createEmevdDslDiagnostic('EMEVD_DSL_SYNTAX_ERROR', message, span));
  }
}

export function parseEmevdPatchDsl(source: string): {
  ast?: EmevdDslDocument;
  diagnostics: EmevdDslDiagnostic[];
} {
  const tokenized = tokenizeEmevdDsl(source);
  if (tokenized.tokens.length === 0) return { diagnostics: tokenized.diagnostics };
  const parser = new Parser(tokenized.tokens);
  const ast = parser.parse();
  const duplicateWriteDiagnostics = ast ? validateDuplicateWrites(ast) : [];
  const diagnostics = [
    ...tokenized.diagnostics,
    ...parser.diagnostics,
    ...duplicateWriteDiagnostics
  ].sort(compareEmevdDslDiagnostics);
  return {
    ...(ast !== undefined ? { ast } : {}),
    diagnostics
  };
}

function validateDuplicateWrites(ast: EmevdDslDocument): EmevdDslDiagnostic[] {
  const diagnostics: EmevdDslDiagnostic[] = [];
  const firstWriteByTarget = new Map<string, EmevdDslSourceSpan>();

  const register = (
    key: string,
    code: 'EMEVD_DSL_DUPLICATE_WRITE' | 'EMEVD_DSL_DUPLICATE_ARGUMENT',
    label: string,
    span: EmevdDslSourceSpan,
    targetAnchor: string
  ): void => {
    const first = firstWriteByTarget.get(key);
    if (first) {
      diagnostics.push(createEmevdDslDiagnostic(
        code,
        `Duplicate write to ${label}; first write is at line ${first.start.line}, column ${first.start.column}.`,
        span,
        { resourceUri: ast.resourceUri, targetAnchor }
      ));
      return;
    }
    firstWriteByTarget.set(key, span);
  };

  for (const event of ast.events) {
    for (const operation of event.operations) {
      register(
        `event:${event.anchor}:${operation.field}`,
        'EMEVD_DSL_DUPLICATE_WRITE',
        `${event.anchor}.${operation.field}`,
        operation.span,
        event.anchor
      );
    }
    for (const instruction of event.instructions) {
      for (const operation of instruction.operations) {
        register(
          `instruction:${instruction.anchor}:arg:${operation.argument}`,
          'EMEVD_DSL_DUPLICATE_ARGUMENT',
          `${instruction.anchor}.arg.${operation.argument}`,
          operation.span,
          instruction.anchor
        );
      }
    }
  }
  return diagnostics;
}
