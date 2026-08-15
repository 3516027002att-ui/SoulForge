/**
 * ANIMATION-56B / ANIMATION-56C / S17：TaeWorkbenchPanel 三栏工作台的渲染结构
 * + 纯逻辑 + typed 写回接线 + 负向清单。
 *
 * renderer-unit 是纯 node SSR（react-dom/server，无 DOM、不跑 effect）。TAE 面板是
 * props 驱动（App 经 read-tae-document 取数后传入），SSR 能看到完整三栏结构、
 * 动画列表、词条事件与三栏底 footer；选择联动与 chrbnd 解析由 e2e 覆盖。
 * 面板只在提交/重读处理器里触达 window，SSR 渲染路径不触达，无需假 window。
 *
 * S17（2026-08-15，grok）重构后：
 *   Animations | 词条 | 预览（只读），详情沉到三栏底 footer。
 * 没有 Timeline / Events、没有 Inspector 第三栏、中栏不再有详情块。
 *
 * 覆盖：
 * 1. SSR 结构：三栏 Animations | 词条 | 预览（只读）挂载即存在；无 Timeline /
 *    Events、无 Inspector、无 Tools 空栏；动画列表由 shared pages 投影派生。
 * 2. 纯逻辑：animationIdLabel（合法 hkx 茎用茎，乱码/空回退 a000_+6 位 animId，
 *    禁止「动画 N」）；secondsToFrame / framesToSeconds；isInvalidTimeRange；
 *    eventTypeLabel（`{typeId} {类型名}` / `{typeId} 未命名`）。
 * 3. authority 语义：partial（TAE_INVALID_TIME_RANGE）时 diagnostics 必须暴露给
 *    用户（tae-partial-diagnostics），非法时间行在词条列表标 failed。
 * 4. ANIMATION-56C 写回接线（收进 footer）：
 *    - 事件选中后 footer 出现帧编辑（update-event-times，输入帧、内部秒）；
 *      insert-event 已按 S17 移除。
 *    - mutation 构建纯函数：update-event-times 带 animId+eventIndex+startTime+endTime。
 *    - eventIndex = 事件在其动画 events 数组里的下标。
 *    - ok=true 后经 readTaeDocument 重读并覆盖本地文档（refresh 触发器）；
 *      ok=false 显示 diagnostics + 回滚提示，不清空词条列表。
 *    - 参数体按模板解码展示字段名+值；解不出写「未解码」+ 有界 hex，不编造含义。
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
  secondsToFrame,
  framesToSeconds,
  TaeWorkbenchPanel,
  TaeEventFooterEditor,
  buildUpdateEventTimesMutation,
  eventIndexOfTimelineRow,
  eventTypeLabel,
  formatWriteDiagnostics,
  formatFieldValue,
  isInvalidTimeRange
} from './TaeWorkbenchPanel.js';
import type { TaeDocument, TaeTimelineEventRow } from '@soulforge/shared';

const EVENT_TYPE_NAMES: Record<string, string> = { 1: 'JumpTable', 2: 'PlaySound_ByStateInfo' };

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
        animId: 0, eventCount: 2, groupCount: 1, timesCount: 2, hkxName: 'a000_000000.hkt',
        events: [
          {
            startTime: 0, endTime: 1, eventTypeId: 1,
            parameterDecoded: true,
            templateFields: [{ name: 'JumpTableID', kind: 's32', value: 12 }]
          },
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
    <TaeWorkbenchPanel resourceUri="fixture://action/c0000.tae" data={data} eventTypeNames={EVENT_TYPE_NAMES} />
  );
}

/** 选中动画 0（无事件）时的渲染。 */
function renderAnimationSelected(): string {
  return renderToStaticMarkup(
    <TaeWorkbenchPanel
      resourceUri="fixture://action/c0000.tae"
      data={makeDocument()}
      eventTypeNames={EVENT_TYPE_NAMES}
      initialSelection={{ kind: 'animation', id: 'anim-0', label: 'a000_000000', animationId: 0 }}
    />
  );
}

