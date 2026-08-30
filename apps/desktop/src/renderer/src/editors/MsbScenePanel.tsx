import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { selectableRowAttributes } from '../a11y/selectableRow.js';
import {
  SceneProjectionError,
  buildMsbSceneManifest,
  buildSceneDrawList,
  type MsbMapEventLike,
  type MsbModelLike,
  type MsbRegionLike,
  type MsbRouteLike,
  type MsbSceneSourceCounts,
  type PartLike,
  type SceneDrawItem,
  type SceneManifest
} from '../scene/sceneManifestBrowser.js';
import { mountThreeProxyScene, type ProxySceneHandle } from '../scene/threeSceneController.js';
import {
  FrameTaskQueue,
  MapModelLoadCache,
  normalizeMapModelKey,
  type MapMeshGeometry
} from '../scene/mapModelLoadScheduler.js';
import { getRendererBridge } from '../runtime/rendererRuntime.js';
import { decodeBase64ToUint8Array, uint8ArrayToBase64 } from '../utils/binary.js';
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

interface MapMeshReadResult {
  ok?: boolean;
  data?: {
    positionsBase64?: string;
    indicesBase64?: string;
    indexSize?: 16 | 32;
    uvsBase64?: string;
    normalsBase64?: string;
    vertexCount?: number;
  };
}

interface MapStaticGeometryChunk {
  positionsBase64?: string | null;
  indicesBase64?: string | null;
  indexElementBytes?: 2 | 4 | null;
  uvsBase64?: string | null;
  normalsBase64?: string | null;
}

interface MapStaticGeometryPage {
  sessionToken?: string | null;
  nextCursor?: string | null;
  complete?: boolean;
  chunks?: MapStaticGeometryChunk[];
}

interface MapStaticGeometryReadResult {
  ok?: boolean;
  data?: MapStaticGeometryPage;
}

type MapMeshGeometryData = NonNullable<MapMeshReadResult['data']>;

function concatUint8Arrays(parts: readonly Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
}

export function mergeMapStaticGeometryChunks(chunks: readonly MapStaticGeometryChunk[]): MapMeshGeometryData {
  const geometryChunks = chunks.filter((chunk) => Boolean(chunk.positionsBase64));
  if (geometryChunks.length === 0) return {};

  const positions: Uint8Array[] = [];
  const uvs: Uint8Array[] = [];
  const normals: Uint8Array[] = [];
  const indices: number[] = [];
  const allHaveIndices = geometryChunks.every((chunk) => Boolean(chunk.indicesBase64));
  const allHaveUvs = geometryChunks.every((chunk) => Boolean(chunk.uvsBase64));
  const allHaveNormals = geometryChunks.every((chunk) => Boolean(chunk.normalsBase64));
  let vertexCount = 0;
  let indexSize: 16 | 32 = 16;

  for (const chunk of geometryChunks) {
    const positionBytes = decodeBase64ToUint8Array(chunk.positionsBase64!);
    if (positionBytes.byteLength % (3 * Float32Array.BYTES_PER_ELEMENT) !== 0) {
      throw new Error('MAP_STATIC_GEOMETRY_INVALID: positions are not Float32 xyz aligned');
    }
    const chunkVertexCount = positionBytes.byteLength / (3 * Float32Array.BYTES_PER_ELEMENT);
    positions.push(positionBytes);

    if (allHaveUvs) uvs.push(decodeBase64ToUint8Array(chunk.uvsBase64!));
    if (allHaveNormals) normals.push(decodeBase64ToUint8Array(chunk.normalsBase64!));

    if (allHaveIndices) {
      const indexElementBytes = chunk.indexElementBytes;
      if (indexElementBytes !== 2 && indexElementBytes !== 4) {
        throw new Error('MAP_STATIC_GEOMETRY_INVALID: indexElementBytes must be 2 or 4');
      }
      const indexBytes = decodeBase64ToUint8Array(chunk.indicesBase64!);
      if (indexBytes.byteLength % indexElementBytes !== 0) {
        throw new Error('MAP_STATIC_GEOMETRY_INVALID: indices are not aligned');
      }
      const indexView = new DataView(indexBytes.buffer, indexBytes.byteOffset, indexBytes.byteLength);
      for (let offset = 0; offset < indexBytes.byteLength; offset += indexElementBytes) {
        const localIndex = indexElementBytes === 4
          ? indexView.getUint32(offset, true)
          : indexView.getUint16(offset, true);
        const mergedIndex = localIndex + vertexCount;
        if (mergedIndex > 0xffff_ffff) {
          throw new Error('MAP_STATIC_GEOMETRY_INVALID: merged index exceeds uint32');
        }
        indices.push(mergedIndex);
        if (indexElementBytes === 4 || mergedIndex > 0xffff) indexSize = 32;
      }
    }

    vertexCount += chunkVertexCount;
  }

  const merged: MapMeshGeometryData = {
    positionsBase64: uint8ArrayToBase64(concatUint8Arrays(positions)),
    vertexCount
  };

  if (allHaveIndices) {
    const indexBytes = new Uint8Array(indices.length * (indexSize / 8));
    const indexView = new DataView(indexBytes.buffer);
    for (let i = 0; i < indices.length; i += 1) {
      const offset = i * (indexSize / 8);
      if (indexSize === 32) indexView.setUint32(offset, indices[i]!, true);
      else indexView.setUint16(offset, indices[i]!, true);
    }
    merged.indicesBase64 = uint8ArrayToBase64(indexBytes);
    merged.indexSize = indexSize;
  }
  if (allHaveUvs) merged.uvsBase64 = uint8ArrayToBase64(concatUint8Arrays(uvs));
  if (allHaveNormals) merged.normalsBase64 = uint8ArrayToBase64(concatUint8Arrays(normals));

  return merged;
}

