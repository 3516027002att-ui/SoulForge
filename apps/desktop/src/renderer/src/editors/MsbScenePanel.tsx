import { useEffect, useRef, useState, type ReactElement } from 'react';
import { isRowTabEntry, selectableRowAttributes } from '../a11y/selectableRow.js';
import {
  SceneProjectionError,
  buildMsbSceneManifest,
  buildSceneDrawList,
  type MsbMapEventLike,
  type MsbModelLike,
  type MsbRegionLike,
  type MsbSceneSourceCounts,
  type PartLike
} from '../scene/sceneManifestBrowser.js';
import { mountThreeProxyScene, type ThreeSceneHandle } from '../scene/threeSceneController.js';
import { formatListTruncation } from '../format/uiText.js';

/** Region 表渲染上限。 */
const REGION_RENDER_LIMIT = 40;

export interface MsbScenePanelProps {
  mapResourceUri: string;
  sourcePath: string;
  game: string;
  revision: string;
  models?: MsbModelLike[];
  parts: PartLike[];
  regions?: MsbRegionLike[];
  events?: MsbMapEventLike[];
  sourceCounts?: MsbSceneSourceCounts;
  maxNodes?: number;
  /** When set, enables structured part position nudge commits via parent (Patch Engine path). */
  onPartPositionCommit?: (input: {
    partName: string;
    posX: number;
    posY: number;
    posZ: number;
  }) => void;
  onRegionPositionCommit?: (input: {
    partName: string;
    posX: number;
    posY: number;
    posZ: number;
  }) => void;
  /** When set, enables full part transform commits (position + rotation + scale). */
  onPartTransformCommit?: (input: {
    partName: string;
    posX: number;
    posY: number;
    posZ: number;
    rotX: number;
    rotY: number;
    rotZ: number;
    scaleX: number;
    scaleY: number;
    scaleZ: number;
  }) => void;
  writeEnabled?: boolean;
  /**
   * 非空表示该编辑器已延期至指定里程碑，本版仅作标记只读预览：
   * 面板隐藏全部提交入口并显式标注延期状态。
   */
  deferredPreviewRelease?: 'V0.6';
}

/**
 * MSB 3D 代理场景：SceneManifest → DrawList → Three.js 代理几何。
 * 不含绝对路径；选择事件仅回传 part id。
 */
