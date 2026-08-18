import { useMemo, useState, type ReactElement } from 'react';
import {
  isFlverDocument,
  projectFlverDocumentPages,
  type FlverBoneWire,
  type FlverDocument,
  type FlverMaterialWire,
  type FlverMeshWire,
  type FlverTextureSlotWire
} from '@soulforge/shared';
import { FlverViewer } from './FlverViewer.js';
import { formatListTruncation } from '../format/uiText.js';
import { WorkbenchLayout } from '../workbench/WorkbenchLayout.js';
import { isRowTabEntry, selectableRowAttributes } from '../a11y/selectableRow.js';

/**
 * FLVER 三栏模型工作台（MODEL-51B）：`模型层级 | Viewport | Properties`（§2.5）。
 *
 * 对照 Smithbox 2.2.4 Model Editor 的选择链：左侧竖叠网格/材质/纹理槽/骨骼
 * 层级，选中网格或材质槽后中间 viewport 切到对应 mesh（真实 FLVER 网格，WebGPU
 * 优先 / WebGL2 fallback），右侧显示选中项数值属性。没有真实能力时不假造：
 * transform gizmo / 骨骼网格（skin preview）/ Asset Browser 在本版不出现。
 *
 * 材质槽与 viewport 的同步是**绑定关系**驱动的：材质（或纹理槽）选中后，
 * viewport 渲染第一个引用该材质的 mesh——与 Smithbox 里「选材质看它贴在哪」一致。
 *
 * S38 开闸：write-flver material-slot-set 写链（mesh 材质槽 → 目标材质）经
 * `resource.applyFlverMutation` → Patch Engine 提交，直接落盘、可回滚。只开放
 * 已接线的材质槽字段；骨骼权重等未接线字段不出现写入口，不假装能编。
 *
 * partial model：authority 为 partial 时，unparsedGaps/layoutWarnings 必须对用户
 * 可见（不能伪装成「完整解析的空模型」）——与硬约束 7 的 partial 严格区分同一条红线。
 */

export interface FlverWorkbenchPanelProps {
  resourceUri: string;
  data: FlverDocument | null;
  /** S38：mesh 材质槽写回（mesh:N → material:N；FLVER 每 mesh 只有 slot 0）。 */
  onMaterialSlotSet?: (input: { meshStableId: string; materialStableId: string }) => void;
  saving?: boolean;
}

type FlverSelectionKind = 'mesh' | 'material' | 'texture' | 'bone';

export interface SelectedItem {
  kind: FlverSelectionKind;
  index: number;
  label: string;
}

/**
 * 材质槽 → viewport 的同步是**绑定关系**驱动：选中 mesh → 其本身；选中材质/纹理槽
 * → 第一个引用该材质的 mesh；否则回退 0。抽成纯函数便于 renderer-unit 直接断言
 * （SSR 不跑 effect，选择逻辑不能在渲染期测）。
 */
export function resolveViewportMeshIndex(
  meshes: FlverMeshWire[],
  textures: FlverTextureSlotWire[],
  selected: SelectedItem | null
): number {
  if (!selected) return 0;
  if (selected.kind === 'mesh') return selected.index;
  const materialIndex = selected.kind === 'material'
    ? selected.index
    : selected.kind === 'texture'
      ? (textures[selected.index]?.materialIndex ?? -1)
      : -1;
  if (materialIndex < 0) return 0;
  const first = meshes.find((mesh) => mesh.materialIndex === materialIndex);
  return first?.index ?? 0;
}

/** 单个分组渲染上限（硬约束 17：大规模列表不能一次性全渲）。 */
const GROUP_RENDER_LIMIT = 40;

interface TreeEntry {
  id: string;
  label: string;
  sub: string;
  index: number;
}

interface TreeGroup {
  id: FlverSelectionKind;
  label: string;
  entries: TreeEntry[];
}

