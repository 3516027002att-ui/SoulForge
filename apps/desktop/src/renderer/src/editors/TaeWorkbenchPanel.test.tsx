/**
 * ANIMATION-56B：TaeWorkbenchPanel 三栏工作台的渲染结构 + 纯逻辑 + 负向清单。
 *
 * renderer-unit 是纯 node SSR（react-dom/server，无 DOM、不跑 effect）。TAE 面板是
 * props 驱动（App 经 read-tae-document 取数后传入），不触达 window，SSR 能看到完整
 * 三栏结构、动画列表、时间轴事件与 Inspector 的初始文件统计；选择联动由 e2e 覆盖。
 *
 * 覆盖：
 * 1. SSR 结构：三栏 Files / Animations | Timeline / Events | Inspector 挂载即存在；
 *    无 Tools 空栏；动画列表由 shared pages 投影派生（不按 chr/action 目录分类）。
 * 2. 纯逻辑：isInvalidTimeRange（startTime > endTime / 非有限时间判非法）。
 * 3. authority 语义：partial（TAE_INVALID_TIME_RANGE）时 diagnostics 必须暴露给
 *    用户（tae-partial-diagnostics），非法时间行在时间轴标 failed。
 * 4. Negative source：无 writer；事件参数体未解码的边界不伪装成完整解析。
 * 5. 截断说明：tae-truncation testId + formatListTruncation（listTruncation 契约）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaeWorkbenchPanel, isInvalidTimeRange } from './TaeWorkbenchPanel.js';
import type { TaeDocument } from '@soulforge/shared';

function makeDocument(overrides: Record<string, unknown> = {}): TaeDocument {
  return {
    format: 'TAE',
    version: '0x20',
    sourceSize: 2048,
    sourceHash: 'fixture-tae-hash',
    animationCount: 2,
    totalEventCount: 3,
    totalGroupCount: 1,
    animations: [
      {
        animId: 0, eventCount: 2, groupCount: 1, timesCount: 2, hkxName: 'a0000.hkx',
        events: [
          { startTime: 0, endTime: 1, eventTypeId: 1 },
          { startTime: 1.5, endTime: 2, eventTypeId: 2 }
        ],
        eventsTruncated: false
      },
      {
        animId: 1, eventCount: 1, groupCount: 0, timesCount: 1,
        events: [{ startTime: 0, endTime: 5, eventTypeId: 3 }],
        eventsTruncated: false
      }
    ],
    animationsTruncated: false,
    eventTypes: [1, 2, 3],
    roundTrip: {
      byteIdentical: true, semanticIdentical: true,
      sourceHash: 'fixture-tae-hash', rebuiltHash: 'fixture-tae-hash',
      animationCount: 2, totalEventCount: 3, totalGroupCount: 1
    },
    diagnostics: [],
    authority: 'candidate',
    ...overrides
  } as TaeDocument;
}

function render(data: TaeDocument | null = makeDocument()): string {
  return renderToStaticMarkup(
    <TaeWorkbenchPanel resourceUri="fixture://action/c0000.tae" data={data} />
  );
}

describe('TaeWorkbenchPanel 初始结构（挂载即有的三栏骨架）', () => {
  it('工作台根的可访问名是「Animation 工作台」', () => {
    assert.match(render(), /aria-label="Animation 工作台"/);
  });

  it('三栏 Files / Animations | Timeline / Events | Inspector 同时存在', () => {
    const html = render();
    assert.match(html, /aria-label="Files \/ Animations"/);
    assert.match(html, /aria-label="Timeline \/ Events"/);
    assert.match(html, /aria-label="Inspector"/);
  });

  it('没有为凑四栏造 Tools 空栏', () => {
    assert.doesNotMatch(render(), /aria-label="Tools"/);
  });

  it('未加载 TAE 数据时左栏是显式 muted 空态而不是错误', () => {
    const html = render(null);
    assert.match(html, /选择 \.tae 文件以查看动画事件数据/);
    assert.doesNotMatch(html, /className="danger"/);
  });

  it('动画列表由 pages 投影派生（animId 行），不按 chr/action 目录分类', () => {
    const html = render();
    assert.match(html, />动画 0</);
    assert.match(html, />动画 1</);
    assert.match(html, /a0000\.hkx/);
    assert.doesNotMatch(html, />chr\//);
    assert.doesNotMatch(html, />action\//);
  });

  it('Timeline 组列出时间轴事件，Events 组报事件/类型汇总', () => {
    const html = render();
    assert.match(html, /0s → 1s/);
    assert.match(html, /1\.5s → 2s/);
    assert.match(html, /类型 1/);
    assert.match(html, /事件总数/);
    assert.match(html, /事件类型（distinct）/);
    assert.match(html, /事件类型 3/);
  });

  it('Inspector 未选中时显示文件级统计', () => {
    const html = render();
    assert.match(html, /文件统计/);
    assert.match(html, /动画数/);
    assert.match(html, /事件总数/);
  });

  it('无 writer：不渲染任何按钮/输入框', () => {
    const html = render();
    assert.doesNotMatch(html, /type="button"/);
    assert.doesNotMatch(html, /<input|type="number"/);
    assert.doesNotMatch(html, /提交|保存/);
  });
});

describe('isInvalidTimeRange（时间范围合法性判据）', () => {
  it('合法范围（start <= end 且均有限）返回 false', () => {
    assert.equal(isInvalidTimeRange(0, 1), false);
    assert.equal(isInvalidTimeRange(1.5, 1.5), false);
  });

  it('startTime > endTime 判非法', () => {
    assert.equal(isInvalidTimeRange(5, 2), true);
  });

  it('非有限时间判非法', () => {
    assert.equal(isInvalidTimeRange(Number.NaN, 2), true);
    assert.equal(isInvalidTimeRange(0, Number.POSITIVE_INFINITY), true);
  });
});

describe('authority 语义（partial 非法时间范围必须暴露）', () => {
  it('partial + TAE_INVALID_TIME_RANGE 时 diagnostics 区段可见', () => {
    const html = render(makeDocument({
      authority: 'partial',
      diagnostics: [{
        severity: 'error',
        code: 'TAE_INVALID_TIME_RANGE',
        message: '事件时间范围非法：startTime(5) > endTime(2)。'
      }],
      animations: [
        {
          animId: 0, eventCount: 1, groupCount: 0, timesCount: 1,
          events: [{ startTime: 5, endTime: 2, eventTypeId: 9 }],
          eventsTruncated: false
        }
      ]
    }));
    assert.match(html, /data-testid="tae-partial-diagnostics"/);
    assert.match(html, /TAE_INVALID_TIME_RANGE/);
    assert.match(html, /事件时间范围非法/);
    // 非法时间行在 Timeline 标记 failed。
    assert.match(html, /5s → 2s/);
    assert.match(html, /非法时间/);
    assert.match(html, /wb-row--failed/);
  });

  it('candidate 且无诊断时不渲染 diagnostics 区段', () => {
    const html = render();
    assert.doesNotMatch(html, /data-testid="tae-partial-diagnostics"/);
  });
});

describe('Negative source tests（ANIMATION-56B）', () => {
  const repoRoot = process.cwd();
  const panelSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'TaeWorkbenchPanel.tsx'),
    'utf8'
  );

  it('列表由 shared pages 投影派生，renderer 不扫字节、不猜格式、不按 chr/action 路径路由', () => {
    assert.match(panelSource, /projectTaeDocumentPages/);
    assert.doesNotMatch(panelSource, /detectNestedFormat\(/);
    assert.doesNotMatch(panelSource, /guessFormatKind\(/);
    assert.doesNotMatch(panelSource, /readFile\(/);
    assert.doesNotMatch(panelSource, /resourceKind/);
    assert.doesNotMatch(panelSource, /relativePath/);
  });

  it('事件参数体未解码的边界必须明示，不伪装成完整解析', () => {
    assert.match(panelSource, /参数体/);
    assert.match(panelSource, /未解码/);
  });

  it('无 writer 出口（56C 才接 event write），不触达 bridge', () => {
    assert.doesNotMatch(panelSource, /getRendererBridge|bridge\./);
    assert.doesNotMatch(panelSource, /commit|upsert|applyTae/);
  });

  it('截断说明走 formatListTruncation 且保留 tae-truncation testId', () => {
    assert.match(panelSource, /formatListTruncation/);
    assert.match(panelSource, /data-testid="tae-truncation"/);
  });
});
