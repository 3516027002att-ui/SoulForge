/**
 * EMEVD 参数角色、事件调用与参数传递 provider（T05）。
 *
 * 与旧内联循环的三点区别（执行指令 §T05）：
 * 1. 只有显式携带的角色（Bridge/registry 摄取时写入 `arg.role`，且
 *    `roleSource` 不为纯名称推断）才生成 confirmed/high 边；`inferArgRole`
 *    的名称推断进入 hypothesis 通道（R07）：默认不出边，`includeHypotheses`
 *    时以 low + 规则名出现，绝不冒充 confirmed。
 * 2. 事件调用目标按命名空间解析：同一 EMEVD 文件内的同号事件才是确定目标；
 *    只有其他文件命中同号时不生成默认确定连接，返回候选诊断（I04）。
 * 3. 每条 confirmed 引用携带真实 typed 参数渲染的调用语句；registry 可用时
 *    未知 bank:id 保留诊断，扫描结束不宣称语义完整（R08）。
 *
 * 调用链遍历（有界：默认深度 ≤4、256 节点、512 扩展边）由
 * {@link buildEventCallChain} 提供，供 ReferenceQueryService（T08）组装
 * indirect 路径；图构建本身只发布直接边。
 */
import type {
  Diagnostic,
  EventArg,
  EventExport,
  EventInstruction,
  EventSymbol,
  ReferenceConfidence,
  ReferenceEdge,
  ReferenceEvidence
} from '@soulforge/shared';
import type { EmedfRegistry } from '../emevd/emedfSchema.js';
import { findInstructionDef } from '../emevd/emedfSchema.js';
import { isCommonEmevdNamespace, matchEmevdRoleRule } from './emevdRoleRules.js';

export interface EventReferenceBuildOptions {
  enableNumericFallback?: boolean;
  maxAmbiguousNumericMatches?: number;
  /** Hypothesis (name-inference) edges are excluded unless this is true. */
  includeHypotheses?: boolean;
  /** Trusted instruction registry; enables unknown-instruction diagnostics. */
  registry?: EmedfRegistry;
}

export interface EventReferenceBuildResult {
  edges: ReferenceEdge[];
  diagnostics: Diagnostic[];
  stats: {
    confirmed: number;
    hypothesisSuppressed: number;
    unknownInstructions: number;
    crossFileEventIdCandidates: number;
    suppressedAmbiguousNumbers: number;
  };
}

export interface EventReferenceTargetIndexes {
  mapEntitiesByEntityId: Map<number, Array<{ uri: string; mapId?: string }>>;
  paramRowsById: Map<number, { uri: string }[]>;
  paramRowsByScopedId: Map<string, { uri: string }[]>;
  textsById: Map<number, { uri: string }[]>;
}

export const CALL_CHAIN_MAX_DEPTH = 4;
export const CALL_CHAIN_MAX_NODES = 256;
export const CALL_CHAIN_MAX_EXPANSION_EDGES = 512;

const MAX_EVENT_REF_DIAGNOSTICS = 500;
const NAME_INFERENCE_RULE = 'name-inference';

interface EventIndexes {
  byFileEventId: Map<string, Map<number, EventSymbol[]>>;
  eventsById: Map<number, EventSymbol[]>;
}

