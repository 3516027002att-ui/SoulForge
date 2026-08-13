/**
 * TEXTURE-52B：Smithbox Texture 工作台（§2.5）。
 *
 * 四栏：`Container list | Texture list | Viewer | Properties`。
 *
 * ── 为什么是它 ──
 *
 * TEXTURE-52A 已在 Bridge 侧给出 read-tpf-document（DCX 解压 / loose 直读、
 * round-trip 逐字节比对、条目表元数据）与 read-tpf-texture-preview（受界 512
 * 下采样、data URI 不落盘）。本组件是这两个通道的第一个消费者 —— 与
 * GparamWorkbench 对 read-gparam-document 的关系相同。
 *
 * ── 层级 ──
 *
 * container（TPF 包文件）→ texture（条目）→ viewer/properties（选中条目的
 * 预览与元数据）。无 3D viewport（§2.5：TEXTURE 无 3D viewport，不发明假
 * 预览）。
 *
 * ── 预览失败隔离 ──
 *
 * 读预览失败时**纹理列表保留**、选择链不清空，Viewer 栏给出结构化诊断
 * （preview failure isolation）——不能把「某张纹理预览读不出来」显示成
 * 「这个包没有纹理」，也不能让一次预览失败把用户从列表里弹出来。
 *
 * ── writer 未就绪，隐藏 replace ──
 *
 * TEXTURE-52C 才接 tpf-texture-replace。本卡不渲染任何 replace 控件，
 * Properties 栏只给诚实说明 —— 不做假按钮占位（与 GPARAM-11B 的
 * 「没有 bytes replace fallback」同口径）。
 *
 * ── 失败 ──
 *
 * 读取失败的 container 保留在列表并标记失败，Textures 栏给出结构化诊断，
 * 不能把 read failure 显示成空包。
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { formatListTruncation } from '../format/uiText.js';
import { getRendererBridge } from '../runtime/rendererRuntime.js';
import { isRowTabEntry, selectableRowAttributes } from '../a11y/selectableRow.js';
import { WorkbenchLayout, type WorkbenchColumnSpec } from '../workbench/WorkbenchLayout.js';

/** Containers 栏的一个条目：工作区索引里的 TPF 文件。 */
export interface TpfContainerView {
  /** 稳定标识（文件浏览器与索引共用）。 */
  sourceUri: string;
  /** 物理相对路径（仅进 metadata details，不做显示名）。 */
  relativePath: string;
}

export interface TpfWorkbenchPanelProps {
  /** 该域的全部 TPF 文件（containers）。 */
  containers: TpfContainerView[];
  /** 打开时默认选中的 container（当前选中文件）。 */
  initialUri?: string;
}

/** 每栏分页大小：纹理数量随包不同可达数百，硬约束 17 要求分页。 */
const LIST_PAGE_SIZE = 60;

/** container 显示名：文件名去扩展，物理路径只在 title/details。 */
function containerDisplayName(file: TpfContainerView): string {
  const base = file.relativePath.split(/[\\/]/).pop() ?? file.relativePath;
  return base.replace(/\.tpf\.dcx$/i, '').replace(/\.tpf$/i, '');
}

/** 一个纹理条目的渲染视图（read-tpf-document 的 textures 行）。 */
interface TpfTextureView {
  index: number;
  name: string;
  /** 条目表 formatByte 查表结果（"BC1"/"BC4"/"0x.."），**不是**真实像素格式。 */
  format: string;
  formatByte: number;
  mipCount: number;
  dataOffset: number;
  dataSize: number;
  width: number;
  height: number;
  /** DDS 头里的 fourCC（"DX10"/"DXT1"/"ATI1"/…），真实封装形态。 */
  ddsFourCC: string;
}

/** read-tpf-document 的 renderer 侧投影（wire 是 unknown，这里只读所需字段）。 */
interface TpfDocumentView {
  sourceSize: number;
  sourceHash: string;
  textureCount: number;
  authority: string;
  textures: TpfTextureView[];
  roundTrip?: { byteIdentical?: boolean; sourceHash?: string; rebuiltHash?: string };
}