function toMapMeshGeometry(raw: MapMeshReadResult): MapMeshGeometry | null {
  if (!raw.ok || !raw.data?.positionsBase64) return null;
  return {
    positionsBase64: raw.data.positionsBase64,
    ...(raw.data.indicesBase64 ? { indicesBase64: raw.data.indicesBase64 } : {}),
    ...(raw.data.indexSize === 16 || raw.data.indexSize === 32 ? { indexSize: raw.data.indexSize } : {}),
    ...(raw.data.uvsBase64 ? { uvsBase64: raw.data.uvsBase64 } : {}),
    ...(raw.data.normalsBase64 ? { normalsBase64: raw.data.normalsBase64 } : {}),
    vertexCount: raw.data.vertexCount ?? 0
  };
}

/** 左栏 Map Object List 里的实体分类。 */
type MsbEntityKind = 'msb-model' | 'msb-event' | 'msb-part' | 'msb-region' | 'msb-route';

interface SelectedEntity {
  id: string;
  label: string;
  kind: MsbEntityKind;
  nativeOffset?: number;
  routeId?: number;
}

interface MapObjectGroup {
  id: string;
  label: string;
  entries: SelectedEntity[];
}

type VirtualMapObjectRow =
  | { kind: 'group'; group: MapObjectGroup }
  | { kind: 'entity'; groupId: string; entity: SelectedEntity }
  | { kind: 'empty'; group: MapObjectGroup };

