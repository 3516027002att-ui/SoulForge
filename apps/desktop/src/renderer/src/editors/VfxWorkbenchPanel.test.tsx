/**
 * VFX-54B/54C：VfxWorkbenchPanel 的渲染结构 + 纯逻辑 + 负向清单 + vfx-field-set 接线。
 *
 * renderer-unit 是纯 node SSR（react-dom/server，无 DOM、不跑 effect）。面板自驱动
 * 经 getRendererBridge 读 read-fxr-document（同 MaterialWorkbenchPanel 模式），SSR 下
 * bridge 为 null → 读取 effect 全部短路。已加载文档态用 initialDocument/initialSelection
 * 测试 seam 注入（生产不传），真实 live 链路（Bridge → ipc → readFxrDocument /
 * commitFxrFieldSet）由 e2e 覆盖。
 *
 * 三类契约：
 * 1. SSR 结构：三栏 Effect / Particle list | 真实预览 | Inspector 挂载即存在，
 *    中栏是诚实空态（不渲染假 viewport / 假 graph）；文件列表由 props 派生、显示名
 *    去 .fxr；未选文件时各栏给引导空态；未加载文档时不渲染任何编辑输入框。
 * 2. 纯逻辑：parseUnknownFxrTypes 从 gap 字符串解析未知类型集合；
 *    flattenFxrNodes 给递归树稳定路径 id + 深度；fxrValuePreview 摘要不透明 int 数组；
 *    buildVfxFieldSetMutation / isVfxFieldSetValue / fxrWriteBlockReasons / fxrCommitNotice
 *    钉住 VFX-54C 写回契约。
 * 3. Negative source：unknown 行只给原始结构字段、不给字段含义假数据；known-layout
 *    门（unknown node type / layout warning / Section9 非空 / Section12-14 非空）
 *    fail-closed，UI 预先禁用编辑控件并给原因；不引用 three/canvas（无假 viewport）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  VfxWorkbenchPanel,
  buildVfxFieldSetMutation,
  flattenFxrNodes,
  fxrCommitNotice,
  fxrValuePreview,
  fxrWriteBlockReasons,
  isVfxFieldSetValue,
  parseUnknownFxrTypes,
  vfxFileDisplayName,
  type VfxFileView,
  type VfxSelection
} from './VfxWorkbenchPanel.js';
import type { FxrDocument } from '@soulforge/shared';

// node 环境没有 window；getRendererRuntime 读 window.soulforge。设为空对象 →
// bridge 为 null → 读取 effect 短路，SSR 输出纯初始结构（同 TpfWorkbenchPanel）。
(globalThis as unknown as { window: Record<string, unknown> }).window = {};

const files: VfxFileView[] = [
  { sourceUri: 'fixture://sfx/f0000.fxr', relativePath: 'sfx/f0000.fxr' },
  { sourceUri: 'fixture://sfx/f0001.fxr', relativePath: 'sfx/f0001.fxr' }
];

function render(initialUri?: string): string {
  return renderToStaticMarkup(
    <VfxWorkbenchPanel files={files} {...(initialUri ? { initialUri } : {})} />
  );
}

function makeDocument(overrides: Record<string, unknown> = {}): FxrDocument {
  return {
    format: 'FXR3',
    formatId: 'fxr',
    version: 5,
    sourceSize: 4096,
    sourceHash: 'fixture-fxr-hash',
    resourceId: 0x00094F00,
    rootNodeCount: 1,
    totalNodeCount: 3,
    hostCount: 2,
    propertyCount: 2,
    section11ValueCount: 6,
    sectionCounts: {
      section1: 1, section2: 1, section3: 1, section4: 3, section5: 0,
      section6: 2, section7: 2, section8: 0, section9: 0, section10: 0,
      section11: 6, section12: 0, section13: 0, section14: 0
    },
    effect: {
      format: 'FXR3',
      version: 5,
      resourceId: 0x00094F00,
      rootNodeCount: 1,
      nodes: [
        {
          typeId: 2000,
          childCount: 1,
          drawEntityCount: 1,
          drawEntityRefCount: 0,
          children: [
            {
              typeId: 2200,
              childCount: 0,
              drawEntityCount: 0,
              drawEntityRefCount: 0,
              children: [],
              childrenTruncated: false
            }
          ],
          childrenTruncated: false
        }
      ],
      nodesTruncated: false
    },
    nodes: {
      total: 3,
      byType: [
        { typeId: 2000, count: 1 },
        { typeId: 2200, count: 2 }
      ]
    },
    fields: {
      hosts: [
        {
          typeId: 0,
          unk02: 1,
          unk03: 0,
          unk04: 2,
          section11Count: 2,
          section10Count: 0,
          section7Count: 1,
          properties: [
            {
              typeId: 3,
              unk04: 0,
              section11Count: 2,
              section8Count: 0,
              values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
              valuesTruncated: false,
              section8: [],
              section8Truncated: false
            }
          ],
          propertiesTruncated: false,
          section10: [],
          section10Truncated: false,
          values: [10, 11],
          valuesTruncated: false
        }
      ],
      hostsTruncated: false
    },
    unparsedGaps: [
      'section11:opaque-int-array（混合 int/float 位模式，无 schema，按不透明 int 数组上报）；values=6',
      'section12-14-empty-samples-only（真实样本恒空，非空布局未验证）',
      'unknown-type:section4:9999',
      'unknown-type:section6:7777',
      'unknown-type:section7:66'
    ],
    layoutWarnings: ['Section1[0]:+0x00/+0x0C 应为 0，实际 1/1。'],
    roundTrip: {
      consistent: true,
      sourceHash: 'fixture-fxr-hash',
      reparsedHash: 'fixture-fxr-hash',
      nodeCount: 3,
      propertyCount: 2,
      section11ValueCount: 6,
      note: null
    },
    authority: 'partial',
    ...overrides
  } as FxrDocument;
}

/**
 * VFX-54C 可写文档：去掉 unknown-type gap 与 layout warning，只留能力边界 gap
 * （section11:opaque-int-array / section12-14-empty-samples-only）——这两类不阻止写，
 * 与 C# FxrNativeWriter 的 EnsureKnownLayout 口径一致。
 */
