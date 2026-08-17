import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { isRowTabEntry, selectableRowAttributes } from '../a11y/selectableRow.js';
import {
  SceneProjectionError,
  buildMsbSceneManifest,
  buildSceneDrawList,
  type MsbMapEventLike,
  type MsbModelLike,
  type MsbRegionLike,
  type MsbSceneSourceCounts,
  type PartLike,
  type SceneDrawItem,
  type SceneManifest
} from '../scene/sceneManifestBrowser.js';
import { mountThreeProxyScene, type ProxySceneHandle } from '../scene/threeSceneController.js';
import { formatListTruncation } from '../format/uiText.js';
import { getRendererBridge } from '../runtime/rendererRuntime.js';
import { WorkbenchLayout } from '../workbench/WorkbenchLayout.js';

/** 左栏 Map Object List 里的实体分类。 */
type MsbEntityKind = 'msb-model' | 'msb-event' | 'msb-part' | 'msb-region';

/** 单个对象分组渲染上限（硬约束 17：大规模列表不能一次性全渲）。 */
const GROUP_RENDER_LIMIT = 40;

/** S23：打开地图时默认预取的 part 模型数（每个 mapbnd 读一次 Bridge，串行）。 */
const MAP_MESH_PREFETCH_LIMIT = 12;

interface SelectedEntity {
  id: string;
  label: string;
  kind: MsbEntityKind;
}

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
   * S19 失败面：打开失败的结构化诊断（code + 人话 + 下一步）。非空时工作台
   * 显示可行动错误块（如 KRAK 缺 Oodle → 到「开始」页挂原版），不再假 0 实体。
   * 与 App.tsx 的 lastOpenFailure 同源，绝不含绝对路径。
   */
  openFailure?: { code: string; message: string } | null;
  /**
   * 非空表示该编辑器已延期至指定里程碑，本版仅作标记只读预览：
   * 面板隐藏全部提交入口并显式标注延期状态。
   */
  deferredPreviewRelease?: 'V0.6';
}

/**
 * MSB 三栏地图工作台（MAP-50B）：`Map Object List | Viewport | Properties`。
 *
 * 对照 Smithbox 2.2.4 Map Editor 的流程：左侧按类型分组列出地图对象，
 * 选中后中间 viewport 用线框高亮（proxy geometry），右侧显示数值属性；
 * camera（旋转/缩放/平移）走 OrbitControls。没有真实能力时不假造：
 * transform gizmo / 资产浏览器 / Prefabs 等在本版不出现（§10.6）。
 *
 * 写链未就绪（msb 处于 deferred）时整个 footer 不渲染任何保存动作，
 * 只显式标注延期状态——与「writer 未就绪时无保存动作」一致。
 */
