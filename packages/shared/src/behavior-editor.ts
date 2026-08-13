/**
 * Sekiro ESD（Event State Definition，.esd）只读模型文档 wire 类型与三页投影。
 *
 * 与 Bridge 的 read-esd-document 一一对应（BEHAVIOR-55A）。
 * 布局权威在 C# 侧 EsdNativeDocument.cs；这里的类型只描述 wire 形状，
 * 不维护第二套 native parser。
 *
 * 语义：unknown layout 由 authority 表达——RPN 字节码不解码登记在 unparsedGaps、
 * 声明量与实解析量不符登记在 coverageShortfalls，任一非空都会把 authority
 * 压到 partial，上层不得把「读出来了」伪装成「完整解析」。跳转图闭合性由
 * transitionGraph.closed 单独表达（悬空/指向哨兵目标会破坏状态机可达性）。
 * `projectEsdDocumentPages` 是纯函数，消费方用它把单个 envelope 投影成
 * states / conditions / transitions 三页，不做任何 I/O。
 */

/** 无修改往返报告（read-esd-document 内嵌；EsdRoundTripReport 经 camelCase 序列化）。 */
export interface EsdRoundTripReport {
  byteIdentical: boolean;
  semanticIdentical: boolean;
  sourceHash: string;
  rebuiltHash: string;
  stateGroupCount: number;
  /** 语义状态数（Σ stateCount，不含每组尾随哨兵槽）。 */
  stateCount: number;
  /** 物理 State 记录数（含每组尾随哨兵槽，与文件头 0x30 同单位）。 */
  stateRecordCount: number;
  conditionCount: number;
  commandCallCount: number;
  commandArgCount: number;
}

/** envelope 里 stateGroups 的采样行（每状态组一行；超出 sampleLimit 时截断）。 */
export interface EsdStateGroupWire {
  groupId: number;
  /** 该组语义状态数（不含尾随哨兵槽）。 */
  stateCount: number;
}

/** envelope 里 conditionSamples 的一行（bounded condition 明细页）。 */
export interface EsdConditionSampleWire {
  /** 条件记录相对 DataStart 的偏移，stable identity；分页按它排序。 */
  conditionRelOffset: number;
  sourceGroupId: number;
  sourceStateRelOffset: number;
  /** 跳转目标原始值（相对 DataStart）；−1 表示本条件不跳转。 */
  targetStateRelOffset: number;
  subConditionCount: number;
  /** evaluator 字节码长度（字节码本身按不透明 (offset,length) 上报，不解码）。 */
  evaluatorLength: number;
  passCommandCount: number;
}

/** transitionGraph.edges 里的一条解析后转移边（仅 resolved 态带目标状态）。 */
export interface EsdTransitionEdgeWire {
  sourceGroupId: number;
  conditionRelOffset: number;
  targetGroupId: number | null;
  targetStateId: number | null;
  resolution: 'none' | 'resolved' | 'sentinel' | 'dangling';
}

/** transitionGraph.danglingSamples 里的一条悬空目标（带原始偏移供定位排查）。 */
export interface EsdDanglingTransitionWire {
  sourceGroupId: number;
  sourceStateRelOffset: number;
  conditionRelOffset: number;
  targetStateRelOffset: number;
}

/** transitionGraph.sentinelSamples 里的一条哨兵目标。 */
export interface EsdSentinelTransitionWire {
  sourceGroupId: number;
  conditionRelOffset: number;
  targetStateRelOffset: number;
}

/**
 * transitionGraph：转移图四态计数 + 闭合判定 + 采样。
 * 四态刻意分开：none（−1，不跳转）是正常形态；sentinel（指向尾随哨兵槽）与
 * dangling（悬空目标）是异常，closed=false 时不得声称结构已认全。
 */
export interface EsdTransitionGraphWire {
  edgeCount: number;
  resolved: number;
  none: number;
  sentinel: number;
  dangling: number;
  closed: boolean;
  danglingSamples: EsdDanglingTransitionWire[];
  sentinelSamples: EsdSentinelTransitionWire[];
  edges: EsdTransitionEdgeWire[];
  edgesTruncated: boolean;
}

/** commandCalls.bySlot 的一行（entry/exit/while/condition-pass 四槽分布）。 */
export interface EsdCommandCallBySlotWire {
  slot: 'entry' | 'exit' | 'while' | 'condition-pass';
  count: number;
}

/** commandCalls.samples 的一行。 */
export interface EsdCommandCallSampleWire {
  sourceGroupId: number;
  slot: 'entry' | 'exit' | 'while' | 'condition-pass';
  bank: number;
  /** 命令身份；取值范围极宽（−1、小整数、接近 int.MaxValue），不做任何范围假设。 */
  commandId: number;
  argCount: number;
}

/** commandCalls：命令调用汇总 + 按槽位分布 + 采样。 */
export interface EsdCommandCallsWire {
  total: number;
  distinctCommandIds: number;
  bySlot: EsdCommandCallBySlotWire[];
  samples: EsdCommandCallSampleWire[];
  samplesTruncated: boolean;
}

/**
 * read-esd-document 的完整 envelope。
 *
 * 裸名 conditionCount/commandCallCount/commandArgCount 携带的是**声明量**
 * （文件头声明），与 parsed* 实解析量对照——UI 显示已解析数时用 parsed*，
 * 别拿裸名当实况（EsdNativeDocument.ToEnvelope 有同款注释）。
 * 裸名 stateCount 是例外：它挂语义状态数（与 parsedStateCount 同值），
 * 不含每组尾随哨兵槽；声明量由 declaredStateCount 取到。
 */