function makeWritableDocument(): FxrDocument {
  return makeDocument({
    layoutWarnings: [],
    unparsedGaps: [
      'section11:opaque-int-array（混合 int/float 位模式，无 schema，按不透明 int 数组上报）；values=6',
      'section12-14-empty-samples-only（真实样本恒空，非空布局未验证）'
    ]
  });
}

/** 未知 host 文档：host.typeId=7777 命中 unknown-type:section6:7777 gap。 */
function makeUnknownHostDocument(): FxrDocument {
  return makeDocument({
    fields: {
      hosts: [
        {
          typeId: 7777,
          unk02: 1,
          unk03: 0,
          unk04: 2,
          section11Count: 2,
          section10Count: 0,
          section7Count: 1,
          properties: [
            {
              typeId: 3,
              unk04: 0,
              section11Count: 2,
              section8Count: 0,
              values: [0, 1],
              valuesTruncated: false,
              section8: [],
              section8Truncated: false
            }
          ],
          propertiesTruncated: false,
          section10: [],
          section10Truncated: false,
          values: [10, 11],
          valuesTruncated: false
        }
      ],
      hostsTruncated: false
    }
  });
}

/** 未知 property 文档：property.typeId=66 命中 unknown-type:section7:66 gap。 */
function makeUnknownPropertyDocument(): FxrDocument {
  return makeDocument({
    fields: {
      hosts: [
        {
          typeId: 0,
          unk02: 1,
          unk03: 0,
          unk04: 2,
          section11Count: 2,
          section10Count: 0,
          section7Count: 1,
          properties: [
            {
              typeId: 66,
              unk04: 0,
              section11Count: 2,
              section8Count: 0,
              values: [0, 1],
              valuesTruncated: false,
              section8: [],
              section8Truncated: false
            }
          ],
          propertiesTruncated: false,
          section10: [],
          section10Truncated: false,
          values: [10, 11],
          valuesTruncated: false
        }
      ],
      hostsTruncated: false
    }
  });
}

const hostSelection: VfxSelection = { kind: 'host', id: '0', label: 'host 0' };

