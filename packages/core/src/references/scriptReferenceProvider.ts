/**
 * 脚本调用、容器身份与完整读取边界 provider（T06，执行指令 §T06）。
 *
 * 状态分离（§T06 步骤 1）：`ScriptSymbol.contentKind` 的
 * `catalog-only` / `bytecode` / `decompiled-view` / `source` 是四种不同事实。
 * 只有 `source`（loader profile 解码出的原文）产生 confirmed 调用证明；
 * 反编译视图只登记视图事实；字节码/目录条目保留编码诊断。绝不按角色号拼接
 * `cXXXX_ai.lua` 后声称该子项存在 —— 名称假设只在 `includeHypotheses` 下以
 * low + 规则名出现，且目标必须真实存在于目录。
 *
 * 容器身份（步骤 2）：`contains` 边只在 `catalogComplete` 为 true 时发布；
 * 目录页未读完时返回 SCRIPT_CATALOG_INCOMPLETE 诊断，任何子项存在性判断降为
 * unverified，不得声明覆盖完整。
 *
 * 调用解析（步骤 5-8）：调用节点全部来自受限 Lua 静态子集的词法/语法结果
 * （`luaStaticSubset.ts`），不使用全文件正则。注释、字符串、函数定义与局部
 * 遮蔽不会误报。参数只有字面量，或同一受限作用域内唯一且未被重新赋值的字面量
 * 绑定才可静态解析；其余标 dynamic，不执行脚本求值。
 *
 * API 语义规则表：仓库目前没有受信任的游戏脚本 API 参数语义登记，因此除
 * `require`（语言级模块加载，按同容器目录唯一匹配解析）外，其它调用只作为
 * 观察事实登记（resolution=unknown），不生成 confirmed 边。规则表留显式扩展点，
 * 新增规则必须携带出处。
 *
 * 读取边界（步骤 11）：本 provider 消费的是关联查询内已读取的脚本文本，输出
 * 的每条证据都是"片段观察事实"（bounded excerpt + span + sourceHash），不构成本
 * 脚本的完整读取/写入证明；full-script write proof 由 T09 的 NativeReadProofStore
 * 独立判定。
 */
import type {
  Diagnostic,
  ReferenceEdge,
  ReferenceEvidence,
  ScriptCallOccurrence,
  ScriptExport,
  ScriptSymbol
} from '@soulforge/shared';
import { parseLuaStaticSubset } from './luaStaticSubset.js';
import type { LuaCall, LuaLocalBinding, LuaParseResult } from './luaStaticSubset.js';

export interface ScriptReferenceBuildOptions {
  /** Name-based asset/loader hypotheses (low, rule-named) are excluded unless true. */
  includeHypotheses?: boolean;
  /** Cap for bounded statement excerpts carried into evidence. */
  maxExcerptChars?: number;
  /**
   * Already located workspace objects that may be compared with literal
   * arguments in otherwise unknown calls.  These are observation edges only:
   * they never turn an unknown game API into a confirmed foreign key.
   */
  literalTargets?: ScriptLiteralTargetIndexes;
  /** Maximum literal matches emitted for one call site. */
  maxLiteralMatchesPerCall?: number;
}

export interface ScriptLiteralTarget {
  uri: string;
  label?: string;
}

export interface ScriptLiteralTargetIndexes {
  numeric: Map<number, ScriptLiteralTarget[]>;
  strings: Map<string, ScriptLiteralTarget[]>;
}

export interface ScriptReferenceBuildResult {
  edges: ReferenceEdge[];
  diagnostics: Diagnostic[];
  /** Enriched call occurrences per script uri (consumed by T08 service assembly). */
  callsByScriptUri: Map<string, ScriptCallOccurrence[]>;
  stats: {
    confirmed: number;
    hypotheses: number;
    dynamicArgs: number;
    /** Scripts whose source could not be lexed/parsed completely. */
    unparsedScripts: number;
    /** Children without decodable source text (bytecode / catalog-only / view). */
    nonSourceChildren: number;
    containersWithCompleteCatalog: number;
    containersWithPartialCatalog: number;
  };
}

const MAX_SCRIPT_REF_DIAGNOSTICS = 500;
const DEFAULT_MAX_EXCERPT_CHARS = 400;

/**
 * 显式 API 语义规则：callee 名（精确匹配）、字面量参数位置、引用命名空间。
 * 目前仓库可追溯的语义只有语言级 `require`；游戏 API 规则必须附出处后才能
 * 加入，不允许凭名称相似猜语义（§T06 步骤 7）。
 */
