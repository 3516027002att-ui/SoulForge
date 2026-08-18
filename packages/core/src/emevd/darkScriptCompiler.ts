/**
 * DarkScript3 式源码 → 现有 typed mutation plan。
 *
 * 对齐规则：$Event 块按「反汇编形状」逐事件对齐；事件体内做 LCS 行对齐 —
 * 已对齐的行只写参数/id/rest 差异；多出来的行编码成 insert_instruction（EMEDF
 * 可编码的固定参数指令），删掉行生成 delete_instruction；新增/删除 $Event 块
 * 生成 insert_event / delete_event。写不了的行（新增 WaitFor 折叠块、vararg
 * 指令、EMEDF 里查不到的名字、改了未解码注释）标 warning「未解码」，并且该事件
 * 的结构性改动整体抑制（只保留已对齐行的参数写入），不锁整份文件、不假成功。
 */

import { createHash } from 'node:crypto';
import type {
  EmevdDslCompileRequest,
  EmevdDslCompileResult,
  EmevdDslDiagnostic,
  EmevdDslDocument,
  EmevdDslLiteral,
  EmevdDslSourcePosition,
  EmevdDslSourceSpan,
  EmevdEditorDocument,
  EmevdMutationPlan,
  EmevdNodeAnchor,
  EmevdPlannedMutation
} from '@soulforge/shared';
import {
  analyzeDarkScriptEvent,
  darkScriptInstructionName,
  type DarkScriptEventItem
} from './darkScriptRenderer.js';
import { fingerprintEmedfRegistry } from './dslCompiler.js';
import {
  encodeEmedfArgs,
  hasVararg,
  type DecodedArg,
  type EmedfInstructionDef,
  type EmedfRegistry
} from './emedfSchema.js';
import {
  computeEmevdEventFingerprint,
  computeEmevdInstructionFingerprint,
  formatEmevdAnchor
} from './stableIdentity.js';