export function buildEventReferenceEdges(
  eventExports: readonly EventExport[],
  indexes: EventReferenceTargetIndexes,
  options: EventReferenceBuildOptions = {}
): EventReferenceBuildResult {
  const enableNumericFallback = options.enableNumericFallback ?? true;
  const maxAmbiguousNumericMatches = options.maxAmbiguousNumericMatches ?? 12;
  const edges: ReferenceEdge[] = [];
  const diagnostics: Diagnostic[] = [];
  const stats: EventReferenceBuildResult['stats'] = {
    confirmed: 0,
    hypothesisSuppressed: 0,
    unknownInstructions: 0,
    crossFileEventIdCandidates: 0,
    suppressedAmbiguousNumbers: 0
  };
  const eventIndexes = buildEventIndexes(eventExports);
  const pushDiagnostic = (diagnostic: Diagnostic): void => {
    if (diagnostics.length >= MAX_EVENT_REF_DIAGNOSTICS) return;
    diagnostics.push(diagnostic);
  };

  for (const eventExport of eventExports) {
    for (const event of eventExport.events) {
      for (const instruction of event.instructions) {
        let unknownLayout = false;
        if (options.registry && typeof instruction.bank === 'number' && typeof instruction.id === 'number') {
          if (!findInstructionDef(options.registry, instruction.bank, instruction.id)) {
            stats.unknownInstructions += 1;
            unknownLayout = true;
            pushDiagnostic({
              severity: 'warning',
              code: 'EMEVD_UNKNOWN_INSTRUCTION',
              message: `指令 bank=${instruction.bank} id=${instruction.id}（${instruction.name ?? '无名'}）不在受信任 registry 中；该位置的引用语义未解析，不能宣称扫描完整。`,
              sourceUri: event.sourceUri,
              details: {
                eventUri: event.uri,
                instructionIndex: instruction.index,
                bank: instruction.bank,
                id: instruction.id,
                byteRange: instruction.byteRange
              }
            });
            // Unknown layout: the gap is recorded, but the position is never
            // treated as "definitely no reference" (T05 step 4). Args that
            // carry their own trusted role metadata (roleSource !== 'inferred')
            // still emit edges; layout-dependent inference/rule matching is off.
          }
        }
        const statement = renderCallStatement(instruction);
        for (const arg of instruction.args) {
          const numeric = toInteger(arg.value);
          if (numeric === null) continue;
          if (unknownLayout && !(arg.role !== undefined && arg.role !== 'unknown' && arg.roleSource !== 'inferred')) {
            continue;
          }

          // Explicit rule-table role (T05 step 2): only when the registry
          // definition names this exact instruction/position/arg. Never a
          // name-substring heuristic.
          const ruleRole = options.registry
            && typeof instruction.bank === 'number'
            && typeof instruction.id === 'number'
            ? matchEmevdRoleRule(options.registry, instruction.bank, instruction.id, arg.argIndex ?? instruction.args.indexOf(arg))
            : undefined;

          // Confirmed requires an explicit role that did not come from pure
          // name inference. roleSource 'inferred' (or absent with a role that
          // the ingest path only ever sets from names) is a hypothesis.
          const trustedArgRole = arg.role !== undefined
            && arg.role !== 'unknown'
            && arg.roleSource !== 'inferred';
          const explicit = trustedArgRole || ruleRole !== undefined;
          const role = trustedArgRole
            ? arg.role!
            : ruleRole
              ? namespaceToRole(ruleRole.namespace)
              : inferArgRole(arg, instruction);
          if (role === 'unknown') {
            if (!enableNumericFallback) continue;
            const targetCount = (eventIndexes.eventsById.get(numeric)?.length ?? 0)
              + (indexes.mapEntitiesByEntityId.get(numeric)?.length ?? 0)
              + (indexes.paramRowsById.get(numeric)?.length ?? 0)
              + (indexes.textsById.get(numeric)?.length ?? 0);
            if (targetCount > maxAmbiguousNumericMatches) {
              stats.suppressedAmbiguousNumbers += 1;
              continue;
            }
            const fallbackTargets = collectFallbackTargets(numeric, indexes, eventIndexes);
            const evidence = makeInstructionEvidence(instruction, arg, statement);
            for (const target of fallbackTargets) {
              edges.push({
                fromUri: event.uri,
                toUri: target.uri,
                kind: target.kind,
                confidence: 'low',
                reason: target.reason,
                evidence: [evidence]
              });
            }
            continue;
          }

          // Do not materialize name-inferred fan-out merely to discard it
          // later. Native boolean/sentinel zero arguments can otherwise join
          // thousands of unrelated map objects and exhaust the process heap.
          if (!explicit && !options.includeHypotheses) {
            stats.hypothesisSuppressed += 1;
            continue;
          }
          if (!explicit) {
            const inferredCount = role === 'entityId' || role === 'regionId'
              ? indexes.mapEntitiesByEntityId.get(numeric)?.length ?? 0
              : role === 'paramId' ? indexes.paramRowsById.get(numeric)?.length ?? 0
              : role === 'textId' ? indexes.textsById.get(numeric)?.length ?? 0
              : role === 'eventId' ? eventIndexes.eventsById.get(numeric)?.length ?? 0 : 1;
            if (inferredCount > maxAmbiguousNumericMatches) {
              stats.suppressedAmbiguousNumbers += 1;
              continue;
            }
          }
          if (explicit) {
            const explicitCount = role === 'entityId' || role === 'regionId'
              ? indexes.mapEntitiesByEntityId.get(numeric)?.length ?? 0
              : role === 'paramId' ? (arg.paramName ? indexes.paramRowsByScopedId.get(paramKey(arg.paramName, numeric)) : indexes.paramRowsById.get(numeric))?.length ?? 0
              : role === 'textId' ? indexes.textsById.get(numeric)?.length ?? 0
              : role === 'eventId' ? eventIndexes.eventsById.get(numeric)?.length ?? 0 : 1;
            if (explicitCount > 256) {
              stats.suppressedAmbiguousNumbers += 1;
              pushDiagnostic({ severity: 'warning', code: 'EMEVD_REFERENCE_TARGET_LIMIT', sourceUri: event.sourceUri,
                message: `指令 ${instruction.index} 的 ${arg.name ?? role}=${numeric} 命中 ${explicitCount} 个目标，超过单参数 256 目标上限；该位置的关联列表不完整。` });
              continue;
            }
          }

          const confidence: ReferenceConfidence = explicit ? 'high' : 'low';
          const ruleName = explicit
            ? (trustedArgRole ? undefined : ruleRole?.ruleId)
            : NAME_INFERENCE_RULE;
          const evidence = makeInstructionEvidence(instruction, arg, statement);
          const outcome = emitRoleEdges(edges, event, role, numeric, arg, instruction, indexes, eventIndexes, confidence, ruleName, evidence, stats);
          if (outcome === 'cross-file') {
            stats.crossFileEventIdCandidates += 1;
            pushDiagnostic({
              severity: 'warning',
              code: 'EMEVD_EVENT_ID_CROSS_FILE',
              message: `事件 id ${numeric} 在 ${fileLabel(event.sourceUri)} 内不存在，仅其他文件命中同号；不生成跨文件默认确定连接。`,
              sourceUri: event.sourceUri,
              details: { eventUri: event.uri, eventId: numeric }
            });
          }
          if (!explicit && outcome === 'emitted' && !options.includeHypotheses) {
            // Hypotheses are withheld from the default graph but counted.
            stats.hypothesisSuppressed += 1;
          }
        }
      }
    }
  }

  // When hypotheses are suppressed we still need to drop the edges we pushed.
  // Rebuild: filter out low-confidence name-inference edges unless included.
  const finalEdges = options.includeHypotheses
    ? edges
    : edges.filter((edge) => !(edge.confidence === 'low' && edge.reason.includes(`hypothesis(${NAME_INFERENCE_RULE})`)));

  if (diagnostics.length >= MAX_EVENT_REF_DIAGNOSTICS) {
    diagnostics.push({
      severity: 'warning',
      code: 'EMEVD_REF_DIAGNOSTICS_TRUNCATED',
      message: `EMEVD 引用诊断达到 ${MAX_EVENT_REF_DIAGNOSTICS} 条上限，后续缺口未列出。`
    });
  }

  return { edges: finalEdges, diagnostics, stats };
}