interface ScriptApiRule {
  ruleId: string;
  callee: string;
  argPosition: number;
  namespace: 'script-module';
  source: string;
}

export const SCRIPT_API_RULES: readonly ScriptApiRule[] = Object.freeze([
  {
    ruleId: 'lua-require',
    callee: 'require',
    argPosition: 0,
    namespace: 'script-module',
    // Lua 语言级模块加载；解析限定在同一容器目录内（步骤 8：同名文件不能跨容器连接）。
    source: 'luaStaticSubset require detection + ScriptLoaderProfile container lookup'
  }
]);

interface ChildIndex {
  /** Lowercased basename (with and without .lua) → children in this container. */
  byName: Map<string, ScriptSymbol[]>;
}

function indexChildren(exportItem: ScriptExport): ChildIndex {
  const byName = new Map<string, ScriptSymbol[]>();
  const push = (key: string, child: ScriptSymbol): void => {
    const list = byName.get(key);
    if (list) {
      if (!list.includes(child)) list.push(child);
    } else byName.set(key, [child]);
  };
  for (const child of exportItem.scripts) {
    const name = child.entryName ?? child.childChain[child.childChain.length - 1];
    if (!name) continue;
    const lowered = name.toLowerCase();
    push(lowered, child);
    push(lowered.replace(/\.lua$/u, ''), child);
  }
  return { byName };
}

export function buildScriptReferenceEdges(
  scriptExports: readonly ScriptExport[],
  options: ScriptReferenceBuildOptions = {}
): ScriptReferenceBuildResult {
  const maxExcerptChars = options.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS;
  const edges: ReferenceEdge[] = [];
  const diagnostics: Diagnostic[] = [];
  const callsByScriptUri = new Map<string, ScriptCallOccurrence[]>();
  const stats: ScriptReferenceBuildResult['stats'] = {
    confirmed: 0,
    hypotheses: 0,
    dynamicArgs: 0,
    unparsedScripts: 0,
    nonSourceChildren: 0,
    containersWithCompleteCatalog: 0,
    containersWithPartialCatalog: 0
  };
  const pushDiagnostic = (diagnostic: Diagnostic): void => {
    if (diagnostics.length >= MAX_SCRIPT_REF_DIAGNOSTICS) return;
    diagnostics.push(diagnostic);
  };

  for (const exportItem of scriptExports) {
    const catalogComplete = exportItem.catalogComplete === true;
    if (catalogComplete) stats.containersWithCompleteCatalog += 1;
    else {
      stats.containersWithPartialCatalog += 1;
      pushDiagnostic({
        severity: 'warning',
        code: 'SCRIPT_CATALOG_INCOMPLETE',
        message: `容器 ${exportItem.sourceUri} 的目录页未全部读取；该导出不能声明覆盖完整，子项存在性判断降为 unverified。`,
        sourceUri: exportItem.sourceUri
      });
    }
    const childIndex = indexChildren(exportItem);

    for (const child of exportItem.scripts) {
      // 容器身份：contains 边只在目录完整时发布（步骤 2）。
      if (catalogComplete) {
        edges.push({
          fromUri: exportItem.sourceUri,
          toUri: child.uri,
          kind: 'contains',
          confidence: 'high',
          reason: `完整目录列出子项 entryIndex=${child.entryIndex ?? '?'} ${child.entryName ?? child.childChain.join('/')}`,
          evidence: [{
            sourceUri: exportItem.sourceUri,
            ...(child.entryName ? { fieldName: child.entryName } : {}),
            excerpt: bounded(containerListing(child), maxExcerptChars)
          }]
        });
      }

      const parseableView = child.contentKind === 'source'
        || (child.contentKind === 'decompiled-view' && child.sourceText !== undefined);
      if (!parseableView) {
        stats.nonSourceChildren += 1;
        if (child.contentKind === 'decompiled-view') {
          pushDiagnostic({
            severity: 'info',
            code: 'SCRIPT_DECOMPILED_VIEW_ONLY',
            message: `${child.uri} 只有反编译视图，不是原文源码；视图内容只登记为视图事实，不生成 confirmed 语义边。`,
            sourceUri: child.sourceUri
          });
        } else if (child.contentKind === 'bytecode') {
          pushDiagnostic({
            severity: 'info',
            code: 'SCRIPT_BYTECODE_NO_SOURCE',
            message: `${child.uri} 为编译字节码，无原文可解析；该子项的调用覆盖为 unknown，不宣称零引用。`,
            sourceUri: child.sourceUri,
            details: { encodingDiagnostics: child.encodingDiagnostics ?? [] }
          });
        }
        continue;
      }
      if (child.sourceText === undefined) {
        stats.unparsedScripts += 1;
        pushDiagnostic({
          severity: 'warning',
          code: 'SCRIPT_SOURCE_TEXT_MISSING',
          message: `${child.uri} 标记为 source 但没有解码文本，编码/loader 诊断：${child.encodingDiagnostics?.join('; ') ?? '（无）'}`,
          sourceUri: child.sourceUri
        });
        continue;
      }

      if (child.contentKind === 'decompiled-view') {
        pushDiagnostic({
          severity: 'info',
          code: 'SCRIPT_DECOMPILED_VIEW_PARSED',
          message: `${child.uri} 使用 SoulForge first-party 反编译视图参与静态关联；该关系不是原始源码写回证明。`,
          sourceUri: child.sourceUri
        });
      }

      const parsed: LuaParseResult = parseLuaStaticSubset(child.sourceText);
      if (parsed.lexTruncated) {
        stats.unparsedScripts += 1;
        pushDiagnostic({
          severity: 'warning',
          code: 'SCRIPT_LEX_TRUNCATED',
          message: `${child.uri} 的词法分析在未闭合字符串/不支持字符处停止；其后位置的引用语义未扫描，不能宣称完整。`,
          sourceUri: child.sourceUri
        });
      }
      for (const item of parsed.diagnostics.slice(0, 20)) {
        pushDiagnostic({
          severity: item.severity,
          code: item.code,
          message: `${child.uri}: ${item.message}`,
          sourceUri: child.sourceUri
        });
      }

      const occurrences: ScriptCallOccurrence[] = [];
      callsByScriptUri.set(child.uri, occurrences);
      const context: CallContext = {
        child,
        containerUri: exportItem.sourceUri,
        catalogComplete,
        childIndex,
        parsed,
        edges,
        pushDiagnostic,
        stats,
        options,
        maxExcerptChars,
        sourceText: child.sourceText
      };
      for (const [statementIndex, call] of parsed.calls.entries()) {
        occurrences.push(emitCallEdges(context, call, statementIndex));
      }
    }
  }

  if (diagnostics.length >= MAX_SCRIPT_REF_DIAGNOSTICS) {
    diagnostics.push({
      severity: 'warning',
      code: 'SCRIPT_REF_DIAGNOSTICS_TRUNCATED',
      message: `脚本引用诊断达到 ${MAX_SCRIPT_REF_DIAGNOSTICS} 条上限，后续缺口未列出。`
    });
  }

  return { edges, diagnostics, callsByScriptUri, stats };
}

