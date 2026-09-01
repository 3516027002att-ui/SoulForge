/**
 * Renderer-independent MSB semantic scene and render packet contracts.
 * This module is browser-safe and must never receive absolute filesystem paths.
 */

export type MsbSceneEntityKind = 'msb-model' | 'msb-part' | 'msb-region' | 'msb-event' | 'msb-route';
export type SceneProxyPrimitive = 'box' | 'sphere' | 'point';

export interface SceneProjectionDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
}

export interface SceneResourceMetadata {
  sourceUri: string;
  /** Workspace-relative POSIX path. Never an absolute filesystem path. */
  sourcePath: string;
  game: string;
  resourceKind: 'map';
  revision: string;
}

export interface MsbNativeEntityLike {
  name: string;
  /** Native record offset, used only as a stable opaque identity. */
  nativeOffset?: number;
  typeId?: number;
}

export interface MsbModelLike extends MsbNativeEntityLike {
  sibPath?: string;
}

export interface MsbPartTransformLike extends MsbNativeEntityLike {
  posX: number;
  posY: number;
  posZ: number;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  scaleX?: number;
  scaleY?: number;
  scaleZ?: number;
  /** 指向 models[] 下标；用来找 part 对应的 FLVER。 */
  modelIndex?: number;
}

export interface MsbRegionLike extends MsbNativeEntityLike {
  typeId: number;
  posX: number;
  posY: number;
  posZ: number;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  scaleX?: number;
  scaleY?: number;
  scaleZ?: number;
}

export interface MsbMapEventLike extends MsbNativeEntityLike {
  typeId: number;
}

export interface MsbRouteLike extends MsbNativeEntityLike {
  typeId: number;
  /** MSB route record id；可能由原生记录缺省。 */
  id?: number;
}

export interface MsbSceneSourceCounts {
  models: number;
  parts: number;
  regions: number;
  events: number;
  routes: number;
}

export interface MsbSemanticSceneEntity {
  id: string;
  label: string;
  kind: MsbSceneEntityKind;
  sourceResourceUri: string;
  nativeOffset?: number;
  typeId?: number;
  /** 仅 msb-route 有效，保留 Bridge 的原生 route id。 */
  routeId?: number;
}

export interface SceneNode extends MsbSemanticSceneEntity {
  kind: 'msb-part' | 'msb-region';
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  /** 指向 manifest.models 的下标；仅 msb-part 有效，用于解析真实 FLVER 的 modelName。 */
  modelIndex?: number;
}

export interface SceneManifest extends SceneResourceMetadata {
  schemaVersion: 2;
  /** Backward-compatible alias for sourceUri. */
  mapResourceUri: string;
  authority: 'partial';
  entityCount: number;
  nodeCount: number;
  entities: MsbSemanticSceneEntity[];
  nodes: SceneNode[];
  /** 模型表，与 SceneNode.modelIndex 联动；用于在 draw 阶段按 modelName 去重拉取 FLVER。 */
  models?: MsbModelLike[];
  sourceCounts: MsbSceneSourceCounts;
  projectedCounts: MsbSceneSourceCounts;
  chunkSize: number;
  diagnostics: SceneProjectionDiagnostic[];
}