type EmitOutcome = 'emitted' | 'none' | 'cross-file';

function emitRoleEdges(
  edges: ReferenceEdge[],
  event: EventSymbol,
  role: NonNullable<EventArg['role']>,
  numeric: number,
  arg: EventArg,
  instruction: EventInstruction,
  indexes: EventReferenceTargetIndexes,
  eventIndexes: EventIndexes,
  confidence: ReferenceConfidence,
  ruleName: string | undefined,
  evidence: ReferenceEvidence,
  stats: EventReferenceBuildResult['stats']
): EmitOutcome {
  // Rule-table edges carry a ruleId but are still confirmed; only name
  // inference is a hypothesis. Key the label off confidence, not ruleName.
  const prefix = confidence === 'high'
    ? (ruleName ? `rule(${ruleName}): ` : 'registry-confirmed: ')
    : `hypothesis(${ruleName ?? NAME_INFERENCE_RULE}): `;
  let emitted = false;
  switch (role) {
    case 'eventId': {
      const resolution = resolveEventTarget(event, numeric, eventIndexes);
      if (resolution.kind === 'same-file') {
        for (const target of resolution.targets) {
          if (target.uri === event.uri) continue;
          pushEdge(edges, event.uri, target.uri, 'calls_event', confidence,
            `${prefix}event id ${numeric} resolved inside ${fileLabel(event.sourceUri)}.`, evidence, stats, confidence === 'high');
          emitted = true;
        }
        return emitted ? 'emitted' : 'none';
      }
      return resolution.kind === 'cross-file' ? 'cross-file' : 'none';
    }
    case 'entityId':
    case 'regionId': {
      const kind = role === 'entityId' ? 'references_map_entity' : 'references_region';
      const targets = indexes.mapEntitiesByEntityId.get(numeric);
      if (!targets?.length) return 'none';
      const sameMap = event.mapId ? targets.filter((t) => t.mapId === event.mapId) : targets;
      const finalTargets = sameMap.length > 0 ? sameMap : targets;
      const effectiveConfidence: ReferenceConfidence = sameMap.length > 0 || !event.mapId ? confidence : 'medium';
      for (const target of finalTargets) {
        pushEdge(edges, event.uri, target.uri, kind, effectiveConfidence,
          `${prefix}${role} ${numeric} matches ${target.mapId ?? 'unknown map'}.`, evidence, stats, confidence === 'high');
        emitted = true;
      }
      return emitted ? 'emitted' : 'none';
    }
    case 'paramId': {
      const targets = arg.paramName
        ? indexes.paramRowsByScopedId.get(paramKey(arg.paramName, numeric))
        : indexes.paramRowsById.get(numeric);
      if (!targets?.length) return 'none';
      const effectiveConfidence: ReferenceConfidence = arg.paramName ? confidence : 'medium';
      for (const target of targets) {
        pushEdge(edges, event.uri, target.uri, 'references_param_row', effectiveConfidence,
          arg.paramName
            ? `${prefix}paramId ${numeric} in ${arg.paramName}.`
            : `${prefix}paramId ${numeric} without table scope.`, evidence, stats, confidence === 'high');
        emitted = true;
      }
      return emitted ? 'emitted' : 'none';
    }
    case 'textId': {
      const targets = indexes.textsById.get(numeric);
      if (!targets?.length) return 'none';
      for (const target of targets) {
        pushEdge(edges, event.uri, target.uri, 'references_text', confidence,
          `${prefix}text id ${numeric}.`, evidence, stats, confidence === 'high');
        emitted = true;
      }
      return emitted ? 'emitted' : 'none';
    }
    case 'flag': {
      pushEdge(edges, event.uri, `flag://${numeric}`, classifyFlagInstruction(instruction), confidence,
        `${prefix}event flag ${numeric}.`, evidence, stats, confidence === 'high');
      return 'emitted';
    }
    default:
      return 'none';
  }
}