export function looksLikeDarkScript(source: string): boolean {
  return /\$Event\s*\(/.test(source);
}

interface ParsedArg {
  value: EmevdDslLiteral;
  span: EmevdDslSourceSpan;
}

interface ParsedCall {
  name: string;
  args: ParsedArg[];
  span: EmevdDslSourceSpan;
}

type ParsedStatement =
  | { kind: 'call'; call: ParsedCall; span: EmevdDslSourceSpan }
  | { kind: 'wait-for'; predicates: ParsedCall[]; span: EmevdDslSourceSpan }
  | { kind: 'comment'; text: string; span: EmevdDslSourceSpan };

interface ParsedEvent {
  eventId: number;
  restBehavior: number;
  statements: ParsedStatement[];
  span: EmevdDslSourceSpan;
}

interface SourceIndex {
  positionAt(offset: number): EmevdDslSourcePosition;
  span(from: number, to: number): EmevdDslSourceSpan;
}

export function compileEmevdDarkScript(
  request: EmevdDslCompileRequest,
  document: EmevdEditorDocument,
  registry?: EmedfRegistry
): EmevdDslCompileResult {
  const source = request.sourceText;
  const index = makeSourceIndex(source);
  const fileSpan = index.span(0, source.length);
  const diagnostics: EmevdDslDiagnostic[] = [];
  const add = (item: EmevdDslDiagnostic): void => { diagnostics.push(item); };

  if (request.mode !== 'patch' && request.mode !== 'dark-script') {
    add(error('EMEVD_DSL_MODE_UNSUPPORTED', `Unsupported compile mode: ${String(request.mode)}.`, fileSpan));
  }
  if (request.resourceUri !== document.resourceUri) {
    add(error('EMEVD_DSL_RESOURCE_MISMATCH', 'Resource URI does not match the opened document.', fileSpan, {
      resourceUri: request.resourceUri
    }));
  }
  if (document.documentInstanceId === undefined || request.documentInstanceId !== document.documentInstanceId) {
    add(error('EMEVD_DSL_DOCUMENT_INSTANCE_MISMATCH', 'Document instance is missing or stale.', fileSpan, {
      resourceUri: request.resourceUri
    }));
  }
  if (request.baseRevision !== document.revision) {
    add(error('EMEVD_DSL_STALE_REVISION', 'Base revision is stale.', fileSpan, {
      resourceUri: request.resourceUri
    }));
  }
  if (!registry) {
    add(error('EMEVD_DSL_SCHEMA_REQUIRED', 'EMEDF schema is required.', fileSpan, {
      resourceUri: request.resourceUri
    }));
  }

  const actualSchemaFingerprint = registry ? fingerprintEmedfRegistry(registry) : undefined;
  if (
    actualSchemaFingerprint !== undefined
    && request.emedfSchemaFingerprint !== actualSchemaFingerprint
  ) {
    add(error('EMEVD_DSL_SCHEMA_CHANGED', 'EMEDF schema fingerprint changed.', fileSpan, {
      resourceUri: request.resourceUri
    }));
  }

  const parsed = parseDarkScriptEvents(source, index, add);
  const ast = emptyAst(request, fileSpan);

  if (diagnostics.some((item) => item.severity === 'error') || !registry || !actualSchemaFingerprint) {
    return { ok: false, ast, diagnostics: diagnostics.sort(compareDiagnostics) };
  }

  const operations: EmevdPlannedMutation[] = [];
  const pairing = pairEvents(parsed, document.events);
  for (const pair of pairing.pairs) {
    compilePairedEvent(pair.parsed, pair.documentEvent, registry, operations, add, request.resourceUri);
  }
  // 新增事件：先 insert_event，再按源码顺序 insert_instruction。有任何一行
  // 编码不了就整个新事件抑制（不写半截事件），各行给「未解码」warning。
  for (const added of pairing.added) {
    compileAddedEvent(added, document, registry, operations, add, request.resourceUri);
  }
  // 删除事件：源码里整块没出现的权威文档事件。
  for (const missing of pairing.deleted) {
    if (!missing.anchor) {
      add(warn('DARKSCRIPT_LINE_UNDECODED', `事件 ${missing.eventId} 没有稳定锚，删除不能写入。`, fileSpan, {
        resourceUri: request.resourceUri
      }));
      continue;
    }
    operations.push({
      kind: 'delete_event',
      eventAnchor: formatEmevdAnchor('event', missing.anchor),
      eventId: missing.eventId,
      target: missing.anchor,
      targetPreconditionHash: computeEmevdEventFingerprint(missing),
      sourceSpan: fileSpan
    });
  }

  if (diagnostics.some((item) => item.severity === 'error')) {
    return { ok: false, ast, diagnostics: diagnostics.sort(compareDiagnostics) };
  }

  const hasUndecoded = diagnostics.some((item) => item.code === 'DARKSCRIPT_LINE_UNDECODED');
  if (operations.length === 0 && hasUndecoded) {
    return { ok: false, ast, diagnostics: diagnostics.sort(compareDiagnostics) };
  }

  const touchedEvents = unique(operations.map((operation) =>
    operation.kind === 'insert_event' ? `new:${operation.eventId}` : operation.eventAnchor
  ).filter((anchor) => anchor.length > 0));
  const touchedInstructions = unique(operations.flatMap((operation) =>
    operation.kind === 'set_instruction_arg' || operation.kind === 'delete_instruction'
      ? [operation.instructionAnchor]
      : []
  ));
  const sourceFingerprint = hashText(source);
  const planWithoutFingerprint = {
    schemaVersion: 1 as const,
    resourceUri: request.resourceUri,
    documentInstanceId: request.documentInstanceId,
    baseRevision: request.baseRevision,
    sourceFingerprint,
    schemaFingerprint: actualSchemaFingerprint,
    operations,
    impact: {
      touchedEvents,
      touchedInstructions,
      inserts: operations.filter((operation) =>
        operation.kind === 'insert_event' || operation.kind === 'insert_instruction').length,
      deletes: operations.filter((operation) =>
        operation.kind === 'delete_event' || operation.kind === 'delete_instruction').length,
      argumentWrites: operations.filter((operation) => operation.kind === 'set_instruction_arg').length
    }
  };
  const plan: EmevdMutationPlan = {
    ...planWithoutFingerprint,
    planFingerprint: hashText(stableJson(planWithoutFingerprint))
  };
  return { ok: true, ast, plan, diagnostics: diagnostics.sort(compareDiagnostics) };
}

function compilePairedEvent(
  parsed: ParsedEvent,
  event: EmevdEditorDocument['events'][number],
  registry: EmedfRegistry,
  operations: EmevdPlannedMutation[],
  add: (item: EmevdDslDiagnostic) => void,
  resourceUri: string
): void {
  if (!event.anchor) {
    add(warn('DARKSCRIPT_LINE_UNDECODED', '事件没有稳定锚，不能写入。', parsed.span, {
      resourceUri
    }));
    return;
  }
  const eventAnchor = formatEmevdAnchor('event', event.anchor);
  const eventHash = computeEmevdEventFingerprint(event);

  if (parsed.eventId !== event.eventId) {
    operations.push({
      kind: 'set_event_id',
      eventAnchor,
      target: event.anchor,
      targetPreconditionHash: eventHash,
      sourceSpan: parsed.span,
      before: event.eventId,
      after: parsed.eventId
    });
  }
  if (parsed.restBehavior !== event.restBehavior) {
    operations.push({
      kind: 'set_event_rest_behavior',
      eventAnchor,
      target: event.anchor,
      targetPreconditionHash: eventHash,
      sourceSpan: parsed.span,
      before: event.restBehavior,
      after: parsed.restBehavior
    });
  }

  const shape = analyzeDarkScriptEvent(event, registry);
  const diff = alignStatements(parsed.statements, shape);

  // 先把插入行全部试编码；任何一行编码不了，本事件的结构性改动（增/删）整体
  // 抑制，只保留已对齐行的参数写入 —— 不写「删了旧的却写不进新的」的半截状态。
  const encodings = new Map<ParsedStatement, { bank: number; id: number; argsBase64: string }>();
  let blocked = false;
  for (const entry of diff) {
    if (entry.kind !== 'insert') continue;
    if (entry.statement.kind === 'comment') continue; // 纯注释，无二进制语义，忽略
    if (entry.statement.kind === 'wait-for') {
      add(warn(
        'DARKSCRIPT_LINE_UNDECODED',
        '新增 WaitFor 折叠块本版不能写入（条件组簿记无法从源码重建），该块未解码。',
        entry.statement.span,
        { resourceUri, targetAnchor: eventAnchor }
      ));
      blocked = true;
      continue;
    }
    const encoded = encodeInsertedCall(entry.statement.call, registry);
    if (!encoded.ok) {
      add(warn('DARKSCRIPT_LINE_UNDECODED', `新增指令 ${entry.statement.call.name} 不能写入：${encoded.reason}`, entry.statement.span, {
        resourceUri,
        targetAnchor: eventAnchor
      }));
      blocked = true;
      continue;
    }
    encodings.set(entry.statement, { bank: encoded.bank, id: encoded.id, argsBase64: encoded.argsBase64 });
  }

  // 已对齐行：照旧逐行编参数差异。
  for (const entry of diff) {
    if (entry.kind === 'match') {
      compileStatement(entry.statement, entry.item, eventAnchor, operations, add, resourceUri);
    }
  }
  if (blocked) return;

  // 删除：原始文档里有、源码里没了的行（wait-for 块 = 谓词 + anchor 全部指令）。
  for (const entry of diff) {
    if (entry.kind !== 'delete') continue;
    for (const instruction of itemInstructions(entry.item)) {
      if (!instruction.anchor) {
        add(warn('DARKSCRIPT_LINE_UNDECODED', '待删指令没有稳定锚，删除不能写入。', parsed.span, {
          resourceUri,
          targetAnchor: eventAnchor
        }));
        continue;
      }
      const index = event.instructions.indexOf(instruction);
      if (index < 0) continue;
      operations.push({
        kind: 'delete_instruction',
        eventAnchor,
        eventId: event.eventId,
        instructionAnchor: formatEmevdAnchor('instruction', instruction.anchor),
        index,
        bank: instruction.bank,
        id: instruction.id,
        target: instruction.anchor,
        targetPreconditionHash: computeEmevdInstructionFingerprint(instruction),
        sourceSpan: parsed.span
      });
    }
  }

  // 插入：位置按「删除已应用后」的指令列表计算。
  let slot = 0;
  for (const entry of diff) {
    if (entry.kind === 'match') {
      slot += itemInstructions(entry.item).length;
      continue;
    }
    if (entry.kind !== 'insert') continue;
    if (entry.statement.kind !== 'call') continue;
    const encoded = encodings.get(entry.statement);
    if (!encoded) continue;
    operations.push({
      kind: 'insert_instruction',
      eventAnchor,
      eventId: event.eventId,
      index: slot,
      bank: encoded.bank,
      id: encoded.id,
      argsBase64: encoded.argsBase64,
      target: event.anchor!,
      targetPreconditionHash: eventHash,
      sourceSpan: entry.statement.span
    });
    slot += 1;
  }
}

/** 一个 shape 行对应事件指令列表里的指令（wait-for = 谓词们 + anchor）。 */
function itemInstructions(item: DarkScriptEventItem): EmevdEditorDocument['events'][number]['instructions'][number][] {
  if (item.kind === 'wait-for') {
    return [...item.predicates.map((predicate) => predicate.instruction), item.anchor];
  }
  return [item.instruction];
}

/**
 * 新增事件的编译：insert_event + 逐行 insert_instruction。
 * 任一行编码不了 → 整个事件抑制（不写空壳/半截事件），各行给「未解码」warning。
 */
function compileAddedEvent(
  parsed: ParsedEvent,
  document: EmevdEditorDocument,
  registry: EmedfRegistry,
  operations: EmevdPlannedMutation[],
  add: (item: EmevdDslDiagnostic) => void,
  resourceUri: string
): void {
  const encodable: Array<{ call: ParsedCall; bank: number; id: number; argsBase64: string }> = [];
  let blocked = false;
  for (const statement of parsed.statements) {
    if (statement.kind === 'comment') continue;
    if (statement.kind === 'wait-for') {
      add(warn('DARKSCRIPT_LINE_UNDECODED', '新增事件里的 WaitFor 折叠块不能写入，该事件未解码。', statement.span, { resourceUri }));
      blocked = true;
      continue;
    }
    const encoded = encodeInsertedCall(statement.call, registry);
    if (!encoded.ok) {
      add(warn('DARKSCRIPT_LINE_UNDECODED', `新增事件 ${parsed.eventId} 的 ${statement.call.name} 不能写入：${encoded.reason}`, statement.span, { resourceUri }));
      blocked = true;
      continue;
    }
    encodable.push({ call: statement.call, bank: encoded.bank, id: encoded.id, argsBase64: encoded.argsBase64 });
  }
  if (blocked) return;
  if (document.events.some((event) => event.eventId === parsed.eventId)) {
    add(warn('DARKSCRIPT_LINE_UNDECODED', `事件 ID ${parsed.eventId} 已存在，新增事件未写入。`, parsed.span, { resourceUri }));
    return;
  }
  const syntheticAnchor: EmevdNodeAnchor = {
    documentInstanceId: document.documentInstanceId ?? '',
    localNodeId: `new-event-${parsed.eventId}`,
    sourceFingerprint: ''
  };
  operations.push({
    kind: 'insert_event',
    eventId: parsed.eventId,
    restBehavior: parsed.restBehavior,
    target: syntheticAnchor,
    targetPreconditionHash: '',
    sourceSpan: parsed.span
  });
  encodable.forEach((entry, index) => {
    operations.push({
      kind: 'insert_instruction',
      eventAnchor: '',
      eventId: parsed.eventId,
      index,
      bank: entry.bank,
      id: entry.id,
      argsBase64: entry.argsBase64,
      target: syntheticAnchor,
      targetPreconditionHash: '',
      sourceSpan: entry.call.span
    });
  });
}

/**
 * 把新增的指令调用行编码成（bank, id, args）。
 * 只有 EMEDF 里名字唯一、无 vararg、参数个数/类型全对上的指令可以插入。
 */
function encodeInsertedCall(
  call: ParsedCall,
  registry: EmedfRegistry
): { ok: true; bank: number; id: number; argsBase64: string } | { ok: false; reason: string } {
  const candidates = registry.instructions.filter((def) => darkScriptInstructionName(def.name) === call.name);
  if (candidates.length === 0) return { ok: false, reason: 'EMEDF 里查不到这个指令名' };
  if (candidates.length > 1) return { ok: false, reason: 'EMEDF 里同名指令不唯一，无法确定 bank/id' };
  const def: EmedfInstructionDef = candidates[0]!;
  if (hasVararg(def)) return { ok: false, reason: 'vararg 指令的尾部长度由观察值决定，本版不能新增' };
  if (call.args.length !== def.args.length) {
    return { ok: false, reason: `参数个数对不上（源码 ${call.args.length}，schema ${def.args.length}）` };
  }
  const values: Record<string, number | boolean> = {};
  for (let i = 0; i < def.args.length; i += 1) {
    const argDef = def.args[i]!;
    const got = call.args[i]!;
    if (argDef.type === 'bool' ? typeof got.value !== 'boolean' : typeof got.value !== 'number') {
      return { ok: false, reason: `参数 ${argDef.name} 类型不匹配` };
    }
    values[argDef.name] = got.value;
  }
  const encoded = encodeEmedfArgs(def, values);
  if (!encoded.ok) return { ok: false, reason: encoded.message };
  return { ok: true, bank: def.bank, id: def.id, argsBase64: encoded.args.toString('base64') };
}

type StatementDiffEntry =
  | { kind: 'match'; statement: ParsedStatement; item: DarkScriptEventItem }
  | { kind: 'delete'; item: DarkScriptEventItem }
  | { kind: 'insert'; statement: ParsedStatement };

function statementKey(statement: ParsedStatement): string {
  if (statement.kind === 'comment') return 'opaque';
  if (statement.kind === 'wait-for') return `wait-for:${statement.predicates.map((predicate) => predicate.name).join(',')}`;
  return `call:${statement.call.name}`;
}

function itemKey(item: DarkScriptEventItem): string {
  if (item.kind === 'opaque') return 'opaque';
  if (item.kind === 'wait-for') return `wait-for:${item.predicates.map((predicate) => predicate.displayName).join(',')}`;
  return `call:${item.displayName}`;
}

/**
 * LCS 行对齐：把源码语句序列和反汇编形状序列按行身份对齐。
 * 输出是源码顺序的 match/delete/insert 混合序列（delete 插在被删行的原位置）。
 */
function alignStatements(statements: ParsedStatement[], items: DarkScriptEventItem[]): StatementDiffEntry[] {
  const n = statements.length;
  const m = items.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return items.map((item) => ({ kind: 'delete' as const, item }));
  if (m === 0) return statements.map((statement) => ({ kind: 'insert' as const, statement }));
  const a = statements.map(statementKey);
  const b = items.map(itemKey);
  // 超大事件（>2000×2000）退化为「公共前缀 + 公共后缀 + 中段全替换」，
  // 避免 LCS 全表内存；中段 replace 等价于 delete-all + insert-all。
  if (n * m > 4_000_000) {
    let prefix = 0;
    while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix += 1;
    const out: StatementDiffEntry[] = [];
    for (let i = 0; i < prefix; i += 1) out.push({ kind: 'match', statement: statements[i]!, item: items[i]! });
    for (let j = prefix; j < m - suffix; j += 1) out.push({ kind: 'delete', item: items[j]! });
    for (let i = prefix; i < n - suffix; i += 1) out.push({ kind: 'insert', statement: statements[i]! });
    for (let k = 0; k < suffix; k += 1) {
      out.push({ kind: 'match', statement: statements[n - suffix + k]!, item: items[m - suffix + k]! });
    }
    return out;
  }
  const width = m + 1;
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const out: StatementDiffEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'match', statement: statements[i]!, item: items[j]! });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      out.push({ kind: 'insert', statement: statements[i]! });
      i += 1;
    } else {
      out.push({ kind: 'delete', item: items[j]! });
      j += 1;
    }
  }
  while (i < n) { out.push({ kind: 'insert', statement: statements[i]! }); i += 1; }
  while (j < m) { out.push({ kind: 'delete', item: items[j]! }); j += 1; }
  return out;
}

