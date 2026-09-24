/**
 * 有界 EMEVD 公共事件参数求值器。
 *
 * 这不是第二套 native parser：事件、指令原始字节和参数绑定均来自
 * C# Bridge 的 EventExport；本模块只在已有 bytes + EMEDF 定义上做精确的
 * 字节复制。任何没有原始字节、越界、歧义或版本失效都显式关闭，不填零。
 */
import { Buffer } from 'node:buffer';
import type { EventExport, EventInstruction, EventSymbol } from '@soulforge/shared';
import { decodeInstructionArgs, findInstructionDef, type DecodedArg, type EmedfRegistry } from '../emevd/emedfSchema.js';
import { isCommonEmevdNamespace, matchEmevdRoleRule } from './emevdRoleRules.js';

export type EmevdParameterEvaluationStatus =
  | 'resolved'
  | 'unbound'
  | 'ambiguous'
  | 'unsupported'
  | 'stale'
  | 'insufficient_evidence';

export interface EmevdParameterTrace {
  caller: string;
  callee: string;
  parameterEnvironment: Record<string, string>;
  targetInstruction: {
    uri: string;
    index: number;
    bank?: number;
    id?: number;
  };
  decodedArguments: Array<{ name: string; type: string; value: number | boolean; startByte?: number; byteCount?: number }>;
  status: EmevdParameterEvaluationStatus;
  diagnostics: string[];
}

export interface EmevdParameterEvaluationResult {
  status: EmevdParameterEvaluationStatus;
  rootUri: string;
  traces: EmevdParameterTrace[];
  cycles: string[];
  unresolved: Array<{
    caller: string;
    instructionUri: string;
    status: Exclude<EmevdParameterEvaluationStatus, 'resolved'>;
    reason: string;
  }>;
  nodesVisited: number;
  edgesExpanded: number;
  truncated: boolean;
  sourceVersions: Array<{ sourceUri: string; sourceHash?: string; sourceRevision?: number }>;
  diagnostics: string[];
}

export interface EvaluateEmevdParameterOptions {
  eventExports: readonly EventExport[];
  rootUri: string;
  registry: EmedfRegistry;
  /** Native event parameter blocks, keyed by exact EventSymbol URI. */
  parameterBytesByEventUri?: Readonly<Record<string, string>>;
  /** Optional expected source hashes; mismatch is stale, never best effort. */
  expectedSourceHashes?: Readonly<Record<string, string>>;
  maxDepth?: number;
  maxNodes?: number;
  maxExpansionEdges?: number;
}

interface ParameterEnvironment {
  values: Map<number, Buffer>;
}

interface EventCallCandidate {
  instruction: EventInstruction;
  argIndex: number;
  targetValue: number | string | boolean;
  instructionBytes: Buffer;
  targetArg: DecodedArg;
  targetName: string;
}

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_NODES = 256;
const DEFAULT_MAX_EDGES = 512;

