/**
 * 截断说明的**渲染期**断言。
 *
 * 为什么必须存在这一层：`listTruncation.test.ts` 对源码做文本对账，它能抓到
 * 「testid 被改名/整段删掉」，但**抓不到「渲染条件被改成永假」**——实测把
 * `{truncationNote && (…)}` 改成 `{false && (…)}` 后，源码里 testid 字面量还在，
 * 全部文本判据照样绿，而用户已经看不到任何截断说明。那正是「grep must-not 门禁
 * 是瞎的」这一类假门禁的形态。
 *
 * 这里用 react-dom/server 真渲染这些面板，断言「喂进超过上限的数据时，输出 HTML
 * 里确实出现带真实数字的截断说明」。断言的是**用户能看到什么**，不是源码写了什么。
 *
 * 不声称覆盖交互与布局：这是静态标记渲染，没有 DOM 事件、没有 CSS 布局。滚动
 * 性能与真实点击由 e2e 承担。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { EsdWorkbenchPanel } from './EsdWorkbenchPanel.js';
import { TaeWorkbenchPanel } from './TaeWorkbenchPanel.js';

/*
 * 覆盖范围的显式声明：这里只渲染**不依赖 window / WebGL** 的面板。
 *
 * TPF 已从本层移除：TEXTURE-52B 把 TpfWorkbenchPanel 改成自驱动四栏工作台
 * （调 getRendererBridge，直接解 window.soulforge），在纯 Node 下导入即
 * ReferenceError —— 与 FlverWorkbenchPanel / MsbScenePanel 同类。它的截断说明
 * （tpf-truncation）由 listTruncation.test.ts 的源码对账覆盖（能抓改名/删除，
 * 抓不到「条件改成永假」）；这个差额与 FLVER/MSB 同口径，如实记在此处。
 *
 * FlverWorkbenchPanel 与 MsbScenePanel 不在此层：它们经 FlverViewer /
 * threeSceneController 触达 `window`（rendererRuntime.getRendererBridge 直接解
 * 引用 window.soulforge），在纯 Node 下导入即 ReferenceError。给它们塞一个假
 * window 就等于在测试里造一个与生产不同的运行表面 —— 那种「为过测试而搭的环境」
 * 通不过它本该抓的缺陷。这两个面板的截断说明由 listTruncation.test.ts 的源码
 * 对账覆盖（能抓改名/删除，抓不到「条件改成永假」），差额如实记在此处。
 */

/** 构造超过面板上限的合成数据（微小、显式构造，不含真实游戏资产）。 */
function synthetic<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_unused, index) => make(index));
}

/** 断言 HTML 里有截断说明，且报出真实总数与显示数。 */
function assertTruncationVisible(
  html: string,
  expected: { testId: string; total: number; shown: number }
): void {
  assert.match(
    html,
    new RegExp(`data-testid="${expected.testId}"`),
    `渲染输出里必须出现 ${expected.testId}：条件被改成永假时源码判据看不出来，只有真渲染能抓到`
  );
  assert.match(
    html,
    new RegExp(String(expected.total)),
    `必须报真实总数 ${expected.total}（状态优先于概念：界面要能回答「已解析多少」）`
  );
  assert.match(
    html,
    new RegExp(String(expected.total - expected.shown)),
    `必须报未显示数 ${expected.total - expected.shown}`
  );
}

