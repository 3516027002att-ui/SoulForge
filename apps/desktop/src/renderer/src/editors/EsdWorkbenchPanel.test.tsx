/**
 * BEHAVIOR-55B：EsdWorkbenchPanel 三栏工作台的渲染结构 + 负向清单。
 *
 * renderer-unit 是纯 node SSR（react-dom/server，无 DOM、不跑 effect）。ESD 面板是
 * props 驱动（App 经 read-esd-document 取数后传入），不触达 window，因此 SSR 能看到
 * 完整三栏结构、机器/条件/命令列表与 Inspector 的初始文件统计；选择联动（machine →
 * state → condition）由 e2e 覆盖。
 *
 * 覆盖：
 * 1. SSR 结构：三栏 Files / Machines / States | Conditions / Commands | Inspector
 *    挂载即存在；无 Tools 空栏；列表由 shared pages 投影派生（不按 action 目录分类）。
 * 2. authority 语义：partial 时 coverageShortfalls / unparsedGaps / 跳转图未闭合
 *    必须暴露给用户（esd-partial-gaps），不能伪装成完整解析。
 * 3. Negative source：无 writer（无按钮/输入框）；不扫字节；不按 action 路径路由。
 * 4. 截断说明：esd-truncation testId + formatListTruncation（listTruncation 契约）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { EsdWorkbenchPanel } from './EsdWorkbenchPanel.js';
import type { EsdDocument } from '@soulforge/shared';

function makeDocument(overrides: Record<string, unknown> = {}): EsdDocument {
  return {
    format: 'ESD',
    version: 1,
    sourceSize: 2048,
    sourceHash: 'fixture-esd-hash',
    stateGroupCount: 2,
    stateCount: 4,
    conditionCount: 2,
    commandCallCount: 2,
    commandArgCount: 2,
    declaredStateGroupCount: 2,
    declaredStateCount: 4,
    declaredConditionCount: 2,
    declaredCommandCallCount: 2,
    declaredCommandArgCount: 2,
    parsedStateCount: 4,
    parsedStateRecordCount: 6,
    stateSentinelPerGroup: 1,
    stateSentinelModelConsistent: true,
    stateSentinelDivergentGroupIds: [],
    parsedConditionCount: 2,
    parsedCommandCallCount: 2,
    parsedCommandArgCount: 2,
    stateGroups: [
      { groupId: 0, stateCount: 2 },
      { groupId: 1, stateCount: 2 }
    ],
    stateGroupsTruncated: false,
    commandBanks: [0],
    bytecodeRegionCount: 2,
    conditionSamples: [
      { conditionRelOffset: 0x10, sourceGroupId: 0, sourceStateRelOffset: 0x0, targetStateRelOffset: 0x28, subConditionCount: 1, evaluatorLength: 8, passCommandCount: 1 },
      { conditionRelOffset: 0x20, sourceGroupId: 1, sourceStateRelOffset: 0x4, targetStateRelOffset: -1, subConditionCount: 0, evaluatorLength: 4, passCommandCount: 0 }
    ],
    conditionSamplesTruncated: false,
    transitionGraph: {
      edgeCount: 2, resolved: 1, none: 1, sentinel: 0, dangling: 0, closed: true,
      danglingSamples: [], sentinelSamples: [], edges: [], edgesTruncated: false
    },
    commandCalls: {
      total: 2, distinctCommandIds: 2,
      bySlot: [
        { slot: 'entry', count: 1 },
        { slot: 'condition-pass', count: 1 }
      ],
      samples: [
        { sourceGroupId: 0, slot: 'entry', bank: 0, commandId: 10, argCount: 2 },
        { sourceGroupId: 1, slot: 'condition-pass', bank: 0, commandId: 20, argCount: 1 }
      ],
      samplesTruncated: false
    },
    coverageComplete: true,
    coverageShortfalls: [],
    unparsedGaps: [],
    roundTrip: {
      byteIdentical: true, semanticIdentical: true,
      sourceHash: 'fixture-esd-hash', rebuiltHash: 'fixture-esd-hash',
      stateGroupCount: 2, stateCount: 4, stateRecordCount: 6,
      conditionCount: 2, commandCallCount: 2, commandArgCount: 2
    },
    authority: 'candidate',
    ...overrides
  } as EsdDocument;
}

function render(data: EsdDocument | null = makeDocument()): string {
  return renderToStaticMarkup(
    <EsdWorkbenchPanel resourceUri="fixture://ai/m10.esd" data={data} />
  );
}

describe('EsdWorkbenchPanel 初始结构（挂载即有的三栏骨架）', () => {
  it('工作台根的可访问名是「Behavior 工作台」', () => {
    assert.match(render(), /aria-label="Behavior 工作台"/);
  });

  it('三栏 Files / Machines / States | Conditions / Commands | Inspector 同时存在', () => {
    const html = render();
    assert.match(html, /aria-label="Files \/ Machines \/ States"/);
    assert.match(html, /aria-label="Conditions \/ Commands"/);
    assert.match(html, /aria-label="Inspector"/);
  });

  it('没有为凑四栏造 Tools 空栏', () => {
    assert.doesNotMatch(render(), /aria-label="Tools"/);
  });

  it('未加载 ESD 数据时左栏是显式 muted 空态而不是错误', () => {
    const html = render(null);
    assert.match(html, /选择 \.esd 文件以查看状态机数据/);
    assert.doesNotMatch(html, /className="danger"/);
  });

  it('机器列表由 pages 投影派生（状态组行），不按 action 目录分类', () => {
    const html = render();
    assert.match(html, />状态组 0</);
    assert.match(html, />状态组 1</);
    assert.doesNotMatch(html, /action\//);
  });

  it('States 组显示语义状态与物理记录聚合', () => {
    const html = render();
    assert.match(html, /全部语义状态/);
    assert.match(html, /物理状态记录/);
    assert.match(html, />4</);
    assert.match(html, />6</);
  });

  it('Conditions 组列出条件样本（转移载体），Commands 组列出命令调用', () => {
    const html = render();
    assert.match(html, /条件 @0x10/);
    assert.match(html, /条件 @0x20/);
    assert.match(html, />命令 10</);
    assert.match(html, />命令 20</);
    assert.match(html, /entry · 2 参数/);
  });

  it('Inspector 未选中时显示文件级统计', () => {
    const html = render();
    assert.match(html, /文件统计/);
    assert.match(html, /已解析条件数/);
    assert.match(html, /authority/);
  });

  it('无 writer：不渲染任何按钮/输入框', () => {
    const html = render();
    assert.doesNotMatch(html, /type="button"/);
    assert.doesNotMatch(html, /<input|type="number"/);
    assert.doesNotMatch(html, /提交|保存/);
  });
});

describe('authority 语义（partial 缺口必须可见）', () => {
  it('partial 且 coverageShortfalls/unparsedGaps/跳转图未闭合时暴露缺口', () => {
    const html = render(makeDocument({
      authority: 'partial',
      coverageComplete: false,
      coverageShortfalls: ['声明 10 个条件，实解析 2 个'],
      unparsedGaps: ['RPN 字节码 24 字节未解码'],
      transitionGraph: {
        edgeCount: 2, resolved: 1, none: 0, sentinel: 1, dangling: 1, closed: false,
        danglingSamples: [], sentinelSamples: [], edges: [], edgesTruncated: false
      }
    }));
    assert.match(html, /data-testid="esd-partial-gaps"/);
    assert.match(html, /未解析区间 1 项/);
    assert.match(html, /覆盖率缺口 1 项/);
    assert.match(html, /跳转图未闭合/);
    assert.match(html, /RPN 字节码 24 字节未解码/);
    assert.match(html, /声明 10 个条件，实解析 2 个/);
  });

  it('candidate 且无缺口时不渲染 gap 区段', () => {
    const html = render();
    assert.doesNotMatch(html, /data-testid="esd-partial-gaps"/);
  });

  it('哨兵模型不一致时 States 组给出明确警告', () => {
    const html = render(makeDocument({
      stateSentinelModelConsistent: false,
      stateSentinelDivergentGroupIds: [1]
    }));
    assert.match(html, /data-testid="esd-sentinel-divergence"/);
    assert.match(html, /哨兵模型不一致/);
  });
});

describe('Negative source tests（BEHAVIOR-55B）', () => {
  const repoRoot = process.cwd();
  const panelSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'EsdWorkbenchPanel.tsx'),
    'utf8'
  );

  it('列表由 shared pages 投影派生，renderer 不扫字节、不猜格式、不按 action 路径路由', () => {
    assert.match(panelSource, /projectEsdDocumentPages/);
    assert.doesNotMatch(panelSource, /detectNestedFormat\(/);
    assert.doesNotMatch(panelSource, /guessFormatKind\(/);
    assert.doesNotMatch(panelSource, /readFile\(/);
    assert.doesNotMatch(panelSource, /resourceKind/);
    assert.doesNotMatch(panelSource, /relativePath/);
  });

  it('无 writer 出口（55C 才接 transition write），不触达 bridge', () => {
    assert.doesNotMatch(panelSource, /getRendererBridge|bridge\./);
    assert.doesNotMatch(panelSource, /commit|upsert|applyEsd/);
  });

  it('截断说明走 formatListTruncation 且保留 esd-truncation testId', () => {
    assert.match(panelSource, /formatListTruncation/);
    assert.match(panelSource, /data-testid="esd-truncation"/);
  });
});