export interface SceneDrawItem {
  id: string;
  label: string;
  entityKind: SceneNode['kind'];
  primitive: SceneProxyPrimitive;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  sourceResourceUri: string;
  colorRgb: [number, number, number];
  /** 按 models[modelIndex].name 解析出的 FLVER 名（用于按模型去重的真实网格拉取）；缺省保持线框。 */
  modelName?: string;
  /**
   * S23：该节点对应的真实 FLVER 网格（mapbnd 里按 modelName 提取的 base64
   * typed buffers）。提供时投影层用真实几何替换 proxy 盒子；缺省保持盒子。
   * base64 而不是 typed array：跨 IPC 的语义场景保持可序列化。
   */
  mesh?: {
    positionsBase64: string;
    indicesBase64?: string;
    indexSize?: 16 | 32;
    uvsBase64?: string;
    normalsBase64?: string;
    vertexCount: number;
    /** Bridge 解析出的 albedo PNG data URI；renderer 不猜测本机纹理路径。 */
    texturePreviewToken?: string;
    textureColorSpace?: string;
    /** 合并多个 FLVER mesh 后的 index/vertex draw groups，materialIndex 对应 texturePreviews。 */
    materialGroups?: Array<{ start: number; count: number; materialIndex: number }>;
    texturePreviews?: Array<{ materialIndex: number; texturePreviewToken: string; colorSpace?: string }>;
    boundingBoxMin?: [number, number, number];
    boundingBoxMax?: [number, number, number];
  };
}

export interface SceneDrawList extends SceneResourceMetadata {
  schemaVersion: 2;
  /** Backward-compatible alias for sourceUri. */
  mapResourceUri: string;
  authority: 'partial';
  packetId: string;
  chunkIndex: number;
  chunkCount: number;
  totalItemCount: number;
  itemCount: number;
  items: SceneDrawItem[];
  bounds: {
    min: [number, number, number];
    max: [number, number, number];
    center: [number, number, number];
  };
  diagnostics: SceneProjectionDiagnostic[];
}

export class SceneProjectionError extends Error {
  readonly diagnostic: SceneProjectionDiagnostic;

  constructor(code: string, message: string) {
    super(code);
    this.name = 'SceneProjectionError';
    this.diagnostic = { severity: 'error', code, message };
  }
}