function compileStatement(
  statement: ParsedStatement,
  item: DarkScriptEventItem,
  eventAnchor: string,
  operations: EmevdPlannedMutation[],
  add: (item: EmevdDslDiagnostic) => void,
  resourceUri: string
): void {
  if (statement.kind === 'comment' && item.kind === 'opaque') {
    if (normalizeComment(statement.text) !== normalizeComment(item.comment)) {
      add(warn('DARKSCRIPT_LINE_UNDECODED', '未解码指令只能保持原注释，不能改写成别的内容。', statement.span, {
        resourceUri,
        targetAnchor: eventAnchor
      }));
    }
    return;
  }
  if (statement.kind === 'wait-for' && item.kind === 'wait-for') {
    if (statement.predicates.length !== item.predicates.length) {
      add(warn('DARKSCRIPT_LINE_UNDECODED', 'WaitFor 谓词数量对不上，该行未解码。', statement.span, {
        resourceUri,
        targetAnchor: eventAnchor
      }));
      return;
    }
    for (let i = 0; i < item.predicates.length; i += 1) {
      emitCallArgMutations(
        statement.predicates[i]!,
        item.predicates[i]!.displayName,
        item.predicates[i]!.visibleArgs,
        item.predicates[i]!.instruction,
        eventAnchor,
        operations,
        add,
        resourceUri
      );
    }
    return;
  }
  if (statement.kind === 'call' && item.kind === 'call') {
    emitCallArgMutations(
      statement.call,
      item.displayName,
      item.args,
      item.instruction,
      eventAnchor,
      operations,
      add,
      resourceUri
    );
    return;
  }
  add(warn('DARKSCRIPT_LINE_UNDECODED', '这一行对不上权威文档里的指令，未解码。', statement.span, {
    resourceUri,
    targetAnchor: eventAnchor
  }));
}