describe('ESD 状态组表全量渲染（问题 5：显示不再设限）', () => {
  const total = 260;
  const html = renderToStaticMarkup(
    <EsdWorkbenchPanel
      resourceUri="synthetic://esd"
      data={{
        format: 'ESD', version: 1, sourceSize: 1024, sourceHash: 'synthetic',
        stateGroupCount: total, stateCount: total, conditionCount: 0,
        commandCallCount: 0, commandArgCount: 0,
        declaredStateGroupCount: total, declaredStateCount: total,
        declaredConditionCount: 0, declaredCommandCallCount: 0, declaredCommandArgCount: 0,
        parsedStateCount: total, parsedStateRecordCount: total,
        stateSentinelPerGroup: 1, stateSentinelModelConsistent: true,
        stateSentinelDivergentGroupIds: [],
        parsedConditionCount: 0, parsedCommandCallCount: 0, parsedCommandArgCount: 0,
        stateGroups: synthetic(total, (i) => ({ groupId: i, stateCount: 1 })),
        stateGroupsTruncated: false, commandBanks: [], bytecodeRegionCount: 0,
        conditionSamples: [], conditionSamplesTruncated: false,
        transitionGraph: {
          edgeCount: 0, resolved: 0, none: 0, sentinel: 0, dangling: 0, closed: true,
          danglingSamples: [], sentinelSamples: [], edges: [], edgesTruncated: false
        },
        commandCalls: { total: 0, distinctCommandIds: 0, bySlot: [], samples: [], samplesTruncated: false },
        coverageComplete: true, coverageShortfalls: [], unparsedGaps: [],
        roundTrip: {
          byteIdentical: true, semanticIdentical: true,
          sourceHash: 'synthetic', rebuiltHash: 'synthetic',
          stateGroupCount: total, stateCount: total, stateRecordCount: total,
          conditionCount: 0, commandCallCount: 0, commandArgCount: 0
        },
        authority: 'candidate'
      }}
    />
  );

  it('不再渲染截断说明：即使数据超过旧上限也没有 esd-truncation', () => {
    assert.doesNotMatch(html, /data-testid="esd-truncation"/);
    assert.doesNotMatch(html, /还?有.*条没|显示.*共|未显示/);
  });

  it('全量渲染所有状态组行（DOM 一次全给，栏自己滚动，不做条数上限）', () => {
    // 精确数「状态组 N」行（renderToStaticMarkup 输出 class 属性，且 wb-row__name/
    // meta 会污染宽泛的 class 计数，必须按文本锚定到行本身）。
    const rows = [...html.matchAll(/状态组 \d+?<\/span>/g)].length;
    assert.ok(rows >= total, `实际渲染 ${rows} 行状态组，不得低于总数 ${total}`);
  });
});

describe('TAE 动画表超上限时渲染截断说明', () => {
  const total = 250;
  const html = renderToStaticMarkup(
    <TaeWorkbenchPanel
      resourceUri="synthetic://tae"
      data={{
        format: 'TAE', version: '0x20', sourceSize: 1024, sourceHash: 'synthetic',
        animationCount: total, totalEventCount: 0, totalGroupCount: 0,
        eventTypes: [], authority: 'candidate',
        animations: synthetic(total, (i) => ({
          animId: i, eventCount: 0, groupCount: 0, timesCount: 0,
          events: [], eventsTruncated: false
        })),
        animationsTruncated: false,
        roundTrip: {
          byteIdentical: true, semanticIdentical: true,
          sourceHash: 'synthetic', rebuiltHash: 'synthetic',
          animationCount: total, totalEventCount: 0, totalGroupCount: 0
        },
        diagnostics: []
      }}
    />
  );

  it('渲染出带真实数字的截断说明', () => {
    assertTruncationVisible(html, { testId: 'tae-truncation', total, shown: 200 });
  });
});

describe('未超上限时不渲染截断说明（防「完整数据被标成部分」）', () => {
  it('ESD 少量状态组：无说明', () => {
    const html = renderToStaticMarkup(
      <EsdWorkbenchPanel
        resourceUri="synthetic://esd-small"
        data={{
          format: 'ESD', version: 1, sourceSize: 128, sourceHash: 'synthetic',
          stateGroupCount: 3, stateCount: 3, conditionCount: 0,
          commandCallCount: 0, commandArgCount: 0,
          declaredStateGroupCount: 3, declaredStateCount: 3,
          declaredConditionCount: 0, declaredCommandCallCount: 0, declaredCommandArgCount: 0,
          parsedStateCount: 3, parsedStateRecordCount: 3,
          stateSentinelPerGroup: 1, stateSentinelModelConsistent: true,
          stateSentinelDivergentGroupIds: [],
          parsedConditionCount: 0, parsedCommandCallCount: 0, parsedCommandArgCount: 0,
          stateGroups: synthetic(3, (i) => ({ groupId: i, stateCount: 1 })),
          stateGroupsTruncated: false, commandBanks: [], bytecodeRegionCount: 0,
          conditionSamples: [], conditionSamplesTruncated: false,
          transitionGraph: {
            edgeCount: 0, resolved: 0, none: 0, sentinel: 0, dangling: 0, closed: true,
            danglingSamples: [], sentinelSamples: [], edges: [], edgesTruncated: false
          },
          commandCalls: { total: 0, distinctCommandIds: 0, bySlot: [], samples: [], samplesTruncated: false },
          coverageComplete: true, coverageShortfalls: [], unparsedGaps: [],
          roundTrip: {
            byteIdentical: true, semanticIdentical: true,
            sourceHash: 'synthetic', rebuiltHash: 'synthetic',
            stateGroupCount: 3, stateCount: 3, stateRecordCount: 3,
            conditionCount: 0, commandCallCount: 0, commandArgCount: 0
          },
          authority: 'candidate'
        }}
      />
    );
    assert.doesNotMatch(html, /data-testid="esd-truncation"/);
  });
});
