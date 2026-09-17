/**
 * Sekiro TAE（.tae，Time Act Editor）文档 wire 类型与三页投影。
 *
 * 与 Bridge 的 read-tae-document 一一对应（ANIMATION-56A）。
 * 布局权威在 C# 侧 TaeNativeDocument.cs；这里的类型只描述 wire 形状，
 * 不维护第二套 native parser。
 *
 * 语义：
 *  - 事件参数体由 Bridge 按 first-party schema 解码；schema 覆盖到的字段可通过
 *    typed mutation 写回，超出 schema 的原始尾部仍随文档保留。
 *  - authority 只在全部事件时间范围合法时为 candidate；存在 startTime > endTime
 *    或非有限时间时降为 partial，并在 diagnostics 里给 TAE_INVALID_TIME_RANGE。
 *  - animations 行只采样前 sampleLimit 条（envelope 内嵌 animationsTruncated），
 *    每行的 events 又是按动画 bounded 的事件时间表（eventsTruncated）。消费方要
 *    全量走后续分页 channel，不要把 envelope 当全量。
 *  - eventTypes 是去重后的 distinct 列表（C# 侧 SortedSet 排序）。
 *
 * `projectTaeDocumentPages` 是纯函数，消费方用它把单个 envelope 投影成
 * animations / timeline / events 三页，不做任何 I/O。
 */

/** TAE envelope 级诊断码。当前只可能来自事件时间范围非法。 */
export const TAE_INVALID_TIME_RANGE = 'TAE_INVALID_TIME_RANGE';

/** envelope 级诊断（当前只来自时间范围非法；形状与 shared Diagnostic 一致）。 */
export interface TaeDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  sourceUri?: string;
  details?: unknown;
}

/** 无修改往返报告（read-tae-document 内嵌）。 */
export interface TaeRoundTripReport {
  byteIdentical: boolean;
  semanticIdentical: boolean;
  sourceHash: string;
  rebuiltHash: string;
  animationCount: number;
  totalEventCount: number;
  totalGroupCount: number;
}

/** first-party schema 解码出的单个参数字段。 */
export interface TaeTemplateFieldValue {
  name: string;
  kind?: string;
  type?: string;
  index?: number;
  offset?: number;
  size?: number;
  assert?: number;
  assertValid?: boolean;
  isPadding?: boolean;
  enumEntries?: Array<{ value: number; name: string }>;
  /** 按 kind 解码的数值/布尔。 */
  value: number | boolean | string;
  rawValue?: number;
  displayValue?: string;
}

/** read-tae-document envelope 里的事件时间表行（timeline page 的最小单元）。 */
export interface TaeTimelineEventWire {
  startTime: number;
  endTime: number;
  eventTypeId: number;
  parameterLength?: number;
  parameterDecodedSize?: number;
  schemaBankId?: number;
  schemaBankName?: string;
  schemaVariantCount?: number;
  schemaVariant?: string;
  parameterTailLength?: number;
  /** 所属 ANIBND TAE 子项；同一 animId 在不同 section 可重复。 */
  taeEntryIndex?: number;
  taeEntryId?: number;
  taeEntryName?: string;
  taeGroup?: string;
  /**
   * S17：参数体按模板布局解码结果。有模板且布局全部解出时为 true，
   * templateFields 携带字段名 + 值；无模板或布局越界时为 false，
   * 消费方回落 parameterBytesHex（有界 hex 预览），禁止编造字段含义。
   */
  parameterDecoded?: boolean;
  /** first-party schema 解码出的字段数组（name/type/value）；未解码时缺省。 */
  templateFields?: TaeTemplateFieldValue[];
  /** 参数体有界 hex 预览（无模板布局时的兜底，最多 64 字节）。 */
  parameterBytesHex?: string;
}

/**
 * ANIBND 内一个原生 TAE 子项的身份摘要。
 *
 * BND4 中不同 TAE 子项可以复用同一个 animId，因此 entryIndex/id/name
 * 是动画身份的一部分，不能只把 animId 当作全局主键。name 由 Bridge
 * 限制为逻辑 basename（例如 a00.tae），不携带宿主机路径。
 */
