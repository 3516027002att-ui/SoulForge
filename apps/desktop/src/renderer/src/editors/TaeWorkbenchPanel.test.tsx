/**
 * ANIMATION-56B / ANIMATION-56C：TaeWorkbenchPanel 三栏工作台的渲染结构 + 纯逻辑
 * + typed 写回接线 + 负向清单。
 *
 * renderer-unit 是纯 node SSR（react-dom/server，无 DOM、不跑 effect）。TAE 面板是
 * props 驱动（App 经 read-tae-document 取数后传入），SSR 能看到完整三栏结构、
 * 动画列表、时间轴事件与 Inspector 的初始文件统计；选择联动由 e2e 覆盖。
 * 面板只在提交/重读处理器里触达 window，SSR 渲染路径不触达，无需假 window。
 *
 * 覆盖：
 * 1. SSR 结构：三栏 Files / Animations | Timeline / Events | Inspector 挂载即存在；
 *    无 Tools 空栏；动画列表由 shared pages 投影派生（不按 chr/action 目录分类）。
 * 2. 纯逻辑：isInvalidTimeRange（startTime > endTime / 非有限时间判非法）。
 * 3. authority 语义：partial（TAE_INVALID_TIME_RANGE）时 diagnostics 必须暴露给
 *    用户（tae-partial-diagnostics），非法时间行在时间轴标 failed。
 * 4. ANIMATION-56C 写回接线：
 *    - 事件选中后 Inspector 出现时间编辑（update-event-times）与新增事件
 *      （insert-event，模板 = 当前事件）入口；提交期间禁用重复提交。
 *    - mutation 构建纯函数：update-event-times 带 animId+eventIndex+startTime+endTime；
 *      insert-event 带 animId+templateEventIndex+eventTypeId+startTime+endTime。
 *    - eventIndex = 事件在其动画 events 数组里的下标（timeline 有序展平回推）。
 *    - ok=true 后经 readTaeDocument 重读并覆盖本地文档（refresh 触发器）；
 *      ok=false 显示 diagnostics + 回滚提示，不清空时间轴。
 *    - 参数体未解码边界：参数体只读展示，编辑区只有时间/类型输入，无参数编辑控件。
 * 5. Negative source：写回只有 commitTaeEvent 一个 typed 出口（无通用文本保存 /
 *    字节直写 fallback）；事件参数体未解码的边界不伪装成完整解析。
 * 6. 截断说明：tae-truncation testId + formatListTruncation（listTruncation 契约）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  TaeWorkbenchPanel,
  TaeEventEditor,
  buildInsertEventMutation,
  buildUpdateEventTimesMutation,
  eventIndexOfTimelineRow,
  formatWriteDiagnostics,
  isInvalidTimeRange
} from './TaeWorkbenchPanel.js';
import type { TaeDocument, TaeTimelineEventRow } from '@soulforge/shared';

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

/** 选中 timeline 第 0 行（动画 0 的第一个事件）时的渲染。 */
function renderWithSelection(): string {
  return renderToStaticMarkup(
    <TaeWorkbenchPanel
      resourceUri="fixture://action/c0000.tae"
      data={makeDocument()}
      initialSelection={{
        kind: 'timeline', id: 'tl-0', label: '事件 1 @0s',
        animationId: 0, timelineIndex: 0, eventIndex: 0
      }}
    />
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

  it('未选中事件时不渲染任何按钮/输入框（写回入口随事件选中出现）', () => {
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

describe('ANIMATION-56C 写回接线（typed event write）', () => {
  it('事件选中后 Inspector 有时间编辑与新增事件入口（各带提交按钮）', () => {
    const html = renderWithSelection();
    assert.match(html, /data-testid="tae-event-editor"/);
    assert.match(html, /编辑事件时间（update-event-times）/);
    assert.match(html, /更新事件时间/);
    assert.match(html, /新增事件（模板：当前事件）/);
    assert.match(html, /新增事件/);
    // 编辑区输入：时间 2（起止）+ 新增 3（类型/起止）= 5 个 number 输入。
    const inputs = html.match(/type="number"/g) ?? [];
    assert.equal(inputs.length, 5);
  });

  it('参数体区无编辑控件：参数体只读展示，编辑区只有时间/类型输入', () => {
    const html = renderWithSelection();
    // Inspector 属性行里参数体是只读值。
    assert.match(html, /参数体/);
    assert.match(html, /未解码（ANIMATION-56C 只开放时间\/类型编辑/);
    // 编辑区本身不出现参数体字样，也没有参数编辑输入（总输入恒为 5 个时间/类型）。
    const editorHtml = renderToStaticMarkup(
      <TaeEventEditor
        row={{ animId: 0, startTime: 0, endTime: 1, eventTypeId: 1 }}
        eventIndex={0}
        timeDraft={null}
        insertDraft={null}
        saving={false}
        notice={null}
        onTimeDraftChange={() => {}}
        onInsertDraftChange={() => {}}
        onSubmitTime={() => {}}
        onSubmitInsert={() => {}}
      />
    );
    assert.doesNotMatch(editorHtml, /参数体/);
    const editorInputs = editorHtml.match(/type="number"/g) ?? [];
    assert.equal(editorInputs.length, 5);
  });

  it('提交期间禁用重复提交：saving 时按钮 disabled', () => {
    const html = renderToStaticMarkup(
      <TaeEventEditor
        row={{ animId: 0, startTime: 0, endTime: 1, eventTypeId: 1 }}
        eventIndex={0}
        timeDraft={{ startText: '0', endText: '1' }}
        insertDraft={{ eventTypeIdText: '1', startText: '0', endText: '1' }}
        saving
        notice={null}
        onTimeDraftChange={() => {}}
        onInsertDraftChange={() => {}}
        onSubmitTime={() => {}}
        onSubmitInsert={() => {}}
      />
    );
    assert.match(html, /type="button"[^>]*disabled/);
  });

  it('buildUpdateEventTimesMutation：animId + eventIndex + startTime + endTime 正确', () => {
    const row: TaeTimelineEventRow = { animId: 3, startTime: 0, endTime: 1, eventTypeId: 7 };
    assert.deepEqual(
      buildUpdateEventTimesMutation(row, 2, { startText: '1.25', endText: '2.5' }),
      { mutation: 'update-event-times', animId: 3, eventIndex: 2, startTime: 1.25, endTime: 2.5 }
    );
    // 非有限时间 → null（不把非法输入发往 C#）。
    assert.equal(buildUpdateEventTimesMutation(row, 0, { startText: 'abc', endText: '2' }), null);
  });

  it('buildInsertEventMutation：templateEventIndex + eventTypeId + startTime + endTime 正确', () => {
    const row: TaeTimelineEventRow = { animId: 3, startTime: 0, endTime: 1, eventTypeId: 7 };
    assert.deepEqual(
      buildInsertEventMutation(row, 2, { eventTypeIdText: '7', startText: '3', endText: '4' }),
      { mutation: 'insert-event', animId: 3, templateEventIndex: 2, eventTypeId: 7, startTime: 3, endTime: 4 }
    );
    assert.equal(
      buildInsertEventMutation(row, 2, { eventTypeIdText: 'x', startText: '3', endText: '4' }),
      null
    );
  });

  it('eventIndexOfTimelineRow：按 animId 分组计数回推动画内事件下标', () => {
    const rows: TaeTimelineEventRow[] = [
      { animId: 0, startTime: 0, endTime: 1, eventTypeId: 1 },
      { animId: 0, startTime: 1.5, endTime: 2, eventTypeId: 2 },
      { animId: 1, startTime: 0, endTime: 5, eventTypeId: 3 }
    ];
    assert.equal(eventIndexOfTimelineRow(rows, 0), 0);
    assert.equal(eventIndexOfTimelineRow(rows, 1), 1);
    assert.equal(eventIndexOfTimelineRow(rows, 2), 0);
    assert.equal(eventIndexOfTimelineRow(rows, 99), undefined);
  });

  it('formatWriteDiagnostics：诊断带 code 回显，空诊断给兜底句', () => {
    assert.equal(
      formatWriteDiagnostics([{
        severity: 'error',
        code: 'TAE_WRITE_BLOCKED_SHARED_SLOT',
        message: '时间槽被兄弟事件共享。'
      }]),
      '[TAE_WRITE_BLOCKED_SHARED_SLOT] 时间槽被兄弟事件共享。'
    );
    assert.equal(formatWriteDiagnostics(undefined), '写入被拒绝');
  });
});

describe('Negative source tests（ANIMATION-56B / ANIMATION-56C）', () => {
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
    // 前端不发送/不编辑参数体字节：insert 依赖 templateEventIndex 由 C# 侧拷贝，
    // mutation 结构里不出现 paramBody 字段。
    assert.doesNotMatch(panelSource, /paramBody/);
  });

  it('写回只有 commitTaeEvent 一个 typed 出口，无通用文本保存/字节直写 fallback', () => {
    assert.match(panelSource, /getRendererBridge/);
    assert.match(panelSource, /commitTaeEvent/);
    assert.match(panelSource, /update-event-times/);
    assert.match(panelSource, /insert-event/);
    assert.doesNotMatch(panelSource, /saveTextResource|applyTae|contentBase64|dataBase64/);
    const bridgeCalls = [...panelSource.matchAll(/bridge\.(\w+)\s*\(/g)]
      .map((m) => m[1])
      .filter((name): name is string => name !== undefined);
    assert.ok(
      bridgeCalls.every((name) => name.startsWith('read') || name === 'commitTaeEvent'),
      `发现非 typed 桥接调用：${bridgeCalls.filter((n) => !n.startsWith('read') && n !== 'commitTaeEvent').join(', ')}`
    );
  });

  it('ok=true 后经 readTaeDocument 重读并覆盖本地文档（refresh 触发器）', () => {
    assert.match(panelSource, /readTaeDocument/);
    assert.match(panelSource, /setRefreshedDocument/);
    assert.match(panelSource, /refreshedDocument \?\? props\.data/);
    assert.match(panelSource, /写入成功，但重读失败/);
  });

  it('ok=false 时显示 diagnostics + 回滚提示，不清空时间轴', () => {
    assert.match(panelSource, /formatWriteDiagnostics/);
    assert.match(panelSource, /已回滚，时间轴保持原状/);
    assert.match(panelSource, /data-testid="tae-write-notice"/);
    assert.match(panelSource, /diag-error/);
  });

  it('截断说明走 formatListTruncation 且保留 tae-truncation testId', () => {
    assert.match(panelSource, /formatListTruncation/);
    assert.match(panelSource, /data-testid="tae-truncation"/);
  });
});
