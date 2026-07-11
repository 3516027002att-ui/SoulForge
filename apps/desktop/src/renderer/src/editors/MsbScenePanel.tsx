import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  buildMsbSceneManifest,
  buildSceneDrawList,
  type PartLike
} from '../scene/sceneManifestBrowser.js';
import { mountThreeProxyScene, type ThreeSceneHandle } from '../scene/threeSceneController.js';

export interface MsbRegionLike {
  name: string;
  typeId: number;
  posX: number;
  posY: number;
  posZ: number;
}

export interface MsbScenePanelProps {
  mapResourceUri: string;
  parts: PartLike[];
  regions?: MsbRegionLike[];
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
  writeEnabled?: boolean;
}

/**
 * MSB 3D 代理场景：SceneManifest → DrawList → Three.js 代理几何。
 * 不含绝对路径；选择事件仅回传 part id。
 */
export function MsbScenePanel(props: MsbScenePanelProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<ThreeSceneHandle | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedRegion, setSelectedRegion] = useState<string | null>(null);
  const [status, setStatus] = useState('正在初始化 3D 场景…');
  const [nodeCount, setNodeCount] = useState(0);
  const [nudge, setNudge] = useState({ x: 0.5, y: 0, z: 0 });
  const regions = props.regions ?? [];

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

    const manifest = buildMsbSceneManifest({
      mapResourceUri: props.mapResourceUri,
      parts: props.parts,
      maxNodes: props.maxNodes ?? 2000,
      chunkSize: 512
    });
    const drawList = buildSceneDrawList(manifest, { maxItems: props.maxNodes ?? 2000 });
    setNodeCount(drawList.itemCount);

    void mountThreeProxyScene({
      container: host,
      drawList,
      onSelect: (id) => setSelected(id)
    }).then((handle) => {
      if (cancelled) {
        handle.dispose();
        return;
      }
      handleRef.current = handle;
      setStatus(`3D 代理场景已加载（${drawList.itemCount} 节点）`);
    }).catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : '3D 场景初始化失败');
    });

    return () => {
      cancelled = true;
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, [props.mapResourceUri, props.parts, props.maxNodes]);

  function resolveSelectedPart(): PartLike | null {
    if (!selected) return null;
    // Draw ids look like part:index:name — prefer exact name match first.
    const byName = props.parts.find((p) => p.name === selected);
    if (byName) return byName;
    const suffix = selected.includes(':') ? selected.slice(selected.lastIndexOf(':') + 1) : selected;
    return props.parts.find((p) => p.name === suffix) ?? null;
  }

  function commitNudge(): void {
    const part = resolveSelectedPart();
    if (!part) {
      setStatus('请先选择一个 part 节点。');
      return;
    }
    if (!props.writeEnabled || !props.onPartPositionCommit) {
      setStatus('当前为演示模式：位置微调不会提交到补丁引擎。');
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
      setStatus('当前为演示模式：region 位置微调不会提交到补丁引擎。');
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

  return (
    <section className="panel editor-msb-scene" aria-label="MSB 三维场景">
      <header className="panel-header">
        <h3>MSB 三维场景（代理几何）</h3>
        <span className="muted">
          节点 {nodeCount} · region {regions.length} · 无绝对路径
        </span>
      </header>
      <div ref={hostRef} className="scene-host" style={{ minHeight: 280, background: '#1a1d23' }} />
      <p className="muted">{status}</p>
      {selected ? <p>已选择 part：{selected}</p> : null}
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
          disabled={!selected}
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
      {regions.length > 0 && (
        <div className="binder-child-table" role="table" aria-label="MSB regions">
          <div className="binder-child-row binder-child-header" role="row">
            <span>Region</span>
            <span>Type</span>
            <span>位置</span>
          </div>
          {regions.slice(0, 40).map((region) => (
            <div
              key={region.name}
              className="binder-child-row"
              role="row"
              onClick={() => setSelectedRegion(region.name)}
              style={selectedRegion === region.name ? { outline: '1px solid var(--accent, #6af)' } : undefined}
            >
              <span title={region.name}>{region.name.slice(0, 28)}</span>
              <span>{region.typeId}</span>
              <span className="muted">
                {region.posX.toFixed(1)}, {region.posY.toFixed(1)}, {region.posZ.toFixed(1)}
              </span>
            </div>
          ))}
          {regions.length > 40 && (
            <p className="muted">仅显示前 40 个 region（共 {regions.length}）。</p>
          )}
        </div>
      )}
      <p className="muted">
        {props.writeEnabled
          ? '实时模式：part/region 位置微调经 Bridge write-msb → Patch Engine 提交。'
          : '演示模式：微调仅本地提示，不会写入。'}
      </p>
    </section>
  );
}