function emitCallArgMutations(
  call: ParsedCall,
  expectedName: string,
  expectedArgs: readonly DecodedArg[],
  instruction: EmevdEditorDocument['events'][number]['instructions'][number],
  eventAnchor: string,
  operations: EmevdPlannedMutation[],
  add: (item: EmevdDslDiagnostic) => void,
  resourceUri: string
): void {
  if (call.name !== expectedName) {
    add(warn(
      'DARKSCRIPT_LINE_UNDECODED',
      `指令名 ${call.name} 对不上 ${expectedName}，该行未解码。`,
      call.span,
      { resourceUri, targetAnchor: eventAnchor }
    ));
    return;
  }
  if (!instruction.anchor) {
    add(warn('DARKSCRIPT_LINE_UNDECODED', '指令没有稳定锚，不能写入。', call.span, {
      resourceUri,
      targetAnchor: eventAnchor
    }));
    return;
  }
  if (call.args.length !== expectedArgs.length) {
    add(warn(
      'DARKSCRIPT_LINE_UNDECODED',
      `参数个数对不上（源码 ${call.args.length}，文档 ${expectedArgs.length}），该行未解码。`,
      call.span,
      { resourceUri, targetAnchor: eventAnchor }
    ));
    return;
  }
  const instructionAnchor = formatEmevdAnchor('instruction', instruction.anchor);
  const hash = computeEmevdInstructionFingerprint(instruction);
  for (let i = 0; i < expectedArgs.length; i += 1) {
    const expected = expectedArgs[i]!;
    const got = call.args[i]!;
    if (typeof expected.value !== typeof got.value) {
      add(error(
        'DARKSCRIPT_ARG_TYPE',
        `参数 ${expected.name} 类型不匹配。`,
        got.span,
        { resourceUri, targetAnchor: instructionAnchor }
      ));
      continue;
    }
    if (!Object.is(expected.value, got.value)) {
      operations.push({
        kind: 'set_instruction_arg',
        eventAnchor,
        instructionAnchor,
        target: instruction.anchor,
        targetPreconditionHash: hash,
        sourceSpan: got.span,
        bank: instruction.bank,
        id: instruction.id,
        argument: expected.name,
        before: expected.value,
        after: got.value
      });
    }
  }
}

