import type {
  EmevdDslDiagnostic,
  EmevdDslDocumentAst,
  EmevdDslEventAst,
  EmevdDslInstructionAst,
  EmevdDslLiteral,
  EmevdDslMutationProposal,
  EmevdDslSourceLocation,
  EmevdEditorDocument,
  EmevdEditorMutation
} from '@soulforge/shared';
import {
  decodeEmedfArgs,
  encodeEmedfArgs,
  validateEmedfRegistry,
  type EmedfInstructionDef,
  type EmedfRegistry
} from './emedfSchema.js';

type TokenKind = 'directive' | 'identifier' | 'number' | 'string' | 'punctuation' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  column: number;
}

export type EmevdDslParseResult =
  | { ok: true; ast: EmevdDslDocumentAst; diagnostics: [] }
  | { ok: false; diagnostics: EmevdDslDiagnostic[] };

export type EmevdDslCompileResult =
  | { ok: true; ast: EmevdDslDocumentAst; proposal: EmevdDslMutationProposal }
  | { ok: false; diagnostics: EmevdDslDiagnostic[] };

export function parseEmevdDsl(text: string): EmevdDslParseResult {
  try {
    const tokens = lex(text);
    return { ok: true, ast: new Parser(tokens).parseDocument(), diagnostics: [] };
  } catch (error) {
    if (error instanceof DslError) {
      return {
        ok: false,
        diagnostics: [diagnostic(error.code, error.message, error.location)]
      };
    }
    return {
      ok: false,
      diagnostics: [diagnostic('EMEVD_DSL_PARSE_FAILED', 'DSL 解析失败。')]
    };
  }
}

export function renderTypedEmevdDsl(
  document: EmevdEditorDocument,
  registry?: EmedfRegistry
): string {
  const registryValidation = registry ? validateEmedfRegistry(registry) : undefined;
  const definitions = registry && registryValidation?.ok
    ? new Map(registry.instructions.map((def) => [`${def.bank}:${def.id}`, def]))
    : undefined;
  const lines = [`$Resource(Uri=${quote(document.resourceUri)});`];
  for (const event of document.events) {
    lines.push(
      `$Event(Id=${event.eventId}, Uri=${quote(event.eventUri)}, Rest=${event.restBehavior}, Layer=${event.layer}) {`
    );
    for (const instruction of event.instructions) {
      const def = definitions?.get(`${instruction.bank}:${instruction.id}`);
      const decoded = def && !instruction.unknown
        ? decodeCanonicalArgs(def, instruction.argsBase64)
        : undefined;
      if (decoded) {
        const args = decoded.map((arg) => `${arg.name}=${formatLiteral(arg.value)}`).join(', ');
        lines.push(
          `  typed(Uri=${quote(instruction.instructionUri)}, Bank=${instruction.bank}, Id=${instruction.id}, Args=(${args}));`
        );
      } else {
        lines.push(
          `  unknown(Uri=${quote(instruction.instructionUri)}, Bank=${instruction.bank}, Id=${instruction.id}, ArgsBase64=${quote(instruction.argsBase64)});`
        );
      }
    }
    lines.push('}');
  }
  return lines.join('\n');
}