export function buildMsbSceneManifest(input: SceneResourceMetadata & {
  models?: MsbModelLike[];
  parts: MsbPartTransformLike[];
  regions?: MsbRegionLike[];
  events?: MsbMapEventLike[];
  routes?: MsbRouteLike[];
  sourceCounts?: Partial<MsbSceneSourceCounts>;
  maxNodes?: number;
  chunkSize?: number;
}): SceneManifest {
  const metadata = validateMetadata(input);
  // 三层截断移除后不再有默认硬上限：不传 maxNodes 即投影全部可绘制节点；
  // 调用方显式传入 maxNodes 时作为有界窗口（scaleAccess=bounded-window 语义），
  // 并给出 SCENE_NODE_TRUNCATED 结构化诊断。
  const maxNodes = input.maxNodes === undefined
    ? undefined
    : positiveInteger(input.maxNodes, 'SCENE_MAX_NODES_INVALID');
  const chunkSize = positiveInteger(input.chunkSize ?? 512, 'SCENE_CHUNK_SIZE_INVALID');
  const diagnostics: SceneProjectionDiagnostic[] = [];
  const models = input.models ?? [];
  const regions = input.regions ?? [];
  const events = input.events ?? [];
  const routes = input.routes ?? [];
  const sourceCounts: MsbSceneSourceCounts = {
    models: sourceCount(input.sourceCounts?.models, models.length),
    parts: sourceCount(input.sourceCounts?.parts, input.parts.length),
    regions: sourceCount(input.sourceCounts?.regions, regions.length),
    events: sourceCount(input.sourceCounts?.events, events.length),
    routes: sourceCount(input.sourceCounts?.routes, routes.length)
  };
  const projectedCounts: MsbSceneSourceCounts = {
    models: models.length,
    parts: input.parts.length,
    regions: regions.length,
    events: events.length,
    routes: routes.length
  };
  const identities = new Map<string, number>();
  let usedFallbackIdentity = false;

  const createEntity = <TKind extends MsbSceneEntityKind>(
    kind: TKind,
    entity: MsbNativeEntityLike
  ): MsbSemanticSceneEntity & { kind: TKind } => {
    validateEntity(entity);
    const identity = entity.nativeOffset === undefined
      ? `name-${encodeURIComponent(entity.name)}`
      : `offset-${entity.nativeOffset.toString(16)}`;
    if (entity.nativeOffset === undefined) usedFallbackIdentity = true;
    const baseId = `${kind}:${identity}`;
    const duplicateIndex = identities.get(baseId) ?? 0;
    identities.set(baseId, duplicateIndex + 1);
    const id = duplicateIndex === 0 ? baseId : `${baseId}:duplicate-${duplicateIndex}`;
    if (duplicateIndex > 0) {
      diagnostics.push({
        severity: 'warning',
        code: 'SCENE_ENTITY_ID_COLLISION',
        message: `实体 ${kind}/${entity.name} 缺少唯一 native identity，已使用不稳定的重复序号。`
      });
    }
    return {
      id,
      label: entity.name,
      kind,
      sourceResourceUri: `${stripFragment(metadata.sourceUri)}#entity/${encodeURIComponent(id)}`,
      ...(entity.nativeOffset === undefined ? {} : { nativeOffset: entity.nativeOffset }),
      ...(entity.typeId === undefined ? {} : { typeId: entity.typeId })
    };
  };

  const entities: MsbSemanticSceneEntity[] = [];
  for (const model of models) entities.push(createEntity('msb-model', model));

  const drawable: SceneNode[] = [];
  for (const part of input.parts) {
    const entity = createEntity('msb-part', part);
    const node = toSceneNode(entity, part);
    if (typeof part.modelIndex === 'number' && Number.isFinite(part.modelIndex)) {
      node.modelIndex = part.modelIndex;
    }
    entities.push(node);
    drawable.push(node);
  }
  for (const region of regions) {
    const entity = createEntity('msb-region', region);
    const node = toSceneNode(entity, region);
    entities.push(node);
    drawable.push(node);
  }
  for (const event of events) entities.push(createEntity('msb-event', event));
  for (const route of routes) {
    const entity = createEntity('msb-route', route);
    entities.push(route.id === undefined ? entity : { ...entity, routeId: route.id });
  }

  const nodes = maxNodes === undefined ? drawable : drawable.slice(0, maxNodes);
  if (maxNodes !== undefined && drawable.length > maxNodes) {
    diagnostics.push({
      severity: 'warning',
      code: 'SCENE_NODE_TRUNCATED',
      message: `调用方显式请求有界窗口 ${maxNodes}，render projection 已截断（非默认行为）。`
    });
  }
  if (Object.keys(sourceCounts).some((key) => {
    const typed = key as keyof MsbSceneSourceCounts;
    return sourceCounts[typed] > projectedCounts[typed];
  })) {
    diagnostics.push({
      severity: 'warning',
      code: 'SCENE_PROJECTION_PARTIAL',
      message: 'Bridge 返回的是实体预览子集；场景投影不得解释为完整 MSB 文档。'
    });
  }
  if (usedFallbackIdentity) {
    diagnostics.push({
      severity: 'warning',
      code: 'SCENE_IDENTITY_FALLBACK',
      message: '部分实体缺少 native offset，identity 已退化为名称；重命名时不保证稳定。'
    });
  }
  diagnostics.push({
    severity: 'info',
    code: 'SCENE_MANIFEST_BUILT',
    message: `已投影 ${entities.length} 个 MSB 实体和 ${nodes.length} 个可绘制节点。`
  });

  const manifest: SceneManifest = {
    ...metadata,
    schemaVersion: 2,
    mapResourceUri: metadata.sourceUri,
    authority: 'partial',
    entityCount: entities.length,
    nodeCount: nodes.length,
    entities,
    nodes,
    ...(models.length > 0 ? { models } : {}),
    sourceCounts,
    projectedCounts,
    chunkSize,
    diagnostics
  };
  assertNoAbsolutePathLeak(manifest);
  return manifest;
}

export function chunkSceneNodes(manifest: SceneManifest, chunkIndex: number): SceneNode[] {
  const index = nonNegativeInteger(chunkIndex, 'SCENE_CHUNK_INDEX_INVALID');
  const start = index * manifest.chunkSize;
  return manifest.nodes.slice(start, start + manifest.chunkSize);
}