export function MsbScenePanel(props: MsbScenePanelProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<ThreeSceneHandle | null>(null);
  const [selected, setSelected] = useState<{
    id: string;
    label: string;
    kind: 'msb-part' | 'msb-region';
  } | null>(null);
  const [selectedRegion, setSelectedRegion] = useState<string | null>(null);
  const [status, setStatus] = useState('正在初始化 3D 场景…');
  const [nodeCount, setNodeCount] = useState(0);
  const [nudge, setNudge] = useState({ x: 0.5, y: 0, z: 0 });
  const [transform, setTransform] = useState<{
    rotX: number;
    rotY: number;
    rotZ: number;
    scaleX: number;
    scaleY: number;
    scaleZ: number;
  }>({ rotX: 0, rotY: 0, rotZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 });
  const regions = props.regions ?? [];
  const regionTruncationNote = formatListTruncation({
    total: regions.length,
    shown: Math.min(regions.length, REGION_RENDER_LIMIT),
    noun: '个 region'
  });

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

    // 未选中资源时不构建场景，直接进空态。
    //
    // 实测缺陷：App.tsx 传 `selectedFile?.sourceUri ?? ''`，未选文件时是空字符串；
    // validateMetadata 要求 sourceUri 含 '://'，于是抛 SCENE_URI_INVALID。这个异常
    // 在 useEffect 里同步抛出、无人捕获，会冒泡成未捕获错误并**炸掉整个 React 树**
    // ——实测点资源栏的 map 目录后，界面全部元素消失（按钮不在 DOM、其余 tab 点不动、
    // Tab 键无任何停靠点），等于应用白屏。
    //
    // 这里做两层：先空态早退（正常路径不该走到校验失败），再对构建过程兜 try/catch
    // （投影校验是安全边界，它该继续 fail-closed，但失败必须呈现为面板内可读状态，
    // 不能把整个界面带走）。
    if (!props.mapResourceUri || !props.mapResourceUri.includes('://')) {
      setStatus('未选中可解析的 MSB 资源：请先在资源浏览器里选择一个 map 资源。');
      setNodeCount(0);
      return;
    }

    let manifest: ReturnType<typeof buildMsbSceneManifest>;
    let drawList: ReturnType<typeof buildSceneDrawList>;
    try {
      manifest = buildMsbSceneManifest({
        sourceUri: props.mapResourceUri,
        sourcePath: props.sourcePath,
        game: props.game,
        resourceKind: 'map',
        revision: props.revision,
        ...(props.models ? { models: props.models } : {}),
        parts: props.parts,
        regions,
        ...(props.events ? { events: props.events } : {}),
        ...(props.sourceCounts ? { sourceCounts: props.sourceCounts } : {}),
        maxNodes: props.maxNodes ?? 2000,
        chunkSize: 512
      });
      drawList = buildSceneDrawList(manifest, { maxItems: props.maxNodes ?? 2000 });
    } catch (error) {
      // 结构化呈现，不吞：把诊断码与消息给用户，同时留在 console 供排查。
      // 注意 SceneProjectionError 的构造是 super(code)，所以 Error.message 里装的是
      // **码**而不是人话；可读消息在 diagnostic.message。直接用 error.message 会把
      // 「SCENE_URI_INVALID」当描述展示给用户。
      const code = error instanceof SceneProjectionError
        ? error.diagnostic.code
        : 'SCENE_BUILD_FAILED';
      const message = error instanceof SceneProjectionError
        ? error.diagnostic.message
        : (error instanceof Error ? error.message : String(error));
      setStatus(`场景投影失败（${code}）：${message}`);
      setNodeCount(0);
      console.error('[MsbScenePanel] 场景投影失败', { code, message });
      return;
    }
    setNodeCount(drawList.itemCount);

    void mountThreeProxyScene({
      container: host,
      drawList,
      onSelect: (id) => {
        const node = manifest.nodes.find((candidate) => candidate.id === id) ?? null;
        setSelected(node ? { id: node.id, label: node.label, kind: node.kind } : null);
        if (node?.kind === 'msb-region') setSelectedRegion(node.label);
      }
    }).then((handle) => {
      if (cancelled) {
        handle.dispose();
        return;
      }
      handleRef.current = handle;
      const partial = manifest.diagnostics.some((item) => item.code === 'SCENE_PROJECTION_PARTIAL');
      setStatus(
        `3D 代理场景已加载（${drawList.itemCount} 节点 / ${manifest.entityCount} 实体）`
        + (partial ? ' · Bridge 实体预览为 partial' : '')
      );
    }).catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : '3D 场景初始化失败');
    });

    return () => {
      cancelled = true;
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, [
    props.mapResourceUri,
    props.sourcePath,
    props.game,
    props.revision,
    props.models,
    props.parts,
    props.regions,
    props.events,
    props.sourceCounts,
    props.maxNodes
  ]);

  function resolveSelectedPart(): PartLike | null {
    if (selected?.kind !== 'msb-part') return null;
    return props.parts.find((part) => part.name === selected.label) ?? null;
  }

  // 选中 part 变化时同步 transform 编辑字段（rotation 为角度，scale 为倍率）。
  useEffect(() => {
    const part = resolveSelectedPart();
    if (!part) return;
    setTransform({
      rotX: part.rotX ?? 0,
      rotY: part.rotY ?? 0,
      rotZ: part.rotZ ?? 0,
      scaleX: part.scaleX ?? 1,
      scaleY: part.scaleY ?? 1,
      scaleZ: part.scaleZ ?? 1
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, props.parts]);

  function commitNudge(): void {
    const part = resolveSelectedPart();
    if (!part) {
      setStatus('请先选择一个 part 节点。');
      return;
    }
    if (!props.writeEnabled || !props.onPartPositionCommit) {
      setStatus('MSB 写入在当前版本未开放：位置微调仅为本地预览，不会写入。');
      return;
    }
    const next = {
      partName: part.name,
      posX: part.posX + nudge.x,
      posY: part.posY + nudge.y,
      posZ: part.posZ + nudge.z
    };
    setStatus(`正在提交 part 位置：${part.name}`);
    props.onPartPositionCommit(next);
  }

  function commitRegionNudge(): void {
    const region = regions.find((r) => r.name === selectedRegion);
    if (!region) {
      setStatus('请先选择一个 region。');
      return;
    }
    if (!props.writeEnabled || !props.onRegionPositionCommit) {
      setStatus('MSB 写入在当前版本未开放：region 位置微调仅为本地预览，不会写入。');
      return;
    }
    props.onRegionPositionCommit({
      partName: region.name,
      posX: region.posX + nudge.x,
      posY: region.posY + nudge.y,
      posZ: region.posZ + nudge.z
    });
    setStatus(`正在提交 region 位置：${region.name}`);
  }

  function commitTransform(): void {
    const part = resolveSelectedPart();
    if (!part) {
      setStatus('请先选择一个 part 节点。');
      return;
    }
    if (!props.writeEnabled || !props.onPartTransformCommit) {
      setStatus('MSB 写入在当前版本未开放：transform 更新仅为本地预览，不会写入。');
      return;
    }
    props.onPartTransformCommit({
      partName: part.name,
      posX: part.posX,
      posY: part.posY,
      posZ: part.posZ,
      rotX: transform.rotX,
      rotY: transform.rotY,
      rotZ: transform.rotZ,
      scaleX: transform.scaleX,
      scaleY: transform.scaleY,
      scaleZ: transform.scaleZ
    });
    setStatus(`正在提交 part transform：${part.name}`);
  }

  const deferredRelease = props.deferredPreviewRelease;

  return (
    <section className="panel editor-msb-scene" aria-label="MSB 三维场景">
      <header className="panel-header">
        <h3>
          MSB 三维场景（代理几何）
          {deferredRelease ? `· ${deferredRelease} 只读预览` : null}
        </h3>
        <span className="muted">
          节点 {nodeCount} · region {regions.length} · 无绝对路径
        </span>
      </header>
      {deferredRelease ? (
        <p className="muted" role="note">
          MSB 编辑已延期至 {deferredRelease}：本版仅提供只读预览，不提供位置提交入口。
        </p>
      ) : null}
      <div ref={hostRef} className="scene-host" style={{ minHeight: 280, background: '#1a1d23' }} />
      <p className="muted">{status}</p>
      {selected ? <p>已选择 {selected.kind === 'msb-region' ? 'region' : 'part'}：{selected.label}</p> : null}
      {deferredRelease ? null : (
      <>
      <div className="row gap" aria-label="part 位置微调">
        <label>
          ΔX
          <input
            type="number"
            step="0.1"
            value={nudge.x}
            onChange={(e) => setNudge((n) => ({ ...n, x: Number(e.target.value) || 0 }))}
          />
        </label>
        <label>
          ΔY
          <input
            type="number"
            step="0.1"
            value={nudge.y}
            onChange={(e) => setNudge((n) => ({ ...n, y: Number(e.target.value) || 0 }))}
          />
        </label>
        <label>
          ΔZ
          <input
            type="number"
            step="0.1"
            value={nudge.z}
            onChange={(e) => setNudge((n) => ({ ...n, z: Number(e.target.value) || 0 }))}
          />
        </label>
        <button
          type="button"
          disabled={selected?.kind !== 'msb-part'}
          onClick={commitNudge}
        >
          提交 part 位置
        </button>
        <button
          type="button"
          disabled={!selectedRegion}
          onClick={commitRegionNudge}
        >
          提交 region 位置
        </button>
      </div>
      <div className="row gap" aria-label="part transform 微调">
        <label>
          rotX
          <input
            type="number"
            step="1"
            value={transform.rotX}
            onChange={(e) => setTransform((t) => ({ ...t, rotX: Number(e.target.value) || 0 }))}
          />
        </label>
        <label>
          rotY
          <input
            type="number"
            step="1"
            value={transform.rotY}
            onChange={(e) => setTransform((t) => ({ ...t, rotY: Number(e.target.value) || 0 }))}
          />
        </label>
        <label>
          rotZ
          <input
            type="number"
            step="1"
            value={transform.rotZ}
            onChange={(e) => setTransform((t) => ({ ...t, rotZ: Number(e.target.value) || 0 }))}
          />
        </label>
        <label>
          scaleX
          <input
            type="number"
            step="0.1"
            value={transform.scaleX}
            onChange={(e) => setTransform((t) => ({ ...t, scaleX: Number(e.target.value) || 1 }))}
          />
        </label>
        <label>
          scaleY
          <input
            type="number"
            step="0.1"
            value={transform.scaleY}
            onChange={(e) => setTransform((t) => ({ ...t, scaleY: Number(e.target.value) || 1 }))}
          />
        </label>
        <label>
          scaleZ
          <input
            type="number"
            step="0.1"
            value={transform.scaleZ}
            onChange={(e) => setTransform((t) => ({ ...t, scaleZ: Number(e.target.value) || 1 }))}
          />
        </label>
        <button
          type="button"
          disabled={selected?.kind !== 'msb-part'}
          onClick={commitTransform}
        >
          提交 part transform
        </button>
      </div>
      </>
      )}
      {regions.length > 0 && (
        <div className="binder-child-table" role="table" aria-label="MSB regions">
          <div className="binder-child-row binder-child-header" role="row">
            <span>Region</span>
            <span>Type</span>
            <span>位置</span>
          </div>
          {/* 行选择必须键盘可达：选中区域后才会显示坐标详情与场景高亮。 */}
          {regions.slice(0, REGION_RENDER_LIMIT).map((region, rowIndex) => (
            <div
              key={region.name}
              className="binder-child-row"
              {...selectableRowAttributes({
                selected: selectedRegion === region.name,
                isTabEntry: isRowTabEntry(rowIndex, selectedRegion !== null),
                onSelect: () => setSelectedRegion(region.name)
              })}
              style={selectedRegion === region.name ? { outline: '1px solid var(--accent, #6af)' } : undefined}
            >
              <span title={region.name}>{region.name.slice(0, 28)}</span>
              <span>{region.typeId}</span>
              <span className="muted">
                {region.posX.toFixed(1)}, {region.posY.toFixed(1)}, {region.posZ.toFixed(1)}
              </span>
            </div>
          ))}
          {/* 文案走统一 helper：此前是手写串，与其他面板口径不一致（不报「未显示多少」）。 */}
          {regionTruncationNote && (
            <p className="muted" data-testid="msb-region-truncation">{regionTruncationNote}</p>
          )}
        </div>
      )}
      <p className="muted">
        {deferredRelease
          ? `${deferredRelease} 只读预览：既有 write-msb typed mutation 写链已在本版关闭，主进程会拒绝写入请求。`
          : props.writeEnabled
            ? '实时模式：part/region 位置微调经 Bridge write-msb → Patch Engine 提交。'
            : 'MSB 写入未开放：微调仅为本地预览，不会写入。'}
      </p>
    </section>
  );
}