export function evaluateEmevdParameters(options: EvaluateEmevdParameterOptions): EmevdParameterEvaluationResult {
  const eventsByUri = new Map<string, EventSymbol>();
  for (const exportItem of options.eventExports) for (const event of exportItem.events) eventsByUri.set(event.uri, event);
  const root = eventsByUri.get(options.rootUri);
  const maxDepth = Math.min(DEFAULT_MAX_DEPTH, Math.max(1, options.maxDepth ?? DEFAULT_MAX_DEPTH));
  const maxNodes = Math.max(1, Math.min(2048, options.maxNodes ?? DEFAULT_MAX_NODES));
  const maxEdges = Math.max(1, Math.min(4096, options.maxExpansionEdges ?? DEFAULT_MAX_EDGES));
  const result: EmevdParameterEvaluationResult = {
    status: 'resolved',
    rootUri: options.rootUri,
    traces: [],
    cycles: [],
    unresolved: [],
    nodesVisited: 0,
    edgesExpanded: 0,
    truncated: false,
    sourceVersions: collectSourceVersions(options.eventExports),
    diagnostics: []
  };
  if (!root) {
    result.status = 'insufficient_evidence';
    result.diagnostics.push(`找不到根事件 ${options.rootUri}。`);
    return result;
  }
  const stale = checkStaleVersions(options.eventExports, options.expectedSourceHashes);
  if (stale.length > 0) {
    result.status = 'stale';
    result.diagnostics.push(...stale);
    return result;
  }

  const visit = (event: EventSymbol, environment: ParameterEnvironment, depth: number, ancestors: Set<string>): void => {
    if (result.nodesVisited >= maxNodes) {
      result.truncated = true;
      result.status = mergeStatus(result.status, 'insufficient_evidence');
      result.diagnostics.push(`节点预算 ${maxNodes} 已耗尽。`);
      return;
    }
    if (depth > maxDepth) {
      result.truncated = true;
      result.status = mergeStatus(result.status, 'insufficient_evidence');
      result.diagnostics.push(`公共事件求值深度超过 ${maxDepth}。`);
      return;
    }
    result.nodesVisited += 1;
    const calls = collectCalls(event, environment, options.registry, options.parameterBytesByEventUri, result);
    for (const call of calls) {
      if (result.edgesExpanded >= maxEdges) {
        result.truncated = true;
        result.status = mergeStatus(result.status, 'insufficient_evidence');
        result.diagnostics.push(`调用边预算 ${maxEdges} 已耗尽。`);
        return;
      }
      result.edgesExpanded += 1;
      const target = resolveTarget(event, call.targetName, toInteger(call.targetValue), eventsByUri);
      if (target.status !== 'resolved' || !target.event) {
        result.unresolved.push({ caller: event.uri, instructionUri: call.instruction.uri, status: target.status as Exclude<EmevdParameterEvaluationStatus, 'resolved'>, reason: target.reason });
        result.status = mergeStatus(result.status, target.status);
        continue;
      }
      const callee = target.event;
      if (ancestors.has(callee.uri)) {
        const cycle = `${event.uri} -> ${callee.uri}`;
        result.cycles.push(cycle);
        result.unresolved.push({ caller: event.uri, instructionUri: call.instruction.uri, status: 'unsupported', reason: `检测到循环调用：${cycle}` });
        result.status = mergeStatus(result.status, 'unsupported');
        continue;
      }
      const nextEnvironment = bindCallArguments(event, call, callee, options.parameterBytesByEventUri, result);
      const targetInstruction = firstBoundInstruction(callee, nextEnvironment, options.registry, options.parameterBytesByEventUri, result);
      const traceStatus = targetInstruction.status;
      result.traces.push({
        caller: event.uri,
        callee: callee.uri,
        parameterEnvironment: Object.fromEntries([...nextEnvironment.values.entries()].map(([offset, bytes]) => [String(offset), bytes.toString('hex')])),
        targetInstruction: targetInstruction.instruction
          ? { uri: targetInstruction.instruction.uri, index: targetInstruction.instruction.index, ...(targetInstruction.instruction.bank === undefined ? {} : { bank: targetInstruction.instruction.bank }), ...(targetInstruction.instruction.id === undefined ? {} : { id: targetInstruction.instruction.id }) }
          : { uri: `${callee.uri}#instruction/?`, index: -1 },
        decodedArguments: targetInstruction.decoded,
        status: traceStatus,
        diagnostics: targetInstruction.diagnostics
      });
      if (traceStatus !== 'resolved') {
        result.status = mergeStatus(result.status, traceStatus);
        result.unresolved.push({ caller: event.uri, instructionUri: call.instruction.uri, status: traceStatus as Exclude<EmevdParameterEvaluationStatus, 'resolved'>, reason: targetInstruction.diagnostics.join('; ') || '目标指令未能求值。' });
      }
      visit(callee, nextEnvironment, depth + 1, new Set([...ancestors, callee.uri]));
    }
  };
  visit(root, { values: new Map() }, 0, new Set([root.uri]));
  if (result.status === 'resolved' && result.unresolved.length > 0) result.status = 'insufficient_evidence';
  return result;
}

function collectCalls(
  event: EventSymbol,
  environment: ParameterEnvironment,
  registry: EmedfRegistry,
  parameterBytesByEventUri: Readonly<Record<string, string>> | undefined,
  result: EmevdParameterEvaluationResult
): EventCallCandidate[] {
  const calls: EventCallCandidate[] = [];
  for (const instruction of event.instructions) {
    if (instruction.bank === undefined || instruction.id === undefined) continue;
    const def = findInstructionDef(registry, instruction.bank, instruction.id);
    if (!def) continue;
    const decoded = materializeInstruction(event, instruction, environment, parameterBytesByEventUri);
    if (decoded.status !== 'resolved' || !decoded.bytes) {
      if (instruction.name?.startsWith('Initialize')) {
        result.unresolved.push({ caller: event.uri, instructionUri: instruction.uri, status: decoded.status as Exclude<EmevdParameterEvaluationStatus, 'resolved'>, reason: decoded.reason });
        result.status = mergeStatus(result.status, decoded.status);
      }
      continue;
    }
    const decodedArgs = decodeInstructionArgs(registry, instruction.bank, instruction.id, decoded.bytes);
    if (!decodedArgs.ok) continue;
    for (let argIndex = 0; argIndex < decodedArgs.args.length; argIndex += 1) {
      const rule = matchEmevdRoleRule(registry, instruction.bank, instruction.id, argIndex);
      const arg = decodedArgs.args[argIndex];
      if (!arg || !rule || rule.namespace !== 'event') continue;
      // Common-event and normal-event target positions are fixed by the rule;
      // the registry may expose a vararg tail, so only the target is followed.
      const targetValue = arg.value;
      calls.push({ instruction, argIndex, targetValue, instructionBytes: decoded.bytes, targetArg: arg, targetName: def.name });
    }
  }
  return calls;
}