export function buildSceneDrawList(
  manifest: SceneManifest,
  options?: { chunkIndex?: number; maxItems?: number }
): SceneDrawList {
  const chunked = options?.chunkIndex !== undefined;
  const chunkIndex = nonNegativeInteger(options?.chunkIndex ?? 0, 'SCENE_CHUNK_INDEX_INVALID');
  // 无默认硬上限：不传 maxItems 即输出全部可用项；显式传入时为有界窗口，
  // 并给出 SCENE_RENDER_PACKET_TRUNCATED 结构化诊断。
  const maxItems = options?.maxItems === undefined
    ? undefined
    : positiveInteger(options.maxItems, 'SCENE_MAX_ITEMS_INVALID');
  const chunkCount = chunked
    ? Math.ceil(manifest.nodeCount / manifest.chunkSize)
    : (manifest.nodeCount === 0 ? 0 : 1);
  const available = chunked ? chunkSceneNodes(manifest, chunkIndex) : manifest.nodes;
  const selected = maxItems === undefined ? available : available.slice(0, maxItems);
  const diagnostics = [...manifest.diagnostics];
  if (maxItems !== undefined && available.length > maxItems) {
    diagnostics.push({
      severity: 'warning',
      code: 'SCENE_RENDER_PACKET_TRUNCATED',
      message: `调用方显式请求有界窗口 ${maxItems} 项，render packet 已截断（非默认行为）。`
    });
  }
  const items: SceneDrawItem[] = selected.map((node) => {
    const modelName = node.kind === 'msb-part'
      && typeof node.modelIndex === 'number'
      && manifest.models?.[node.modelIndex]?.name
      ? manifest.models[node.modelIndex]!.name
      : undefined;
    return {
      id: node.id,
      label: node.label,
      entityKind: node.kind,
      primitive: node.kind === 'msb-region' ? 'sphere' : 'box',
      position: node.position,
      rotation: node.rotation,
      scale: sanitizeScale(node.scale),
      sourceResourceUri: node.sourceResourceUri,
      colorRgb: colorForEntity(node.id, node.kind),
      ...(modelName ? { modelName } : {})
    };
  });
  const packet: SceneDrawList = {
    sourceUri: manifest.sourceUri,
    sourcePath: manifest.sourcePath,
    game: manifest.game,
    resourceKind: manifest.resourceKind,
    revision: manifest.revision,
    schemaVersion: 2,
    mapResourceUri: manifest.sourceUri,
    authority: 'partial',
    packetId: `${manifest.sourceUri}@${manifest.revision}:${chunked ? `chunk-${chunkIndex}` : 'full'}`,
    chunkIndex,
    chunkCount,
    totalItemCount: manifest.nodeCount,
    itemCount: items.length,
    items,
    bounds: computeBounds(items),
    diagnostics
  };
  assertNoAbsolutePathLeak(packet);
  return packet;
}

function validateMetadata(input: SceneResourceMetadata): SceneResourceMetadata {
  if (!input.sourceUri || !input.sourceUri.includes('://')) {
    throw new SceneProjectionError('SCENE_URI_INVALID', 'sourceUri 必须是 renderer-safe 资源 URI。');
  }
  if (!input.game.trim()) {
    throw new SceneProjectionError('SCENE_GAME_REQUIRED', 'game 不能为空。');
  }
  if (input.resourceKind !== 'map') {
    throw new SceneProjectionError('SCENE_RESOURCE_KIND_INVALID', 'MSB 场景的 resourceKind 必须为 map。');
  }
  if (!input.revision.trim()) {
    throw new SceneProjectionError('SCENE_REVISION_REQUIRED', '场景投影必须绑定 source revision。');
  }
  const sourcePath = input.sourcePath.replaceAll('\\', '/');
  if (!sourcePath || sourcePath.startsWith('/') || /^[A-Za-z]:/.test(sourcePath)
    || sourcePath.split('/').includes('..')) {
    throw new SceneProjectionError('SCENE_SOURCE_PATH_INVALID', 'sourcePath 必须是无越界段的工作区相对路径。');
  }
  const metadata = { ...input, sourcePath };
  assertNoAbsolutePathLeak(metadata);
  return metadata;
}