export function compileEmevdDslMutationProposal(input: {
  text: string;
  document: EmevdEditorDocument;
  registry: EmedfRegistry;
}): EmevdDslCompileResult {
  const parsed = parseEmevdDsl(input.text);
  if (!parsed.ok) return parsed;

  const { ast } = parsed;
  const diagnostics: EmevdDslDiagnostic[] = [];
  const mutations: EmevdEditorMutation[] = [];
  const currentEvents = new Map(input.document.events.map((event) => [event.eventUri, event]));

  const registryValidation = validateEmedfRegistry(input.registry);
  if (!registryValidation.ok) {
    return {
      ok: false,
      diagnostics: [diagnostic(registryValidation.code, registryValidation.message)]
    };
  }
  const definitions = new Map(
    input.registry.instructions.map((def) => [`${def.bank}:${def.id}`, def])
  );

  if (ast.resourceUri !== input.document.resourceUri) {
    diagnostics.push(diagnostic(
      'EMEVD_DSL_RESOURCE_MISMATCH',
      'DSL resource URI 与当前文档不一致。'
    ));
  }

  const seenEventUris = new Set<string>();
  const seenEventIds = new Set<number>();
  let idMutationCount = 0;
  for (const eventAst of ast.events) {
    if (seenEventUris.has(eventAst.eventUri)) {
      diagnostics.push(diagnostic(
        'EMEVD_DSL_EVENT_URI_DUPLICATE',
        `事件 URI 重复：${eventAst.eventUri}`,
        eventAst.location
      ));
      continue;
    }
    seenEventUris.add(eventAst.eventUri);
    if (seenEventIds.has(eventAst.eventId)) {
      diagnostics.push(diagnostic(
        'EMEVD_DSL_EVENT_ID_DUPLICATE',
        `事件 ID 重复：${eventAst.eventId}`,
        eventAst.location
      ));
    }
    seenEventIds.add(eventAst.eventId);

    const current = currentEvents.get(eventAst.eventUri);
    if (!current) {
      diagnostics.push(diagnostic(
        'EMEVD_DSL_EVENT_STRUCTURE_CHANGED',
        'DSL 不允许新增事件或更改稳定事件 URI。',
        eventAst.location
      ));
      continue;
    }
    if (eventAst.layer !== current.layer) {
      diagnostics.push(diagnostic(
        'EMEVD_DSL_LAYER_MUTATION_UNSUPPORTED',
        '当前 DSL proposal 不支持修改 event layer。',
        eventAst.location
      ));
    }
    const restBehaviorValid = Number.isInteger(eventAst.restBehavior)
      && eventAst.restBehavior >= 0
      && eventAst.restBehavior <= 0xffff_ffff;
    if (!restBehaviorValid) {
      diagnostics.push(diagnostic(
        'EMEVD_DSL_REST_BEHAVIOR_OUT_OF_RANGE',
        'Rest 必须是 uint32 范围内的整数。',
        eventAst.location
      ));
    }

    compileInstructions({
      eventAst,
      current,
      document: input.document,
      definitions,
      diagnostics,
      mutations
    });

    if (restBehaviorValid && eventAst.restBehavior !== current.restBehavior) {
      mutations.push({
        kind: 'emevd_set_rest_behavior',
        eventUri: current.eventUri,
        restBehavior: eventAst.restBehavior,
        baseRevision: input.document.revision + mutations.length
      });
    }

    if (eventAst.eventId !== current.eventId) {
      idMutationCount += 1;
      const occupied = input.document.events.some(
        (event) => event.eventUri !== current.eventUri && event.eventId === eventAst.eventId
      );
      if (occupied) {
        diagnostics.push(diagnostic(
          'EMEVD_DSL_EVENT_ID_OCCUPIED',
          `事件 ID ${eventAst.eventId} 已被当前文档占用。`,
          eventAst.location
        ));
      } else {
        mutations.push({
          kind: 'emevd_update_id',
          eventUri: current.eventUri,
          newEventId: eventAst.eventId,
          baseRevision: input.document.revision + mutations.length
        });
      }
    }
  }

  for (const current of input.document.events) {
    if (!seenEventUris.has(current.eventUri)) {
      diagnostics.push(diagnostic(
        'EMEVD_DSL_EVENT_STRUCTURE_CHANGED',
        `DSL 缺少事件 ${current.eventId}；当前 proposal 不支持删除事件。`
      ));
    }
  }
  if (idMutationCount > 1) {
    diagnostics.push(diagnostic(
      'EMEVD_DSL_MULTI_ID_MUTATION_UNSUPPORTED',
      '一次 DSL proposal 最多修改一个事件 ID，避免顺序相关的 ID 冲突。'
    ));
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return {
    ok: true,
    ast,
    proposal: {
      schemaVersion: 1,
      authority: 'fixture-confirmed',
      resourceUri: input.document.resourceUri,
      baseRevision: input.document.revision,
      mutations,
      diagnostics: []
    }
  };
}

function compileInstructions(input: {
  eventAst: EmevdDslEventAst;
  current: EmevdEditorDocument['events'][number];
  document: EmevdEditorDocument;
  definitions: ReadonlyMap<string, EmedfInstructionDef>;
  diagnostics: EmevdDslDiagnostic[];
  mutations: EmevdEditorMutation[];
}): void {
  const currentInstructions = new Map(
    input.current.instructions.map((instruction) => [instruction.instructionUri, instruction])
  );
  const seen = new Set<string>();
  for (const instructionAst of input.eventAst.instructions) {
    if (seen.has(instructionAst.instructionUri)) {
      input.diagnostics.push(diagnostic(
        'EMEVD_DSL_INSTRUCTION_URI_DUPLICATE',
        `指令 URI 重复：${instructionAst.instructionUri}`,
        instructionAst.location
      ));
      continue;
    }
    seen.add(instructionAst.instructionUri);
    const current = currentInstructions.get(instructionAst.instructionUri);
    if (!current) {
      input.diagnostics.push(diagnostic(
        'EMEVD_DSL_INSTRUCTION_STRUCTURE_CHANGED',
        'DSL 不允许新增指令或更改稳定指令 URI。',
        instructionAst.location
      ));
      continue;
    }
    if (instructionAst.bank !== current.bank || instructionAst.id !== current.id) {
      input.diagnostics.push(diagnostic(
        'EMEVD_DSL_INSTRUCTION_IDENTITY_CHANGED',
        '当前 DSL proposal 不支持修改 instruction bank/id。',
        instructionAst.location
      ));
      continue;
    }

    const currentBytes = decodeStrictBase64(current.argsBase64);
    if (!currentBytes) {
      input.diagnostics.push(diagnostic(
        'EMEVD_DSL_DOCUMENT_ARGS_INVALID',
        '当前文档包含非规范 argsBase64，拒绝生成 mutation。',
        instructionAst.location
      ));
      continue;
    }
    if (instructionAst.kind === 'unknown') {
      const proposedBytes = decodeStrictBase64(instructionAst.argsBase64);
      if (!proposedBytes) {
        input.diagnostics.push(diagnostic(
          'EMEVD_DSL_BASE64_INVALID',
          'unknown instruction 的 ArgsBase64 不是规范 Base64。',
          instructionAst.location
        ));
      } else if (!proposedBytes.equals(currentBytes)) {
        input.diagnostics.push(diagnostic(
          'EMEVD_DSL_UNKNOWN_INSTRUCTION_EDIT_FORBIDDEN',
          '未知 instruction 必须逐字节保留；没有 EMEDF schema 时禁止修改。',
          instructionAst.location
        ));
      }
      continue;
    }
    if (current.unknown) {
      input.diagnostics.push(diagnostic(
        'EMEVD_DSL_OPAQUE_INSTRUCTION',
        '当前 instruction 没有完整样本，不能通过 DSL 提升为 typed。',
        instructionAst.location
      ));
      continue;
    }
    const def = input.definitions.get(`${current.bank}:${current.id}`);
    if (!def) {
      input.diagnostics.push(diagnostic(
        'EMEDF_UNKNOWN_INSTRUCTION',
        `无 schema：bank=${current.bank} id=${current.id}`,
        instructionAst.location
      ));
      continue;
    }
    const encoded = encodeEmedfArgs(def, instructionAst.args);
    if (!encoded.ok) {
      input.diagnostics.push(diagnostic(encoded.code, encoded.message, instructionAst.location));
      continue;
    }
    if (encoded.args.length !== currentBytes.length) {
      input.diagnostics.push(diagnostic(
        'EMEDF_LENGTH_CHANGED',
        `编码后长度 ${encoded.args.length} != 原 ${currentBytes.length}；拒绝 proposal。`,
        instructionAst.location
      ));
      continue;
    }
    if (!encoded.args.equals(currentBytes)) {
      input.mutations.push({
        kind: 'emevd_set_instruction_args',
        eventUri: input.current.eventUri,
        instructionUri: current.instructionUri,
        argsBase64: encoded.args.toString('base64'),
        baseRevision: input.document.revision + input.mutations.length
      });
    }
  }

  for (const current of input.current.instructions) {
    if (!seen.has(current.instructionUri)) {
      input.diagnostics.push(diagnostic(
        'EMEVD_DSL_INSTRUCTION_STRUCTURE_CHANGED',
        `DSL 缺少指令 ${current.instructionUri}；当前 proposal 不支持删除指令。`
      ));
    }
  }
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parseDocument(): EmevdDslDocumentAst {
    this.expectDirective('Resource');
    this.expectPunctuation('(');
    this.expectIdentifier('Uri');
    this.expectPunctuation('=');
    const resourceUri = this.expect('string').value;
    this.expectPunctuation(')');
    this.expectPunctuation(';');

    const events: EmevdDslEventAst[] = [];
    while (!this.check('eof')) events.push(this.parseEvent());
    return { schemaVersion: 1, resourceUri, events };
  }

  private parseEvent(): EmevdDslEventAst {
    const start = this.expectDirective('Event');
    this.expectPunctuation('(');
    this.expectIdentifier('Id');
    this.expectPunctuation('=');
    const eventId = this.expectInteger('event Id');
    this.expectPunctuation(',');
    this.expectIdentifier('Uri');
    this.expectPunctuation('=');
    const eventUri = this.expect('string').value;
    this.expectPunctuation(',');
    this.expectIdentifier('Rest');
    this.expectPunctuation('=');
    const restBehavior = this.expectInteger('Rest');
    this.expectPunctuation(',');
    this.expectIdentifier('Layer');
    this.expectPunctuation('=');
    const layer = this.expectInteger('Layer');
    this.expectPunctuation(')');
    this.expectPunctuation('{');
    const instructions: EmevdDslInstructionAst[] = [];
    while (!this.matchPunctuation('}')) instructions.push(this.parseInstruction());
    return {
      eventUri,
      eventId,
      restBehavior,
      layer,
      instructions,
      location: locationOf(start)
    };
  }

  private parseInstruction(): EmevdDslInstructionAst {
    const kind = this.expect('identifier');
    if (kind.value !== 'typed' && kind.value !== 'unknown') {
      throw new DslError(
        'EMEVD_DSL_INSTRUCTION_KIND_INVALID',
        `指令必须是 typed 或 unknown，收到 ${kind.value}。`,
        locationOf(kind)
      );
    }
    this.expectPunctuation('(');
    this.expectIdentifier('Uri');
    this.expectPunctuation('=');
    const instructionUri = this.expect('string').value;
    this.expectPunctuation(',');
    this.expectIdentifier('Bank');
    this.expectPunctuation('=');
    const bank = this.expectUnsignedInteger('Bank');
    this.expectPunctuation(',');
    this.expectIdentifier('Id');
    this.expectPunctuation('=');
    const id = this.expectUnsignedInteger('instruction Id');
    this.expectPunctuation(',');

    let instruction: EmevdDslInstructionAst;
    if (kind.value === 'typed') {
      this.expectIdentifier('Args');
      this.expectPunctuation('=');
      this.expectPunctuation('(');
      const args: Record<string, EmevdDslLiteral> = {};
      if (!this.matchPunctuation(')')) {
        do {
          const name = this.expect('identifier');
          if (name.value in args) {
            throw new DslError(
              'EMEVD_DSL_ARG_DUPLICATE',
              `参数重复：${name.value}`,
              locationOf(name)
            );
          }
          this.expectPunctuation('=');
          args[name.value] = this.parseLiteral();
        } while (this.matchPunctuation(','));
        this.expectPunctuation(')');
      }
      instruction = {
        kind: 'typed',
        instructionUri,
        bank,
        id,
        args,
        location: locationOf(kind)
      };
    } else {
      this.expectIdentifier('ArgsBase64');
      this.expectPunctuation('=');
      instruction = {
        kind: 'unknown',
        instructionUri,
        bank,
        id,
        argsBase64: this.expect('string').value,
        location: locationOf(kind)
      };
    }
    this.expectPunctuation(')');
    this.expectPunctuation(';');
    return instruction;
  }

  private parseLiteral(): EmevdDslLiteral {
    if (this.check('number')) {
      const token = this.advance();
      const value = Number(token.value);
      if (!Number.isFinite(value)) {
        throw new DslError('EMEVD_DSL_NUMBER_INVALID', '参数数值必须有限。', locationOf(token));
      }
      return value;
    }
    const token = this.expect('identifier');
    if (token.value === 'true') return true;
    if (token.value === 'false') return false;
    throw new DslError(
      'EMEVD_DSL_LITERAL_INVALID',
      `参数值必须是 number/true/false，收到 ${token.value}。`,
      locationOf(token)
    );
  }

  private expectInteger(label: string): number {
    const token = this.expect('number');
    const value = Number(token.value);
    if (!Number.isSafeInteger(value)) {
      throw new DslError(
        'EMEVD_DSL_INTEGER_INVALID',
        `${label} 必须是安全整数。`,
        locationOf(token)
      );
    }
    return value;
  }

  private expectUnsignedInteger(label: string): number {
    const token = this.peek();
    const value = this.expectInteger(label);
    if (value < 0) {
      throw new DslError(
        'EMEVD_DSL_UNSIGNED_INTEGER_REQUIRED',
        `${label} 不能为负数。`,
        locationOf(token)
      );
    }
    return value;
  }

  private expectDirective(value: string): Token {
    const token = this.expect('directive');
    if (token.value !== value) {
      throw new DslError(
        'EMEVD_DSL_DIRECTIVE_UNEXPECTED',
        `期望 $${value}，收到 $${token.value}。`,
        locationOf(token)
      );
    }
    return token;
  }

  private expectIdentifier(value: string): Token {
    const token = this.expect('identifier');
    if (token.value !== value) {
      throw new DslError(
        'EMEVD_DSL_IDENTIFIER_UNEXPECTED',
        `期望 ${value}，收到 ${token.value}。`,
        locationOf(token)
      );
    }
    return token;
  }

  private expectPunctuation(value: string): Token {
    const token = this.expect('punctuation');
    if (token.value !== value) {
      throw new DslError(
        'EMEVD_DSL_PUNCTUATION_UNEXPECTED',
        `期望 ${value}，收到 ${token.value}。`,
        locationOf(token)
      );
    }
    return token;
  }

  private matchPunctuation(value: string): boolean {
    if (this.peek().kind !== 'punctuation' || this.peek().value !== value) return false;
    this.advance();
    return true;
  }

  private expect(kind: TokenKind): Token {
    const token = this.peek();
    if (token.kind !== kind) {
      throw new DslError(
        'EMEVD_DSL_TOKEN_UNEXPECTED',
        `期望 ${kind}，收到 ${token.kind}(${token.value})。`,
        locationOf(token)
      );
    }
    return this.advance();
  }

  private check(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private advance(): Token {
    const token = this.tokens[this.index]!;
    this.index += 1;
    return token;
  }
}

function lex(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let column = 1;
  const advance = (): string => {
    const char = text[index++]!;
    if (char === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    return char;
  };

  while (index < text.length) {
    const char = text[index]!;
    if (/\s/.test(char)) {
      advance();
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') advance();
      continue;
    }
    const startLine = line;
    const startColumn = column;
    if (char === '$') {
      advance();
      const name = readIdentifier(() => text[index], advance);
      if (!name) {
        throw new DslError(
          'EMEVD_DSL_LEX_ERROR',
          '$ 后必须是 directive 名称。',
          { line: startLine, column: startColumn }
        );
      }
      tokens.push({ kind: 'directive', value: name, line: startLine, column: startColumn });
      continue;
    }
    if (char === '"') {
      let raw = advance();
      let closed = false;
      while (index < text.length) {
        const next = advance();
        raw += next;
        if (next === '\n') {
          throw new DslError(
            'EMEVD_DSL_STRING_INVALID',
            '字符串不能跨行。',
            { line: startLine, column: startColumn }
          );
        }
        if (next === '\\') {
          if (index >= text.length) break;
          raw += advance();
          continue;
        }
        if (next === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) {
        throw new DslError(
          'EMEVD_DSL_STRING_INVALID',
          '字符串未闭合。',
          { line: startLine, column: startColumn }
        );
      }
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new DslError(
          'EMEVD_DSL_STRING_INVALID',
          '字符串转义无效。',
          { line: startLine, column: startColumn }
        );
      }
      if (typeof value !== 'string') {
        throw new DslError(
          'EMEVD_DSL_STRING_INVALID',
          '字符串字面量无效。',
          { line: startLine, column: startColumn }
        );
      }
      tokens.push({ kind: 'string', value, line: startLine, column: startColumn });
      continue;
    }
    const numberMatch = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
    if (numberMatch) {
      for (let i = 0; i < numberMatch[0].length; i += 1) advance();
      tokens.push({
        kind: 'number',
        value: numberMatch[0],
        line: startLine,
        column: startColumn
      });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const value = readIdentifier(() => text[index], advance);
      tokens.push({ kind: 'identifier', value, line: startLine, column: startColumn });
      continue;
    }
    if ('(){},=;'.includes(char)) {
      tokens.push({
        kind: 'punctuation',
        value: advance(),
        line: startLine,
        column: startColumn
      });
      continue;
    }
    throw new DslError(
      'EMEVD_DSL_LEX_ERROR',
      `无法识别字符 ${char}。`,
      { line: startLine, column: startColumn }
    );
  }
  tokens.push({ kind: 'eof', value: '', line, column });
  return tokens;
}

function readIdentifier(
  peek: () => string | undefined,
  advance: () => string
): string {
  let value = '';
  while (peek() !== undefined && /[A-Za-z0-9_]/.test(peek()!)) value += advance();
  return value;
}

function decodeCanonicalArgs(
  def: EmedfInstructionDef,
  argsBase64: string
): Array<{ name: string; value: number | boolean }> | undefined {
  const bytes = decodeStrictBase64(argsBase64);
  if (!bytes) return undefined;
  const decoded = decodeEmedfArgs(def, bytes);
  if (!decoded.ok || decoded.args.some((arg) => (
    typeof arg.value === 'number' && !Number.isFinite(arg.value)
  ))) return undefined;
  const values: Record<string, number | boolean> = {};
  for (const arg of decoded.args) values[arg.name] = arg.value;
  const encoded = encodeEmedfArgs(def, values);
  if (!encoded.ok || !encoded.args.equals(bytes)) return undefined;
  return decoded.args.map((arg) => ({ name: arg.name, value: arg.value }));
}

function decodeStrictBase64(value: string): Buffer | undefined {
  if (value === '') return Buffer.alloc(0);
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : undefined;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function formatLiteral(value: number | boolean): string {
  return typeof value === 'boolean' ? String(value) : String(value);
}

function locationOf(token: Token): EmevdDslSourceLocation {
  return { line: token.line, column: token.column };
}

function diagnostic(
  code: string,
  message: string,
  location?: EmevdDslSourceLocation
): EmevdDslDiagnostic {
  return {
    severity: 'error',
    code,
    message,
    ...(location ? { location } : {})
  };
}

class DslError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly location: EmevdDslSourceLocation
  ) {
    super(message);
  }
}