interface EventPairing {
  pairs: Array<{ parsed: ParsedEvent; documentEvent: EmevdEditorDocument['events'][number] }>;
  /** 源码里有、文档里没有的事件（等数量时优先按位置当成改 id）。 */
  added: ParsedEvent[];
  /** 文档里有、源码里没有的事件。 */
  deleted: EmevdEditorDocument['events'][number][];
}

function pairEvents(
  parsed: ParsedEvent[],
  documentEvents: readonly EmevdEditorDocument['events'][number][]
): EventPairing {
  const remaining = [...documentEvents];
  const pairs: EventPairing['pairs'] = [];
  const leftovers: ParsedEvent[] = [];
  for (const event of parsed) {
    const index = remaining.findIndex((item) => item.eventId === event.eventId);
    if (index >= 0) {
      pairs.push({ parsed: event, documentEvent: remaining.splice(index, 1)[0]! });
    } else {
      leftovers.push(event);
    }
  }
  // 数量相等的「多出来 ↔ 缺下来」按位置配对：这是改事件 id 的场景，
  // 配对后走 set_event_id，保留原事件的全部指令。
  while (leftovers.length > 0 && remaining.length > 0) {
    pairs.push({ parsed: leftovers.shift()!, documentEvent: remaining.shift()! });
  }
  return { pairs, added: leftovers, deleted: remaining };
}