interface CallContext {
  child: ScriptSymbol;
  containerUri: string;
  catalogComplete: boolean;
  childIndex: ChildIndex;
  parsed: LuaParseResult;
  edges: ReferenceEdge[];
  pushDiagnostic: (diagnostic: Diagnostic) => void;
  stats: ScriptReferenceBuildResult['stats'];
  options: ScriptReferenceBuildOptions;
  maxExcerptChars: number;
  sourceText: string;
}

function emitCallEdges(context: CallContext, call: LuaCall, statementIndex: number): ScriptCallOccurrence {
  const { child, catalogComplete, edges, pushDiagnostic, stats, options, maxExcerptChars, sourceText } = context;

  // 静态解析实参：字面量直接取值；裸名称只有在同一受限作用域内存在唯一、
  // 未被修改的字面量绑定时才可解析（步骤 7）。不执行脚本求值。
  const resolvedArgs = call.args.map((arg) => resolveArg(context, arg.kind, arg.text, arg.literal));
  const hasDynamicArg = resolvedArgs.some((arg) => arg.dynamic);
  if (hasDynamicArg) stats.dynamicArgs += 1;

  const statementText = sourceText.slice(call.span.startOffset, call.span.endOffset);
  const excerpt = bounded(statementText, maxExcerptChars);
  const literalArgs = resolvedArgs
    .filter((arg): arg is { dynamic: false; literal: string | number | boolean } =>
      !arg.dynamic && arg.literal !== undefined && arg.literal !== null)
    .map((arg) => arg.literal);

  const evidence = (): ReferenceEvidence => ({
    sourceUri: child.uri,
    fieldName: call.callee,
    excerpt: withLocation(excerpt, call),
    ...(literalArgs.length > 0 ? { value: literalArgs[0] } : {})
  });
  const span = {
    startLine: call.span.startLine,
    startColumn: call.span.startColumn,
    endLine: call.span.endLine,
    endColumn: call.span.endColumn
  };

  // 局部定义或局部遮蔽的调用：不生成已确认游戏 API 引用（步骤 6）。
  if (call.isLocal) {
    return {
      statementIndex,
      callee: call.callee,
      ...(literalArgs.length > 0 ? { literalArgs } : {}),
      hasDynamicArg,
      span,
      resolution: 'local'
    };
  }

  const rule = SCRIPT_API_RULES.find((item) => item.callee === call.callee);
  if (!rule) {
    // 没有受信任语义规则：调用只是观察事实，不冒充 API 引用（resolution=unknown）。
    emitLiteralMatchEdges(context, call, resolvedArgs, excerpt);
    emitNameHypothesis(context, call, resolvedArgs, excerpt);
    return {
      statementIndex,
      callee: call.callee,
      ...(literalArgs.length > 0 ? { literalArgs } : {}),
      hasDynamicArg,
      span,
      resolution: 'unknown'
    };
  }

  const arg = resolvedArgs[rule.argPosition];
  if (!arg || arg.dynamic || typeof arg.literal !== 'string') {
    pushDiagnostic({
      severity: 'info',
      code: 'SCRIPT_MODULE_ARG_DYNAMIC',
      message: `${child.uri} 的 ${call.callee} 第 ${rule.argPosition + 1} 参不是可静态解析的字符串字面量，模块连接保留为缺口，不强行填目标。`,
      sourceUri: child.sourceUri,
      details: { callee: call.callee, statementIndex }
    });
    return {
      statementIndex, callee: call.callee,
      ...(literalArgs.length > 0 ? { literalArgs } : {}),
      hasDynamicArg, span, resolution: 'api'
    };
  }

  // require 目标解析限定在同一容器目录内（步骤 8：同名文件不能跨容器随意连接）。
  const moduleName = arg.literal;
  const candidates = dedupeByUri(resolveModuleTargets(context.childIndex, moduleName));
  if (candidates.length === 0) {
    pushDiagnostic({
      severity: 'warning',
      code: catalogComplete ? 'SCRIPT_REQUIRE_TARGET_MISSING' : 'SCRIPT_REQUIRE_TARGET_UNVERIFIED',
      message: catalogComplete
        ? `${child.uri} 加载 ${moduleName}，但完整目录中不存在该子项；不能声称该模块存在。`
        : `${child.uri} 加载 ${moduleName}，目录未读全，存在性 unverified。`,
      sourceUri: child.sourceUri,
      details: { module: moduleName }
    });
  } else if (candidates.length > 1) {
    pushDiagnostic({
      severity: 'warning',
      code: 'SCRIPT_REQUIRE_TARGET_AMBIGUOUS',
      message: `模块名 ${moduleName} 在本容器目录中命中 ${candidates.length} 个子项，返回候选而非任选其一。`,
      sourceUri: child.sourceUri,
      details: { module: moduleName, candidates: candidates.map((item) => item.uri) }
    });
  } else {
    const target = candidates[0]!;
    const decompiledView = child.contentKind === 'decompiled-view';
    if (!decompiledView) stats.confirmed += 1;
    edges.push({
      fromUri: child.uri,
      toUri: target.uri,
      kind: 'invokes_script',
      confidence: decompiledView ? 'medium' : 'high',
      reason: `规则 ${rule.ruleId}：${call.callee}(${moduleName}) 在同容器完整目录中唯一命中 ${target.entryName ?? target.childChain.join('/')}${decompiledView ? '（first-party 反编译视图）' : ''}`,
      evidence: [evidence()]
    });
  }

  return {
    statementIndex, callee: call.callee,
    ...(literalArgs.length > 0 ? { literalArgs } : {}),
    hasDynamicArg, span, resolution: 'api'
  };
}