export interface EsdDocument {
  format: 'ESD';
  version: number;
  sourceSize: number;
  sourceHash: string;
  stateGroupCount: number;
  /** 语义状态数（Σ stateCount，不含尾随哨兵槽）。 */
  stateCount: number;
  conditionCount: number;
  commandCallCount: number;
  commandArgCount: number;
  declaredStateGroupCount: number;
  declaredStateCount: number;
  declaredConditionCount: number;
  declaredCommandCallCount: number;
  declaredCommandArgCount: number;
  /** 语义状态数（与 stateCount 同值）。 */
  parsedStateCount: number;
  /** 物理 State 记录数（含每组尾随哨兵槽，与 0x30 同单位，覆盖率判据比这一项）。 */
  parsedStateRecordCount: number;
  /** 每组尾随哨兵槽数量（ESD 布局恒为 1）。 */
  stateSentinelPerGroup: number;
  stateSentinelModelConsistent: boolean;
  stateSentinelDivergentGroupIds: number[];
  parsedConditionCount: number;
  parsedCommandCallCount: number;
  parsedCommandArgCount: number;
  stateGroups: EsdStateGroupWire[];
  stateGroupsTruncated: boolean;
  commandBanks: number[];
  bytecodeRegionCount: number;
  conditionSamples: EsdConditionSampleWire[];
  conditionSamplesTruncated: boolean;
  transitionGraph: EsdTransitionGraphWire;
  commandCalls: EsdCommandCallsWire;
  coverageComplete: boolean;
  coverageShortfalls: string[];
  /** 本版刻意未解析的字段区间（能力边界，与 coverageShortfalls 分列）。 */
  unparsedGaps: string[];
  roundTrip: EsdRoundTripReport;
  /** candidate 需计数闭合 + 无 unparsedGaps + 跳转图闭合三者同时成立。 */
  authority: 'candidate' | 'partial';
}

/** states page：状态组列表 + 语义状态计数 + 哨兵模型状态。 */
export interface EsdStatesPage {
  stateGroupCount: number;
  /** 语义状态数（不含每组尾随哨兵槽）。 */
  stateCount: number;
  /** 物理 State 记录数（含尾随哨兵槽，与 0x30 同单位）。 */
  stateRecordCount: number;
  stateSentinelModelConsistent: boolean;
  stateSentinelDivergentGroupIds: number[];
  stateGroups: EsdStateGroupWire[];
  stateGroupsTruncated: boolean;
}

/** conditions page：条件计数 + bounded 明细采样（conditionOffset 定位）。 */
export interface EsdConditionsPage {
  declaredConditionCount: number;
  parsedConditionCount: number;
  samples: EsdConditionSampleWire[];
  samplesTruncated: boolean;
}

/** transitions page：转移图四态 + 闭合判定 + 采样。 */
export interface EsdTransitionsPage {
  edgeCount: number;
  resolved: number;
  none: number;
  sentinel: number;
  dangling: number;
  closed: boolean;
  edges: EsdTransitionEdgeWire[];
  edgesTruncated: boolean;
  danglingSamples: EsdDanglingTransitionWire[];
  sentinelSamples: EsdSentinelTransitionWire[];
}

/** 单个 ESD envelope 投影出的三页。 */
export interface EsdDocumentPages {
  states: EsdStatesPage;
  conditions: EsdConditionsPage;
  transitions: EsdTransitionsPage;
}

/** 把 read-esd-document envelope 投影成三页。纯函数，不吞异常、不做 I/O。 */
export function projectEsdDocumentPages(doc: EsdDocument): EsdDocumentPages {
  return {
    states: {
      stateGroupCount: doc.stateGroupCount,
      stateCount: doc.stateCount,
      stateRecordCount: doc.parsedStateRecordCount,
      stateSentinelModelConsistent: doc.stateSentinelModelConsistent,
      stateSentinelDivergentGroupIds: doc.stateSentinelDivergentGroupIds,
      stateGroups: doc.stateGroups,
      stateGroupsTruncated: doc.stateGroupsTruncated,
    },
    conditions: {
      declaredConditionCount: doc.declaredConditionCount,
      parsedConditionCount: doc.parsedConditionCount,
      samples: doc.conditionSamples,
      samplesTruncated: doc.conditionSamplesTruncated,
    },
    transitions: {
      edgeCount: doc.transitionGraph.edgeCount,
      resolved: doc.transitionGraph.resolved,
      none: doc.transitionGraph.none,
      sentinel: doc.transitionGraph.sentinel,
      dangling: doc.transitionGraph.dangling,
      closed: doc.transitionGraph.closed,
      edges: doc.transitionGraph.edges,
      edgesTruncated: doc.transitionGraph.edgesTruncated,
      danglingSamples: doc.transitionGraph.danglingSamples,
      sentinelSamples: doc.transitionGraph.sentinelSamples,
    },
  };
}

/** 窄守卫：判读一个 read-esd-document 响应是不是 EsdDocument。 */
export function isEsdDocument(value: unknown): value is EsdDocument {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.format === 'ESD'
    && typeof v.sourceHash === 'string'
    && typeof v.authority === 'string'
    && typeof v.transitionGraph === 'object' && v.transitionGraph !== null
    && typeof v.commandCalls === 'object' && v.commandCalls !== null;
}