/** read-tpf-texture-preview 的 renderer 侧投影。 */
interface TpfTexturePreviewView {
  textureIndex: number;
  name: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  colorSpace: string;
  mediaType: string;
  byteLength: number;
  previewToken: string;
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function TpfWorkbenchPanel(props: TpfWorkbenchPanelProps): ReactElement {
  const bridge = getRendererBridge();

  const [selectedContainerUri, setSelectedContainerUri] = useState<string | null>(props.initialUri ?? null);
  /** 选中 container 的读取结果；null 表示未选或失败。 */
  const [document, setDocument] = useState<TpfDocumentView | null>(null);
  /** container → 读取失败诊断；失败 container 保留在列表并标记。 */
  const [containerFailures, setContainerFailures] = useState<Map<string, { code: string; message: string }>>(new Map());
  const [loading, setLoading] = useState(false);
  const [selectedTextureIndex, setSelectedTextureIndex] = useState<number | null>(null);
  /** 选中纹理的预览；null 表示未选/加载中/失败。 */
  const [preview, setPreview] = useState<TpfTexturePreviewView | null>(null);
  const [previewFailure, setPreviewFailure] = useState<{ code: string; message: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // ── 选择链：container → texture ──
  useEffect(() => {
    setSelectedTextureIndex(null);
    setPreview(null);
    setPreviewFailure(null);
  }, [selectedContainerUri]);
  useEffect(() => {
    setPreview(null);
    setPreviewFailure(null);
  }, [selectedTextureIndex]);

  // ── 读取选中 container ──
  useEffect(() => {
    if (!bridge || typeof bridge.readTpfDocument !== 'function') return;
    if (selectedContainerUri === null) {
      setDocument(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    bridge.readTpfDocument(selectedContainerUri)
      .then((raw) => {
        if (cancelled) return;
        const result = raw as { ok: boolean; data?: TpfDocumentView; diagnostics?: Array<{ code?: string; message?: string }> };
        if (result.ok && result.data) {
          setDocument({
            ...result.data,
            textures: Array.isArray(result.data.textures) ? result.data.textures : []
          });
          // 成功则清掉该 container 的失败标记（上次可能因未挂载失败，现已可读）。
          setContainerFailures((current) => {
            if (!current.has(selectedContainerUri)) return current;
            const next = new Map(current);
            next.delete(selectedContainerUri);
            return next;
          });
        } else {
          setDocument(null);
          const first = result.diagnostics?.[0];
          setContainerFailures((current) => {
            const next = new Map(current);
            next.set(selectedContainerUri, {
              code: first?.code ?? 'TPF_READ_FAILED',
              message: first?.message ?? 'TPF 读取失败。'
            });
            return next;
          });
        }
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setDocument(null);
        setContainerFailures((current) => {
          const next = new Map(current);
          next.set(selectedContainerUri, {
            code: 'TPF_READ_EXCEPTION',
            message: error instanceof Error ? error.message : 'TPF 读取异常。'
          });
          return next;
        });
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [bridge, selectedContainerUri]);

  // ── 读取选中纹理的预览 ──
  useEffect(() => {
    if (!bridge || typeof bridge.readTpfTexturePreview !== 'function') return;
    if (selectedContainerUri === null || selectedTextureIndex === null) {
      setPreview(null);
      setPreviewFailure(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewFailure(null);
    bridge.readTpfTexturePreview(selectedContainerUri, selectedTextureIndex)
      .then((raw) => {
        if (cancelled) return;
        const result = raw as { ok: boolean; data?: TpfTexturePreviewView; diagnostics?: Array<{ code?: string; message?: string }> };
        if (result.ok && result.data) {
          setPreview(result.data);
          setPreviewFailure(null);
        } else {
          setPreview(null);
          const first = result.diagnostics?.[0];
          setPreviewFailure({
            code: first?.code ?? 'TPF_TEXTURE_PREVIEW_FAILED',
            message: first?.message ?? '纹理预览生成失败。'
          });
        }
        setPreviewLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPreview(null);
        setPreviewFailure({
          code: 'TPF_TEXTURE_PREVIEW_EXCEPTION',
          message: error instanceof Error ? error.message : '纹理预览异常。'
        });
        setPreviewLoading(false);
      });
    return () => { cancelled = true; };
  }, [bridge, selectedContainerUri, selectedTextureIndex]);

  // ── 本地分页（Textures 可能有数百条）──
  const [texturePage, setTexturePage] = useState(0);
  useEffect(() => { setTexturePage(0); }, [selectedContainerUri]);

  const textures = document?.textures ?? [];
  const texturePageCount = Math.max(1, Math.ceil(textures.length / LIST_PAGE_SIZE));
  const textureSlice = textures.slice(texturePage * LIST_PAGE_SIZE, (texturePage + 1) * LIST_PAGE_SIZE);

  const selectedTexture = useMemo(
    () => textures.find((tex) => tex.index === selectedTextureIndex) ?? null,
    [textures, selectedTextureIndex]
  );

  const containerError = selectedContainerUri ? containerFailures.get(selectedContainerUri) : undefined;

  // 截断说明：全量纹理数 vs 本页显示数。分页与截断是两层——这里只报
  // 「还有多少没显示」，静默截断会让用户把部分数据当成全部。
  const truncationNote = formatListTruncation({
    total: textures.length,
    shown: Math.min(textureSlice.length, LIST_PAGE_SIZE),
    noun: '个纹理',
    hint: '翻页查看其余纹理'
  });

  const properties: Array<readonly [string, string]> = selectedTexture
    ? [
        ['Name', selectedTexture.name],
        ['Index', String(selectedTexture.index)],
        ['Format（条目表）', selectedTexture.format],
        ['DDS FourCC（真实封装）', selectedTexture.ddsFourCC],
        ['尺寸', `${selectedTexture.width}×${selectedTexture.height}`],
        ['Mip Levels', String(selectedTexture.mipCount)],
        ['Data Size', formatBytes(selectedTexture.dataSize)],
        ['Data Offset', `0x${selectedTexture.dataOffset.toString(16)}`],
        ['Format Byte', `0x${selectedTexture.formatByte.toString(16).padStart(2, '0')}`]
      ]
    : [];

  const columns: WorkbenchColumnSpec[] = [
    {
      id: 'containers',
      title: 'Containers',
      hint: `${props.containers.length} containers`,
      initialFlex: 0.16,
      minWidth: 150,
      children: (
        <div className="wb-list">
          {props.containers.length === 0 && <p className="wb-empty">工作区中没有 TPF 文件。</p>}
          {props.containers.map((container, index) => {
            const failure = containerFailures.get(container.sourceUri);
            return (
              <div
                key={container.sourceUri}
                className={failure ? 'wb-row wb-row--failed' : 'wb-row'}
                {...selectableRowAttributes({
                  selected: selectedContainerUri === container.sourceUri,
                  isTabEntry: isRowTabEntry(index, selectedContainerUri !== null),
                  onSelect: () => setSelectedContainerUri(container.sourceUri)
                })}
              >
                <span className="wb-row__name" title={container.relativePath}>{containerDisplayName(container)}</span>
                {failure && <span className="wb-row__meta diag-error">读取失败</span>}
              </div>
            );
          })}
        </div>
      )
    },
    {
      id: 'textures',
      title: 'Textures',
      hint: `${textures.length} textures`,
      initialFlex: 0.24,
      minWidth: 200,
      children: (
        <div className="wb-list">
          {selectedContainerUri === null && <p className="wb-empty">先在最左栏选择一个容器。</p>}
          {selectedContainerUri !== null && loading && <p className="wb-empty">加载中…</p>}
          {selectedContainerUri !== null && !loading && containerError && (
            <p className="wb-empty diag-error">{containerError.message}</p>
          )}
          {selectedContainerUri !== null && !loading && !containerError && document === null && (
            <p className="wb-empty">这个容器读不出来。</p>
          )}
          {selectedContainerUri !== null && !loading && !containerError && document !== null && (
            <>
              {truncationNote && (
                <p className="muted" data-testid="tpf-truncation">{truncationNote}</p>
              )}
              {textureSlice.map((tex, index) => (
                <div
                  key={tex.index}
                  className="wb-row"
                  {...selectableRowAttributes({
                    selected: selectedTextureIndex === tex.index,
                    isTabEntry: isRowTabEntry(index, selectedTextureIndex !== null),
                    onSelect: () => setSelectedTextureIndex(tex.index)
                  })}
                >
                  <span className="wb-row__name" title={tex.name}>{tex.name || `Texture ${tex.index}`}</span>
                  <span className="wb-row__meta">{tex.width}×{tex.height} · {tex.ddsFourCC}</span>
                </div>
              ))}
              {textureSlice.length === 0 && <p className="wb-empty">这个容器没有纹理条目。</p>}
              {texturePageCount > 1 && (
                <div className="wb-pager">
                  <button type="button" disabled={texturePage === 0} onClick={() => setTexturePage(texturePage - 1)}>‹</button>
                  <span>{texturePage + 1}/{texturePageCount}</span>
                  <button type="button" disabled={texturePage >= texturePageCount - 1} onClick={() => setTexturePage(texturePage + 1)}>›</button>
                </div>
              )}
            </>
          )}
        </div>
      )
    },
    {
      id: 'viewer',
      title: 'Viewer',
      initialFlex: 0.40,
      minWidth: 240,
      children: (
        <div className="tpf-viewer">
          {selectedTextureIndex === null && <p className="wb-empty">在中间选择一张纹理查看预览。</p>}
          {selectedTextureIndex !== null && previewLoading && <p className="wb-empty">预览生成中…</p>}
          {selectedTextureIndex !== null && !previewLoading && preview && (
            <>
              <img
                className="tpf-viewer__image"
                src={preview.previewToken}
                alt={preview.name || `纹理 ${preview.textureIndex}`}
              />
              <p className="wb-empty">
                预览 {preview.width}×{preview.height}
                {preview.sourceWidth !== preview.width || preview.sourceHeight !== preview.height
                  ? ` · 原始 ${preview.sourceWidth}×${preview.sourceHeight}`
                  : ''}
                {preview.colorSpace !== 'unknown' ? ` · ${preview.colorSpace}` : ''}
                {' '}· {formatBytes(preview.byteLength)}
              </p>
            </>
          )}
          {selectedTextureIndex !== null && !previewLoading && previewFailure && (
            <p className="wb-empty diag-error" data-testid="tpf-preview-failure">{previewFailure.message}</p>
          )}
        </div>
      )
    },
    {
      id: 'properties',
      title: 'Properties',
      initialFlex: 0.20,
      minWidth: 200,
      children: (
        <div className="wb-list">
          {selectedTextureIndex === null && <p className="wb-empty">选择一张纹理查看元数据。</p>}
          {selectedTextureIndex !== null && (
            <>
              <div className="wb-list__group-label">
                {selectedTexture?.name || `Texture ${selectedTextureIndex}`}
              </div>
              <div className="wb-props">
                {properties.map(([name, value]) => (
                  <div key={name} className="wb-prop">
                    <span className="wb-prop__name">{name}</span>
                    <span className="wb-prop__value">{value}</span>
                  </div>
                ))}
              </div>
              <div className="wb-list__group-label">写回</div>
              {/* writer 未就绪时隐藏 replace：不渲染任何替换控件，只给诚实说明。 */}
              <p className="wb-empty">纹理写回链尚未接通（TEXTURE-52C），当前没有 replace 入口。</p>
            </>
          )}
        </div>
      )
    }
  ];

  return (
    <WorkbenchLayout
      label="Texture 工作台"
      columns={columns}
      toolbar={
        <>
          <span className="crumb">Texture · {props.containers.length} containers</span>
          {document && (
            <span className="muted" style={{ fontSize: 11 }}>
              {document.textureCount} textures · {document.authority}
              {document.roundTrip?.byteIdentical ? ' · round-trip ✓' : ''}
            </span>
          )}
        </>
      }
    />
  );
}