/**
 * Unknown game APIs still expose useful, bounded observations when a literal
 * argument exactly equals an object already located by another provider.  The
 * edge is deliberately `numeric_match` + low confidence and says the rule is
 * unknown; it is never promoted to a typed API relationship.
 */
function emitLiteralMatchEdges(
  context: CallContext,
  call: LuaCall,
  resolvedArgs: ResolvedArg[],
  excerpt: string
): void {
  const targets = context.options.literalTargets;
  if (!targets) return;
  const maxMatches = Math.max(1, context.options.maxLiteralMatchesPerCall ?? 16);
  let emitted = 0;
  for (const [argIndex, arg] of resolvedArgs.entries()) {
    if (emitted >= maxMatches || arg.dynamic || arg.literal === undefined || arg.literal === null) continue;
    const candidates = typeof arg.literal === 'number'
      && Number.isSafeInteger(arg.literal)
      ? targets.numeric.get(arg.literal) ?? []
      : typeof arg.literal === 'string'
        ? targets.strings.get(normalizeLiteral(arg.literal)) ?? []
        : [];
    for (const target of dedupeLiteralTargets(candidates)) {
      if (emitted >= maxMatches) break;
      emitted += 1;
      const value = arg.literal as string | number | boolean;
      const valueText = typeof value === 'string' ? JSON.stringify(value) : String(value);
      context.edges.push({
        fromUri: context.child.uri,
        toUri: target.uri,
        kind: typeof value === 'string' ? 'name_match' : 'numeric_match',
        confidence: 'low',
        reason: `unknown-api literal-match: ${call.callee}(${valueText}) 的第 ${argIndex + 1} 个字面量与已定位对象 ${target.label ?? target.uri} 相同；未登记游戏 API 规则。`,
        evidence: [{
          sourceUri: context.child.uri,
          fieldName: `${call.callee}[${argIndex}]`,
          value,
          excerpt: withLocation(excerpt, call)
        }]
      });
    }
  }
}

