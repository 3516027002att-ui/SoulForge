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
import { getRendererBridge } from '../runtime/rendererRuntime.js';
import { WorkbenchLayout } from '../workbench/WorkbenchLayout.js';
import type { MapEditTransaction } from '@soulforge/shared';

/**
 * 按 models[modelIndex].name 解析真实 FLVER 名（mapbnd 容器读链）。
 * 供 SceneDrawItem 去重加载使用：优先取 item.modelName（来自 buildSceneDrawList 的
 * manifest.models[modelIndex]），缺省时回退到 props.models[modelIndex]。
 * 返回 undefined 时该 part 保持线框，不发起 Bridge。
 */
export function resolvePartModelName(
  part: { label?: string; modelName?: string; modelIndex?: number } | string,
  models?: MsbModelLike[]
): string | undefined {
  if (typeof part === 'string') return undefined;
  if (part.modelName) return part.modelName;
  if (typeof part.modelIndex === 'number' && models?.[part.modelIndex]?.name) {
    return models[part.modelIndex]!.name;
  }
  return undefined;
}

/** 与 main 的 loadMapDocument 保持同一份 mapId 派生规则，供 human transaction 使用。 */
export function deriveMapIdFromSourcePath(sourcePath: string): string {
  const basename = sourcePath.replace(/\\/g, '/').split('/').pop() ?? sourcePath;
  return basename.replace(/\.msb(?:\.dcx)?$/i, '');
}

/** 左栏 Map Object List 里的实体分类。 */
type MsbEntityKind = 'msb-model' | 'msb-event' | 'msb-part' | 'msb-region';

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
  /**
   * S19 失败面：打开失败的结构化诊断（code + 人话 + 下一步）。非空时工作台
   * 显示可行动错误块（如 KRAK 缺 Oodle → 到「开始」页挂原版），不再假 0 实体。
   * 与 App.tsx 的 lastOpenFailure 同源，绝不含绝对路径。
   */
  openFailure?: { code: string; message: string } | null;
}

/**
 * MSB 三栏地图工作台（MAP-50B）：`Map Object List | Viewport | Properties`。
 *
 * 对照 Smithbox 2.2.4 Map Editor 的流程：左侧按类型分组列出地图对象，
 * 选中后中间 viewport 用线框高亮（proxy geometry），右侧显示数值属性；
 * camera（旋转/缩放/平移）走 OrbitControls。没有真实能力时不假造：
 * transform gizmo / 资产浏览器 / Prefabs 等在本版不出现（§10.6）。
 *
 * 问题4-A：打开地图默认按**全部** part 拉模型（可报进度「已挂 N / M」），不再只
 * 预取前 12 个；对象列表 entries.map 全量渲染，名字不 slice 截断（窄栏用
 * ellipsis + title 全名，但数据不砍），不写虚拟滚动。
 * 问题4-B：地图写入入口（Δ 微调 / transform 输入 / 三个提交按钮 / 「实时模式」）
 * 整段从本面板移除——Properties 栏保持只读属性表；写入另立案，不偷偷留一条。
 */
