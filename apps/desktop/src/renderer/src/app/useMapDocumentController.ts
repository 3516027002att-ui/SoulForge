import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  MsbMapEventLike, MsbModelLike, MsbPartTransformLike, MsbRegionLike,
  MsbRouteLike, MsbSceneSourceCounts
} from '@soulforge/shared';
import type { RendererIndexedFile } from '../../../main/rendererDto.js';
import type { RendererRuntime } from '../runtime/rendererRuntime.js';
import { shouldLoadMsb } from '../workbench/documentLoadGates.js';

export type MapDocumentBridge = Pick<NonNullable<RendererRuntime['bridge']>, 'readMsbDocument'>;
export interface MapDocumentOpenFailure {
  kind: 'msb-open-failed';
  document: string;
  code: string;
  message: string;
}
export interface MapDocumentOptions {
  bridge: MapDocumentBridge | null;
  selectedFile: Pick<RendererIndexedFile,
    'sourceUri' | 'relativePath' | 'resourceKind' | 'formatKind' | 'compoundExtension'> | null;
  setStatus(message: string): void;
  onMapOpenFailure(failure: MapDocumentOpenFailure | null): void;
}

/** Existing logical MSB read projection; native parsing and full document authority remain in main. */
export interface MapDocumentReadResult {
  ok?: boolean;
  diagnostics?: Array<{ severity?: string; code?: string; message?: string }>;
  data?: {
    sourceHash?: string;
    models?: Array<{ name: string; nativeOffset?: number; offset?: number; typeId: number; sibPath?: string }>;
    parts: Array<{
      name: string; nativeOffset?: number; offset?: number; modelIndex?: number;
      posX: number; posY: number; posZ: number;
      rotX?: number; rotY?: number; rotZ?: number;
      scaleX?: number; scaleY?: number; scaleZ?: number;
    }>;
    regions?: Array<{
      name: string; nativeOffset?: number; typeId: number;
      posX: number; posY: number; posZ: number;
      rotX?: number; rotY?: number; rotZ?: number;
      scaleX?: number; scaleY?: number; scaleZ?: number;
    }>;
    events?: Array<{ name: string; nativeOffset?: number; typeId: number }>;
    routes?: Array<{ name: string; nativeOffset?: number; typeId: number; id?: number }>;
    modelCount?: number; partCount?: number; regionCount?: number; eventCount?: number; routeCount?: number;
    authority?: string;
  } | null;
}

const EMPTY_MSB_PARTS: MsbPartTransformLike[] = [];
const emptySourceCounts = (): MsbSceneSourceCounts => ({ models: 0, parts: 0, regions: 0, events: 0, routes: 0 });

function readLevelLabel(authority: string): string {
  switch (authority) {
    case 'partial': return '读取不完整';
    case 'candidate': return '候选读取';
    case 'fixture-confirmed': return '样本已确认';
    case 'native-verified': return '原生读取已验证';
    case 'unverified': return '尚未验证';
    default: return authority;
  }
}

