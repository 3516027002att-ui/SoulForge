/**
 * FMG 文本行的解析与序列化（纯函数，无 React 依赖）。
 *
 * 从 App.tsx 搬出。EditableMsgRow 原先声明在 App.tsx 顶部、helper 在尾部，中间
 * 隔着 2300 行 App 组件本体——同一组关注点被文件位置拆开，是「上帝组件」最典型
 * 的症状之一。
 */
import type { TextEntrySymbol } from '@soulforge/shared';
import type { RendererResourcePreview } from '../../../main/rendererDto.js';

export interface EditableMsgRow {
  textId: string;
  text: string;
  category?: string;
}

export function extractMsgRows(preview: RendererResourcePreview | null | undefined): EditableMsgRow[] {
  return preview?.structuredPreview?.msgs
    ?.flatMap((msgExport) => msgExport.entries.map((entry) => msgEntryToEditableRow(entry, msgExport.category)))
    ?? [];
}

function msgEntryToEditableRow(entry: TextEntrySymbol, fallbackCategory?: string): EditableMsgRow {
  const category = entry.category ?? fallbackCategory;
  return {
    textId: String(entry.textId),
    text: entry.text,
    ...(category ? { category } : {})
  };
}

export function serializeMsgRowsToTsv(rows: EditableMsgRow[]): string {
  return `${rows.map((row) => `${sanitizeTextId(row.textId)}\t${escapeTsvText(row.text)}`).join('\n')}\n`;
}

function sanitizeTextId(value: string): string {
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? trimmed : '0';
}

function escapeTsvText(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll('\n', '\\n').replaceAll('\t', ' ');
}

export function nextMsgId(rows: EditableMsgRow[]): string {
  const maxId = rows.reduce((max, row) => {
    const id = Number.parseInt(row.textId, 10);
    return Number.isFinite(id) ? Math.max(max, id) : max;
  }, 0);
  return String(maxId + 1);
}