export function MsbScenePanel(props: MsbScenePanelProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<ProxySceneHandle | null>(null);
  const [manifest, setManifest] = useState<SceneManifest | null>(null);
  const [selected, setSelected] = useState<SelectedEntity | null>(null);
  const [status, setStatus] = useState('正在初始化 3D 场景…');
  const [nodeCount, setNodeCount] = useState(0);
  const [transformMode, setTransformMode] = useState<'translate' | 'rotate' | 'scale'>('translate');
  const [partsState, setPartsState] = useState<PartLike[]>(props.parts);
  const regions = props.regions ?? [];

  useEffect(() => {
    setPartsState(props.parts);
  }, [props.parts]);
  /** S23：最近一次 drawList（mesh 渐进加载后重建用）。 */
  const drawListRef = useRef<ReturnType<typeof buildSceneDrawList> | null>(null);
  /** 按 modelName 去重后的网格：modelName → mesh。同一模型只读一次 Bridge，多 part 共享引用。 */
  const loadedModelMeshesRef = useRef<Map<string, NonNullable<SceneDrawItem['mesh']>>>(new Map());
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  const handleSavePartTransform = useCallback(async (partName: string) => {
    const current = partsState.find((p) => p.name === partName);
    if (!current) return;
    const bridge = getRendererBridge();
    if (!bridge || !props.mapResourceUri) return;
    setIsSaving(true);
    setSaveStatus('正在提交变换…');
    try {
      const transaction: MapEditTransaction = {
        id: `tx-gizmo-${Date.now()}`,
        mapId: deriveMapIdFromSourcePath(props.sourcePath),
        baseRevision: props.revision,
        description: `Human Gizmo 调整 Part [${partName}] 变换`,
        author: 'human',
        operations: [
          {
            kind: 'set_transform',
            target: partName,
            position: [current.posX, current.posY, current.posZ],
            ...(current.rotX !== undefined || current.rotY !== undefined || current.rotZ !== undefined
              ? { rotation: [current.rotX ?? 0, current.rotY ?? 0, current.rotZ ?? 0] as [number, number, number] }
              : {}),
            ...(current.scaleX !== undefined || current.scaleY !== undefined || current.scaleZ !== undefined
              ? { scale: [current.scaleX ?? 1, current.scaleY ?? 1, current.scaleZ ?? 1] as [number, number, number] }
              : {})
          }
        ],
        timestamp: Date.now()
      };
      const res = await bridge.executeMapTransaction?.(props.mapResourceUri, props.revision, transaction);
      if (res?.ok) {
        setSaveStatus('变换已成功提交！');
        // 重新加载权威 MapDocument
        const reread = await (bridge.readMsbDocument?.(props.mapResourceUri) as Promise<{ ok: boolean; data?: { parts?: PartLike[] } } | undefined>);
        if (reread?.ok && reread.data?.parts) {
          setPartsState(reread.data.parts);
        }
      } else {
        setSaveStatus(`提交失败：${res?.diagnostics?.[0]?.message ?? '未知错误'}`);
      }
    } catch (err) {
      setSaveStatus(`提交失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsSaving(false);
    }
  }, [partsState, props.mapResourceUri, props.revision, props.sourcePath]);

  const [meshStatus, setMeshStatus] = useState<{ loaded: number; missing: number; total: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

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
        parts: partsState,
        regions,
        ...(props.events ? { events: props.events } : {}),
        ...(props.sourceCounts ? { sourceCounts: props.sourceCounts } : {}),
        ...(props.maxNodes !== undefined ? { maxNodes: props.maxNodes } : {}),
        chunkSize: 512
      });
      drawList = buildSceneDrawList(sceneManifest, {
        ...(props.maxNodes !== undefined ? { maxItems: props.maxNodes } : {})
      });
    } catch (error) {
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
        const node = sceneManifest.nodes.find((candidate) => candidate.id === id) ?? null;
        if (!node) return;
        setSelected({ id: node.id, label: node.label, kind: node.kind });
      },
      onTransformChange: ({ id, position, rotation, scale }) => {
        // 当 Gizmo 拖动时，同步更新选中的 Part 的坐标数据
        setPartsState((prev) =>
          prev.map((p) => {
            const isMatch = p.name === id || `msb-part:${p.name}` === id || (selected?.id === id && p.name === selected.label);
            if (!isMatch) return p;
            return {
              ...p,
              posX: position[0],
              posY: position[1],
              posZ: position[2],
              rotX: rotation[0],
              rotY: rotation[1],
              rotZ: rotation[2],
              scaleX: scale[0],
              scaleY: scale[1],
              scaleZ: scale[2]
            };
          })
        );
      }
    }).then((handle) => {
      if (cancelled) {
        handle.dispose();
        return;
      }
      handleRef.current = handle;
      handle.setTransformMode?.(transformMode);
      drawListRef.current = drawList;
      const partial = sceneManifest.diagnostics.some((item) => item.code === 'SCENE_PROJECTION_PARTIAL');
      setStatus(
        `3D 场景已加载（${drawList.itemCount} 节点 / ${sceneManifest.entityCount} 实体）`
        + (partial ? ' · Bridge 实体预览为 partial' : '')
      );

      // 场景挂载完成后立即启动去重模型并发拉取与热替换
      const bridge = getRendererBridge();
      if (bridge && typeof bridge.readMapPartMesh === 'function' && props.mapResourceUri) {
        const parts = drawList.items.filter((item) => item.entityKind === 'msb-part');
        if (parts.length > 0) {
          const byModel = new Map<string, typeof parts>();
          let missingFromNoModel = 0;
          for (const item of parts) {
            const modelName = item.modelName
              ?? resolvePartModelName(item as { modelName?: string; modelIndex?: number }, props.models);
            if (!modelName) {
              missingFromNoModel += 1;
              continue;
            }
            const list = byModel.get(modelName);
            if (list) list.push(item);
            else byModel.set(modelName, [item]);
          }
          const distinctModelNames = [...byModel.keys()];
          const totalPartCount = parts.length;
          void (async () => {
            let loaded = 0;
            let missing = missingFromNoModel;
            const BATCH_SIZE = 8;
            for (let i = 0; i < distinctModelNames.length; i += BATCH_SIZE) {
              if (cancelled) return;
              const chunk = distinctModelNames.slice(i, i + BATCH_SIZE);
              await Promise.all(chunk.map(async (modelName) => {
                if (loadedModelMeshesRef.current.has(modelName)) {
                  const cached = loadedModelMeshesRef.current.get(modelName)!;
                  handle.updateModelGeometry?.(modelName, cached);
                  loaded += (byModel.get(modelName)?.length ?? 1);
                  return;
                }
                try {
                  const raw = await bridge.readMapPartMesh(props.mapResourceUri, modelName) as {
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
                    const geometryData = {
                      positionsBase64: raw.data.positionsBase64,
                      ...(raw.data.indicesBase64 ? { indicesBase64: raw.data.indicesBase64 } : {}),
                      ...(raw.data.uvsBase64 ? { uvsBase64: raw.data.uvsBase64 } : {}),
                      ...(raw.data.normalsBase64 ? { normalsBase64: raw.data.normalsBase64 } : {}),
                      vertexCount: raw.data.vertexCount ?? 0
                    };
                    loadedModelMeshesRef.current.set(modelName, geometryData as any);
                    loaded += (byModel.get(modelName)?.length ?? 1);
                    // applyLoadedMeshes: 更新已加载的网格几何
                    handle.updateModelGeometry?.(modelName, geometryData);
                  } else {
                    missing += (byModel.get(modelName)?.length ?? 1);
                  }
                } catch {
                  if (!cancelled) missing += (byModel.get(modelName)?.length ?? 1);
                }
              }));
              if (!cancelled) setMeshStatus({ loaded, missing, total: totalPartCount });
            }
          })();
        }
      }
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
    props.regions,
    props.events,
    props.sourceCounts,
    props.maxNodes
  ]);

  /** S23：选中 part 时按 modelName 补载（去重共享，直接热更新几何，绝不全量重新 setDrawList）。 */
  useEffect(() => {
    if (selected?.kind !== 'msb-part' || !handleRef.current) return;
    const bridge = getRendererBridge();
    if (!bridge || typeof bridge.readMapPartMesh !== 'function' || !props.mapResourceUri) return;
    const base = drawListRef.current;
    const item = base?.items.find((candidate) => candidate.id === selected.id) as SceneDrawItem | undefined;
    const modelName = item?.modelName
      ?? (item ? resolvePartModelName(item as { modelName?: string; modelIndex?: number }, props.models) : undefined);
    if (!modelName) return;

    if (loadedModelMeshesRef.current.has(modelName)) {
      const cached = loadedModelMeshesRef.current.get(modelName)!;
      handleRef.current.updateModelGeometry?.(modelName, cached);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const raw = await bridge.readMapPartMesh(props.mapResourceUri, modelName) as {
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
        const meshData: NonNullable<SceneDrawItem['mesh']> = {
          positionsBase64: raw.data.positionsBase64,
          ...(raw.data.indicesBase64 ? { indicesBase64: raw.data.indicesBase64 } : {}),
          ...(raw.data.uvsBase64 ? { uvsBase64: raw.data.uvsBase64 } : {}),
          ...(raw.data.normalsBase64 ? { normalsBase64: raw.data.normalsBase64 } : {}),
          vertexCount: raw.data.vertexCount ?? 0
        };
        loadedModelMeshesRef.current.set(modelName, meshData);
        if (handleRef.current) {
          handleRef.current.updateModelGeometry?.(modelName, meshData);
        }
      } catch {
        // 选中补载失败保持线框
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected?.kind, selected?.id, selected?.label, props.mapResourceUri, props.models]);

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
      const part = partsState.find((candidate) => candidate.name === entity.label) ?? props.parts.find((c) => c.name === entity.label);
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

  function handleSwitchTransformMode(mode: 'translate' | 'rotate' | 'scale'): void {
    setTransformMode(mode);
    handleRef.current?.setTransformMode?.(mode);
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
                return (
                  <details key={group.id} className="msb-object-group" open={group.entries.length > 0}>
                    <summary className="msb-object-group__summary">
                      {group.label}
                      <span className="muted"> {group.entries.length}</span>
                    </summary>
                    {group.entries.length === 0 ? (
                      <p className="muted msb-object-group__empty">无 {group.label} 实体</p>
                    ) : (
                      <div className="binder-child-table" role="table" aria-label={`${group.label} 实体`}>
                        {group.entries.map((entity, index) => (
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
                            title={entity.label}
                          >
                            <span className="msb-object-name" title={entity.label}>{entity.label}</span>
                          </div>
                        ))}
                      </div>
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
            <div className="msb-viewport" style={{ position: 'relative', display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
              <div ref={hostRef} className="scene-host" style={{ flex: 1, width: '100%', height: '100%', minHeight: 200, background: '#1a1d23' }} />
              <p className="muted">
                {props.openFailure
                  ? props.openFailure.message
                  : (nodeCount > 0
                      ? (() => {
                          const meshNote = meshStatus === null
                            ? ''
                            : meshStatus.loaded > 0
                              ? ` · 已挂 ${meshStatus.loaded} / ${meshStatus.total} 个 part 模型${meshStatus.missing > 0 ? `，${meshStatus.missing} 个没找到（线框）` : ''}`
                              : meshStatus.missing > 0
                                ? ' · 没有找到 part 模型（线框）；未挂原版时可到「开始」页挂载后重开'
                                : '';
                          return `节点 ${nodeCount} · region ${regions.length}${meshNote} · 漫游：WASD 移动 / Q下降 E上升 / F居中 / Gizmo 拖拽编辑`;
                        })()
                      : status)}
              </p>
              {(selected?.kind === 'msb-part' || selected?.kind === 'msb-region') ? (
                <p data-testid="msb-selected-summary">
                  已选择 {selected.kind === 'msb-region' ? 'region' : 'part'}：{selected.label}（已挂载 3D Transform Gizmo 拖拽句柄）
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
            <div className="msb-properties-panel">
              <div className="binder-child-table" role="table" aria-label={`${selected.label} 属性`}>
                {propertiesFor(selected).map(([key, value]) => (
                  <div className="binder-child-row msb-property-row" role="row" key={key}>
                    <span className="muted">{key}</span>
                    <span>{value}</span>
                  </div>
                ))}
              </div>
              {selected.kind === 'msb-part' && (
                <div style={{ marginTop: '16px', padding: '0 8px' }}>
                  <button
                    type="button"
                    className="button button--primary"
                    disabled={isSaving}
                    onClick={() => void handleSavePartTransform(selected.label)}
                    style={{ width: '100%', padding: '6px 12px' }}
                  >
                    {isSaving ? '正在提交…' : '提交 Part 变换到 Patch Engine'}
                  </button>
                  {saveStatus && (
                    <p className="muted" style={{ marginTop: '8px', fontSize: '12px' }}>
                      {saveStatus}
                    </p>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="muted">在左侧对象列表中选择一个对象后显示属性，可在 3D 视口中拖拽修改。</p>
          )
        }
      ]}
    />
  );
}