/* ------------------------------------------------------------------ */
/* Bounded call-chain traversal (T08 consumes this for indirect paths) */
/* ------------------------------------------------------------------ */

export interface CallChainHop {
  fromEventUri: string;
  toEventUri: string;
  instructionUri: string;
  /** True when the target id came through a parameter binding (X<n>_<m>). */
  indirect: boolean;
  /** Parameter symbol the argument resolved through, when indirect. */
  parameterSymbol?: string;
  /** Byte offset in the parameter source block, parsed from X<offset>_<width>. */
  sourceStartByte?: number;
  /** Byte width of the bound slot; never dropped (T05 step 6). */
  byteCount?: number;
  /**
   * Native parameter record identity when the event's parameter table matched
   * this slot. Absent means the binding is unresolved — the hop stays visible
   * but is never presented as a complete proof (T05 step 7).
   */
  parameterInstructionIndex?: number;
  parameterTargetStartByte?: number;
}

export interface CallChainResult {
  rootUri: string;
  paths: CallChainHop[][];
  truncated: boolean;
  truncationReason?: string;
  cycles: string[];
}

/**
 * Bounded event-call chain from one root event. Depth counts edges (default
 * 3, max 4); node and expansion-edge budgets prevent blowup on dense graphs.
 * Reaching a limit returns the truncation explicitly — never a claim that the
 * traversal was complete (R11).
 */