/** SSR 渲染已加载文档态：bridge 为 null（effect 短路），文档/选中态走 seam 注入。 */
function renderLoaded(
  doc: FxrDocument,
  selection: VfxSelection | null,
  initialUri = 'fixture://sfx/f0000.fxr'
): string {
  return renderToStaticMarkup(
    <VfxWorkbenchPanel
      files={files}
      initialUri={initialUri}
      initialDocument={doc}
      initialSelection={selection}
    />
  );
}

describe('VfxWorkbenchPanel 初始结构（挂载即有的三栏骨架）', () => {
  it('工作台根的可访问名是「VFX 工作台」', () => {
    assert.match(render(), /aria-label="VFX 工作台"/);
  });

  it('三栏 Effect / Particle list | 真实预览 | Inspector 同时存在', () => {
    const html = render();
    assert.match(html, /aria-label="Effect \/ Particle list"/);
    assert.match(html, /aria-label="真实预览"/);
    assert.match(html, /aria-label="Inspector"/);
  });

  it('没有为凑四栏造 Tools 空栏', () => {
    const html = render();
    assert.doesNotMatch(html, /aria-label="Tools"/);
  });

  it('文件列表列出全部 FXR 文件，显示名去 .fxr，物理路径只在 title', () => {
    const html = render();
    assert.match(html, /f0000/);
    assert.match(html, /f0001/);
    assert.doesNotMatch(html, />f0000\.fxr</);
    assert.match(html, /title="sfx\/f0000\.fxr"/);
  });

  it('未选文件时各栏给出引导空态', () => {
    const html = render();
    assert.match(html, /先在最左栏选择一个 FXR 文件/);
  });

  it('未加载文档时无任何 type=button 与编辑输入框（编辑控件以读到的文档为前提）', () => {
    const html = render();
    assert.doesNotMatch(html, /type="button"/);
    assert.doesNotMatch(html, /type="number"/);
    assert.doesNotMatch(html, /<textarea/);
  });
});

describe('vfxFileDisplayName（显示名去 .fxr，不做假名字）', () => {
  it('去 .fxr 后缀', () => {
    assert.equal(vfxFileDisplayName({ sourceUri: 'fixture://sfx/f0000.fxr', relativePath: 'sfx/f0000.fxr' }), 'f0000');
  });

  it('去 .fxr.dcx 后缀', () => {
    assert.equal(vfxFileDisplayName({ sourceUri: 'fixture://sfx/f0000.fxr.dcx', relativePath: 'sfx/f0000.fxr.dcx' }), 'f0000');
  });

  it('无后缀文件保留原名（不猜格式）', () => {
    assert.equal(vfxFileDisplayName({ sourceUri: 'fixture://sfx/unknown', relativePath: 'sfx/unknown' }), 'unknown');
  });
});

describe('parseUnknownFxrTypes（从 gap 字符串解析未知类型集合）', () => {
  it('识别 section4/6/7 的 unknown-type gap', () => {
    const sets = parseUnknownFxrTypes([
      'unknown-type:section4:9999',
      'unknown-type:section4:8888',
      'unknown-type:section6:7777',
      'unknown-type:section7:66',
      'section11:opaque-int-array（...）',
      'section12-14-empty-samples-only（...）'
    ]);
    assert.ok(sets.section4.has(9999));
    assert.ok(sets.section4.has(8888));
    assert.ok(sets.section6.has(7777));
    assert.ok(sets.section7.has(66));
    assert.equal(sets.section4.size, 2);
    assert.equal(sets.section6.size, 1);
    assert.equal(sets.section7.size, 1);
  });

  it('空 gap 列表 → 全空集合（不把未知当已知）', () => {
    const sets = parseUnknownFxrTypes([]);
    assert.equal(sets.section4.size, 0);
    assert.equal(sets.section6.size, 0);
    assert.equal(sets.section7.size, 0);
  });

  it('已知类型不在未知集合里（无 gap = 已知）', () => {
    const sets = parseUnknownFxrTypes(['unknown-type:section6:7777']);
    assert.equal(sets.section4.has(2000), false);
    assert.equal(sets.section6.has(2000), false);
  });
});

