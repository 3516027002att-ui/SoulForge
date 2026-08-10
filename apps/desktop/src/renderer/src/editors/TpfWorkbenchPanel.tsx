import { type ReactElement } from 'react';
import { formatListTruncation } from '../format/uiText.js';
import { ReadOnlyEntryWorkbench } from '../workbench/ReadOnlyEntryWorkbench.js';

export interface TpfTextureEntry {
  index: number;
  name: string;
  format: number;
  mipCount: number;
  dataOffset: number;
  dataSize: number;
  width: number;
  height: number;
  ddsFourCC: string;
}

export interface TpfDocumentData {
  format: string;
  sourceSize: number;
  sourceHash: string;
  textureCount: number;
  authority: string;
  textures?: TpfTextureEntry[];
}

export interface TpfWorkbenchPanelProps {
  resourceUri: string;
  data: TpfDocumentData | null;
}

/** 表格一次最多渲染多少个纹理行（硬约束 17：大规模访问不得全量建 DOM）。 */
const TEXTURE_RENDER_LIMIT = 200;

const FORMAT_NAMES: Record<number, string> = {
  0x00: 'BC1 (DXT1)',
  0x01: 'BC1 Alpha',
  0x67: 'BC4 (ATI1)',
  0x6A: 'BC5 (DX10)',
  0x6B: 'BC5 Variant'
};

/**
 * TPF 纹理包只读面板：显示纹理列表、格式、尺寸和 DDS 信息。
 */
export function TpfWorkbenchPanel(props: TpfWorkbenchPanelProps): ReactElement {
  const data = props.data;
  const filtered = data?.textures ?? [];

  /**
   * 投影上限。TPF 纹理数不可控，此前是 filtered 全量 map（无分页、无上限），
   * 只靠容器的 maxHeight+overflow 挡住视觉——DOM 仍然全量建出。
   *
   * 纠正原注释一处事实错误：它写「TPF 是 V0.6 延期的只读预览族」，但
   * shared 的 DEFERRED_PREVIEW_EDITOR_KINDS 只含 msb/tae/esd/flver，**不含 tpf**。
   * TPF 的只读是另一回事（写回链尚未接通），不是范围裁定。两者混为一谈会让
   * 用户无法判断该等下一个版本还是该报 bug，所以横幅文案也据此区分。
   *
   * 截断说明保留：静默截断会让用户把部分数据当成全部，那是伪造观感。
   * 工作台内部另有分页，两者层次不同（这里限制投影出多少条目对象）。
   */
  const visible = filtered.slice(0, TEXTURE_RENDER_LIMIT);
  const truncationNote = formatListTruncation({
    total: filtered.length,
    shown: visible.length,
    noun: '个纹理',
    hint: '用搜索框按名称或格式缩小范围'
  });

  const entries = visible.map((tex) => ({
    id: String(tex.index),
    label: tex.name,
    meta: `${tex.width}×${tex.height}`,
    properties: [
      ['Name', tex.name],
      ['Size', `${tex.width}×${tex.height}`],
      ['Format', FORMAT_NAMES[tex.format] ?? tex.ddsFourCC],
      ['DDS FourCC', tex.ddsFourCC],
      ['Mip Levels', String(tex.mipCount)],
      ['Data Size', `${(tex.dataSize / 1024).toFixed(1)} KB`],
      ['Data Offset', `0x${tex.dataOffset.toString(16)}`],
      ['Format Code', `0x${tex.format.toString(16).padStart(2, '0')}`]
    ] as Array<readonly [string, string]>
  }));

  return (
    <section className="panel" aria-label="TPF 纹理包面板">
      {truncationNote && (
        <p className="muted" data-testid="tpf-truncation">{truncationNote}</p>
      )}
      <ReadOnlyEntryWorkbench
        label="TPF 纹理包工作台"
        kindLabel="TPF 纹理包"
        entriesTitle="Textures"
        filterPlaceholder="搜索纹理名称或格式…"
        entries={entries}
        emptyHint="选择 .tpf 文件以查看纹理数据。"
        readOnlyNote="TPF 当前只读：纹理写回链尚未接通。这不是版本范围裁定 —— TPF 不在延期编辑器清单里。"
        {...(data
          ? {
              summary: `${data.textureCount} textures`
                + ` · ${(data.sourceSize / 1024 / 1024).toFixed(1)} MB · ${data.authority}`
            }
          : {})}
      />
    </section>
  );
}