function dedupeLiteralTargets(targets: readonly ScriptLiteralTarget[]): ScriptLiteralTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    if (seen.has(target.uri)) return false;
    seen.add(target.uri);
    return true;
  });
}

function normalizeLiteral(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function withLocation(excerpt: string, call: LuaCall): string {
  // `luaStaticSubset` is zero based; reference-query locations are displayed
  // as one based line/column values.  The marker is parsed by the existing
  // page projection, so no shared evidence type change is required.
  return `${excerpt} @L${call.span.startLine + 1}:C${call.span.startColumn + 1}`;
}

type ResolvedArg =
  | { dynamic: false; literal?: string | number | boolean | null }
  | { dynamic: true };

function resolveArg(
  context: CallContext,
  kind: string,
  text: string,
  literal?: string | number | boolean | null
): ResolvedArg {
  if (kind === 'literal' && literal !== undefined) return { dynamic: false, literal };
  if (kind === 'name') {
    const binding = findUniqueBinding(context.parsed.bindings, text);
    if (binding && binding.literal !== undefined && !binding.modified && !binding.isFunction) {
      return { dynamic: false, literal: binding.literal };
    }
  }
  return { dynamic: true };
}

/**
 * 唯一字面量绑定（步骤 7）：同名 local 在整个受限扫描中只能声明一次，且未被
 * 重新赋值。多次声明（含不同作用域）视为不唯一，按动态处理。
 */
function findUniqueBinding(bindings: readonly LuaLocalBinding[], name: string): LuaLocalBinding | undefined {
  const matches = bindings.filter((item) => item.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * 名称假设通道（默认关闭）：字符串实参形如资产/脚本名时，只有目录里真实存在
 * 同名 `.lua` 子项才允许生成 low + 规则名的假设边；绝不因拼接名称而声称子项
 * 存在（步骤 1）。
 */
function emitNameHypothesis(
  context: CallContext,
  call: LuaCall,
  resolvedArgs: ResolvedArg[],
  excerpt: string
): void {
  if (!context.options.includeHypotheses) return;
  const first = resolvedArgs[0];
  if (!first || first.dynamic || typeof first.literal !== 'string') return;
  const candidates = dedupeByUri(resolveModuleTargets(context.childIndex, first.literal));
  if (candidates.length !== 1) return;
  const target = candidates[0]!;
  context.stats.hypotheses += 1;
  context.edges.push({
    fromUri: context.child.uri,
    toUri: target.uri,
    kind: 'invokes_script',
    confidence: 'low',
    reason: `hypothesis(script-name-match): ${call.callee} 的第 1 参字符串与同容器子项 ${target.entryName ?? ''} 同名；该匹配只说明命名一致，不能证明运行时加载关系。`,
    evidence: [{ sourceUri: context.child.uri, fieldName: call.callee, excerpt: withLocation(excerpt, call) }]
  });
}

function resolveModuleTargets(index: ChildIndex, moduleName: string): ScriptSymbol[] {
  const normalized = moduleName.toLowerCase().replace(/\./gu, '/');
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  return index.byName.get(basename) ?? index.byName.get(`${basename}.lua`) ?? [];
}

function dedupeByUri(children: ScriptSymbol[]): ScriptSymbol[] {
  const seen = new Set<string>();
  const out: ScriptSymbol[] = [];
  for (const child of children) {
    if (seen.has(child.uri)) continue;
    seen.add(child.uri);
    out.push(child);
  }
  return out;
}

function containerListing(child: ScriptSymbol): string {
  return `entry ${child.entryIndex ?? '?'}: ${child.entryName ?? child.childChain.join('/')} [${child.contentKind}]`;
}

function bounded(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[truncated ${text.length - maxChars} chars]`;
}