function bindCallArguments(
  caller: EventSymbol,
  call: EventCallCandidate,
  callee: EventSymbol,
  parameterBytesByEventUri: Readonly<Record<string, string>> | undefined,
  result: EmevdParameterEvaluationResult
): ParameterEnvironment {
  const values = new Map<number, Buffer>();
  const bytes = call.instructionBytes;
  const start = (call.targetArg.startByte ?? 0) + (call.targetArg.byteCount ?? 4);
  const calleeParameters = readParameters(callee);
  for (const parameter of calleeParameters) {
    if (parameter.sourceStartByte + parameter.byteCount > bytes.length - start) {
      result.diagnostics.push(`调用 ${call.instruction.uri} 传入参数越界：source=${parameter.sourceStartByte} width=${parameter.byteCount}。`);
      continue;
    }
    values.set(parameter.sourceStartByte, Buffer.from(bytes.subarray(start + parameter.sourceStartByte, start + parameter.sourceStartByte + parameter.byteCount)));
  }
  // A callee with a parameter table but no materialized environment is not
  // allowed to silently receive zeroes. Keep the caller in the trace as an
  // unbound observation; the empty environment is still useful for literal
  // instructions that do not consume a formal parameter.
  if (calleeParameters.length > 0 && values.size === 0 && !parameterBytesByEventUri?.[caller.uri]) {
    result.diagnostics.push(`调用 ${call.instruction.uri} 没有可验证的公共事件实参环境。`);
  }
  return { values };
}

function firstBoundInstruction(
  event: EventSymbol,
  environment: ParameterEnvironment,
  registry: EmedfRegistry,
  parameterBytesByEventUri: Readonly<Record<string, string>> | undefined,
  result: EmevdParameterEvaluationResult
): { status: EmevdParameterEvaluationStatus; instruction?: EventInstruction; decoded: Array<{ name: string; type: string; value: number | boolean; startByte?: number; byteCount?: number }>; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const parameters = readParameters(event);
  const parameterized = event.instructions.filter((instruction) => parameters.some((item) => item.instructionIndex === instruction.index));
  const candidates = parameterized.length > 0 ? parameterized : event.instructions;
  for (const instruction of candidates) {
    if (instruction.bank === undefined || instruction.id === undefined) continue;
    const materialized = materializeInstruction(event, instruction, environment, parameterBytesByEventUri);
    if (materialized.status !== 'resolved' || !materialized.bytes) {
      if (parameters.some((item) => item.instructionIndex === instruction.index)) {
        diagnostics.push(materialized.reason);
        return { status: materialized.status, instruction, decoded: [], diagnostics };
      }
      continue;
    }
    const decoded = decodeInstructionArgs(registry, instruction.bank, instruction.id, materialized.bytes);
    if (!decoded.ok) {
      diagnostics.push(decoded.message);
      return { status: 'unsupported', instruction, decoded: [], diagnostics };
    }
    return { status: 'resolved', instruction, decoded: decoded.args.map((arg) => ({ name: arg.name, type: arg.type, value: arg.value, ...(arg.startByte === undefined ? {} : { startByte: arg.startByte }), ...(arg.byteCount === undefined ? {} : { byteCount: arg.byteCount }) })), diagnostics };
  }
  return { status: 'insufficient_evidence', decoded: [], diagnostics: ['公共事件没有可解码的目标指令。'] };
}

function materializeInstruction(
  event: EventSymbol,
  instruction: EventInstruction,
  environment: ParameterEnvironment,
  parameterBytesByEventUri: Readonly<Record<string, string>> | undefined
): { status: EmevdParameterEvaluationStatus; bytes?: Buffer; reason: string } {
  const raw = instruction.raw && typeof instruction.raw === 'object' && !Array.isArray(instruction.raw)
    ? instruction.raw as Record<string, unknown> : {};
  const encoded = typeof raw.argsBase64 === 'string' ? raw.argsBase64 : undefined;
  if (encoded === undefined) return { status: 'insufficient_evidence', reason: `指令 ${instruction.uri} 没有 native argsBase64。` };
  let bytes: Buffer;
  try { bytes = Buffer.from(encoded, 'base64'); } catch { return { status: 'unsupported', reason: `指令 ${instruction.uri} 的 argsBase64 无效。` }; }
  for (const parameter of readParameters(event).filter((item) => item.instructionIndex === instruction.index)) {
    const source = environment.values.get(parameter.sourceStartByte)
      ?? readParameterBytes(event.uri, parameter.sourceStartByte, parameter.byteCount, parameterBytesByEventUri);
    if (!source || source.length < parameter.byteCount) {
      return { status: 'unbound', reason: `指令 ${instruction.uri} 的 X${parameter.sourceStartByte}_${parameter.byteCount} 没有可验证源字节。` };
    }
    if (parameter.targetStartByte + parameter.byteCount > bytes.length) {
      return { status: 'unsupported', reason: `指令 ${instruction.uri} 的 parameter targetStartByte 越界。` };
    }
    source.copy(bytes, parameter.targetStartByte, 0, parameter.byteCount);
  }
  return { status: 'resolved', bytes, reason: 'resolved' };
}

