/**
 * BEHAVIOR-55B/55C：EsdWorkbenchPanel 三栏工作台的渲染结构 + 55C 转移目标写回。
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
 * 3. 55C typed 写回：`submitEsdTransitionEdit` 纯逻辑（提交参数从选中条件取 relOffset、
 *    expectedDocumentHash 取 sourceHash、ok=true 后重读、ok=false 返回诊断且不重读、
 *    bridge 缺失结构化诊断）；编辑入口只随条件选中出现，evaluator 参数体保持
 *    「未解码」只读标注（不给字节码假编辑）；提交期间禁用重复提交。
 * 4. Negative source：无字节直写 fallback；不扫字节；不按 action 路径路由。
 * 5. 截断说明：esd-truncation testId + formatListTruncation（listTruncation 契约）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  EsdWorkbenchPanel,
  parseEsdTargetOffset,
  submitEsdTransitionEdit,
  type EsdTransitionEditBridge
} from './EsdWorkbenchPanel.js';
import type { EsdConditionSampleWire, EsdDocument } from '@soulforge/shared';

// node 环境没有 window；面板在点击提交时才调 getRendererBridge。设为空对象 →
// bridge 为 null → SSR 渲染不触达 window（纯初始结构）。
(globalThis as unknown as { window: Record<string, unknown> }).window = {};

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

  it('未选中条件时不渲染任何按钮/输入框（55C 编辑入口只随条件选中出现）', () => {
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

  it('55C typed 写回已接线：唯一写出口是 commitEsdTransition（set-transition-target），无字节直写 fallback', () => {
    const bridgeCalls = [...panelSource.matchAll(/bridge\.(\w+)\s*\(/g)]
      .map((m) => m[1])
      .filter((name): name is string => name !== undefined);
    assert.ok(bridgeCalls.includes('commitEsdTransition'), '缺少 commitEsdTransition 写出口');
    assert.ok(
      bridgeCalls.every((name) => name.startsWith('read') || name === 'commitEsdTransition'),
      `发现非 typed 桥接调用：${bridgeCalls.filter((n) => !n.startsWith('read') && n !== 'commitEsdTransition').join(', ')}`
    );
    // 没有 bytes replace 直写，也没有绕过 typed mutation 的 applyEsd 出口。
    assert.doesNotMatch(panelSource, /contentBase64|dataBase64|applyEsd/);
  });

  it('截断说明走 formatListTruncation 且保留 esd-truncation testId', () => {
    assert.match(panelSource, /formatListTruncation/);
    assert.match(panelSource, /data-testid="esd-truncation"/);
  });
});

describe('EsdTransitionEdit 纯逻辑（BEHAVIOR-55C 写回接线）', () => {
  const sample: EsdConditionSampleWire = {
    conditionRelOffset: 0x10,
    sourceGroupId: 0,
    sourceStateRelOffset: 0x0,
    targetStateRelOffset: 0x28,
    subConditionCount: 1,
    evaluatorLength: 8,
    passCommandCount: 1
  };

  function makeBridge(overrides: Record<string, unknown> = {}): {
    bridge: EsdTransitionEditBridge;
    calls: {
      commit: Array<{ sourceUri: string; expectedDocumentHash: string; mutations: unknown[] }>;
      reread: string[];
    };
  } {
    const calls = {
      commit: [] as Array<{ sourceUri: string; expectedDocumentHash: string; mutations: unknown[] }>,
      reread: [] as string[]
    };
    const bridge: EsdTransitionEditBridge = {
      commitEsdTransition: async (sourceUri, expectedDocumentHash, mutations) => {
        calls.commit.push({ sourceUri, expectedDocumentHash, mutations });
        return { ok: true, changedFiles: [], diagnostics: [] };
      },
      readEsdDocument: async (sourceUri) => {
        calls.reread.push(sourceUri);
        return { ok: true, data: makeDocument() };
      },
      ...overrides
    };
    return { bridge, calls };
  }

  it('提交参数正确：mutation 从选中条件取 relOffset，expectedDocumentHash 取 sourceHash', async () => {
    const doc = makeDocument();
    const { bridge, calls } = makeBridge();
    const outcome = await submitEsdTransitionEdit({
      bridge,
      resourceUri: 'fixture://ai/m10.esd',
      document: doc,
      sample,
      targetStateRelOffset: 0xF8
    });
    assert.equal(outcome.ok, true);
    assert.equal(calls.commit.length, 1);
    const first = calls.commit[0]!;
    assert.equal(first.sourceUri, 'fixture://ai/m10.esd');
    assert.equal(first.expectedDocumentHash, doc.sourceHash);
    assert.deepEqual(first.mutations, [{
      mutation: 'set-transition-target',
      stateRelOffset: 0x0,       // sample.sourceStateRelOffset
      conditionRelOffset: 0x10,  // sample.conditionRelOffset
      targetStateRelOffset: 0xF8 // 编辑后的目标偏移
    }]);
  });

  it('ok=true 后重读：readEsdDocument 被调用，outcome.refreshed 携带新 envelope', async () => {
    const { bridge, calls } = makeBridge();
    const outcome = await submitEsdTransitionEdit({
      bridge,
      resourceUri: 'fixture://ai/m10.esd',
      document: makeDocument(),
      sample,
      targetStateRelOffset: 0xF8
    });
    assert.equal(outcome.ok, true);
    assert.equal(calls.reread.length, 1);
    assert.equal(calls.reread[0], 'fixture://ai/m10.esd');
    assert.ok(outcome.refreshed !== null && outcome.refreshed !== undefined);
    assert.equal(outcome.refreshed?.sourceHash, 'fixture-esd-hash');
  });

  it('ok=false 返回诊断且不重读、不带 refreshed（已读内容保留由面板不覆盖 props 保证）', async () => {
    const { bridge, calls } = makeBridge({
      commitEsdTransition: async () => ({
        ok: false,
        changedFiles: [],
        diagnostics: [{ code: 'ESD_STAGING_WRITE_FAILED', message: '目标状态 relOffset=0x123456 不存在。' }]
      })
    });
    const outcome = await submitEsdTransitionEdit({
      bridge,
      resourceUri: 'fixture://ai/m10.esd',
      document: makeDocument(),
      sample,
      targetStateRelOffset: 0x123456
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.refreshed, null);
    assert.equal(calls.reread.length, 0);
    assert.ok(outcome.diagnostics.some((d) => d.code === 'ESD_STAGING_WRITE_FAILED'));
  });

  it('bridge 缺失时返回结构化诊断（不吞异常）', async () => {
    const outcome = await submitEsdTransitionEdit({
      bridge: null,
      resourceUri: 'fixture://ai/m10.esd',
      document: makeDocument(),
      sample,
      targetStateRelOffset: 0xF8
    });
    assert.equal(outcome.ok, false);
    assert.ok(outcome.diagnostics.some((d) => d.code === 'ESD_WRITE_UNAVAILABLE'));
  });

  it('parseEsdTargetOffset：0x 十六进制 / 十进制 / -1 清空 / 空与非法输入', () => {
    assert.equal(parseEsdTargetOffset('0xF8'), 0xF8);
    assert.equal(parseEsdTargetOffset('0xf8'), 0xF8);
    assert.equal(parseEsdTargetOffset('248'), 248);
    assert.equal(parseEsdTargetOffset('-1'), -1);
    assert.equal(parseEsdTargetOffset(''), null);
    assert.equal(parseEsdTargetOffset('   '), null);
    assert.equal(parseEsdTargetOffset('abc'), null);
    assert.equal(parseEsdTargetOffset('0xZZ'), null);
  });
});

describe('BEHAVIOR-55C 编辑入口（条件选中才出现，evaluator 不做假编辑）', () => {
  const repoRoot = process.cwd();
  const panelSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'EsdWorkbenchPanel.tsx'),
    'utf8'
  );

  it('Inspector 写回区不再说「尚未接通」，说明编辑入口随条件选中出现', () => {
    const html = render();
    assert.match(html, /写回（transition upsert）/);
    assert.match(html, /选中一条条件后/);
    assert.doesNotMatch(html, /尚未接通/);
  });

  it('条件选中后渲染编辑入口：目标偏移输入框 + 提交按钮（源码判定）', () => {
    assert.match(panelSource, /selectedConditionSample \? \(/);
    assert.match(panelSource, /data-testid="esd-transition-edit"/);
    assert.match(panelSource, /aria-label="重定向目标偏移"/);
    assert.match(panelSource, /提交转移目标/);
    assert.match(panelSource, /selected\?\.kind === 'condition'/);
  });

  it('evaluator 区域无编辑控件：参数体保持「未解码」只读标注，不给字节码假编辑', () => {
    const html = render();
    assert.match(panelSource, /evaluator 长度/);
    assert.match(panelSource, /未解码/);
    // 唯一编辑输入框是目标偏移（重定向目标偏移），没有 evaluator/字节码输入框。
    const inputs = panelSource.match(/<input/g) ?? [];
    assert.equal(inputs.length, 1);
    assert.match(panelSource, /<input[\s\S]*?aria-label="重定向目标偏移"/);
    // 初始渲染（未选条件）没有任何输入框/按钮。
    assert.doesNotMatch(html, /<input|type="button"/);
  });

  it('写回失败给结构化诊断 + 回滚提示，不清空已读内容（源码判定）', () => {
    assert.match(panelSource, /History & Recovery 回滚/);
    assert.match(panelSource, /已读内容保留/);
  });

  it('提交期间禁用重复提交（源码判定）', () => {
    assert.match(panelSource, /if \(submitting\) return/);
    assert.match(panelSource, /disabled=\{!canSubmit\}/);
  });
});