export interface TaeEntryWire {
  entryIndex: number;
  entryId: number;
  entryName: string;
  taeGroup: string;
  animationCount: number;
  sourceSize: number;
  sourceHash: string;
  eventBank?: number;
  schemaBankId?: number;
}

/** read-tae-document envelope 里的 animation 行：摘要 + bounded 事件时间表。 */
export interface TaeAnimationWire {
  animId: number;
  /**
   * Bridge 解析出的实际动作引用 ID；缺省表示未能安全解析，不能回退猜测为 animId。
   * 生产 wire 仅接受非负 safe integer，保持旧 envelope 的可选字段兼容性。
   */
  motionAnimId?: number | undefined;
  /** 所属 ANIBND BND4 子项；裸 .tae 时缺省。 */
  taeEntryIndex?: number | undefined;
  taeEntryId?: number | undefined;
  taeEntryName?: string | undefined;
  taeGroup?: string | undefined;
  eventCount: number;
  groupCount: number;
  timesCount: number;
  hkxName?: string | undefined;
  /** 本动画的事件时间表，受 timelineEventLimit 上限约束。 */
  events: TaeTimelineEventWire[];
  /** events 超出每动画上限而被截断。 */
  eventsTruncated: boolean;
}

/**
 * 动画的稳定 UI/运行时身份。entryIndex 只在当前 BND4 source 内解释，
 * 与 sourceHash/sourceUri 组合后可作为完整外部身份；animId 不能单独使用。
 */
export function taeAnimationIdentityKey(
  animation: Pick<TaeAnimationWire, 'animId' | 'taeEntryIndex' | 'taeEntryId' | 'taeEntryName' | 'taeGroup'>
): string {
  const entry = Number.isSafeInteger(animation.taeEntryIndex)
    ? `index:${animation.taeEntryIndex}`
    : Number.isSafeInteger(animation.taeEntryId)
      ? `id:${animation.taeEntryId}`
      : `name:${animation.taeEntryName ?? animation.taeGroup ?? 'tae'}`;
  return `${entry}|anim:${animation.animId}`;
}

/** 分组键使用原生 entry 身份，不从 hkxName 或 animId 猜分区。 */
export function taeAnimationGroupKey(
  animation: Pick<TaeAnimationWire, 'taeEntryIndex' | 'taeEntryId' | 'taeEntryName' | 'taeGroup'>
): string {
  if (Number.isSafeInteger(animation.taeEntryIndex)) return `index:${animation.taeEntryIndex}`;
  if (Number.isSafeInteger(animation.taeEntryId)) return `id:${animation.taeEntryId}`;
  return `name:${animation.taeEntryName ?? animation.taeGroup ?? 'tae'}`;
}

/** UI 分组标题；a150 等不存在的子项不会被本地补造。 */
export function taeAnimationGroupLabel(
  animation: Pick<TaeAnimationWire, 'taeEntryName' | 'taeGroup'>
): string {
  const label = animation.taeGroup
    ?? animation.taeEntryName?.replace(/\.tae$/i, '')
    ?? 'TAE';
  return label || 'TAE';
}

