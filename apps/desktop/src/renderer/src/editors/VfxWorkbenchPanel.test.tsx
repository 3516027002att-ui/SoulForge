/**
 * VFX-54B：VfxWorkbenchPanel 的渲染结构 + 纯逻辑 + 负向清单。
 *
 * renderer-unit 是纯 node SSR（react-dom/server，无 DOM、不跑 effect）。面板自驱动
 * 经 getRendererBridge 读 read-fxr-document（同 MaterialWorkbenchPanel 模式），SSR 下
 * bridge 为 null → 读取 effect 全部短路，这里钉住「挂载即有的结构」；真实 live 链路
 * （Bridge → ipc → readFxrDocument）由 e2e 覆盖。
 *
 * 三类契约：
 * 1. SSR 结构：三栏 Effect / Particle list | 真实预览 | Inspector 挂载即存在，
 *    中栏是诚实空态（不渲染假 viewport / 假 graph）；文件列表由 props 派生、显示名
 *    去 .fxr；未选文件时各栏给引导空态。
 * 2. 纯逻辑：parseUnknownFxrTypes 从 gap 字符串解析未知类型集合；
 *    flattenFxrNodes 给递归树稳定路径 id + 深度；fxrValuePreview 摘要不透明 int 数组。
 * 3. Negative source：本卡只有 read（VFX-54C 才接写回）——无 type=button、无输入框/
 *    textarea；不引用 three/canvas（无假 viewport）；known/unknown node 状态必须通过
 *    gap 解析明确区分，unknown 行只给原始结构字段、不给字段含义假数据。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  VfxWorkbenchPanel,
  flattenFxrNodes,
  fxrValuePreview,
  parseUnknownFxrTypes,
  vfxFileDisplayName,
  type VfxFileView
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

  it('初始渲染无任何 type=button 与编辑输入框（本卡无 writer）', () => {
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
  it('超限时给省略号', () => {
    assert.equal(fxrValuePreview([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 8), '0, 1, 2, 3, 4, 5, 6, 7, …');
  });

  it('未超限时全量显示', () => {
    assert.equal(fxrValuePreview([10, 11], 8), '10, 11');
  });

  it('空数组显示占位，不编造值', () => {
    assert.equal(fxrValuePreview([], 8), '—');
  });
});

describe('Negative source tests（VFX-54B）', () => {
  const repoRoot = process.cwd();
  const panelSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'VfxWorkbenchPanel.tsx'),
    'utf8'
  );

  it('渲染侧桥接调用只有 read，无任何写出口（54C 才接写回）', () => {
    const bridgeCalls = [...panelSource.matchAll(/bridge\.(\w+)\s*\(/g)]
      .map((m) => m[1])
      .filter((name): name is string => name !== undefined);
    assert.ok(bridgeCalls.length > 0, '工作台没有任何 bridge 调用（read 通道缺失）');
    assert.ok(
      bridgeCalls.every((name) => name.startsWith('read')),
      `发现非 read 桥接调用：${bridgeCalls.filter((n) => !n.startsWith('read')).join(', ')}`
    );
  });

  it('writer 未就绪时隐藏编辑入口：只给诚实说明，无属性输入控件', () => {
    assert.match(panelSource, /FXR 写回链尚未接通（VFX-54C）/);
    assert.match(panelSource, /只读工作台/);
    assert.doesNotMatch(panelSource, /<input/);
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

  it('截断说明走 formatListTruncation 且保留 vfx 专属 testId', () => {
    assert.match(panelSource, /formatListTruncation/);
    assert.match(panelSource, /data-testid="vfx-node-truncation"/);
  });
});
