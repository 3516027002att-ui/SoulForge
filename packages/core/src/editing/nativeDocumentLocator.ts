/**
 * NATIVE-03: Bridge-confirmed native document locator（§14.4 core-internal）。
 *
 * core 内部专用，绝不通过 shared/preload 导出：locator 携带 main-only 的
 * outerSourceUri，renderer 永远只消费 opaque document handle。
 *
 * 本模块只解释 Bridge probe 返回的脱敏结果（bridge-protocol.ts 的
 * BridgeDocumentLocatorValue）；suffix/path hint 永远不能构造层。冲突
 * （同一 child 两个不兼容 confirmed leaf）必须失败关闭，禁止静默单选。
 */
import type {
  BridgeDocumentLocatorValue,
  ContainerRole,
  NativeFormatId
} from '@soulforge/shared';

// §14.4 逐字契约（core internal only；NativeDocumentLocatorLayer 的
// formatId 是 Exclude<NativeFormatId, 'unknown'>）
export interface NativeDocumentLocatorLayer {
  readonly layerIndex: number;
  readonly formatId: Exclude<NativeFormatId, 'unknown'>;
  readonly entry: null | {
    readonly parentLayerIndex: number;
    readonly stableEntryId: string;
    readonly entryIndex: number;
    readonly entryName: string;
    readonly expectedEntryHash: string;
  };
}

export interface NativeDocumentLocator {
  readonly locatorId: string;
  readonly outerResourceId: string;
  readonly outerSourceUri: string;
  readonly sourceVariant: 'overlay' | 'base';
  readonly expectedOuterRevision: string;
  readonly expectedOuterHash: string;
  readonly containerRole: ContainerRole;
  readonly layers: readonly NativeDocumentLocatorLayer[];
  readonly leafDocumentStableId: string;
}

export type LocatorProbeOutcome =
  | { kind: 'confirmed'; locator: NativeDocumentLocator }
  | { kind: 'blocked'; reasonCode: 'compression-runtime-unavailable' | 'bridge-runtime-unavailable'; bridgeMessage: string | null }
  | { kind: 'unsupported'; reasonCode: string }
  | { kind: 'conflict'; confirmedStackIds: readonly string[] };

export interface BuildNativeDocumentLocatorInput {
  readonly outerResourceId: string;
  readonly outerSourceUri: string;
  readonly sourceVariant: 'overlay' | 'base';
  readonly expectedOuterRevision: string;
  readonly bridgeValue: BridgeDocumentLocatorValue;
}

const CONTAINER_ROLES = new Set<ContainerRole>([
  'none', 'gameparam-binder', 'drawparam-binder', 'msg-binder', 'script-binder',
  'behavior-binder', 'animation-binder', 'texture-binder', 'vfx-binder', 'generic-binder'
]);

const CONFIRMED_LEAF_FORMATS = new Set<string>([
  'dcx-dflt', 'dcx-krak', 'bnd4', 'param', 'gparam', 'fmg', 'emevd', 'msb',
  'lua-source', 'lua-bytecode', 'hks-bytecode', 'esd', 'tae', 'flver', 'tpf',
  'dds', 'mtd', 'matbin', 'fxr'
]);

function normalizeContainerRole(role: string): ContainerRole {
  return CONTAINER_ROLES.has(role as ContainerRole) ? (role as ContainerRole) : 'generic-binder';
}

function normalizeFormatId(formatId: string): Exclude<NativeFormatId, 'unknown'> {
  if (!CONFIRMED_LEAF_FORMATS.has(formatId)) {
    throw new Error(`probe 返回了未登记格式 ${formatId}，拒绝构造 locator。`);
  }
  return formatId as Exclude<NativeFormatId, 'unknown'>;
}

/**
 * 只把 Bridge-confirmed 层组装进 locator；`unknown` 层不得成为 confirmed
 * format。probe 已判 conflict/blocked 时失败关闭，不静默单选。
 */
export function buildNativeDocumentLocator(
  input: BuildNativeDocumentLocatorInput
): LocatorProbeOutcome {
  const { bridgeValue } = input;
  if (bridgeValue.probeStatus === 'blocked') {
    return {
      kind: 'blocked',
      reasonCode: bridgeValue.reasonCode === 'compression-runtime-unavailable'
        ? 'compression-runtime-unavailable'
        : 'bridge-runtime-unavailable',
      bridgeMessage: null
    };
  }
  if (bridgeValue.probeStatus === 'conflict') {
    return { kind: 'conflict', confirmedStackIds: bridgeValue.confirmedStackIds };
  }
  if (bridgeValue.probeStatus !== 'confirmed') {
    return {
      kind: 'unsupported',
      reasonCode: bridgeValue.reasonCode ?? `probe-status-${bridgeValue.probeStatus}`
    };
  }

  const layers: NativeDocumentLocatorLayer[] = [];
  const confirmedChildren: Array<{ layerIndex: number; stableEntryId: string }> = [];

  for (const layer of bridgeValue.layers) {
    if (layer.formatId === 'unknown') continue;
    const normalized = normalizeFormatId(layer.formatId);
    if (layer.entry === null) {
      layers.push({ layerIndex: layer.layerIndex, formatId: normalized, entry: null });
      continue;
    }
    // child 层的 parentLayerIndex 指向外层容器层（最近且索引更小的
    // bnd4/dcx 容器根层）。
    const parentLayer = bridgeValue.layers
      .filter((candidate) => candidate.entry === null && candidate.layerIndex < layer.layerIndex)
      .filter((candidate) => candidate.formatId === 'bnd4' || candidate.formatId === 'dcx-dflt' || candidate.formatId === 'dcx-krak')
      .sort((a, b) => b.layerIndex - a.layerIndex)[0];
    layers.push({
      layerIndex: layer.layerIndex,
      formatId: normalized,
      entry: {
        parentLayerIndex: parentLayer?.layerIndex ?? 0,
        stableEntryId: layer.entry.stableEntryId,
        entryIndex: layer.entry.entryIndex,
        entryName: layer.entry.entryName,
        expectedEntryHash: layer.entry.expectedEntryHash
      }
    });
    if (normalized !== 'bnd4') {
      confirmedChildren.push({ layerIndex: layer.layerIndex, stableEntryId: layer.entry.stableEntryId });
    }
  }

  const leafDocumentStableId = confirmedChildren.length > 0
    ? confirmedChildren[confirmedChildren.length - 1]!.stableEntryId
    : bridgeValue.leafFormatId === 'bnd4'
      ? 'bnd4-root'
      : `loose:${bridgeValue.leafFormatId}`;

  const locator: NativeDocumentLocator = {
    locatorId: `locator:${input.outerResourceId}:${input.expectedOuterRevision}`,
    outerResourceId: input.outerResourceId,
    outerSourceUri: input.outerSourceUri,
    sourceVariant: input.sourceVariant,
    expectedOuterRevision: input.expectedOuterRevision,
    expectedOuterHash: bridgeValue.outerHash,
    containerRole: normalizeContainerRole(bridgeValue.containerRole),
    layers,
    leafDocumentStableId
  };
  return { kind: 'confirmed', locator };
}
