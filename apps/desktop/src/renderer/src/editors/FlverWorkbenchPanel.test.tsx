/**
 * MODEL-51B：FLVER 三栏模型工作台接入后的 renderer 单元测试。
 *
 * renderer-unit 是纯 node SSR（react-dom/server，无 DOM、不跑 effect），而
 * FlverViewer 的 3D 场景由 effect 驱动（readFlverMesh → mountFlverScene），SSR
 * 只能看到挂载即有的骨架。因此这里钉两类契约：
 *
 * 1. SSR 结构：三栏 模型层级 | Viewport | Properties 挂载即存在，没有为凑四栏造
 *    Tools 空栏；未加载 FLVER 数据时左栏是显式 muted 空态而不是错误；树栈竖叠
 *    网格/材质/纹理槽/骨骼四组，分组列表由 shared pages 投影派生而不是扫字节；
 * 2. Negative source：FLVER 是 V0.6 延期只读预览时 footer 只有延期提示、没有任何
 *    保存动作；viewport 只承载 FlverViewer 宿主（SSR 下无 canvas）；partial model
 *    必须把 unparsedGaps/layoutWarnings 暴露给用户，不能伪装成完整解析。
 *
 * 选择 → viewport 的绑定逻辑抽成纯函数 resolveViewportMeshIndex，直接断言
 * （SSR 不跑 effect，无法在渲染期点击）。真实 live 链路（Bridge → ipc →
 * readFlverDocument → mountFlverScene）由 bridge:verify:flver-multi 与 E2E 覆盖。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FlverWorkbenchPanel,
  resolveViewportMeshIndex,
  type SelectedItem
} from './FlverWorkbenchPanel.js';
import type { FlverDocument, FlverMeshWire, FlverTextureSlotWire } from '@soulforge/shared';

// node 环境没有 window；getRendererRuntime 读 window.soulforge。设为空对象 →
// bridge 为 null → live 路径短路，SSR 输出纯初始结构（effect 不跑）。
(globalThis as unknown as { window: Record<string, unknown> }).window = {};

function makeDocument(overrides: Record<string, unknown> = {}): FlverDocument {
  return {
    format: 'FLVER',
    version: 'L',
    internalVersion: '0x2001A',
    sourceSize: 4096,
    sourceHash: 'abc123',
    skeletonTransformCount: 8,
    materialCount: 1,
    boneCount: 2,
    vertexBufferCount: 1,
    meshCount: 2,
    faceSetCount: 2,
    bufferLayoutCount: 1,
    textureCount: 2,
    faceCount: 24,
    totalFaceCount: 24,
    vertexStride: 40,
    vertexStrides: [40],
    unicode: false,
    boundingBox: { min: [0, 0, 0], max: [10, 20, 30] },
    materials: [
      { name: 'mat_a', mtdPath: 'mtd/m_a.mtd', textureCount: 2, flags: 0, gxOffset: 0, unk18: 0, gxList: null }
    ],
    materialsTruncated: false,
    bones: [
      { name: 'root', parentIndex: -1, nextSiblingIndex: -1 },
      { name: 'hand', parentIndex: 0, nextSiblingIndex: -1 }
    ],
    bonesTruncated: false,
    meshes: [
      { index: 0, dynamic: 0, materialIndex: 0, defaultBoneIndex: 0, vertexCount: 10, vertexStride: 40, bufferLayoutIndex: 0, faceSetCount: 1, boneCount: 2, indexFormat: 16 },
      { index: 1, dynamic: 0, materialIndex: 0, defaultBoneIndex: 0, vertexCount: 6, vertexStride: 40, bufferLayoutIndex: 0, faceSetCount: 1, boneCount: 2, indexFormat: 16 }
    ],
    meshesTruncated: false,
    bufferLayouts: [],
    textureSlots: [
      { index: 0, type: 'g', path: 'tex/a.dds', materialIndex: 0 },
      { index: 1, type: 'g', path: 'tex/b.dds', materialIndex: 0 }
    ],
    texturesTruncated: false,
    layoutWarnings: [],
    unparsedGaps: [],
    roundTrip: {
      byteIdentical: true, semanticIdentical: true,
      sourceHash: 'abc123', rebuiltHash: 'abc123',
      skeletonTransformCount: 8, materialCount: 1, boneCount: 2, meshCount: 2
    },
    authority: 'partial',
    ...overrides
  } as FlverDocument;
}

function render(data: FlverDocument | null = makeDocument()): string {
  return renderToStaticMarkup(
    <FlverWorkbenchPanel resourceUri="fixture://chr/c1000.flver" data={data} />
  );
}

describe('FlverWorkbenchPanel 初始结构（挂载即有的三栏骨架）', () => {
  it('工作台根的可访问名是「FLVER 模型工作台」', () => {
    assert.match(render(), /aria-label="FLVER 模型工作台"/);
  });

  it('三栏 模型层级 | Viewport | Properties 同时存在', () => {
    const html = render();
    assert.match(html, /aria-label="模型层级"/);
    assert.match(html, /aria-label="Viewport"/);
    assert.match(html, /aria-label="Properties"/);
  });

  it('没有为凑四栏造 Tools 空栏', () => {
    assert.doesNotMatch(render(), /aria-label="Tools"/);
  });

  it('未加载 FLVER 数据时左栏是显式 muted 空态而不是错误', () => {
    const html = render(null);
    assert.match(html, /选择 \.flver 文件以查看 3D 模型数据/);
    assert.doesNotMatch(html, /className="danger"/);
  });

  it('树栈竖叠 网格/材质/纹理槽/骨骼 四组，由 pages 投影派生', () => {
    const html = render();
    assert.match(html, />网格<|网格 列表/);
    assert.match(html, />材质<|材质 列表/);
    assert.match(html, />纹理槽<|纹理槽 列表/);
    assert.match(html, />骨骼<|骨骼 列表/);
    // 具体条目来自 shared 投影（mesh[0]/mat_a/tex/a.dds 的 basename/root），不是 renderer 扫字节。
    assert.match(html, /mesh\[0\]/);
    assert.match(html, /mat_a/);
    assert.match(html, /title="a\.dds"/);
    assert.match(html, />root</);
  });
});

describe('resolveViewportMeshIndex（材质槽 → viewport 绑定同步的纯逻辑）', () => {
  const meshes: FlverMeshWire[] = [
    { index: 0, dynamic: 0, materialIndex: 0, defaultBoneIndex: 0, vertexCount: 10, vertexStride: 40, bufferLayoutIndex: 0, faceSetCount: 1, boneCount: 2, indexFormat: 16 },
    { index: 1, dynamic: 0, materialIndex: 1, defaultBoneIndex: 0, vertexCount: 6, vertexStride: 40, bufferLayoutIndex: 0, faceSetCount: 1, boneCount: 2, indexFormat: 16 }
  ];
  const textures: FlverTextureSlotWire[] = [
    { index: 0, type: 'g', path: 'tex/a.dds', materialIndex: 0 },
    { index: 1, type: 'g', path: 'tex/b.dds', materialIndex: 1 }
  ];

  it('未选择时回退 mesh[0]', () => {
    assert.equal(resolveViewportMeshIndex(meshes, textures, null), 0);
  });

  it('选中 mesh → 显示其本身', () => {
    const selected: SelectedItem = { kind: 'mesh', index: 1, label: 'mesh[1]' };
    assert.equal(resolveViewportMeshIndex(meshes, textures, selected), 1);
  });

  it('选中材质 → 第一个引用该材质的 mesh', () => {
    const selected: SelectedItem = { kind: 'material', index: 0, label: 'mat_a' };
    assert.equal(resolveViewportMeshIndex(meshes, textures, selected), 0);
    const selectedB: SelectedItem = { kind: 'material', index: 1, label: 'mat_b' };
    assert.equal(resolveViewportMeshIndex(meshes, textures, selectedB), 1);
  });

  it('选中纹理槽 → 经其 materialIndex 找到绑定 mesh', () => {
    const selected: SelectedItem = { kind: 'texture', index: 1, label: 'tex/b.dds' };
    assert.equal(resolveViewportMeshIndex(meshes, textures, selected), 1);
  });

  it('无 mesh 引用该材质时回退 0（不崩、不越界）', () => {
    const selected: SelectedItem = { kind: 'material', index: 9, label: '材质 9' };
    assert.equal(resolveViewportMeshIndex(meshes, textures, selected), 0);
  });

  it('纹理槽 materialIndex 缺失时回退 0', () => {
    const selected: SelectedItem = { kind: 'texture', index: 0, label: 'tex/a.dds' };
    assert.equal(resolveViewportMeshIndex(meshes, [{ index: 0, type: 'g', path: 'tex/a.dds', materialIndex: -1 }], selected), 0);
  });

  it('骨骼/其他 kind 不驱动 viewport（回退 0）', () => {
    const selected: SelectedItem = { kind: 'bone', index: 0, label: 'root' };
    assert.equal(resolveViewportMeshIndex(meshes, textures, selected), 0);
  });
});

describe('Negative source tests（MODEL-51B 四类覆盖）', () => {
  const repoRoot = process.cwd();
  const panelSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'FlverWorkbenchPanel.tsx'),
    'utf8'
  );

  it('S38 开闸后无延期文案：footer 不再标注「延期至 V0.6 / 主进程拒绝写入」', () => {
    const html = render();
    assert.doesNotMatch(html, /已延期至|只读预览与网格\/材质槽选择，无写回入口|主进程会拒绝写入请求/);
    assert.match(html, /写入口未开放|直接写入/);
  });

  it('未传 onMaterialSlotSet 时不渲染写入控件，也不冒充可写', () => {
    const html = render();
    assert.doesNotMatch(html, /<button/);
    assert.doesNotMatch(html, /type="number"/);
  });

  it('传 onMaterialSlotSet 时 footer 说明写入口形态', () => {
    const html = renderToStaticMarkup(
      <FlverWorkbenchPanel
        resourceUri="fixture://chr/c1000.flver"
        data={makeDocument()}
        onMaterialSlotSet={() => undefined}
      />
    );
    assert.match(html, /材质槽修改在 Properties 栏点「应用材质槽」直接写入/);
    assert.doesNotMatch(html, /已延期至/);
  });

  it('mesh 属性区含材质槽写 UI（选中态渲染；SSR 初始无选中，用源码断言存在）', () => {
    // 写 UI 在 selected.kind === 'mesh' 分支，SSR 静态渲染看不到选中态，因此
    // 钉源码：按钮、slot 0 恒定、目标材质钳制都在面板内，而不是假装在别处。
    assert.match(panelSource, /应用材质槽/);
    assert.match(panelSource, /slotIndex/);
    assert.doesNotMatch(panelSource, /slotIndex=1|slotIndex: 1/);
    assert.match(panelSource, /meshStableId: `mesh:\$\{mesh\.index\}`/);
    assert.match(panelSource, /materialStableId: `material:\$\{target\}`/);
  });

  it('viewport 只承载 FlverViewer 宿主：SSR 下不渲染 canvas/假预览', () => {
    const html = render();
    assert.match(html, /FLVER 3D 预览/);
    assert.doesNotMatch(html, /<canvas/);
    assert.doesNotMatch(html, /假预览|fakePreview/);
  });

  it('partial model 必须把 unparsedGaps 暴露给用户，不伪装成完整解析', () => {
    const html = render(makeDocument({
      authority: 'partial',
      unparsedGaps: ['skeletonTransform 8 字节未解析', 'tangent 语义未解析'],
      layoutWarnings: []
    }));
    assert.match(html, /authority=partial/);
    assert.match(html, /已识别未解析结构 2 项/);
    assert.match(html, /skeletonTransform 8 字节未解析/);
    assert.match(html, /tangent 语义未解析/);
  });

  it('左树栈列表由 pages 投影派生，renderer 不扫字节、不猜格式', () => {
    assert.match(panelSource, /projectFlverDocumentPages/);
    assert.doesNotMatch(panelSource, /detectNestedFormat\(/);
    assert.doesNotMatch(panelSource, /guessFormatKind\(/);
    assert.doesNotMatch(panelSource, /readFile\(/);
  });
});
