/**
 * 把 DSL 模板里的事件锚对齐到 renderer 的 EMEVD 文档。
 *
 * 为什么需要它：renderer 经 readEmevdDocument（EVENT-30A bounded outline）拿到的
 * envelope 只有事件表，mapEmevdEnvelopeToDocument 产出的 EmevdEventIr 没有
 * anchor——而 DSL 工作台的 diagnostic gutter 与 Go to Event 都依赖
 * `event @e:<localNodeId>` 行能命中事件的 anchor.localNodeId（见
 * EventSourceWorkbenchPanel.indexEventLines）。真实文档经 attachEmevdStableIdentity
 * 生成 24-hex 的 localNodeId，renderer 侧的 bounded projection 永远算不出那个 hash；
 * 唯一权威的锚源是 readEmevdFullDocument 返回的 dslTemplate 本身。
 *
 * 对齐规则：dslTemplate 与 envelope 是同一份 Bridge 文档的两个投影，事件顺序一致，
 * 因此按「事件锚出现的顺序」逐事件赋予 localNodeId。bounded 模板（≤2000 行）可能
 * 截断、读失败时模板可能为空：没有锚行的事件回退到 String(eventId) —— 与
 * renderSource 的 `event @e:<anchor ?? eventId>` 兜底形态对齐，indexEventLines
 * 仍能命中。
 */
import type { EmevdEditorDocument } from '@soulforge/shared';

const EVENT_ANCHOR_LINE = /^event\s+@e:(\S+)/;

/** 从 DSL 模板中按出现顺序提取事件锚；模板为空时返回空数组。 */
export function extractEmevdEventAnchors(dslTemplate: string): string[] {
  const anchors: string[] = [];
  for (const line of dslTemplate.split('\n')) {
    const match = EVENT_ANCHOR_LINE.exec(line);
    if (match) anchors.push(match[1]!);
  }
  return anchors;
}

export function alignEmevdDocumentAnchors(
  document: EmevdEditorDocument,
  dslTemplate: string | null | undefined
): EmevdEditorDocument {
  const anchors = dslTemplate ? extractEmevdEventAnchors(dslTemplate) : [];
  const events = document.events.map((event, index) => {
    const localNodeId = anchors[index] ?? String(event.eventId);
    return {
      ...event,
      anchor: {
        documentInstanceId: document.documentInstanceId ?? document.resourceUri,
        localNodeId,
        sourceFingerprint: event.anchor?.sourceFingerprint ?? String(event.eventId)
      }
    };
  });
  return { ...document, events };
}