export function buildEventCallChain(
  eventExports: readonly EventExport[],
  rootUri: string,
  options: {
    maxDepth?: number;
    maxNodes?: number;
    maxExpansionEdges?: number;
    registry?: EmedfRegistry;
  } = {}
): CallChainResult {
  const maxDepth = Math.min(CALL_CHAIN_MAX_DEPTH, Math.max(1, options.maxDepth ?? 3));
  const maxNodes = options.maxNodes ?? CALL_CHAIN_MAX_NODES;
  const maxExpansionEdges = options.maxExpansionEdges ?? CALL_CHAIN_MAX_EXPANSION_EDGES;
  const indexes = buildEventIndexes(eventExports);
  const byUri = new Map<string, EventSymbol>();
  for (const eventExport of eventExports) {
    for (const event of eventExport.events) byUri.set(event.uri, event);
  }
  const root = byUri.get(rootUri);
  const paths: CallChainHop[][] = [];
  const cycles: string[] = [];
  if (!root) return { rootUri, paths, truncated: false, cycles };

  let visitedNodes = 0;
  let expansionEdges = 0;
  let truncated = false;
  let truncationReason: string | undefined;

  const walk = (event: EventSymbol, path: CallChainHop[], ancestorUris: Set<string>): void => {
    const calls = collectEventCalls(event, indexes, options.registry);
    if (path.length >= maxDepth) {
      truncated = true;
      truncationReason = truncationReason ?? `深度达到上限 ${maxDepth}，更深的调用未展开。`;
      if (path.length > 0) paths.push(path);
      return;
    }
    let extended = false;
    for (const call of calls) {
      if (expansionEdges >= maxExpansionEdges) {
        truncated = true;
        truncationReason = truncationReason ?? `调用链扩展边达到上限 ${maxExpansionEdges}。`;
        if (path.length > 0) paths.push(path);
        return;
      }
      expansionEdges += 1;
      extended = true;
      if (call.hop.indirect) {
        // Dynamic formal-parameter binding: the concrete target depends on the
        // call site; record the hop but do not recurse into an unresolved id.
        paths.push([...path, call.hop]);
        continue;
      }
      if (ancestorUris.has(call.target.uri)) {
        cycles.push(`${event.uri} -> ${call.target.uri}`);
        paths.push([...path, call.hop]);
        continue;
      }
      if (visitedNodes >= maxNodes) {
        truncated = true;
        truncationReason = truncationReason ?? `调用链节点达到上限 ${maxNodes}。`;
        if (path.length > 0) paths.push(path);
        return;
      }
      visitedNodes += 1;
      walk(call.target, [...path, call.hop], new Set([...ancestorUris, call.target.uri]));
    }
    if (!extended && path.length > 0) paths.push(path);
  };

  walk(root, [], new Set([rootUri]));
  return { rootUri, paths, truncated, ...(truncationReason ? { truncationReason } : {}), cycles };
}

interface EventCall {
  target: EventSymbol;
  hop: CallChainHop;
}

function collectEventCalls(
  event: EventSymbol,
  indexes: EventIndexes,
  registry?: EmedfRegistry
): EventCall[] {
  const calls: EventCall[] = [];
  const nativeParameters = readNativeParameters(event);
  for (const instruction of event.instructions) {
    for (const [position, arg] of instruction.args.entries()) {
      const trusted = arg.role === 'eventId' && arg.roleSource !== 'inferred';
      const rule = !trusted && registry
        && typeof instruction.bank === 'number' && typeof instruction.id === 'number'
        ? matchEmevdRoleRule(registry, instruction.bank, instruction.id, arg.argIndex ?? position)
        : undefined;
      const viaRule = rule !== undefined && rule.namespace === 'event';
      if (!trusted && !viaRule) continue;
      const parameterSymbol = typeof arg.value === 'string' && /^X(\d+)_(\d+)$/u.test(arg.value.trim())
        ? arg.value.trim()
        : undefined;
      const numeric = parameterSymbol ? null : toInteger(arg.value);
      if (numeric === null && parameterSymbol === undefined) continue;
      if (parameterSymbol !== undefined) {
        // Real parameter binding (T05 step 6): parse BOTH offset and width,
        // then match against the native parameters table by
        // (sourceStartByte, byteCount). Never collapse X0_4 to "integer 0".
        const match = /^X(\d+)_(\d+)$/u.exec(parameterSymbol)!;
        const sourceStartByte = Number(match[1]);
        const byteCount = Number(match[2]);
        const bound = nativeParameters.find((p) =>
          p.sourceStartByte === sourceStartByte && p.byteCount === byteCount
        );
        calls.push({
          target: event,
          hop: {
            fromEventUri: event.uri,
            toEventUri: event.uri,
            instructionUri: instruction.uri,
            indirect: true,
            parameterSymbol,
            sourceStartByte,
            byteCount,
            ...(bound
              ? { parameterInstructionIndex: bound.instructionIndex, parameterTargetStartByte: bound.targetStartByte }
              : {})
          }
        });
        continue;
      }
      const resolution = resolveEventTarget(event, numeric!, indexes);
      if (resolution.kind !== 'same-file') continue;
      for (const target of resolution.targets) {
        if (target.uri === event.uri) continue;
        calls.push({
          target,
          hop: {
            fromEventUri: event.uri,
            toEventUri: target.uri,
            instructionUri: instruction.uri,
            indirect: false
          }
        });
      }
    }
  }
  return calls;
}