function parseDarkScriptEvents(
  source: string,
  index: SourceIndex,
  add: (item: EmevdDslDiagnostic) => void
): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  let offset = 0;
  const header = /\$Event\(\s*(-?\d+)\s*,\s*(Default|Restart|-?\d+)(?:\s*\/\*[\s\S]*?\*\/)?\s*,\s*function\s*\(\s*\)\s*\{/g;
  while (offset <= source.length) {
    header.lastIndex = offset;
    const match = header.exec(source);
    if (!match) break;
    const headerStart = match.index;
    const headerEnd = header.lastIndex;
    const close = findEventClose(source, headerEnd);
    if (close < 0) {
      add(error('DARKSCRIPT_PARSE', '事件块没有对应的 `});`。', index.span(headerStart, source.length)));
      break;
    }
    const restRaw = match[2]!;
    const restBehavior = restRaw === 'Default' ? 0 : restRaw === 'Restart' ? 1 : Number(restRaw);
    const body = source.slice(headerEnd, close);
    const statements = parseStatements(body, headerEnd, index, add);
    events.push({
      eventId: Number(match[1]),
      restBehavior,
      statements,
      span: index.span(headerStart, close + 3)
    });
    offset = close + 3;
  }
  if (events.length === 0 && /\$Event\s*\(/.test(source)) {
    add(error('DARKSCRIPT_PARSE', '没有解析到完整的 $Event 块。', index.span(0, source.length)));
  }
  return events;
}

function findEventClose(source: string, from: number): number {
  const needle = '\n});';
  let search = from;
  while (search < source.length) {
    const at = source.indexOf(needle, search);
    if (at < 0) {
      return source.startsWith('});', from) ? from : source.endsWith('\n});') ? source.lastIndexOf('\n});') + 1 : -1;
    }
    return at + 1;
  }
  return -1;
}

function parseStatements(
  body: string,
  bodyStart: number,
  index: SourceIndex,
  add: (item: EmevdDslDiagnostic) => void
): ParsedStatement[] {
  const statements: ParsedStatement[] = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i]!)) i += 1;
    if (i >= body.length) break;
    if (body.startsWith('//', i)) {
      const nl = body.indexOf('\n', i);
      const end = nl < 0 ? body.length : nl;
      const text = body.slice(i, end).trim();
      statements.push({
        kind: 'comment',
        text,
        span: index.span(bodyStart + i, bodyStart + end)
      });
      i = end;
      continue;
    }
    const start = i;
    const sliced = scanBalancedStatement(body, i);
    if (!sliced) {
      add(error('DARKSCRIPT_PARSE', '无法解析的语句。', index.span(bodyStart + i, bodyStart + body.length)));
      break;
    }
    i = sliced.end;
    const raw = body.slice(start, sliced.end).trim();
    const span = index.span(bodyStart + start, bodyStart + sliced.end);
    const wait = parseWaitFor(raw, span, bodyStart + start, index, add);
    if (wait) {
      statements.push(wait);
      continue;
    }
    const call = parseCall(raw, span);
    if (call) {
      statements.push({ kind: 'call', call, span });
      continue;
    }
    add(warn('DARKSCRIPT_LINE_UNDECODED', '无法识别的语句，未解码。', span));
  }
  return statements;
}