function validateEntity(entity: MsbNativeEntityLike): void {
  if (!entity.name || entity.name.length > 512) {
    throw new SceneProjectionError('SCENE_ENTITY_NAME_INVALID', 'MSB 实体名称为空或过长。');
  }
  if (entity.nativeOffset !== undefined
    && (!Number.isSafeInteger(entity.nativeOffset) || entity.nativeOffset < 0)) {
    throw new SceneProjectionError('SCENE_NATIVE_OFFSET_INVALID', 'MSB native offset 必须是非负安全整数。');
  }
  assertNoAbsolutePathLeak(entity.name);
}

function toSceneNode(
  entity: MsbSemanticSceneEntity & { kind: 'msb-part' | 'msb-region' },
  transform: MsbPartTransformLike | MsbRegionLike
): SceneNode;
function toSceneNode(
  entity: MsbSemanticSceneEntity,
  transform: MsbPartTransformLike | MsbRegionLike
): SceneNode {
  const position = finiteVector(
    [transform.posX, transform.posY, transform.posZ],
    'SCENE_POSITION_INVALID'
  );
  const rotation = finiteVector(
    [transform.rotX ?? 0, transform.rotY ?? 0, transform.rotZ ?? 0],
    'SCENE_ROTATION_INVALID'
  );
  const scale = finiteVector(
    [transform.scaleX ?? 1, transform.scaleY ?? 1, transform.scaleZ ?? 1],
    'SCENE_SCALE_INVALID'
  );
  return { ...entity, kind: entity.kind as SceneNode['kind'], position, rotation, scale };
}

function finiteVector(values: number[], code: string): [number, number, number] {
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) {
    throw new SceneProjectionError(code, `${code}: 场景向量必须包含三个有限数值。`);
  }
  return [values[0]!, values[1]!, values[2]!];
}

function sourceCount(value: number | undefined, projected: number): number {
  if (value === undefined) return projected;
  const count = nonNegativeInteger(value, 'SCENE_SOURCE_COUNT_INVALID');
  if (count < projected) {
    throw new SceneProjectionError('SCENE_SOURCE_COUNT_INVALID', 'source count 不能小于已投影实体数。');
  }
  return count;
}

function positiveInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SceneProjectionError(code, `${code}: 值必须是正安全整数。`);
  }
  return value;
}

function nonNegativeInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SceneProjectionError(code, `${code}: 值必须是非负安全整数。`);
  }
  return value;
}

function stripFragment(uri: string): string {
  const index = uri.indexOf('#');
  return index < 0 ? uri : uri.slice(0, index);
}

function sanitizeScale(scale: [number, number, number]): [number, number, number] {
  // 忠实保留原始 MSB scale 语义，不做截断、不取绝对值、不强制改 0，仅对 NaN/Infinity 做有限数值保护
  return [
    Number.isFinite(scale[0]) ? scale[0] : 1,
    Number.isFinite(scale[1]) ? scale[1] : 1,
    Number.isFinite(scale[2]) ? scale[2] : 1
  ];
}

function colorForEntity(id: string, kind: SceneNode['kind']): [number, number, number] {
  let hash = kind === 'msb-region' ? 0x6d2b79f5 : 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193) >>> 0;
  }
  const hue = hash % 360;
  const saturation = kind === 'msb-region' ? 0.7 : 0.55;
  const lightness = kind === 'msb-region' ? 0.62 : 0.55;
  return hslToRgb(hue, saturation, lightness);
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lightness - chroma / 2;
  let rgb: [number, number, number];
  if (hue < 60) rgb = [chroma, x, 0];
  else if (hue < 120) rgb = [x, chroma, 0];
  else if (hue < 180) rgb = [0, chroma, x];
  else if (hue < 240) rgb = [0, x, chroma];
  else if (hue < 300) rgb = [x, 0, chroma];
  else rgb = [chroma, 0, x];
  return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
}