function VirtualMapObjectList(props: {
  groups: MapObjectGroup[];
  selectedId: string | null;
  onSelect: (entity: SelectedEntity) => void;
}): ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(props.groups.filter((group) => group.entries.length > 0).map((group) => group.id))
  );

  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current);
      for (const group of props.groups) {
        if (group.entries.length > 0 && !next.has(group.id)) next.add(group.id);
      }
      return next;
    });
  }, [props.groups]);

  const rows = useMemo<VirtualMapObjectRow[]>(() => {
    const next: VirtualMapObjectRow[] = [];
    for (const group of props.groups) {
      next.push({ kind: 'group', group });
      if (!expanded.has(group.id)) continue;
      if (group.entries.length === 0) next.push({ kind: 'empty', group });
      else {
        for (const entity of group.entries) {
          next.push({ kind: 'entity', groupId: group.id, entity });
        }
      }
    }
    return next;
  }, [expanded, props.groups]);
  const firstEntityId = rows.find((row) => row.kind === 'entity')?.entity.id ?? null;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => rows[index]?.kind === 'group' ? 32 : 28,
    overscan: 16,
    getItemKey: (index) => {
      const row = rows[index];
      if (!row) return index;
      if (row.kind === 'entity') return `entity:${row.entity.id}`;
      return `${row.kind}:${row.group.id}`;
    }
  });

  return (
    <div
      ref={scrollRef}
      className="msb-object-list"
      role="table"
      aria-label="地图对象"
      aria-rowcount={rows.length}
    >
      <div className="msb-object-list__spacer" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) return null;
          const style = {
            height: virtualRow.size,
            transform: `translateY(${virtualRow.start}px)`
          };
          if (row.kind === 'group') {
            const isExpanded = expanded.has(row.group.id);
            return (
              <div
                key={virtualRow.key}
                className="msb-object-list__virtual-row msb-object-group__summary"
                style={style}
                role="rowgroup"
              >
                <button
                  type="button"
                  className="msb-object-group__toggle"
                  aria-expanded={isExpanded}
                  onClick={() => setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(row.group.id)) next.delete(row.group.id);
                    else next.add(row.group.id);
                    return next;
                  })}
                >
                  <span aria-hidden="true">{isExpanded ? '\u25be' : '\u25b8'}</span>
                  <span>{row.group.label}</span>
                  <span className="muted">{row.group.entries.length}</span>
                </button>
              </div>
            );
          }
          if (row.kind === 'empty') {
            return (
              <div
                key={virtualRow.key}
                className="msb-object-list__virtual-row muted msb-object-group__empty"
                style={style}
                role="row"
              >
                无 {row.group.label} 实体
              </div>
            );
          }
          return (
            <div
              key={virtualRow.key}
              className="msb-object-list__virtual-row binder-child-row msb-object-row"
              {...selectableRowAttributes({
                selected: props.selectedId === row.entity.id,
                isTabEntry: props.selectedId === null && row.entity.id === firstEntityId,
                onSelect: () => props.onSelect(row.entity)
              })}
              style={{
                ...style,
                ...(props.selectedId === row.entity.id ? { outline: '1px solid var(--ember)' } : {})
              }}
              title={row.entity.label}
            >
              <span className="msb-object-name" title={row.entity.label}>{row.entity.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
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
  routes?: MsbRouteLike[];
  sourceCounts?: MsbSceneSourceCounts;
  maxNodes?: number;
  /** native 提交后把 fresh revision 提升到 App，触发权威 MSB 重读。 */
  onRevisionChange?: (sourceHash: string) => void;
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
 * 选中后中间 viewport 用线框高亮，右侧显示数值属性；camera 走关卡编辑器式
 * free-look，选中 part 后由 TransformControls 驱动平移/旋转/缩放。
 *
 * 问题4-A：打开地图默认按**全部** part 拉模型（可报进度「已挂 N / M」），不再只
 * 预取前 12 个；对象数据完整保留，DOM 由虚拟列表按视窗窗口化，名字不截断。
 * Gizmo 拖动只更新 GPU instance，松手后才写一次 React 语义状态；显式提交仍只走
 * Patch Engine 事务，不从 renderer 直接写文件。
 */
export function MsbScenePanel(props: MsbScenePanelProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<ProxySceneHandle | null>(null);
  const [manifest, setManifest] = useState<SceneManifest | null>(null);
  const [selected, setSelected] = useState<SelectedEntity | null>(null);
  const [status, setStatus] = useState('正在初始化 3D 场景…');
  const [nodeCount, setNodeCount] = useState(0);
  const [partsState, setPartsState] = useState<PartLike[]>(props.parts);
  const regions = props.regions ?? [];

  useEffect(() => {
    setPartsState(props.parts);
  }, [props.parts]);
  /** S23：最近一次 drawList（mesh 渐进加载后重建用）。 */
  const drawListRef = useRef<ReturnType<typeof buildSceneDrawList> | null>(null);
  const drawItemByIdRef = useRef<Map<string, SceneDrawItem>>(new Map());
  const modelLoadCacheRef = useRef<MapModelLoadCache | null>(null);
  const modelUploadQueueRef = useRef<FrameTaskQueue | null>(null);
  const modelUploadRef = useRef<((modelName: string, mesh: MapMeshGeometry) => Promise<boolean>) | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  const handleSavePartTransform = useCallback(async (entity: SelectedEntity) => {
    if (entity.kind !== 'msb-part' || entity.nativeOffset === undefined) {
      setSaveStatus('提交失败：目标缺少 nativeOffset，已失败关闭。');
      return;
    }
    const current = partsState.find((p) => p.nativeOffset === entity.nativeOffset);
    if (!current) {
      setSaveStatus('提交失败：按 nativeOffset 找不到目标 Part。');
      return;
    }
    const bridge = getRendererBridge();
    if (!bridge || !props.mapResourceUri) return;
    setIsSaving(true);
    setSaveStatus('正在提交变换…');
    try {
      const transaction: MapEditTransaction = {
        id: `tx-gizmo-${Date.now()}`,
        mapId: props.sourcePath.split(/[\\/]/).pop()?.replace(/\.msb(?:\.dcx)?$/i, '') ?? '',
        baseRevision: props.revision,
        description: `Human Gizmo 调整 Part [${entity.label}] 变换`,
        author: 'human',
        operations: [
          {
            kind: 'set_transform',
            target: `part:${props.sourcePath.split(/[\\/]/).pop()?.replace(/\.msb(?:\.dcx)?$/i, '') ?? ''}:offset-${entity.nativeOffset.toString(16)}`,
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
        const reread = await (bridge.readMsbDocument?.(props.mapResourceUri) as Promise<{
          ok: boolean;
          data?: { sourceHash?: string; parts?: PartLike[] };
        } | undefined>);
        if (reread?.ok && reread.data?.parts) {
          setPartsState(reread.data.parts);
        }
        const freshHash = reread?.data?.sourceHash ?? res.sourceHash;
        if (freshHash && freshHash !== props.revision) props.onRevisionChange?.(freshHash);
      } else {
        setSaveStatus(`提交失败：${res?.diagnostics?.[0]?.message ?? '未知错误'}`);
      }
    } catch (err) {
      setSaveStatus(`提交失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsSaving(false);
    }
  }, [partsState, props.mapResourceUri, props.onRevisionChange, props.revision, props.sourcePath]);

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
        ...(props.routes ? { routes: props.routes } : {}),
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
    const nodeById = new Map(sceneManifest.nodes.map((node) => [node.id, node]));

    void mountThreeProxyScene({
      container: host,
      drawList,
      onSelect: (id) => {
        const node = id ? (nodeById.get(id) ?? null) : null;
        if (!node) return;
        setSelected({ id: node.id, label: node.label, kind: node.kind, ...(node.nativeOffset === undefined ? {} : { nativeOffset: node.nativeOffset }) });
      },
      onTransformChange: ({ id, position, rotation, scale }) => {
        // controller 在拖拽结束才发一次；按稳定 nativeOffset 定位并只复制目标行。
        const node = nodeById.get(id);
        setPartsState((current) => {
          const index = node?.nativeOffset !== undefined
            ? current.findIndex((part) => part.nativeOffset === node.nativeOffset)
            : current.findIndex((part) => part.name === id || `msb-part:${part.name}` === id);
          if (index < 0) return current;
          const part = current[index];
          if (!part) return current;
          const next = current.slice();
          next[index] = {
            ...part,
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
          return next;
        });
      }
    }).then((handle) => {
      if (cancelled) {
        handle.dispose();
        return;
      }
      handleRef.current = handle;
      drawListRef.current = drawList;
      drawItemByIdRef.current = new Map(drawList.items.map((item) => [item.id, item]));
      const partial = sceneManifest.diagnostics.some((item) => item.code === 'SCENE_PROJECTION_PARTIAL');
      setStatus(
        `3D 场景已加载（${drawList.itemCount} 节点 / ${sceneManifest.entityCount} 实体）`
        + (partial ? ' · Bridge 实体预览为 partial' : '')
      );

      // 场景挂载完成后立即启动去重模型并发拉取与热替换
      const bridge = getRendererBridge();
      // 24.10 streaming: read-map-static-geometry (chunked, cursor opaque with daemon/owner/sourceHash/resourceCacheKey, wire bytes budget)
      // Deprecated: readMapPartMesh -> readMapStaticGeometry
      if (bridge && typeof (bridge as any).readMapStaticGeometry === 'function' && props.mapResourceUri) {
        const loadCache = new MapModelLoadCache(async (modelName) => {
          let raw: MapMeshReadResult = { ok: false };
          // Chunked streaming: follow opaque cursors until complete, wire bytes budget <8MiB per chunk
          let cursor: string | null = null;
          let sessionToken: string | null = null;
          const chunks: MapStaticGeometryChunk[] = [];
          do {
            const chunkResult = await (bridge as any).readMapStaticGeometry(props.mapResourceUri, modelName, cursor, sessionToken) as any;
            if (!chunkResult?.ok) { raw = chunkResult as MapMeshReadResult; break; }
            const page = (chunkResult as MapStaticGeometryReadResult).data;
            if (page?.chunks) chunks.push(...page.chunks);
            sessionToken = page?.sessionToken ?? sessionToken;
            cursor = page?.nextCursor ?? null;
            if (page?.complete || !cursor) {
              raw = { ok: true, data: mergeMapStaticGeometryChunks(chunks) };
              break;
            }
          } while (cursor);
          return toMapMeshGeometry(raw);
        });
        const uploadQueue = new FrameTaskQueue();
        const uploads = new Map<string, Promise<boolean>>();
        const uploadModel = (modelName: string, geometry: MapMeshGeometry): Promise<boolean> => {
          const key = normalizeMapModelKey(modelName);
          const pending = uploads.get(key);
          if (pending) return pending;
          const upload = uploadQueue
            .enqueue(() => handle.updateModelGeometry?.(modelName, geometry))
            .finally(() => uploads.delete(key));
          uploads.set(key, upload);
          return upload;
        };
        modelLoadCacheRef.current = loadCache;
        modelUploadQueueRef.current = uploadQueue;
        modelUploadRef.current = uploadModel;

        const parts = drawList.items.filter((item) => item.entityKind === 'msb-part');
        if (parts.length > 0) {
          const byModel = new Map<string, { modelName: string; items: typeof parts }>();
          let missingFromNoModel = 0;
          for (const item of parts) {
            const modelName = item.modelName
              ?? resolvePartModelName(item as { modelName?: string; modelIndex?: number }, props.models);
            if (!modelName) {
              missingFromNoModel += 1;
              continue;
            }
            const key = normalizeMapModelKey(modelName);
            const group = byModel.get(key);
            if (group) group.items.push(item);
            else byModel.set(key, { modelName, items: [item] });
          }
          const distinctModels = [...byModel.values()];
          const totalPartCount = parts.length;
          setMeshStatus({ loaded: 0, missing: missingFromNoModel, total: totalPartCount });
          void (async () => {
            let loaded = 0;
            let missing = missingFromNoModel;
            const BATCH_SIZE = 8;
            for (let i = 0; i < distinctModels.length; i += BATCH_SIZE) {
              if (cancelled) return;
              const chunk = distinctModels.slice(i, i + BATCH_SIZE);
              await Promise.all(chunk.map(async ({ modelName, items }) => {
                try {
                  const geometry = await loadCache.load(modelName);
                  if (cancelled) return;
                  if (geometry) {
                    const uploaded = await uploadModel(modelName, geometry);
                    if (!cancelled && uploaded) loaded += items.length;
                  } else {
                    missing += items.length;
                  }
                } catch {
                  if (!cancelled) missing += items.length;
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
      drawItemByIdRef.current.clear();
      modelLoadCacheRef.current?.dispose();
      modelLoadCacheRef.current = null;
      modelUploadQueueRef.current?.dispose();
      modelUploadQueueRef.current = null;
      modelUploadRef.current = null;
    };
  }, [
    props.mapResourceUri,
    props.sourcePath,
    props.game,
    props.revision,
    props.models,
    props.regions,
    props.events,
    props.routes,
    props.sourceCounts,
    props.maxNodes
  ]);

  /** S23：选中 part 时按 modelName 补载（去重共享，直接热更新几何，绝不全量重新 setDrawList）。 */
  useEffect(() => {
    if (selected?.kind !== 'msb-part' || !handleRef.current) return;
    const loadCache = modelLoadCacheRef.current;
    const uploadModel = modelUploadRef.current;
    if (!loadCache || !uploadModel) return;
    const item = drawItemByIdRef.current.get(selected.id);
    const modelName = item?.modelName
      ?? (item ? resolvePartModelName(item as { modelName?: string; modelIndex?: number }, props.models) : undefined);
    if (!modelName) return;

    let cancelled = false;
    void (async () => {
      try {
        const meshData = await loadCache.load(modelName);
        if (cancelled || !meshData) return;
        await uploadModel(modelName, meshData);
      } catch {
        // 选中补载失败保持线框
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected?.kind, selected?.id, props.models]);

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
   * 左栏对象分组（Map Object List）：Model / Event / Region / Part / Route。
   *
   * 由 scene manifest 派生而不是 props 各数组直接拼：条目带稳定 id
   * （`<kind>:offset-<hex>` 或 name 退化），左栏选中 ↔ viewport 高亮用同一把 id。
   */
  const groupedEntities = useMemo<MapObjectGroup[]>(() => {
    const entities = manifest?.entities ?? [];
    // entities 的 kind 字段是 MsbSceneEntityKind 联合；pick 返回同子集的数组，
    // 赋值给 SelectedEntity.kind 是结构兼容的（字面量联合等价）。
    const pick = (kind: MsbEntityKind): SelectedEntity[] => entities
      .filter((entity) => entity.kind === kind)
      .map((entity) => ({
        id: entity.id,
        label: entity.label,
        kind: entity.kind,
        ...(entity.nativeOffset === undefined ? {} : { nativeOffset: entity.nativeOffset }),
        ...('routeId' in entity && typeof entity.routeId === 'number' ? { routeId: entity.routeId } : {})
      }));
    return [
      { id: 'model', label: 'Model', entries: pick('msb-model') },
      { id: 'event', label: 'Event', entries: pick('msb-event') },
      { id: 'region', label: 'Region', entries: pick('msb-region') },
      { id: 'part', label: 'Part', entries: pick('msb-part') },
      { id: 'route', label: 'Route', entries: pick('msb-route') }
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
    if (entity.kind === 'msb-route') {
      const route = props.routes?.find((candidate) => (
        candidate.name === entity.label
        && (entity.nativeOffset === undefined || candidate.nativeOffset === entity.nativeOffset)
      ));
      const routeId = route?.id ?? entity.routeId;
      return [
        ['Name', entity.label],
        ...(route?.typeId !== undefined ? [['Type ID', String(route.typeId)] as const] : []),
        ...(routeId !== undefined ? [['Route ID', String(routeId)] as const] : []),
        ...(route?.nativeOffset !== undefined ? [['Native Offset', String(route.nativeOffset)] as const] : [])
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
            <div className="msb-object-list-shell">
              {props.openFailure ? (
                <div className="msb-open-failure" role="alert">
                  <p className="msb-open-failure__code">{props.openFailure.code}</p>
                  <p>{props.openFailure.message}</p>
                </div>
              ) : manifest === null ? (
                <p className="muted">未加载 MSB 数据：请先在资源浏览器里选择一个 map 资源。</p>
              ) : (
                <VirtualMapObjectList
                  groups={groupedEntities}
                  selectedId={selected?.id ?? null}
                  onSelect={selectEntity}
                />
              )}
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
                          return `节点 ${nodeCount} · region ${regions.length}${meshNote} · 漫游：WASD 移动 / Shift+WASD 加速 / Q下降 E上升 / F居中`;
                        })()
                      : status)}
              </p>
              <p className="muted">Universal Gizmo 拖拽（移动、旋转、缩放）</p>
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
                    onClick={() => void handleSavePartTransform(selected)}
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
