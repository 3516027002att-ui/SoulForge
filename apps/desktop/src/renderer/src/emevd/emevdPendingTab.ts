/**
 * 把 `resource.readEmevdFullDocument` 的一次响应变成一个事件工作台标签。
 *
 * 为什么是一次：打开事件文档以前要两次 IPC —— `readEmevdDocument` 拿有界
 * envelope 投影，`readEmevdFullDocument` 拿权威源码。前者产出的 renderer 文档
 * 只被用在两处：状态行的三个标量（事件数 / 指令数 / authority），和 gutter 的
 * 「未知指令条数」。而它的 `instructionsSample` 默认只覆盖前 256 条指令
 * （Bridge `read-emevd-document` 的 instructionPageSize 默认值），
 * 而做投影的 `mapEmevdEnvelopeToDocument`（已随本次改动删除，函数名只作历史
 * 追溯用）对采样不到的指令一律记 `unknown: true` —— 真实 common.emevd 有 33266
 * 条指令，于是第 256 条之后的事件全被标成「整段未知」。那次读付了一整趟 Bridge
 * 往返，换回来的是一份系统性错误的判据。
 *
 * 现在两者都从 `readEmevdFullDocument` 的 `outline` 里出：outline 的
 * `unknownCount` 是主进程用完整 EMEDF registry 逐条判定的（见
 * buildEmevdDocumentOutline / readFullEmevdDocumentViaBridge），覆盖到 4096 个
 * 事件（实测最大的 common_func 是 2124 个）。
 *
 * ## renderer 侧的 document 里为什么没有指令体
 *
 * 权威文档留在主进程（`emevdFullDocuments`），renderer 从来不需要 33266 条指令
 * 的 `argsBase64`：源码显示走 `dslTemplate`，gutter 走 outline 计数，写回走
 * 主进程的 Patch Engine。把指令体搬进 renderer 只会多出数 MB 的 IPC 序列化。
 * 所以这里的 `events` 是空数组，并挂一条显式诊断说明「指令体不在 renderer」——
 * 不伪造 bank/id 占位，避免把「没下发」冒充成「已解析出这些指令」。
 */

import type { EmevdEditorDocument } from '@soulforge/shared';
import type {
  EventSourceTabData,
  EventWarningRow
} from '../editors/EventSourceWorkbenchPanel.js';

/** `readEmevdFullDocument` 响应里本模块要用的部分（preload 契约的子集）。 */
export interface EmevdFullDocumentResponseLike {
  ok?: boolean;
  documentInstanceId?: string;
  revision?: number;
  eventCount?: number;
  instructionCount?: number;
  sourceHash?: string | null;
  authority?: string | null;
  outline?: {
    eventCount: number;
    instructionTotal: number;
    truncated: boolean;
    limit: number;
    events: Array<{
      eventId: number;
      instructionCount: number;
      unknownCount: number;
    }>;
  } | null | undefined;
}

export interface EmevdPendingTabInput {
  tabId: string;
  title: string;
  resourceUri: string;
  full: EmevdFullDocumentResponseLike;
  dslTemplate: string | null;
  dslTemplateTruncated: boolean;
  dslTemplateTotalLines: number;
  sourceStyle: 'dark-script' | 'patch-dsl' | 'none';
}

/** outline 行 → gutter 判据行（顺序即文档顺序，与 `$Event(` 出现顺序一致）。 */
export function eventWarningRowsFromOutline(
  outline: EmevdFullDocumentResponseLike['outline']
): readonly EventWarningRow[] {
  if (!outline) return [];
  return outline.events.map((event) => ({
    eventId: event.eventId,
    warnings: event.unknownCount
  }));
}

export function emevdPendingTabFromFullDocument(
  input: EmevdPendingTabInput
): EventSourceTabData {
  const outline = input.full.outline ?? null;
  const diagnostics: EmevdEditorDocument['diagnostics'] = [{
    severity: 'info',
    code: 'EMEVD_INSTRUCTION_BODIES_STAY_IN_MAIN',
    message: '指令体保留在主进程的权威文档里；源码显示走 DarkScript 模板，'
      + '事件判据走 outline 计数。'
  }];
  if (outline?.truncated) {
    diagnostics.push({
      severity: 'info',
      code: 'EMEVD_OUTLINE_TRUNCATED',
      message: `事件判据只覆盖前 ${outline.limit} 个事件（共 ${outline.eventCount}）；`
        + '其余事件不打 gutter 标记。'
    });
  }
  const document: EmevdEditorDocument = {
    schemaVersion: 1,
    resourceUri: input.resourceUri,
    revision: input.full.revision ?? 0,
    events: [],
    bytesBase64: '',
    diagnostics,
    ...(input.full.documentInstanceId !== undefined
      ? { documentInstanceId: input.full.documentInstanceId }
      : {})
  };
  return {
    tabId: input.tabId,
    title: input.title,
    resourceUri: input.resourceUri,
    document,
    eventWarnings: eventWarningRowsFromOutline(outline),
    sourceHash: input.full.sourceHash ?? null,
    live: true,
    dslTemplate: input.dslTemplate,
    dslTemplateTruncated: input.dslTemplateTruncated,
    dslTemplateTotalLines: input.dslTemplateTotalLines,
    sourceStyle: input.sourceStyle
  };
}