/** 运行时 wire 守卫：motionAnimId 缺失/空值表示未解析，不得猜测为 animId。 */
export function isSafeMotionAnimId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** read-tae-document 的完整 envelope。 */
export interface TaeDocument {
  format: 'TAE';
  version: string;
  sourceSize: number;
  sourceHash: string;
  containerSourceHash?: string;
  eventBank?: number;
  schemaBankId?: number;
  animationCount: number;
  totalEventCount: number;
  totalGroupCount: number;
  animations: TaeAnimationWire[];
  /** ANIBND 内完整 TAE 子项目录；裸 .tae 时可缺省。 */
  taeEntryCount?: number;
  taeEntries?: TaeEntryWire[];
  /** animations 只采样前 sampleLimit 条时为 true。 */
  animationsTruncated: boolean;
  /** distinct 事件类型列表（C# 侧 SortedSet，已去重排序）。 */
  eventTypes: number[];
  schema?: {
    origin: 'first-party';
    package: string;
    version: string;
    contentDigest: string;
    game: string;
    format: string;
    nativeFormatAuthority: boolean;
    bankCount: number;
    eventCount: number;
    fieldCount: number;
  };
  schemaCoverage?: {
    coveredEventCount: number;
    unknownEventCount: number;
    lengthMismatchCount: number;
    ambiguousEventCount: number;
    assertFailureCount?: number;
    assertFailureDetails?: Array<{
      animId: number;
      eventIndex: number;
      eventTypeId: number;
      parameterLength: number;
      fields: string[];
    }>;
    unknownEventTypeIds: number[];
    complete: boolean;
  };
  roundTrip: TaeRoundTripReport;
  diagnostics: TaeDiagnostic[];
  authority: 'native-verified' | 'candidate' | 'fixture-confirmed' | 'unsupported' | 'partial';
}

/** animations page：动画摘要列表 + 采样截断元数据。 */
export interface TaeAnimationsPage {
  animationCount: number;
  animations: TaeAnimationWire[];
  animationsTruncated: boolean;
}

/** timeline page：跨采样动画展平的事件时间表行（带 animId，供选中动画过滤）。 */
export interface TaeTimelineEventRow extends TaeTimelineEventWire {
  animId: number;
}

/** timeline page：事件时间表 + 截断元数据。 */
export interface TaeTimelinePage {
  events: TaeTimelineEventRow[];
  /** 参与本页投影的采样动画条数（= envelope animations 行数）。 */
  animationCount: number;
  /** events 超出每动画上限而被截断的采样动画个数；>0 表示 timeline 不全。 */
  truncatedAnimationCount: number;
}

/** events page：事件/事件组计数 + distinct 事件类型列表。 */
export interface TaeEventsPage {
  totalEventCount: number;
  totalGroupCount: number;
  eventTypes: number[];
  eventTypeCount: number;
}

/** 单个 TAE envelope 投影出的三页。 */
export interface TaeDocumentPages {
  animations: TaeAnimationsPage;
  timeline: TaeTimelinePage;
  events: TaeEventsPage;
}

/** 把 read-tae-document envelope 投影成三页。纯函数，不吞异常、不做 I/O。 */
export function projectTaeDocumentPages(doc: TaeDocument): TaeDocumentPages {
  const timelineEvents: TaeTimelineEventRow[] = [];
  let truncatedAnimationCount = 0;
  for (const animation of doc.animations) {
    for (const event of animation.events) {
      timelineEvents.push({
        animId: animation.animId,
        ...event,
        ...(animation.taeEntryIndex === undefined ? {} : { taeEntryIndex: animation.taeEntryIndex }),
        ...(animation.taeEntryId === undefined ? {} : { taeEntryId: animation.taeEntryId }),
        ...(animation.taeEntryName === undefined ? {} : { taeEntryName: animation.taeEntryName }),
        ...(animation.taeGroup === undefined ? {} : { taeGroup: animation.taeGroup })
      });
    }
    if (animation.eventsTruncated) truncatedAnimationCount++;
  }
  return {
    animations: {
      animationCount: doc.animationCount,
      animations: doc.animations,
      animationsTruncated: doc.animationsTruncated,
    },
    timeline: {
      events: timelineEvents,
      animationCount: doc.animations.length,
      truncatedAnimationCount,
    },
    events: {
      totalEventCount: doc.totalEventCount,
      totalGroupCount: doc.totalGroupCount,
      eventTypes: doc.eventTypes,
      eventTypeCount: doc.eventTypes.length,
    },
  };
}

/** 窄守卫：判读一个 read-tae-document 响应是不是 TaeDocument。 */
export function isTaeDocument(value: unknown): value is TaeDocument {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.format === 'TAE' && typeof v.sourceHash === 'string' && typeof v.authority === 'string';
}