describe('flattenFxrNodes（递归树扁平化，稳定路径 id）', () => {
  it('根与子节点都有路径 id 与深度', () => {
    const flat = flattenFxrNodes([
      {
        typeId: 2000, childCount: 1, drawEntityCount: 1, drawEntityRefCount: 0,
        children: [
          {
            typeId: 2200, childCount: 0, drawEntityCount: 0, drawEntityRefCount: 0,
            children: [], childrenTruncated: false
          }
        ],
        childrenTruncated: false
      },
      {
        typeId: 2200, childCount: 0, drawEntityCount: 0, drawEntityRefCount: 0,
        children: [], childrenTruncated: false
      }
    ]);
    assert.deepEqual(
      flat.map((item) => `${item.id}@${item.depth}:${item.node.typeId}`),
      ['0@0:2000', '0.0@1:2200', '1@0:2200']
    );
  });

  it('空树 → 空列表', () => {
    assert.deepEqual(flattenFxrNodes([]), []);
  });
});

describe('fxrValuePreview（Section11 不透明 int 数组摘要）', () => {
  it('全量显示所有值，不做省略（问题 5：显示不再设限）', () => {
    assert.equal(fxrValuePreview([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), '0, 1, 2, 3, 4, 5, 6, 7, 8, 9');
  });

  it('小数组长度的全量显示', () => {
    assert.equal(fxrValuePreview([10, 11]), '10, 11');
  });

  it('空数组显示占位，不编造值', () => {
    assert.equal(fxrValuePreview([]), '—');
  });
});

describe('VFX-54C vfx-field-set 接线', () => {
  const repoRoot = process.cwd();
  const panelSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'VfxWorkbenchPanel.tsx'),
    'utf8'
  );

  it('buildVfxFieldSetMutation:host 容器地址与值正确', () => {
    const mutation = buildVfxFieldSetMutation({ container: 'host', hostIndex: 1, valueIndex: 2 }, 42);
    assert.deepEqual(mutation, {
      mutation: 'vfx-field-set',
      address: { container: 'host', hostIndex: 1, valueIndex: 2 },
      value: 42
    });
  });

  it('buildVfxFieldSetMutation:property 容器带 propertyIndex', () => {
    const mutation = buildVfxFieldSetMutation(
      { container: 'property', hostIndex: 0, propertyIndex: 2, valueIndex: 5 },
      -1
    );
    assert.deepEqual(mutation, {
      mutation: 'vfx-field-set',
      address: { container: 'property', hostIndex: 0, propertyIndex: 2, valueIndex: 5 },
      value: -1
    });
  });

  it('buildVfxFieldSetMutation:section8 容器带 propertyIndex+section8Index', () => {
    const mutation = buildVfxFieldSetMutation(
      { container: 'section8', hostIndex: 0, propertyIndex: 1, section8Index: 3, valueIndex: 0 },
      4_294_967_295
    );
    assert.deepEqual(mutation, {
      mutation: 'vfx-field-set',
      address: { container: 'section8', hostIndex: 0, propertyIndex: 1, section8Index: 3, valueIndex: 0 },
      value: 4294967295
    });
  });

  it('isVfxFieldSetValue 只接受 int32/uint32 位模式（不据值做类型推断）', () => {
    assert.ok(isVfxFieldSetValue(0));
    assert.ok(isVfxFieldSetValue(-2_147_483_648));
    assert.ok(isVfxFieldSetValue(4_294_967_295));
    assert.ok(!isVfxFieldSetValue(-2_147_483_649));
    assert.ok(!isVfxFieldSetValue(4_294_967_296));
    assert.ok(!isVfxFieldSetValue(1.5));
    assert.ok(!isVfxFieldSetValue(Number.NaN));
  });

  it('fxrWriteBlockReasons:能力边界 gap（section11 不透明 / section12-14 恒空）不阻止写', () => {
    assert.deepEqual(fxrWriteBlockReasons(makeWritableDocument()), []);
  });

  it('fxrWriteBlockReasons:unknown node type 与 layout warning 各自命中', () => {
    const codes = fxrWriteBlockReasons(makeDocument()).map((reason) => reason.code);
    assert.ok(codes.includes('unknown-node-types'));
    assert.ok(codes.includes('layout-warnings-present'));
  });

  it('fxrWriteBlockReasons:Section9 非空 / Section12-14 非空命中', () => {
    const doc = makeDocument({
      unparsedGaps: [
        'section9-not-verified（SoulsFormats 布局，121 样本全部未实测）',
        'section12-14:opaque-int-array（非空布局未验证）'
      ]
    });
    const codes = fxrWriteBlockReasons(doc).map((reason) => reason.code);
    assert.ok(codes.includes('section9-not-verified'));
    assert.ok(codes.includes('section12-14-nonempty'));
  });

  it('known host:数值字段渲染 int32 输入框 + 写回按钮,不 disabled', () => {
    const html = renderLoaded(makeWritableDocument(), hostSelection);
    assert.match(html, /type="number"/);
    assert.match(html, /vfx-value-input-host:0:-:-:0/);
    assert.match(html, /vfx-value-input-property:0:0:-:0/);
    assert.match(html, /vfx-value-submit-host:0:-:-:0/);
    assert.match(html, /aria-label="host\[0\]" value="10"/);
    assert.match(html, /aria-label="property 3\[0\]" value="0"/);
    assert.doesNotMatch(html, /vfx-value-input-host:0:-:-:0"[^>]*disabled/);
  });

  it('unknown host:无任何编辑控件,保留 blocked 提示', () => {
    const html = renderLoaded(makeUnknownHostDocument(), { kind: 'host', id: '0', label: 'host 7777' });
    assert.match(html, /vfx-unknown-host-block/);
    assert.doesNotMatch(html, /vfx-value-input-/);
    assert.doesNotMatch(html, /type="number"/);
  });

  it('fail-closed:known host 输入框存在但 disabled,且给出原因', () => {
    const html = renderLoaded(makeDocument(), hostSelection);
    assert.match(html, /vfx-write-blocked/);
    assert.match(html, /vfx-write-block-layout-warnings-present/);
    assert.match(html, /vfx-write-block-unknown-node-types/);
    assert.match(html, /vfx-value-input-host:0:-:-:0/);
    assert.match(html, /vfx-value-input-host:0:-:-:0"[^>]*disabled/);
    assert.match(html, /（禁用）/);
  });

  it('unknown property:该属性不渲染编辑行,host 直连值仍受文档级门禁禁用', () => {
    const html = renderLoaded(makeUnknownPropertyDocument(), hostSelection);
    assert.match(html, /vfx-unknown-property/);
    assert.doesNotMatch(html, /vfx-value-input-property:0:0:-:/);
    assert.match(html, /vfx-value-input-host:0:-:-:0"[^>]*disabled/);
  });

  it('提交期间禁用重复提交:提交按钮与输入框都绑 committing', () => {
    assert.match(panelSource, /disabled=\{props\.disabled \|\| props\.committing \|\| invalid\}/);
    assert.match(panelSource, /disabled=\{props\.disabled \|\| props\.committing\}/);
  });

  it('fxrCommitNotice:ok 给「已重新读取」成功提示', () => {
    const notice = fxrCommitNotice({ ok: true, changedFiles: ['fixture://sfx/f0000.fxr'], diagnostics: [] });
    assert.equal(notice.kind, 'success');
    assert.match(notice.title, /重新读取/);
    assert.deepEqual(notice.lines, []);
  });

  it('fxrCommitNotice:失败给 diagnostics 与回滚提示', () => {
    const notice = fxrCommitNotice({
      ok: false,
      changedFiles: [],
      diagnostics: [{
        severity: 'error',
        code: 'FXR_WRITE_BLOCKED_UNKNOWN_STRUCTURE',
        message: '存在未识别的 node type'
      }]
    });
    assert.equal(notice.kind, 'failure');
    assert.ok(notice.lines.some((line) => line.includes('回滚')));
    assert.ok(notice.lines.some((line) => line.includes('FXR_WRITE_BLOCKED_UNKNOWN_STRUCTURE')));
  });

  it('ok=true 后重读:read effect 依赖 reloadKey 刷新触发器', () => {
    assert.match(panelSource, /reloadKey/);
    assert.match(panelSource, /\[bridge, selectedUri, selectedEntry, reloadKey\]/);
    assert.match(panelSource, /setReloadKey\(\(k\) => k \+ 1\)/);
  });

  it('失败不清空已读节点树:commit 失败路径不触碰 document', () => {
    const commitHandler = panelSource.match(/function commitFieldValue[\s\S]*?\n  \}/)?.[0] ?? '';
    assert.ok(commitHandler.includes('setCommitOutcome'), 'commit 处理器必须设置提交结果');
    assert.doesNotMatch(commitHandler, /setDocument/, 'commit 失败路径不得清空已读节点树');
  });
});

describe('Negative source tests（VFX-54B/54C）', () => {
  const repoRoot = process.cwd();
  const panelSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'VfxWorkbenchPanel.tsx'),
    'utf8'
  );

  it('桥接调用只有三个通道：read-fxr-document 读入 + listFxrEntries 子项列表 + commitFxrFieldSet 写回', () => {
    const bridgeCalls = [...panelSource.matchAll(/bridge\.(\w+)\s*\(/g)]
      .map((m) => m[1])
      .filter((name): name is string => name !== undefined);
    assert.ok(bridgeCalls.includes('readFxrDocument'), 'read 通道缺失');
    // S24：ffxbnd 效果库先列 .fxr 子项（一条失败不再整包判死）。
    assert.ok(bridgeCalls.includes('listFxrEntries'), 'listFxrEntries 通道缺失');
    assert.ok(bridgeCalls.includes('commitFxrFieldSet'), 'vfx-field-set 写回通道缺失');
    const unDeclared = bridgeCalls.filter(
      (name) => name !== 'readFxrDocument' && name !== 'listFxrEntries' && name !== 'commitFxrFieldSet'
    );
    assert.deepEqual(unDeclared, [], `发现未声明的桥接调用：${unDeclared.join(', ')}`);
  });

  it('编辑控件以 known-layout 门为前置：fail-closed 预禁用 + 给原因', () => {
    // 组件必须实现 C# EnsureKnownLayout 的镜像门禁（不是等 commit 失败）。
    assert.match(panelSource, /fxrWriteBlockReasons/);
    assert.match(panelSource, /vfx-write-blocked/);
    // 编辑入口存在（vfx-field-set 已接线），但值输入框带 disabled 能力。
    assert.match(panelSource, /commitFxrFieldSet/);
    assert.match(panelSource, /vfx-value-input-/);
    assert.match(panelSource, /disabled=\{/);
  });

  it('partial 必须把 unparsedGaps 暴露给用户，不伪装成完整解析', () => {
    assert.match(panelSource, /data-testid="vfx-partial-gaps"/);
    assert.match(panelSource, /未解析区间/);
  });

  it('未知类型状态来自 gap 解析，不硬编码第二套 parser', () => {
    assert.match(panelSource, /parseUnknownFxrTypes/);
    assert.match(panelSource, /unknown-type:section4/);
    // 不得在 renderer 维护第二套 Section4 闭集：known/unknown 只由 C# gap 决定。
    assert.doesNotMatch(panelSource, /2000[\s,}|\]]*2001|2000, 2001/);
  });

  it('无 3D viewport / 假 graph：不引用 three / canvas / graph', () => {
    assert.doesNotMatch(panelSource, /three|FlverViewer|<canvas/i);
    assert.doesNotMatch(panelSource, /fakeGraph|graph-canvas|particle-playback/i);
  });

  it('投影来自 shared 的 projectFxrDocumentPages，renderer 不扫字节、不猜格式', () => {
    assert.match(panelSource, /projectFxrDocumentPages/);
    assert.doesNotMatch(panelSource, /detectNestedFormat\(/);
    assert.doesNotMatch(panelSource, /guessFormatKind\(/);
    assert.doesNotMatch(panelSource, /readFile\(/);
  });

  it('节点/host/属性/可编辑值全量渲染：不再截断，也没有 vfx-node/host-truncation testId（问题 5）', () => {
    assert.doesNotMatch(panelSource, /formatListTruncation/);
    assert.doesNotMatch(panelSource, /data-testid="vfx-(node|host|property|edit)-truncation"/);
    assert.match(panelSource, /const visibleFlatNodes = flatNodes;/);
    assert.match(panelSource, /const visibleHosts = hosts;/);
  });
});