function scanBalancedStatement(body: string, start: number): { end: number } | null {
  let depth = 0;
  let i = start;
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ';' && depth === 0) return { end: i + 1 };
    i += 1;
  }
  return null;
}

function parseWaitFor(
  raw: string,
  span: EmevdDslSourceSpan,
  absoluteStart: number,
  index: SourceIndex,
  add: (item: EmevdDslDiagnostic) => void
): ParsedStatement | null {
  const match = /^WaitFor\s*\(([\s\S]*)\)\s*;$/.exec(raw);
  if (!match) return null;
  const inner = match[1]!.trim();
  if (/^[A-Z][A-Za-z0-9_]*\s*\(/.test(inner) && !inner.includes('&&')) {
    const call = parseCall(`${inner};`, span);
    if (!call) {
      add(warn('DARKSCRIPT_LINE_UNDECODED', 'WaitFor 里的谓词无法解析，未解码。', span));
      return { kind: 'wait-for', predicates: [], span };
    }
    return { kind: 'wait-for', predicates: [call], span };
  }
  const parts = splitTopLevel(inner, '&&');
  const predicates: ParsedCall[] = [];
  let cursor = raw.indexOf('(') + 1;
  for (const part of parts) {
    const local = part.trim();
    const rel = raw.indexOf(local, cursor);
    const callSpan = rel >= 0
      ? index.span(absoluteStart + rel, absoluteStart + rel + local.length)
      : span;
    const call = parseCall(`${local};`, callSpan);
    if (!call) {
      add(warn('DARKSCRIPT_LINE_UNDECODED', 'WaitFor 里的谓词无法解析，未解码。', callSpan));
      return { kind: 'wait-for', predicates: [], span };
    }
    predicates.push(call);
    cursor = rel >= 0 ? rel + local.length : cursor;
  }
  return { kind: 'wait-for', predicates, span };
}

function parseCall(raw: string, span: EmevdDslSourceSpan): ParsedCall | null {
  const match = /^([A-Z][A-Za-z0-9_]*)\s*\(([\s\S]*)\)\s*;$/.exec(raw.trim());
  if (!match) return null;
  const argsRaw = match[2]!.trim();
  if (argsRaw.length === 0) return { name: match[1]!, args: [], span };
  const parts = splitTopLevel(argsRaw, ',');
  const args: ParsedArg[] = [];
  for (const part of parts) {
    const literal = parseLiteral(part.trim());
    if (literal === undefined) return null;
    args.push({ value: literal, span });
  }
  return { name: match[1]!, args, span };
}

function parseLiteral(text: string): EmevdDslLiteral | undefined {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === '-0') return -0;
  if (/^-?\d+$/.test(text)) {
    const value = Number(text);
    return Number.isSafeInteger(value) ? value : undefined;
  }
  if (/^-?\d+\.\d+(?:e[+-]?\d+)?$/i.test(text)) {
    const value = Number(text);
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0 && text.startsWith(separator, i)) {
      parts.push(text.slice(start, i));
      i += separator.length - 1;
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.filter((part) => part.trim().length > 0);
}

function normalizeComment(text: string): string {
  return text.replace(/^\s*\/\/\s*/, '').trim();
}

function makeSourceIndex(source: string): SourceIndex {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  const positionAt = (offset: number): EmevdDslSourcePosition => {
    const clamped = Math.max(0, Math.min(offset, source.length));
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high + 1) / 2);
      if (starts[mid]! <= clamped) low = mid;
      else high = mid - 1;
    }
    return { offset: clamped, line: low + 1, column: clamped - starts[low]! + 1 };
  };
  return {
    positionAt,
    span(from: number, to: number) {
      return { start: positionAt(from), end: positionAt(to) };
    }
  };
}

function emptyAst(request: EmevdDslCompileRequest, span: EmevdDslSourceSpan): EmevdDslDocument {
  return {
    schemaVersion: 1,
    resourceUri: request.resourceUri,
    baseRevision: request.baseRevision,
    emedfSchemaFingerprint: request.emedfSchemaFingerprint,
    events: [],
    span
  };
}

function error(
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

function warn(
  code: string,
  message: string,
  span: EmevdDslSourceSpan,
  extra?: { resourceUri?: string; targetAnchor?: string }
): EmevdDslDiagnostic {
  return {
    severity: 'warning',
    code,
    message,
    span,
    ...(extra?.resourceUri !== undefined ? { resourceUri: extra.resourceUri } : {}),
    ...(extra?.targetAnchor !== undefined ? { targetAnchor: extra.targetAnchor } : {})
  };
}

function compareDiagnostics(left: EmevdDslDiagnostic, right: EmevdDslDiagnostic): number {
  return left.span.start.offset - right.span.start.offset || left.code.localeCompare(right.code);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function hashText(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}