/** Owns the selected map's renderer projection and its lifetime, never a native transaction. */
export function useMapDocumentController(options: MapDocumentOptions) {
  const { bridge, selectedFile, setStatus, onMapOpenFailure } = options;
  const [msbParts, setMsbParts] = useState<MsbPartTransformLike[]>(EMPTY_MSB_PARTS);
  const [msbModels, setMsbModels] = useState<MsbModelLike[]>([]);
  const [msbRegions, setMsbRegions] = useState<MsbRegionLike[]>([]);
  const [msbEvents, setMsbEvents] = useState<MsbMapEventLike[]>([]);
  const [msbRoutes, setMsbRoutes] = useState<MsbRouteLike[]>([]);
  const [msbSourceCounts, setMsbSourceCounts] = useState<MsbSceneSourceCounts>(emptySourceCounts);
  const [msbLive, setMsbLive] = useState(false);
  const [msbSourceHash, setMsbSourceHashState] = useState<string | null>(null);
  const [resetEpoch, setMsbResetEpoch] = useState(0);
  const documentOwner = useMemo(() => ({}), [bridge, selectedFile, resetEpoch]);
  const lifetimeRef = useRef<{ mounted: boolean; owner: object | null }>({ mounted: false, owner: null });
  const readRequestRef = useRef(0);

  useEffect(() => {
    lifetimeRef.current = { mounted: true, owner: documentOwner };
    return () => { lifetimeRef.current.mounted = false; };
  }, [documentOwner]);

  const clearProjection = useCallback(() => {
    setMsbParts(EMPTY_MSB_PARTS);
    setMsbModels([]);
    setMsbRegions([]);
    setMsbEvents([]);
    setMsbRoutes([]);
    setMsbSourceCounts(emptySourceCounts());
    setMsbLive(false);
    setMsbSourceHashState(null);
  }, []);

  const resetMapDocument = useCallback(() => {
    // Registry resets can precede a selection rerender; invalidate pending reads/callbacks now.
    readRequestRef.current++;
    lifetimeRef.current.owner = null;
    setMsbResetEpoch(epoch => epoch + 1);
    clearProjection();
  }, [clearProjection]);

  /**
   * MsbScenePanel owns transaction submission and source readback. A late committed result may
   * retain its receipt, but its captured callback cannot publish a hash into another map lifetime.
   */
  const setMsbSourceHash = useCallback((sourceHash: string) => {
    if (lifetimeRef.current.mounted && lifetimeRef.current.owner === documentOwner) {
      setMsbSourceHashState(sourceHash);
    }
  }, [documentOwner]);

  useEffect(() => {
    let cancelled = false;
    const requestId = ++readRequestRef.current;
    const isCurrent = () => !cancelled && readRequestRef.current === requestId
      && lifetimeRef.current.mounted && lifetimeRef.current.owner === documentOwner;
    async function loadMsb(): Promise<void> {
      // Only an explicitly selected map opens; there is no semantic-domain fallback list.
      const target = selectedFile;
      if (!target || !shouldLoadMsb(target)) {
        clearProjection();
        onMapOpenFailure(null);
        return;
      }
      if (!bridge || typeof bridge.readMsbDocument !== 'function') {
        clearProjection();
        return;
      }
      setStatus(`正在读取 MSB：${target.relativePath}`);
      try {
        const result = await bridge.readMsbDocument(target.sourceUri) as MapDocumentReadResult;
        if (!isCurrent()) return;
        if (!result?.ok || !result.data) {
          clearProjection();
          const diag = result?.diagnostics?.[0];
          const code = diag?.code ?? 'MSB_READ_FAILED';
          onMapOpenFailure({
            kind: 'msb-open-failed', document: target.relativePath, code,
            message: diag?.message ?? (code === 'MSB_DOCUMENT_KRAK_OODLE_UNAVAILABLE'
              ? '这份地图是 KRAK 压缩，到「开始」页选择含 sekiro.exe 的原版目录后再打开。'
              : '这张地图读不出来，请检查文件状态后重试。')
          });
          setStatus('这张地图读不出来。');
          return;
        }
        const data = result.data;
        onMapOpenFailure(null);
        setMsbParts(data.parts.map(p => ({
          name: p.name,
          ...((p.nativeOffset ?? p.offset) === undefined ? {} : { nativeOffset: p.nativeOffset ?? p.offset }),
          ...(typeof p.modelIndex === 'number' ? { modelIndex: p.modelIndex } : {}),
          posX: p.posX, posY: p.posY, posZ: p.posZ,
          rotX: p.rotX ?? 0, rotY: p.rotY ?? 0, rotZ: p.rotZ ?? 0,
          scaleX: p.scaleX ?? 1, scaleY: p.scaleY ?? 1, scaleZ: p.scaleZ ?? 1
        })));
        setMsbModels((data.models ?? []).map(model => ({
          name: model.name,
          ...((model.nativeOffset ?? model.offset) === undefined ? {} : { nativeOffset: model.nativeOffset ?? model.offset }),
          typeId: model.typeId,
          ...(model.sibPath ? { sibPath: model.sibPath.replace(/\\/g, '/').split('/').pop() ?? model.sibPath } : {})
        })));
        setMsbRegions((data.regions ?? []).map(region => ({
          name: region.name,
          ...(region.nativeOffset === undefined ? {} : { nativeOffset: region.nativeOffset }),
          typeId: region.typeId, posX: region.posX, posY: region.posY, posZ: region.posZ,
          rotX: region.rotX ?? 0, rotY: region.rotY ?? 0, rotZ: region.rotZ ?? 0,
          scaleX: region.scaleX ?? 1, scaleY: region.scaleY ?? 1, scaleZ: region.scaleZ ?? 1
        })));
        setMsbEvents((data.events ?? []).map(event => ({
          name: event.name, ...(event.nativeOffset === undefined ? {} : { nativeOffset: event.nativeOffset }), typeId: event.typeId
        })));
        setMsbRoutes((data.routes ?? []).map(route => ({
          name: route.name, ...(route.nativeOffset === undefined ? {} : { nativeOffset: route.nativeOffset }),
          typeId: route.typeId, ...(route.id === undefined ? {} : { id: route.id })
        })));
        setMsbSourceCounts({
          models: data.modelCount ?? data.models?.length ?? 0,
          parts: data.partCount ?? data.parts.length,
          regions: data.regionCount ?? data.regions?.length ?? 0,
          events: data.eventCount ?? data.events?.length ?? 0,
          routes: data.routeCount ?? data.routes?.length ?? 0
        });
        setMsbSourceHashState(data.sourceHash ?? null);
        setMsbLive(true);
        setStatus(`已加载 MSB：${data.partCount ?? data.parts.length} parts`
          + (data.regionCount !== undefined ? ` / ${data.regionCount} regions` : '')
          + (data.routeCount !== undefined ? ` / ${data.routeCount} routes` : '')
          + (data.authority ? ` · 读取级别：${readLevelLabel(data.authority)}` : ''));
      } catch (error) {
        if (!isCurrent()) return;
        clearProjection();
        setStatus(error instanceof Error ? error.message : 'MSB 读取异常');
      }
    }
    void loadMsb();
    return () => { cancelled = true; };
    // Feedback callbacks and reset do not determine selection identity or trigger native rereads.
  }, [bridge, selectedFile]);

  return { msbParts, msbModels, msbRegions, msbEvents, msbRoutes, msbSourceCounts,
    msbLive, msbSourceHash, setMsbSourceHash, resetMapDocument };
}
export type MapDocumentController = ReturnType<typeof useMapDocumentController>;