/** 选中动画 0 的第 0 个事件时的渲染。 */
function renderWithSelection(): string {
  return renderToStaticMarkup(
    <TaeWorkbenchPanel
      resourceUri="fixture://action/c0000.tae"
      data={makeDocument()}
      eventTypeNames={EVENT_TYPE_NAMES}
      initialSelection={{
        kind: 'event', id: 'ev-0-0', label: '1 JumpTable',
        animationId: 0, eventIndex: 0
      }}
    />
  );
}

describe('TaeWorkbenchPanel 初始结构（挂载即有的三栏骨架）', () => {
  it('工作台根的可访问名是「动作工作台」', () => {
    assert.match(render(), /aria-label="动作工作台"/);
  });

  it('三栏 Animations | 词条 | 预览（只读）同时存在，无 Timeline/Inspector/Tools', () => {
    const html = render();
    assert.match(html, /aria-label="Animations"/);
    assert.match(html, /aria-label="Events \/ 词条"/);
    assert.match(html, /aria-label="预览（只读）"/);
    // S17：详情沉 footer，中栏不再有 Inspector 第三栏。
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

  it('动画列表由 pages 投影派生（合法 hkx 茎去扩展），不按 chr/action 目录分类', () => {
    const html = render();
    // a000_000000.hkt → a000_000000（去扩展主标签）；anim 1 无 hkxName → a000_000001。
    assert.match(html, />a000_000000</);
    assert.match(html, />a000_000001</);
    assert.doesNotMatch(html, />a000_000000\.hkt</);
    assert.doesNotMatch(html, />动画 /);
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

  it('选中动画后中栏出现词条事件列表：`{typeId} {类型名}`，帧为元信息，无详情块', () => {
    const html = renderAnimationSelected();
    assert.match(html, /词条 · 动画 0/);
    assert.match(html, />1 JumpTable</);
    assert.match(html, />2 PlaySound_ByStateInfo</);
    // 行内帧元信息（无秒）；中栏无详情块（下沉 footer）。
    assert.match(html, />0 → 30 帧/);
    assert.match(html, />45 → 60 帧/);
    assert.doesNotMatch(html, /0s → 1s/);
    assert.doesNotMatch(html, /data-testid="tae-details"/);
  });

  it('未选中任何项时中栏没有详情块（文件统计已在 footer 之外移除）', () => {
    const html = render();
    assert.doesNotMatch(html, /文件统计/);
    assert.doesNotMatch(html, /data-testid="tae-details"/);
  });

  it('右栏只读：未解析到 chrbnd（SSR 无 effect）时是显式 idle 空态，无输入/按钮', () => {
    const html = render();
    assert.match(html, /data-testid="tae-chrbnd-idle"/);
    assert.doesNotMatch(html, /tae-preview[^"]*">\s*<input|tae-preview[^"]*">\s*<button/);
  });
});

describe('animationIdLabel / 帧换算（动画标签与帧换算纯逻辑）', () => {
  it('合法 hkx 茎去扩展（.hkx/.hkt）；乱码/空/非文件名字符丢弃回退 a000_+6 位 animId', () => {
    assert.equal(animationIdLabel({ animId: 3013, eventCount: 0, groupCount: 0, timesCount: 0, hkxName: 'a000_003013.hkx', events: [], eventsTruncated: false }), 'a000_003013');
    assert.equal(animationIdLabel({ animId: 600, eventCount: 0, groupCount: 0, timesCount: 0, hkxName: 'a000_000600.hkt', events: [], eventsTruncated: false }), 'a000_000600');
    // 乱码（非 ASCII 文件名）、空串、别名残留 → 回退。
    assert.equal(animationIdLabel({ animId: 610, eventCount: 0, groupCount: 0, timesCount: 0, hkxName: '葉', events: [], eventsTruncated: false }), 'a000_000610');
    assert.equal(animationIdLabel({ animId: 4, eventCount: 0, groupCount: 0, timesCount: 0, hkxName: '', events: [], eventsTruncated: false }), 'a000_000004');
    assert.equal(animationIdLabel({ animId: 7, eventCount: 0, groupCount: 0, timesCount: 0, events: [], eventsTruncated: false }), 'a000_000007');
    assert.equal(animationIdLabel({ animId: 9, eventCount: 0, groupCount: 0, timesCount: 0, hkxName: 'a b', events: [], eventsTruncated: false }), 'a000_000009');
  });

  it('秒 → 帧（30fps）；帧 → 秒；非有限给占位', () => {
    assert.equal(secondsToFrame(0.5), '15');
    assert.equal(secondsToFrame(2), '60');
    assert.equal(secondsToFrame(Number.NaN), '—');
    assert.equal(secondsToFrame(Number.POSITIVE_INFINITY), '—');
    assert.equal(framesToSeconds('30'), 1);
    assert.equal(framesToSeconds('15'), 0.5);
    assert.ok(Number.isNaN(framesToSeconds('abc')));
  });

  it('eventTypeLabel：`{typeId} {类型名}`；无模板名给「未命名」', () => {
    assert.equal(eventTypeLabel(1, EVENT_TYPE_NAMES), '1 JumpTable');
    assert.equal(eventTypeLabel(99, EVENT_TYPE_NAMES), '99 未命名');
    assert.equal(eventTypeLabel(5, undefined), '5 未命名');
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
        eventTypeNames={EVENT_TYPE_NAMES}
        initialSelection={{ kind: 'animation', id: 'anim-0', label: 'a000_000000', animationId: 0 }}
      />
    );
    assert.match(html, /data-testid="tae-partial-diagnostics"/);
    assert.match(html, /TAE_INVALID_TIME_RANGE/);
    assert.match(html, /事件时间范围非法/);
    // 非法时间行在词条列表标记 failed。
    assert.match(html, /150 → 60 帧/);
    assert.match(html, /非法时间/);
    assert.match(html, /wb-row--failed/);
  });

  it('candidate 且无诊断时不渲染 diagnostics 区段', () => {
    const html = render();
    assert.doesNotMatch(html, /data-testid="tae-partial-diagnostics"/);
  });
});

describe('ANIMATION-56C 写回接线（typed event write，收进三栏底 footer）', () => {
  it('事件选中后 footer 出现：起始帧/结束帧/完整类型/事件下标/参数字段 + 帧编辑', () => {
    const html = renderWithSelection();
    assert.match(html, /data-testid="tae-event-footer"/);
    assert.match(html, /data-testid="tae-event-editor"/);
    assert.match(html, /编辑事件时间（update-event-times，内部秒）/);
    assert.match(html, /更新事件时间/);
    // 起始帧 0 / 结束帧 30（0s/1s @ 30fps）。
    assert.match(html, />起始帧 <strong>0<\/strong>/);
    assert.match(html, />结束帧 <strong>30<\/strong>/);
    // 类型名 + 下标。
    assert.match(html, />类型 <strong>1 JumpTable<\/strong>/);
    assert.match(html, /事件下标 0/);
    // 帧编辑输入 2 个（insert-event 已按 S17 移除）。
    const inputs = html.match(/type="number"/g) ?? [];
    assert.equal(inputs.length, 2);
  });

  it('参数字段按模板解码展示（字段名 + 值 + kind）；未解码事件给 hex 兜底', () => {
    const html = renderWithSelection();
    assert.match(html, /data-testid="tae-event-fields"/);
    assert.match(html, />JumpTableID</);
    assert.match(html, /12/);
    assert.match(html, /\[s32\]/);
    // 未解码事件（第 1 个动画的事件）→ 「参数体未解码」+ hex 兜底。
    const undecoded = renderToStaticMarkup(
      <TaeWorkbenchPanel
        resourceUri="fixture://action/c0000.tae"
        data={makeDocument()}
        eventTypeNames={EVENT_TYPE_NAMES}
        initialSelection={{
          kind: 'event', id: 'ev-0-1', label: '2 PlaySound_ByStateInfo',
          animationId: 0, eventIndex: 1
        }}
      />
    );
    assert.match(undecoded, /data-testid="tae-fields-undecoded"/);
    assert.match(undecoded, /参数体未解码/);
  });

  it('提交期间禁用重复提交：saving 时按钮 disabled', () => {
    const html = renderToStaticMarkup(
      <TaeEventFooterEditor
        row={{ animId: 0, startTime: 0, endTime: 1, eventTypeId: 1 }}
        eventIndex={0}
        timeDraft={{ startFrameText: '0', endFrameText: '30' }}
        saving
        notice={null}
        onTimeDraftChange={() => {}}
        onSubmitTime={() => {}}
      />
    );
    assert.match(html, /type="button"[^>]*disabled/);
  });

  it('buildUpdateEventTimesMutation：帧输入 → 内部秒（/30），animId + eventIndex 正确', () => {
    const row: TaeTimelineEventRow = { animId: 3, startTime: 0, endTime: 1, eventTypeId: 7 };
    assert.deepEqual(
      buildUpdateEventTimesMutation(row, 2, { startFrameText: '37.5', endFrameText: '75' }),
      { mutation: 'update-event-times', animId: 3, eventIndex: 2, startTime: 1.25, endTime: 2.5 }
    );
    // 非有限帧 → null（不把非法输入发往 C#）。
    assert.equal(buildUpdateEventTimesMutation(row, 0, { startFrameText: 'abc', endFrameText: '2' }), null);
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

  it('formatFieldValue：bool 显式 true/false，数值原样', () => {
    assert.equal(formatFieldValue({ name: 'A', kind: 'b', value: true }), 'true');
    assert.equal(formatFieldValue({ name: 'B', kind: 's32', value: 12 }), '12');
    assert.equal(formatFieldValue({ name: 'C', kind: 'f32', value: 1.5 }), '1.5');
  });
});

describe('Negative source tests（ANIMATION-56B / ANIMATION-56C / S17）', () => {
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

  it('S17：动画标签不猜编码，乱码回退 a000_+animId，无「动画 N」', () => {
    assert.match(panelSource, /a000_/);
    assert.match(panelSource, /padStart\(6, '0'\)/);
    assert.doesNotMatch(panelSource, /`动画 /);
    assert.doesNotMatch(panelSource, /IconButton|TreeItem/);
  });

  it('S17：词条行用 `{typeId} {类型名}`；无模板名显示「未命名」，不编造 PlaySound', () => {
    assert.match(panelSource, /eventTypeNames/);
    assert.match(panelSource, /未命名/);
    assert.doesNotMatch(panelSource, /事件类型 \$\{eventTypeId\}/);
  });

  it('事件参数体未解码的边界必须明示，不伪装成完整解析；insert-event 已按 S17 移除', () => {
    assert.match(panelSource, /参数体/);
    assert.match(panelSource, /未解码/);
    assert.match(panelSource, /parameterBytesHex/);
    // S17：新增事件入口移除；mutation 结构里不出现 paramBody 字段。
    assert.doesNotMatch(panelSource, /insert-event/);
    assert.doesNotMatch(panelSource, /paramBody/);
  });

  it('写回只有 commitTaeEvent 一个 typed 出口，无通用文本保存/字节直写 fallback', () => {
    assert.match(panelSource, /getRendererBridge/);
    assert.match(panelSource, /commitTaeEvent/);
    assert.match(panelSource, /update-event-times/);
    assert.doesNotMatch(panelSource, /saveTextResource|applyTae|contentBase64|dataBase64/);
    const bridgeCalls = [...panelSource.matchAll(/bridge\.(\w+)\s*\(/g)]
      .map((m) => m[1])
      .filter((name): name is string => name !== undefined);
    assert.ok(
      bridgeCalls.every((name) => name.startsWith('read') || name === 'commitTaeEvent' || name === 'resolveChrbndPreview'),
      `发现非 typed 桥接调用：${bridgeCalls.filter((n) => !n.startsWith('read') && n !== 'commitTaeEvent' && n !== 'resolveChrbndPreview').join(', ')}`
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