export function MsbScenePanel(props: MsbScenePanelProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<ProxySceneHandle | null>(null);
  const [manifest, setManifest] = useState<SceneManifest | null>(null);
  const [selected, setSelected] = useState<SelectedEntity | null>(null);
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
  const deferredRelease = props.deferredPreviewRelease;
  /** S23：最近一次 drawList（mesh 渐进加载后重建用）。 */
  const drawListRef = useRef<ReturnType<typeof buildSceneDrawList> | null>(null);
  /** S23：已加载到真实网格的 part（item id → mesh 数据）。 */
  const loadedMeshesRef = useRef<Map<string, NonNullable<SceneDrawItem['mesh']>>>(new Map());
  const [meshStatus, setMeshStatus] = useState<{ loaded: number; missing: number } | null>(null);
  /** S23：刷新场景里的 part 网格（每加载/选中一个就渐进 setDrawList）。 */
  const applyLoadedMeshes = useCallback((base: ReturnType<typeof buildSceneDrawList> | null) => {
    if (!base || !handleRef.current) return;
    const updated: SceneDrawItem[] = base.items.map((item) => {
      const mesh = loadedMeshesRef.current.get(item.id);
      return mesh ? { ...item, mesh } : item;
    });
    handleRef.current.setDrawList({ ...base, items: updated });
  }, []);

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
      setManifest(null);
      setNodeCount(0);
      return;
    }

    let sceneManifest: ReturnType<typeof buildMsbSceneManifest>;
    let drawList: ReturnType<typeof buildSceneDrawList>;
    try {
      sceneManifest = buildMsbSceneManifest({
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
      drawList = buildSceneDrawList(sceneManifest, { maxItems: props.maxNodes ?? 2000 });
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
      setManifest(null);
      setNodeCount(0);
      console.error('[MsbScenePanel] 场景投影失败', { code, message });
      return;
    }
    setManifest(sceneManifest);
    setNodeCount(drawList.itemCount);

    void mountThreeProxyScene({
      container: host,
      drawList,
      onSelect: (id) => {
        // viewport 点击 → 左栏与右栏同步：用 manifest 里的实体补全 kind。
        const node = sceneManifest.nodes.find((candidate) => candidate.id === id) ?? null;
        if (!node) return;
        setSelected({ id: node.id, label: node.label, kind: node.kind });
      }
    }).then((handle) => {
      if (cancelled) {
        handle.dispose();
        return;
      }
      handleRef.current = handle;
      drawListRef.current = drawList;
      const partial = sceneManifest.diagnostics.some((item) => item.code === 'SCENE_PROJECTION_PARTIAL');
      setStatus(
        `3D 场景已加载（${drawList.itemCount} 节点 / ${sceneManifest.entityCount} 实体）`
        + (partial ? ' · Bridge 实体预览为 partial' : '')
      );
    }).catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : '3D 场景初始化失败');
    });

    return () => {
      cancelled = true;
      handleRef.current?.dispose();
      handleRef.current = null;
      drawListRef.current = null;
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

  /**
   * S23：地图 part 模型渐进加载——mapbnd 里按 part 名取 FLVER 网格，
   * 加载到的 part 用真实几何替换 proxy 盒子（`setDrawList` 渐进更新），
   * 没有模型或未挂原版的 part 保持线框并汇总一句可行动状态。
   */
  useEffect(() => {
    const bridge = getRendererBridge();
    if (!bridge || typeof bridge.readMapPartMesh !== 'function' || !props.mapResourceUri) return;
    const base = drawListRef.current;
    if (!base) return;
    const parts = base.items.filter((item) => item.entityKind === 'msb-part');
    if (parts.length === 0) return;
    let cancelled = false;
    const targets = parts.slice(0, MAP_MESH_PREFETCH_LIMIT);
    setMeshStatus(null);
    void (async () => {
      let loaded = 0;
      let missing = 0;
      for (const item of targets) {
        if (cancelled) return;
        if (loadedMeshesRef.current.has(item.id)) {
          if (loadedMeshesRef.current.get(item.id)) loaded += 1;
          continue;
        }
        try {
          const raw = await bridge.readMapPartMesh(props.mapResourceUri, item.label) as {
            ok?: boolean;
            data?: {
              positionsBase64?: string;
              indicesBase64?: string;
              uvsBase64?: string;
              normalsBase64?: string;
              vertexCount?: number;
            };
          };
          if (cancelled) return;
          if (raw.ok && raw.data?.positionsBase64) {
            loadedMeshesRef.current.set(item.id, {
              positionsBase64: raw.data.positionsBase64,
              ...(raw.data.indicesBase64 ? { indicesBase64: raw.data.indicesBase64 } : {}),
              ...(raw.data.uvsBase64 ? { uvsBase64: raw.data.uvsBase64 } : {}),
              ...(raw.data.normalsBase64 ? { normalsBase64: raw.data.normalsBase64 } : {}),
              vertexCount: raw.data.vertexCount ?? 0
            });
            loaded += 1;
          } else {
            missing += 1;
          }
        } catch {
          if (cancelled) return;
          missing += 1;
        }
        applyLoadedMeshes(drawListRef.current);
      }
      if (!cancelled) setMeshStatus({ loaded, missing });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.mapResourceUri, props.parts]);

  /** S23：选中 part 时补载它的模型（预取窗口外的 part 点开也能看）。 */
  useEffect(() => {
    if (selected?.kind !== 'msb-part') return;
    const bridge = getRendererBridge();
    if (!bridge || typeof bridge.readMapPartMesh !== 'function' || !props.mapResourceUri) return;
    if (loadedMeshesRef.current.has(selected.id)) return;
    let cancelled = false;
    void (async () => {
      try {
        const raw = await bridge.readMapPartMesh(props.mapResourceUri, selected.label) as {
          ok?: boolean;
          data?: {
            positionsBase64?: string;
            indicesBase64?: string;
            uvsBase64?: string;
            normalsBase64?: string;
            vertexCount?: number;
          };
        };
        if (cancelled || !raw.ok || !raw.data?.positionsBase64) return;
        loadedMeshesRef.current.set(selected.id, {
          positionsBase64: raw.data.positionsBase64,
          ...(raw.data.indicesBase64 ? { indicesBase64: raw.data.indicesBase64 } : {}),
          ...(raw.data.uvsBase64 ? { uvsBase64: raw.data.uvsBase64 } : {}),
          ...(raw.data.normalsBase64 ? { normalsBase64: raw.data.normalsBase64 } : {}),
          vertexCount: raw.data.vertexCount ?? 0
        });
        applyLoadedMeshes(drawListRef.current);
      } catch {
        // 选中补载失败保持线框（预取汇总已说明情况）。
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.kind, selected?.id, selected?.label, props.mapResourceUri, applyLoadedMeshes]);

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

  /**
   * 选中左栏对象：更新选中态，part/region 同时驱动 viewport 线框高亮。
   * model/event 没有可绘制节点，viewport 不动（对照 Smithbox：只有放置对象才有 3D 句柄）。
   */
  function selectEntity(entity: SelectedEntity): void {
    setSelected(entity);
    if (entity.kind === 'msb-part' || entity.kind === 'msb-region') {
      handleRef.current?.setSelected(entity.id);
    }
  }

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
    const region = regions.find((r) => r.name === selected?.label && selected.kind === 'msb-region');
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

  /**
   * 左栏对象分组（Map Object List）：Model / Event / Region / Part。
   *
   * 由 scene manifest 派生而不是 props 各数组直接拼：条目带稳定 id
   * （`<kind>:offset-<hex>` 或 name 退化），左栏选中 ↔ viewport 高亮用同一把 id。
   */
  const groupedEntities = useMemo(() => {
    const entities = manifest?.entities ?? [];
    // entities 的 kind 字段是 MsbSceneEntityKind 联合；pick 返回同子集的数组，
    // 赋值给 SelectedEntity.kind 是结构兼容的（字面量联合等价）。
    const pick = (kind: MsbEntityKind) => entities.filter((entity) => entity.kind === kind);
    return [
      { id: 'model', label: 'Model', entries: pick('msb-model') },
      { id: 'event', label: 'Event', entries: pick('msb-event') },
      { id: 'region', label: 'Region', entries: pick('msb-region') },
      { id: 'part', label: 'Part', entries: pick('msb-part') }
    ];
  }, [manifest]);

  /**
   * 右栏 Properties 的数值格式化（与视图分离）：
   * 三维场景看空间关系，属性表看数值 —— 前者不负责回答「这个 ObjAct 的
   * Entity ID 是多少」，后者才是。格式化放这里而不是工作台组件里，
   * 避免把布局组件绑死到 MSB 字段上。
   */
  const num = (value: number | undefined): string =>
    value === undefined ? '' : String(Math.round(value * 1e4) / 1e4);

  function propertiesFor(entity: SelectedEntity): Array<readonly [string, string]> {
    if (entity.kind === 'msb-part') {
      const part = props.parts.find((candidate) => candidate.name === entity.label);
      return [
        ['Name', entity.label],
        ...(part?.typeId !== undefined ? [['Type ID', String(part.typeId)] as const] : []),
        ['Position X', num(part?.posX)],
        ['Position Y', num(part?.posY)],
        ['Position Z', num(part?.posZ)],
        ['Rotation X', num(part?.rotX)],
        ['Rotation Y', num(part?.rotY)],
        ['Rotation Z', num(part?.rotZ)],
        ['Scale X', num(part?.scaleX)],
        ['Scale Y', num(part?.scaleY)],
        ['Scale Z', num(part?.scaleZ)]
      ];
    }
    if (entity.kind === 'msb-region') {
      const region = props.regions?.find((candidate) => candidate.name === entity.label);
      return [
        ['Name', entity.label],
        ...(region?.typeId !== undefined ? [['Type ID', String(region.typeId)] as const] : []),
        ['Position X', num(region?.posX)],
        ['Position Y', num(region?.posY)],
        ['Position Z', num(region?.posZ)],
        ['Rotation X', num(region?.rotX)],
        ['Rotation Y', num(region?.rotY)],
        ['Rotation Z', num(region?.rotZ)],
        ['Scale X', num(region?.scaleX)],
        ['Scale Y', num(region?.scaleY)],
        ['Scale Z', num(region?.scaleZ)]
      ];
    }
    if (entity.kind === 'msb-model') {
      const model = props.models?.find((candidate) => candidate.name === entity.label);
      return [
        ['Name', entity.label],
        ...(model?.sibPath ? [['Sib Path', model.sibPath] as const] : []),
        ...(model?.typeId !== undefined ? [['Type ID', String(model.typeId)] as const] : [])
      ];
    }
    const mapEvent = props.events?.find((candidate) => candidate.name === entity.label);
    return [
      ['Name', entity.label],
      ...(mapEvent?.typeId !== undefined ? [['Type ID', String(mapEvent.typeId)] as const] : [])
    ];
  }

  return (
    <WorkbenchLayout
      label="MSB 地图工作台"
      columns={[
        {
          id: 'map-object-list',
          title: 'Map Object List',
          hint: `${manifest?.entityCount ?? 0} 实体`,
          initialFlex: 0.25,
          minWidth: 200,
          children: (
            <div className="msb-object-list">
              {props.openFailure ? (
                <div className="msb-open-failure" role="alert">
                  <p className="msb-open-failure__code">{props.openFailure.code}</p>
                  <p>{props.openFailure.message}</p>
                </div>
              ) : manifest === null ? (
                <p className="muted">未加载 MSB 数据：请先在资源浏览器里选择一个 map 资源。</p>
              ) : groupedEntities.map((group, groupIndex) => {
                // 硬约束 17：对象列表也可能上千条，分组内条目要分页而不是一次全渲；
                // 超限必须报「已显示多少」，不能静默 slice（守门 site 锚点 region）。
                const visible = group.entries.slice(0, GROUP_RENDER_LIMIT);
                const truncationNote = formatListTruncation({
                  total: group.entries.length,
                  shown: visible.length,
                  noun: `个 ${group.label}`
                });
                return (
                  <details key={group.id} className="msb-object-group" open={group.entries.length > 0}>
                    <summary className="msb-object-group__summary">
                      {group.label}
                      <span className="muted"> {group.entries.length}</span>
                    </summary>
                    {group.entries.length === 0 ? (
                      <p className="muted msb-object-group__empty">无 {group.label} 实体</p>
                    ) : (
                      <>
                        <div className="binder-child-table" role="table" aria-label={`${group.label} 实体`}>
                          {visible.map((entity, index) => (
                            <div
                              key={entity.id}
                              className="binder-child-row msb-object-row"
                              {...selectableRowAttributes({
                                selected: selected?.id === entity.id,
                                isTabEntry: groupIndex === 0 && isRowTabEntry(index, selected !== null),
                                onSelect: () => selectEntity(entity)
                              })}
                              style={selected?.id === entity.id
                                ? { outline: '1px solid var(--ember)' }
                                : undefined}
                            >
                              <span title={entity.label}>{entity.label.slice(0, 40)}</span>
                            </div>
                          ))}
                        </div>
                        {truncationNote && (
                          group.id === 'region' ? (
                            <p className="muted" data-testid="msb-region-truncation">{truncationNote}</p>
                          ) : (
                            <p className="muted" data-testid={`${group.id}-truncation`}>{truncationNote}</p>
                          )
                        )}
                      </>
                    )}
                  </details>
                );
              })}
            </div>
          )
        },
        {
          id: 'viewport',
          title: 'Viewport',
          children: (
            <div className="msb-viewport">
              <div ref={hostRef} className="scene-host" style={{ minHeight: 320, background: '#1a1d23' }} />
              <p className="muted">
                {props.openFailure
                  ? props.openFailure.message
                  : (nodeCount > 0
                      ? (() => {
                          const meshNote = meshStatus === null
                            ? ''
                            : meshStatus.loaded > 0
                              ? ` · ${meshStatus.loaded} 个 part 已挂模型${meshStatus.missing > 0 ? `，${meshStatus.missing} 个没找到（线框）` : ''}`
                              : meshStatus.missing > 0
                                ? ' · 没有找到 part 模型（线框）；未挂原版时可到「开始」页挂载后重开'
                                : '';
                          return `节点 ${nodeCount} · region ${regions.length}${meshNote}`;
                        })()
                      : status)}
              </p>
              {(selected?.kind === 'msb-part' || selected?.kind === 'msb-region') ? (
                <p data-testid="msb-selected-summary">
                  已选择 {selected.kind === 'msb-region' ? 'region' : 'part'}：{selected.label}
                </p>
              ) : null}
            </div>
          )
        },
        {
          id: 'properties',
          title: 'Properties',
          ...(selected ? { hint: selected.label } : {}),
          initialFlex: 0.3,
          minWidth: 240,
          children: selected ? (
            <div className="binder-child-table" role="table" aria-label={`${selected.label} 属性`}>
              {propertiesFor(selected).map(([key, value]) => (
                <div className="binder-child-row msb-property-row" role="row" key={key}>
                  <span className="muted">{key}</span>
                  <span>{value}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">在左侧对象列表中选择一个对象后显示属性。</p>
          )
        }
      ]}
      footer={
        deferredRelease ? (
          <div className="row gap">
            <p className="muted" role="note">
              MSB 编辑已延期至 {deferredRelease}：本版仅提供只读预览，无位置提交入口。
              既有 write-msb typed mutation 写链已在本版关闭，主进程会拒绝写入请求。
            </p>
          </div>
        ) : (
          <div className="row gap">
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
                disabled={selected?.kind !== 'msb-region'}
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
            <p className="muted">
              {props.writeEnabled
                ? '实时模式：part/region 位置微调经 Bridge write-msb → Patch Engine 提交。'
                : 'MSB 写入未开放：微调仅为本地预览，不会写入。'}
            </p>
          </div>
        )
      }
    />
  );
}
