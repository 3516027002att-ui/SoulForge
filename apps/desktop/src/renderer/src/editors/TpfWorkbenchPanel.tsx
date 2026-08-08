import { useMemo, useState, type ReactElement } from 'react';
import { formatListTruncation } from '../format/uiText.js';

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
  const [query, setQuery] = useState('');
  const [selectedTexture, setSelectedTexture] = useState<TpfTextureEntry | null>(null);
  const data = props.data;

  const filtered = useMemo(() => {
    if (!data?.textures) return [];
    const q = query.trim().toLowerCase();
    if (!q) return data.textures;
    return data.textures.filter(
      (t) => t.name.toLowerCase().includes(q) || t.ddsFourCC.toLowerCase().includes(q)
    );
  }, [data?.textures, query]);

  /**
   * 表格渲染上限。TPF 纹理数不可控，此前是 filtered 全量 map（无分页、无上限），
   * 只靠容器的 maxHeight+overflow 挡住视觉——DOM 仍然全量建出。
   *
   * 这里用「截断 + 显式说明」而不是分页：TPF 是 V0.6 延期的只读预览族，加完整
   * 分页控件属于超出当前范围的功能；但静默截断会让用户把部分数据当成全部，
   * 那是硬约束 7 意义上的伪造观感。搜索框已能定位具体纹理，说清即可。
   */
  const visible = filtered.slice(0, TEXTURE_RENDER_LIMIT);
  const truncationNote = formatListTruncation({
    total: filtered.length,
    shown: visible.length,
    noun: '个纹理',
    hint: '用搜索框按名称或格式缩小范围'
  });

  return (
    <section className="panel" aria-label="TPF 纹理包面板">
      <header className="panel-header">
        <h3>TPF 纹理包</h3>
        <span className="muted">
          {data ? `${data.textureCount} textures · ${(data.sourceSize / 1024 / 1024).toFixed(1)} MB · ${data.authority}` : '未加载'}
        </span>
      </header>
      {!data && <p className="muted">选择 .tpf 文件以查看纹理数据。</p>}
      {data && (
        <>
          <div className="row gap">
            <input
              className="input"
              placeholder="搜索纹理名称或格式…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="搜索纹理名称或格式"
            />
          </div>
          {truncationNote && (
            <p className="muted" data-testid="tpf-truncation">{truncationNote}</p>
          )}
          <div className="row gap" style={{ marginTop: 8 }}>
            <div style={{ flex: 1, overflowY: 'auto', maxHeight: 300 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>尺寸</th>
                    <th>格式</th>
                    <th>Mips</th>
                    <th>大小</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((tex) => (
                    <tr
                      key={tex.index}
                      className={selectedTexture?.index === tex.index ? 'selected' : ''}
                      onClick={() => setSelectedTexture(tex)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>{tex.name}</td>
                      <td>{tex.width}×{tex.height}</td>
                      <td>{FORMAT_NAMES[tex.format] ?? tex.ddsFourCC}</td>
                      <td>{tex.mipCount}</td>
                      <td>{(tex.dataSize / 1024).toFixed(0)} KB</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {selectedTexture && (
              <div style={{ width: 280, padding: 8 }}>
                <h4>{selectedTexture.name}</h4>
                <dl>
                  <dt>尺寸</dt><dd>{selectedTexture.width}×{selectedTexture.height}</dd>
                  <dt>格式</dt><dd>{FORMAT_NAMES[selectedTexture.format] ?? selectedTexture.ddsFourCC}</dd>
                  <dt>DDS FourCC</dt><dd>{selectedTexture.ddsFourCC}</dd>
                  <dt>Mip 级别</dt><dd>{selectedTexture.mipCount}</dd>
                  <dt>数据大小</dt><dd>{(selectedTexture.dataSize / 1024).toFixed(1)} KB</dd>
                  <dt>数据偏移</dt><dd>0x{selectedTexture.dataOffset.toString(16)}</dd>
                  <dt>格式代码</dt><dd>0x{selectedTexture.format.toString(16).padStart(2, '0')}</dd>
                </dl>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
