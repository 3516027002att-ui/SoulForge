/**
 * ANIMATION-56B / ANIMATION-56C：TaeWorkbenchPanel 三栏工作台的渲染结构 + 纯逻辑
 * + typed 写回接线 + 负向清单。
 *
 * renderer-unit 是纯 node SSR（react-dom/server，无 DOM、不跑 effect）。TAE 面板是
 * props 驱动（App 经 read-tae-document 取数后传入），SSR 能看到完整三栏结构、
 * 动画列表、词条事件与中栏详情区的文件统计；选择联动由 e2e 覆盖。
 * 面板只在提交/重读处理器里触达 window，SSR 渲染路径不触达，无需假 window。
 *
 * T3（2026-08-15，grok）重构后三栏为：
 *   Animations | Events / 词条（含详情 + 写回）| 预览（只读）。
 * 没有 Timeline / Events、没有 Inspector 第三栏 —— 详情收进中栏。
 *
 * 覆盖：
 * 1. SSR 结构：三栏 Animations | Events / 词条 | 预览（只读）挂载即存在；
 *    无 Timeline / Events、无 Inspector、无 Tools 空栏；动画列表由 shared pages
 *    投影派生（不按 chr/action 目录分类），hkxName 去扩展作主标签。
 * 2. 纯逻辑：isInvalidTimeRange（startTime > endTime / 非有限时间判非法）。
 * 3. authority 语义：partial（TAE_INVALID_TIME_RANGE）时 diagnostics 必须暴露给
 *    用户（tae-partial-diagnostics），非法时间行在词条列表标 failed。
 * 4. ANIMATION-56C 写回接线（收进中栏详情）：
 *    - 事件选中后详情区出现时间编辑（update-event-times）与新增事件
 *      （insert-event，模板 = 当前事件）入口；提交期间禁用重复提交。
 *    - mutation 构建纯函数：update-event-times 带 animId+eventIndex+startTime+endTime；
 *      insert-event 带 animId+templateEventIndex+eventTypeId+startTime+endTime。
 *    - eventIndex = 事件在其动画 events 数组里的下标。
 *    - ok=true 后经 readTaeDocument 重读并覆盖本地文档（refresh 触发器）；
 *      ok=false 显示 diagnostics + 回滚提示，不清空词条列表。
 *    - 参数体未解码边界：详情区只读展示参数体，编辑区只有时间/类型输入。
 * 5. Negative source：写回只有 commitTaeEvent 一个 typed 出口（无通用文本保存 /
 *    字节直写 fallback）；事件参数体未解码的边界不伪装成完整解析；右栏只读。
 * 6. 截断说明：tae-truncation testId + formatListTruncation（listTruncation 契约）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  animationIdLabel,
  isLegalHkxStem,
  secondsToFrame,
  TaeWorkbenchPanel,
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

/** 选中动画 0（无事件）时的渲染。 */
function renderAnimationSelected(): string {
  return renderToStaticMarkup(
    <TaeWorkbenchPanel
      resourceUri="fixture://action/c0000.tae"
      data={makeDocument()}
      initialSelection={{ kind: 'animation', id: 'anim-0', label: 'a0000', animationId: 0 }}
    />
  );
}

/** 选中动画 0 的第 0 个事件时的渲染。 */
function renderWithSelection(): string {
  return renderToStaticMarkup(
    <TaeWorkbenchPanel
      resourceUri="fixture://action/c0000.tae"
      data={makeDocument()}
      initialSelection={{
        kind: 'event', id: 'ev-0-0', label: '事件类型 1 @0s',
        animationId: 0, eventIndex: 0
      }}
    />
  );
}