export function FlverWorkbenchPanel(props: FlverWorkbenchPanelProps): ReactElement {
  const [selected, setSelected] = useState<SelectedItem | null>(null);
  /** S38 写入口草稿：mesh 材质槽的目标材质下标；越界值在提交前被钳制。 */
  const [draftMaterialIndex, setDraftMaterialIndex] = useState<number>(0);

  const document = useMemo(
    () => (props.data && isFlverDocument(props.data) ? props.data : null),
    [props.data]
  );
  const pages = useMemo(
    () => (document ? projectFlverDocumentPages(document) : null),
    [document]
  );

  const meshes: FlverMeshWire[] = pages?.meshes.meshes ?? [];
  const materials: FlverMaterialWire[] = pages?.materialSlots.materials ?? [];
  const textures: FlverTextureSlotWire[] = pages?.materialSlots.textures ?? [];
  const bones: FlverBoneWire[] = document?.bones ?? [];
  const meshCount = pages?.meshes.meshCount ?? 0;
  const authority = document?.authority;

  /**
   * viewport 显示哪个 mesh：选中 mesh → 其本身；选中材质/纹理槽 → 第一个引用该
   * 材质的 mesh（材质槽与 viewport 高亮同步的驱动点）；否则回退 0。
   */
  const viewportMeshIndex = useMemo(
    () => resolveViewportMeshIndex(meshes, textures, selected),
    [selected, meshes, textures]
  );

  const treeGroups = useMemo<TreeGroup[]>(() => [
    {
      id: 'mesh',
      label: '网格',
      entries: meshes.map((mesh, index) => ({
        id: `mesh-${index}`,
        label: `mesh[${index}]`,
        sub: `${mesh.vertexCount} 顶点`,
        index
      }))
    },
    {
      id: 'material',
      label: '材质',
      entries: materials.map((material, index) => ({
        id: `mat-${index}`,
        label: material.name || `材质 ${index}`,
        sub: `${material.textureCount} 纹理`,
        index
      }))
    },
    {
      id: 'texture',
      label: '纹理槽',
      entries: textures.map((texture, index) => ({
        id: `tex-${index}`,
        label: texture.path.split(/[/\\]/).pop() || texture.path,
        sub: texture.type,
        index
      }))
    },
    {
      id: 'bone',
      label: '骨骼',
      entries: bones.map((bone, index) => ({
        id: `bone-${index}`,
        label: bone.name || `骨骼 ${index}`,
        sub: bone.parentIndex >= 0 ? `父 ${bone.parentIndex}` : '根',
        index
      }))
    }
  ], [meshes, materials, textures, bones]);

  function selectItem(kind: FlverSelectionKind, index: number, label: string): void {
    setSelected({ kind, index, label });
  }

  /** S38：mesh 材质槽写回（slotIndex 恒 0；目标材质下标越界则钳制为 0）。 */
  function submitMaterialSlot(mesh: FlverMeshWire | undefined): void {
    if (!props.onMaterialSlotSet || mesh === undefined) return;
    const target = Number.isFinite(draftMaterialIndex)
      ? Math.min(Math.max(Math.trunc(draftMaterialIndex), 0), Math.max(materials.length - 1, 0))
      : 0;
    props.onMaterialSlotSet({
      meshStableId: `mesh:${mesh.index}`,
      materialStableId: `material:${target}`
    });
  }

  const num = (value: number | undefined): string =>
    value === undefined ? '' : String(Math.round(value * 1e4) / 1e4);

  function propertiesFor(item: SelectedItem): Array<readonly [string, string]> {
    if (item.kind === 'mesh') {
      const mesh = meshes[item.index];
      return [
        ['索引', num(mesh?.index)],
        ['顶点数', num(mesh?.vertexCount)],
        ['顶点 stride', num(mesh?.vertexStride)],
        ['材质索引', num(mesh?.materialIndex)],
        ['缓冲布局', num(mesh?.bufferLayoutIndex)],
        ['faceSet 数', num(mesh?.faceSetCount)],
        ['骨骼数', num(mesh?.boneCount)],
        ['索引格式', mesh?.indexFormat === 16 ? 'uint16' : num(mesh?.indexFormat)]
      ];
    }
    if (item.kind === 'material') {
      const material = materials[item.index];
      return [
        ['名称', material?.name ?? item.label],
        ['MTD 路径', material?.mtdPath ?? ''],
        ['纹理数', num(material?.textureCount)],
        ['Flags', num(material?.flags)],
        ['GX 项数', material?.gxList ? String(material.gxList.itemCount) : '—']
      ];
    }
    if (item.kind === 'texture') {
      const texture = textures[item.index];
      return [
        ['类型', texture?.type ?? ''],
        ['路径', texture?.path ?? ''],
        ['所属材质', texture && texture.materialIndex >= 0 ? `材质 ${texture.materialIndex}` : '—']
      ];
    }
    const bone = bones[item.index];
    return [
      ['名称', bone?.name ?? item.label],
      ['父骨骼', bone?.parentIndex === undefined ? '' : String(bone.parentIndex)],
      ['下一兄弟', bone?.nextSiblingIndex === undefined ? '' : String(bone.nextSiblingIndex)]
    ];
  }

  const viewportSummary = selected
    ? (selected.kind === 'material' || selected.kind === 'texture')
      ? `材质槽 ${selected.label} 绑定 mesh[${viewportMeshIndex}]，视口已同步`
      : selected.kind === 'mesh'
        ? `已选择 ${selected.label}，视口已同步`
        : `已选择 ${selected.label}（仅属性，不驱动视口）`
    : `视口显示 mesh[${viewportMeshIndex}]`;

  const unparsedGapCount = document?.unparsedGaps?.length ?? 0;
  const layoutWarningCount = document?.layoutWarnings?.length ?? 0;
  const isPartial = authority === 'partial';
  // 用具名切片而非 `.slice(0, N).map(` 连写：listTruncation gate 把裸连写视为
  // 静默截断（此处最多展示前 8 条缺口，且必须配 summary 说明总数）。
  const visibleGaps = (document?.unparsedGaps ?? []).slice(0, 8);

  return (
    <WorkbenchLayout
      label="FLVER 模型工作台"
      columns={[
        {
          id: 'model-hierarchy',
          title: '模型层级',
          hint: `${meshCount} meshes · ${materials.length} mats`,
          initialFlex: 0.28,
          minWidth: 200,
          children: (
            <div className="flver-tree-list">
              {document === null ? (
                <p className="muted">选择 .flver 文件以查看 3D 模型数据。</p>
              ) : (
                treeGroups.map((group) => {
                  // 硬约束 17：分组条目可能上千，要分页而不是一次全渲；超限必须报
                  // 「已显示多少」（锚点 mesh 组用字面量 testid，守门见 listTruncation.test.ts）。
                  const visible = group.entries.slice(0, GROUP_RENDER_LIMIT);
                  const truncationNote = formatListTruncation({
                    total: group.entries.length,
                    shown: visible.length,
                    noun: `个 ${group.label}`
                  });
                  return (
                    <details key={group.id} className="flver-tree-group" open={group.entries.length > 0}>
                      <summary className="flver-tree-group__summary">
                        {group.label}
                        <span className="muted"> {group.entries.length}</span>
                      </summary>
                      {group.entries.length === 0 ? (
                        <p className="muted flver-tree-group__empty">无 {group.label}</p>
                      ) : (
                        <>
                          <div className="binder-child-table" role="table" aria-label={`${group.label} 列表`}>
                            {visible.map((entry, entryIndex) => (
                              <div
                                key={entry.id}
                                className="binder-child-row flver-tree-row"
                                {...selectableRowAttributes({
                                  selected: selected?.kind === group.id && selected?.index === entry.index,
                                  isTabEntry: group.id === 'mesh' && isRowTabEntry(entryIndex, selected !== null),
                                  onSelect: () => selectItem(group.id, entry.index, entry.label)
                                })}
                                style={selected?.kind === group.id && selected?.index === entry.index
                                  ? { outline: '1px solid var(--ember)' }
                                  : undefined}
                              >
                                <span title={entry.label}>{entry.label.slice(0, 40)}</span>
                                <span className="muted">{entry.sub}</span>
                              </div>
                            ))}
                          </div>
                          {truncationNote && (
                            group.id === 'mesh' ? (
                              <p className="muted" data-testid="flver-truncation">{truncationNote}</p>
                            ) : (
                              <p className="muted" data-testid={`${group.id}-truncation`}>{truncationNote}</p>
                            )
                          )}
                        </>
                      )}
                    </details>
                  );
                })
              )}
            </div>
          )
        },
        {
          id: 'viewport',
          title: 'Viewport',
          children: (
            <div className="flver-viewport">
              <FlverViewer
                sourceUri={props.resourceUri}
                meshIndex={viewportMeshIndex}
                boundingBox={pages?.bounds
                  ? { min: [...pages.bounds.min], max: [...pages.bounds.max] }
                  : undefined}
                boneCount={document?.boneCount ?? 0}
                meshCount={meshCount}
              />
              <p data-testid="flver-viewport-summary">{viewportSummary}</p>
              {isPartial && (unparsedGapCount > 0 || layoutWarningCount > 0) && (
                <details className="flver-partial">
                  <summary>
                    authority=partial · 已识别未解析结构 {unparsedGapCount} 项
                    {layoutWarningCount > 0 ? ` · 数据警告 ${layoutWarningCount} 条` : ''}
                  </summary>
                  <ul>
                    {visibleGaps.map((gap, gapIndex) => (
                      <li key={gapIndex} className="muted">{gap}</li>
                    ))}
                  </ul>
                </details>
              )}
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
                <div className="binder-child-row flver-property-row" role="row" key={key}>
                  <span className="muted">{key}</span>
                  <span>{value}</span>
                </div>
              ))}
              {selected.kind === 'mesh' && props.onMaterialSlotSet && (
                <div className="flver-slot-write" role="row">
                  <span className="muted">材质槽</span>
                  <label className="flver-slot-write__form">
                    <input
                      type="number"
                      min={0}
                      max={Math.max(materials.length - 1, 0)}
                      value={draftMaterialIndex}
                      aria-label={`目标材质（0-${Math.max(materials.length - 1, 0)}）`}
                      onChange={(event) => {
                        const parsed = Number(event.target.value);
                        setDraftMaterialIndex(Number.isFinite(parsed) ? parsed : 0);
                      }}
                      disabled={props.saving}
                    />
                    <button
                      type="button"
                      onClick={() => submitMaterialSlot(meshes[selected.index])}
                      disabled={props.saving || materials.length === 0}
                    >
                      {props.saving ? '提交中…' : '应用材质槽'}
                    </button>
                  </label>
                  <p className="muted">写回 mesh[{selected.index}] 的材质引用（slot 0），直接进 Patch Engine，可回滚。</p>
                </div>
              )}
            </div>
          ) : (
            <p className="muted">在左侧模型层级中选择一个网格、材质、纹理槽或骨骼后显示属性。</p>
          )
        }
      ]}
      footer={
        <div className="row gap">
          <p className="muted" role="note">
            {props.onMaterialSlotSet
              ? '材质槽修改在 Properties 栏点「应用材质槽」直接写入，经 Patch Engine 提交、可回滚。'
              : '仅提供只读预览与网格/材质槽选择；写入口未开放。'}
          </p>
        </div>
      }
    />
  );
}