function resolveTarget(
  caller: EventSymbol,
  instructionName: string,
  targetId: number | null,
  events: Map<string, EventSymbol>
): { status: EmevdParameterEvaluationStatus; event?: EventSymbol; reason: string } {
  if (targetId === null) return { status: 'unbound', reason: '事件目标是动态参数，当前实例没有可验证的数值。' };
  const candidates = [...events.values()].filter((event) => event.eventId === targetId && (
    instructionName === 'InitializeCommonEvent' ? isCommonEmevdNamespace(event.sourceUri) : event.sourceUri === caller.sourceUri
  ));
  if (candidates.length === 1) return { status: 'resolved', event: candidates[0]!, reason: 'resolved' };
  if (candidates.length > 1) return { status: 'ambiguous', reason: `事件 ${targetId} 在目标命名空间中命中 ${candidates.length} 个候选。` };
  return { status: 'insufficient_evidence', reason: `事件 ${targetId} 在 ${instructionName} 的目标命名空间中不存在。` };
}

function readParameterBytes(
  eventUri: string,
  sourceStartByte: number,
  byteCount: number,
  parameterBytesByEventUri: Readonly<Record<string, string>> | undefined
): Buffer | undefined {
  const raw = parameterBytesByEventUri?.[eventUri];
  if (typeof raw !== 'string') return undefined;
  let bytes: Buffer;
  try { bytes = Buffer.from(raw, 'base64'); } catch { return undefined; }
  if (sourceStartByte < 0 || byteCount < 1 || sourceStartByte + byteCount > bytes.length) return undefined;
  return Buffer.from(bytes.subarray(sourceStartByte, sourceStartByte + byteCount));
}

function readParameters(event: EventSymbol): Array<{ instructionIndex: number; targetStartByte: number; sourceStartByte: number; byteCount: number }> {
  const raw = event.raw && typeof event.raw === 'object' && !Array.isArray(event.raw) ? event.raw as Record<string, unknown> : {};
  return Array.isArray(raw.parameters) ? raw.parameters.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const values = ['instructionIndex', 'targetStartByte', 'sourceStartByte', 'byteCount'].map((key) => row[key]);
    if (!values.every((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) return [];
    return [{ instructionIndex: values[0] as number, targetStartByte: values[1] as number, sourceStartByte: values[2] as number, byteCount: values[3] as number }];
  }) : [];
}

function byUri(exports: readonly EventExport[]): Map<string, EventSymbol> {
  const result = new Map<string, EventSymbol>();
  for (const item of exports) for (const event of item.events) result.set(event.uri, event);
  return result;
}

function toInteger(value: number | string | boolean): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/u.test(value.trim())) return Number(value);
  return null;
}

function collectSourceVersions(exports: readonly EventExport[]): EmevdParameterEvaluationResult['sourceVersions'] {
  return exports.flatMap((item) => item.events.slice(0, 2048).map((event) => ({
    sourceUri: event.sourceUri,
    ...(event.sourceHash ? { sourceHash: event.sourceHash } : {}),
    ...(event.sourceRevision === undefined ? {} : { sourceRevision: event.sourceRevision })
  }))).filter((value, index, values) => values.findIndex((item) => item.sourceUri === value.sourceUri) === index);
}

function checkStaleVersions(exports: readonly EventExport[], expected: Readonly<Record<string, string>> | undefined): string[] {
  if (!expected) return [];
  const current = new Map<string, string>();
  for (const item of exports) for (const event of item.events) if (event.sourceHash) current.set(event.sourceUri, event.sourceHash);
  return Object.entries(expected).flatMap(([sourceUri, hash]) => current.get(sourceUri) !== hash
    ? [`来源 ${sourceUri} 已变化或缺少 sourceHash，公共事件求值失效。`]
    : []);
}

function mergeStatus(current: EmevdParameterEvaluationStatus, next: EmevdParameterEvaluationStatus): EmevdParameterEvaluationStatus {
  const rank: Record<EmevdParameterEvaluationStatus, number> = {
    resolved: 0,
    insufficient_evidence: 1,
    unbound: 2,
    ambiguous: 3,
    unsupported: 4,
    stale: 5
  };
  return rank[next] > rank[current] ? next : current;
}