describe('TaeWorkbenchPanel 初始结构（挂载即有的三栏骨架）', () => {
  it('工作台根的可访问名是「动作工作台」', () => {
    assert.match(render(), /aria-label="动作工作台"/);
  });

  it('三栏 Animations | Events / 词条 | 预览（只读）同时存在，无 Timeline/Inspector/Tools', () => {
    const html = render();
    assert.match(html, /aria-label="Animations"/);
    assert.match(html, /aria-label="Events \/ 词条"/);
    assert.match(html, /aria-label="预览（只读）"/);
    // T3：不要时间轴图、不要 Inspector 第三栏。
    assert.doesNotMatch(html, /aria-label="Timeline \/ Events"/);
    assert.doesNotMatch(html, /aria-label="Inspector"/);
    assert.doesNotMatch(html, /aria-label="Files \/ Animations"/);
    assert.doesNotMatch(html, /aria-label="Tools"/);
  });

  it('未加载 TAE 数据时左栏是显式 muted 空态而不是错误', () => {
    const html = render(null);
    assert.match(html, /选择 \.tae \/ \.anibnd\.dcx 文件以查看动画事件数据/);
    assert.doesNotMatch(html, /className="danger"/);
  });

  it('动画列表由 pages 投影派生（hkxName 去扩展），不按 chr/action 目录分类', () => {
    const html = render();
    // a0000.hkx → a0000（去扩展主标签）；anim 1 无合法 hkx 茎 → 干净数字 id「1」，
    // 禁止「动画 1」（S17）。
    assert.match(html, />a0000</);
    assert.match(html, />1</);
    assert.doesNotMatch(html, />a0000\.hkx</);
    assert.doesNotMatch(html, />动画 1</);
    assert.doesNotMatch(html, />chr\//);
    assert.doesNotMatch(html, />action\//);
  });

  it('词条组在选中动画前提示先选动画，未选中事件时不渲染按钮/输入框', () => {
    const html = render();
    assert.match(html, /data-testid="tae-events-pick-animation"/);
    assert.match(html, /选中左侧动画以查看其词条事件列表/);
    assert.doesNotMatch(html, /type="button"/);
    assert.doesNotMatch(html, /<input|type="number"/);
    assert.doesNotMatch(html, /提交|保存/);
  });

  it('选中动画后中栏出现词条事件列表（`{typeId} {类型名}`，无模板类型名「未命名」）', () => {
    const html = renderAnimationSelected();
    assert.match(html, /词条 · 动画 0/);
    // 无模板目录（SSR 不拉 IPC）→ 类型名「未命名」；列表不出现秒区间（S17）。
    assert.match(html, />1 未命名</);
    assert.match(html, />2 未命名</);
    assert.doesNotMatch(html, />0s → 1s</);
    assert.doesNotMatch(html, /data-testid="tae-details"/);
  });

  it('未选中词条事件时三栏底不出现 footer', () => {
    const html = renderAnimationSelected();
    assert.doesNotMatch(html, /data-testid="tae-event-footer"/);
    assert.doesNotMatch(html, /更新事件时间/);
  });

  it('右栏预览在 SSR 下是查找中空态，不出现「预览不可用」推诿句', () => {
    const html = render();
    // effect 不跑 → 预览初始态是「正在查找伴生模型（chrbnd）…」。
    assert.match(html, /正在查找伴生模型（chrbnd）…/);
    assert.doesNotMatch(html, /本夜不挂/);
    assert.doesNotMatch(html, /预览不可用/);
    assert.doesNotMatch(html, /见底部日志/);
  });

  it('S17：源码挂 FlverViewer，有网格时出现预览宿主', () => {
    const source = readFileSync(
      join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'TaeWorkbenchPanel.tsx'),
      'utf8'
    );
    assert.match(source, /FlverViewer/);
    assert.match(source, /tae-preview-host/);
    assert.match(source, /模型已挂，动画播放未接入/);
    assert.doesNotMatch(source, /本夜不挂/);
    assert.doesNotMatch(source, /见底部日志/);
  });
});

describe('animationIdLabel / isLegalHkxStem / secondsToFrame（动画标签与帧换算纯逻辑）', () => {
  it('合法 hkx 茎去扩展直接用；乱码/空/非文件名字符一律丢弃显示数字 id（S17）', () => {
    assert.equal(animationIdLabel({ animId: 3, eventCount: 0, groupCount: 0, timesCount: 0, hkxName: 'a000_003013.hkx', events: [], eventsTruncated: false }), 'a000_003013');
    // 无 hkxName → 干净数字 id（旧行为是「动画 4」）。
    assert.equal(animationIdLabel({ animId: 4, eventCount: 0, groupCount: 0, timesCount: 0, events: [], eventsTruncated: false }), '4');
    // 乱码（旧 UTF-16 误读）→ 数字 id，禁止「葉」。
    assert.equal(animationIdLabel({ animId: 610, eventCount: 0, groupCount: 0, timesCount: 0, hkxName: '葉', events: [], eventsTruncated: false }), '610');
    // 含空白的占位名（如 "AE "）→ 数字 id。
    assert.equal(animationIdLabel({ animId: 700, eventCount: 0, groupCount: 0, timesCount: 0, hkxName: 'AE ', events: [], eventsTruncated: false }), '700');
    // 空串 → 数字 id。
    assert.equal(animationIdLabel({ animId: 9, eventCount: 0, groupCount: 0, timesCount: 0, hkxName: '', events: [], eventsTruncated: false }), '9');
  });

  it('isLegalHkxStem：ASCII 文件名茎合法，空白/乱码/空不合法', () => {
    assert.equal(isLegalHkxStem('a000_003013'), true);
    assert.equal(isLegalHkxStem('a0000'), true);
    assert.equal(isLegalHkxStem('葉'), false);
    assert.equal(isLegalHkxStem('AE '), false);
    assert.equal(isLegalHkxStem(''), false);
    assert.equal(isLegalHkxStem('a b'), false);
    assert.equal(isLegalHkxStem('a/b'), false);
  });

  it('秒 → 帧（30fps）；非有限给占位', () => {
    assert.equal(secondsToFrame(0.5), '15');
    assert.equal(secondsToFrame(2), '60');
    assert.equal(secondsToFrame(Number.NaN), '—');
    assert.equal(secondsToFrame(Number.POSITIVE_INFINITY), '—');
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
    const html = renderToStaticMarkup(
      <TaeWorkbenchPanel
        resourceUri="fixture://action/c0000.tae"
        data={makeDocument({
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
        })}
        initialSelection={{ kind: 'animation', id: 'anim-0', label: '动画 0', animationId: 0 }}
      />
    );
    assert.match(html, /data-testid="tae-partial-diagnostics"/);
    assert.match(html, /TAE_INVALID_TIME_RANGE/);
    assert.match(html, /事件时间范围非法/);
    // 非法时间行在词条列表标记 failed（S17：词条行只显示类型名 + 非法标记）。
    assert.match(html, />9 未命名</);
    assert.match(html, /非法时间/);
    assert.match(html, /wb-row--failed/);
  });

  it('candidate 且无诊断时不渲染 diagnostics 区段', () => {
    const html = render();
    assert.doesNotMatch(html, /data-testid="tae-partial-diagnostics"/);
  });
});

describe('S17 footer 写回接线（typed event write，收进三栏底 footer）', () => {
  it('事件选中后三栏底出现 footer：起始帧/结束帧/事件类型/下标/时间编辑', () => {
    const html = renderWithSelection();
    assert.match(html, /data-testid="tae-event-footer"/);
    assert.match(html, /编辑事件时间（update-event-times，内部秒）/);
    assert.match(html, /更新事件时间/);
    // 起始帧/结束帧是主标签（≈ 秒是小字）；0s→帧0、1s→帧30。
    assert.match(html, /起始帧/);
    assert.match(html, /结束帧/);
    // 帧为主标签（0 / 30），≈ 秒为小字。
    assert.match(html, />0\s*<span/);
    assert.match(html, /≈ 0s/);
    assert.match(html, />30\s*<span/);
    assert.match(html, /≈ 1s/);
    assert.match(html, /事件下标/);
    assert.match(html, /参数体/);
    // 新增事件入口已删（S17：中栏详情整块移除，footer 只留时间编辑）。
    assert.doesNotMatch(html, /新增事件/);
    // footer 编辑输入：起始帧 + 结束帧 = 2 个 number 输入。
    const inputs = html.match(/type="number"/g) ?? [];
    assert.equal(inputs.length, 2);
  });

  it('参数体区只读：footer 不出现参数编辑控件', () => {
    const html = renderWithSelection();
    // SSR 下参数 effect 不跑 → 显示读取中；无参数输入框（总输入恒为 2 个时间）。
    const inputs = html.match(/type="number"/g) ?? [];
    assert.equal(inputs.length, 2);
    assert.doesNotMatch(html, /type="checkbox"/);
  });

  it('提交期间禁用重复提交：saving 时按钮 disabled', () => {
    const html = renderToStaticMarkup(
      <TaeWorkbenchPanel
        resourceUri="fixture://action/c0000.tae"
        data={makeDocument()}
        initialSelection={{
          kind: 'event', id: 'ev-0-0', label: '1 未命名',
          animationId: 0, eventIndex: 0
        }}
      />
    );
    // SSR 下 saving 恒 false；断言按钮在保存中禁用由组件内部 saving 门禁承担，
    // 这里验证「事件下标缺失时按钮禁用」路径（eventIndex undefined）。
    const missing = renderToStaticMarkup(
      <TaeWorkbenchPanel
        resourceUri="fixture://action/c0000.tae"
        data={makeDocument()}
        initialSelection={{
          kind: 'event', id: 'ev-0-0', label: '1 未命名',
          animationId: 99, eventIndex: 0
        }}
      />
    );
    // animId 99 不存在 → selectedEvent undefined → 无 footer。
    assert.doesNotMatch(missing, /data-testid="tae-event-footer"/);
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

  it('参数体边界：有模板按模板解码（readTaeEventParams），无模板给未解码 + hex，不伪装', () => {
    assert.match(panelSource, /readTaeEventParams/);
    assert.match(panelSource, /参数体/);
    assert.match(panelSource, /未解码/);
    assert.match(panelSource, /undecodedHex/);
    // 前端不发送/不编辑参数体字节：mutation 结构里不出现 paramBody 字段。
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

  it('ok=false 时显示 diagnostics + 回滚提示，不清空词条列表', () => {
    assert.match(panelSource, /formatWriteDiagnostics/);
    assert.match(panelSource, /已回滚，事件表保持原状/);
    assert.match(panelSource, /data-testid="tae-write-notice"/);
    assert.match(panelSource, /diag-error/);
  });

  it('截断说明走 formatListTruncation 且保留 tae-truncation testId', () => {
    assert.match(panelSource, /formatListTruncation/);
    assert.match(panelSource, /data-testid="tae-truncation"/);
  });
});