function computeBounds(items: SceneDrawItem[]): SceneDrawList['bounds'] {
  if (items.length === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0] };
  }
  // 优先仅基于主要实体（msb-part）计算紧致包围盒，防止远端辅助 Region / Event 把地图视觉中心拉向几公里外
  const parts = items.filter((item) => item.entityKind === 'msb-part');
  const targetItems = parts.length > 0 ? parts : items;

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  for (const item of targetItems) {
    const bMin = item.mesh?.boundingBoxMin;
    const bMax = item.mesh?.boundingBoxMax;

    if (bMin && bMax && Number.isFinite(bMin[0]) && Number.isFinite(bMax[0])) {
      // 8 个局部 AABB 角点
      const corners: Array<[number, number, number]> = [
        [bMin[0], bMin[1], bMin[2]],
        [bMin[0], bMin[1], bMax[2]],
        [bMin[0], bMax[1], bMin[2]],
        [bMin[0], bMax[1], bMax[2]],
        [bMax[0], bMin[1], bMin[2]],
        [bMax[0], bMin[1], bMax[2]],
        [bMax[0], bMax[1], bMin[2]],
        [bMax[0], bMax[1], bMax[2]]
      ];

      // 欧拉角 (度 -> 弧度)
      const radX = (item.rotation[0] * Math.PI) / 180;
      const radY = (item.rotation[1] * Math.PI) / 180;
      const radZ = (item.rotation[2] * Math.PI) / 180;

      const cx = Math.cos(radX), sx = Math.sin(radX);
      const cy = Math.cos(radY), sy = Math.sin(radY);
      const cz = Math.cos(radZ), sz = Math.sin(radZ);

      for (const [lx, ly, lz] of corners) {
        // 缩放
        const scaledX = lx * item.scale[0];
        const scaledY = ly * item.scale[1];
        const scaledZ = lz * item.scale[2];

        // 旋转 (XYZ Euler)
        const x1 = scaledX;
        const y1 = cx * scaledY - sx * scaledZ;
        const z1 = sx * scaledY + cx * scaledZ;

        const x2 = cy * x1 + sy * z1;
        const y2 = y1;
        const z2 = -sy * x1 + cy * z1;

        const x3 = cz * x2 - sz * y2;
        const y3 = sz * x2 + cz * y2;
        const z3 = z2;

        // 平移
        const wx = x3 + item.position[0];
        const wy = y3 + item.position[1];
        const wz = z3 + item.position[2];

        min[0] = Math.min(min[0], wx);
        min[1] = Math.min(min[1], wy);
        min[2] = Math.min(min[2], wz);

        max[0] = Math.max(max[0], wx);
        max[1] = Math.max(max[1], wy);
        max[2] = Math.max(max[2], wz);
      }
    } else {
      for (let index = 0; index < 3; index += 1) {
        min[index] = Math.min(min[index]!, item.position[index]!);
        max[index] = Math.max(max[index]!, item.position[index]!);
      }
    }
  }

  return {
    min,
    max,
    center: [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2
    ]
  };
}

function assertNoAbsolutePathLeak(value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (/(?:^|["'\s])(?:[A-Za-z]:[\\/]|\\\\)/.test(text)
    || /file:\/\/{1,3}[A-Za-z]:/i.test(text)
    || /\/(?:Users|home)\//i.test(text)) {
    throw new SceneProjectionError('SCENE_ABSOLUTE_PATH_LEAK', '场景投影包含绝对文件系统路径。');
  }
}