interface NativeParameterRecord {
  instructionIndex: number;
  targetStartByte: number;
  sourceStartByte: number;
  byteCount: number;
}

/**
 * The native semantic export keeps the event's `parameters` table on `raw`
 * (see nativeSemanticRefresh). Anything malformed is dropped — an absent
 * table means unresolved bindings, never an empty-but-complete claim.
 */
function readNativeParameters(event: EventSymbol): NativeParameterRecord[] {
  const raw = event.raw;
  if (typeof raw !== 'object' || raw === null) return [];
  const list = (raw as { parameters?: unknown }).parameters;
  if (!Array.isArray(list)) return [];
  const out: NativeParameterRecord[] = [];
  for (const value of list) {
    if (typeof value !== 'object' || value === null) continue;
    const record = value as Record<string, unknown>;
    const { instructionIndex, targetStartByte, sourceStartByte, byteCount } = record;
    if ([instructionIndex, targetStartByte, sourceStartByte, byteCount].every(
      (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
    )) {
      out.push({
        instructionIndex: instructionIndex as number,
        targetStartByte: targetStartByte as number,
        sourceStartByte: sourceStartByte as number,
        byteCount: byteCount as number
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function buildEventIndexes(eventExports: readonly EventExport[]): EventIndexes {
  const byFileEventId = new Map<string, Map<number, EventSymbol[]>>();
  const eventsById = new Map<number, EventSymbol[]>();
  for (const eventExport of eventExports) {
    for (const event of eventExport.events) {
      const fileKey = event.sourceUri;
      let perFile = byFileEventId.get(fileKey);
      if (!perFile) {
        perFile = new Map();
        byFileEventId.set(fileKey, perFile);
      }
      const list = perFile.get(event.eventId);
      if (list) list.push(event);
      else perFile.set(event.eventId, [event]);
      const global = eventsById.get(event.eventId);
      if (global) global.push(event);
      else eventsById.set(event.eventId, [event]);
    }
  }
  return { byFileEventId, eventsById };
}

function namespaceToRole(namespace: 'event' | 'event-common' | 'flag' | 'param' | 'map-entity' | 'map-region' | 'text'): NonNullable<EventArg['role']> {
  switch (namespace) {
    case 'event':
    case 'event-common':
      return 'eventId';
    case 'flag': return 'flag';
    case 'param': return 'paramId';
    case 'map-entity': return 'entityId';
    case 'map-region': return 'regionId';
    case 'text': return 'textId';
  }
}

type EventTargetResolution =
  | { kind: 'same-file'; targets: EventSymbol[] }
  | { kind: 'cross-file'; targets: EventSymbol[] }
  | { kind: 'none' };

/**
 * Event-id resolution (T05 step 5): the calling file's own events are the
 * confirmed namespace. Failing that, the Sekiro global namespaces —
 * common.emevd and commonfunc.emevd — are the existing supported fallback
 * targets. Any other cross-file same-id hit stays a candidate diagnostic.
 */
function resolveEventTarget(event: EventSymbol, eventId: number, indexes: EventIndexes): EventTargetResolution {
  const sameFile = indexes.byFileEventId.get(event.sourceUri)?.get(eventId);
  if (sameFile?.length) return { kind: 'same-file', targets: sameFile };
  const all = indexes.eventsById.get(eventId) ?? [];
  if (all.length === 0) return { kind: 'none' };
  const commonTargets = all.filter((target) => isCommonEmevdNamespace(target.sourceUri));
  if (commonTargets.length > 0) return { kind: 'same-file', targets: commonTargets };
  return { kind: 'cross-file', targets: all };
}

/**
 * Render the real typed call statement from decoded args: names, order and
 * values come from the native decode, never rewritten.
 */
function renderCallStatement(instruction: EventInstruction): string {
  const args = instruction.args.map((arg, position) => {
    const label = arg.name ?? `arg${arg.argIndex ?? position}`;
    return `${label}=${String(arg.value)}`;
  });
  return `${instruction.name ?? 'instruction'}#${instruction.index}(${args.join(', ')})`;
}

function makeInstructionEvidence(instruction: EventInstruction, arg: EventArg, statement: string): ReferenceEvidence {
  return {
    sourceUri: instruction.uri,
    instructionUri: instruction.uri,
    ...(arg.name ? { fieldName: arg.name } : {}),
    value: arg.value,
    excerpt: statement
  };
}

function pushEdge(
  edges: ReferenceEdge[],
  fromUri: string,
  toUri: string,
  kind: ReferenceEdge['kind'],
  confidence: ReferenceConfidence,
  reason: string,
  evidence: ReferenceEvidence,
  stats: EventReferenceBuildResult['stats'],
  confirmed: boolean
): void {
  edges.push({ fromUri, toUri, kind, confidence, reason, evidence: [evidence] });
  if (confirmed) stats.confirmed += 1;
}

function collectFallbackTargets(
  numeric: number,
  indexes: EventReferenceTargetIndexes,
  eventIndexes: EventIndexes
): Array<{ uri: string; kind: ReferenceEdge['kind']; reason: string }> {
  const targets: Array<{ uri: string; kind: ReferenceEdge['kind']; reason: string }> = [];
  for (const target of eventIndexes.eventsById.get(numeric) ?? []) {
    targets.push({ uri: target.uri, kind: 'calls_event', reason: `Numeric fallback: value ${numeric} matches an event id.` });
  }
  for (const target of indexes.mapEntitiesByEntityId.get(numeric) ?? []) {
    targets.push({ uri: target.uri, kind: 'numeric_match', reason: `Numeric fallback: value ${numeric} matches a map entity or region id.` });
  }
  for (const target of indexes.paramRowsById.get(numeric) ?? []) {
    targets.push({ uri: target.uri, kind: 'numeric_match', reason: `Numeric fallback: value ${numeric} matches a param row id.` });
  }
  for (const target of indexes.textsById.get(numeric) ?? []) {
    targets.push({ uri: target.uri, kind: 'numeric_match', reason: `Numeric fallback: value ${numeric} matches a text id.` });
  }
  return targets;
}

function inferArgRole(arg: EventArg, instruction: EventInstruction): NonNullable<EventArg['role']> {
  const argName = (arg.name ?? '').toLowerCase();
  const instructionName = (instruction.name ?? '').toLowerCase();

  if (argName.includes('flag') || instructionName.includes('flag')) return 'flag';
  if (argName.includes('event')) return 'eventId';
  if (argName.includes('entity') || argName.includes('chr') || argName.includes('character')) return 'entityId';
  if (argName.includes('region') || instructionName.includes('region')) return 'regionId';
  if (argName.includes('text') || argName.includes('msg')) return 'textId';
  if (argName.includes('speffect') || argName.includes('param') || argName.includes('row')) return 'paramId';

  if (instructionName.includes('event') && instructionName.includes('initialize')) return 'eventId';
  if (instructionName.includes('character') || instructionName.includes('asset') || instructionName.includes('object')) return 'entityId';
  if (instructionName.includes('message') || instructionName.includes('dialog')) return 'textId';

  return 'unknown';
}

function classifyFlagInstruction(instruction: EventInstruction): 'reads_flag' | 'writes_flag' {
  const name = (instruction.name ?? '').toLowerCase();
  if (name.includes('set') || name.includes('enable') || name.includes('disable') || name.includes('clear')) return 'writes_flag';
  return 'reads_flag';
}

function paramKey(paramName: string, rowId: number): string {
  return `${paramName.toLowerCase()}#${rowId}`;
}

function toInteger(value: string | number | boolean): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function fileLabel(sourceUri: string): string {
  const trimmed = sourceUri.replace(/\\/g, '/');
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}


