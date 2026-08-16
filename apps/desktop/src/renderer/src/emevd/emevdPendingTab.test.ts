/**
 * emevdPendingTab 单测：`readEmevdFullDocument` 单次响应 → 事件工作台标签。
 *
 * 判据核心（S18-B）：document.events 不再从 envelope 投影（那需要第二次
 * IPC 且指令样本只覆盖前 256 条），gutter 判据行改由 outline 的 unknownCount
 * 出；指令体不搬进 renderer（显式诊断声明）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EmevdDocumentOutline } from '@soulforge/shared';
import {
  emevdPendingTabFromFullDocument,
  eventWarningRowsFromOutline,
  type EmevdPendingTabInput
} from './emevdPendingTab.js';

function makeOutline(overrides?: Partial<EmevdDocumentOutline>): EmevdDocumentOutline {
  return {
    schemaVersion: 1,
    resourceUri: 'file://event/common.emevd',
    eventCount: 2,
    instructionTotal: 10,
    truncated: false,
    limit: 4096,
    events: [
      {
        eventUri: 'file://event/common.emevd#event/50',
        eventId: 50,
        restBehavior: 0,
        layer: 0,
        instructionCount: 6,
        unknownCount: 0
      },
      {
        eventUri: 'file://event/common.emevd#event/51',
        eventId: 51,
        restBehavior: 1,
        layer: -1,
        instructionCount: 4,
        unknownCount: 2
      }
    ],
    ...overrides
  };
}

function makeInput(overrides?: Partial<EmevdPendingTabInput>): EmevdPendingTabInput {
  return {
    tabId: 'file://event/common.emevd',
    title: 'common.emevd',
    resourceUri: 'file://event/common.emevd',
    full: { ok: true, sourceHash: 'abc123', outline: makeOutline() },
    dslTemplate: '$Event(50, x) {\n// ...\n',
    dslTemplateTruncated: false,
    dslTemplateTotalLines: 3,
    sourceStyle: 'dark-script',
    ...overrides
  };
}

describe('eventWarningRowsFromOutline', () => {
  it('无 outline 时返回空判据', () => {
    assert.deepEqual(eventWarningRowsFromOutline(null), []);
    assert.deepEqual(eventWarningRowsFromOutline(undefined), []);
  });

  it('outline 行按文档顺序映射为 eventId + unknownCount', () => {
    assert.deepEqual(eventWarningRowsFromOutline(makeOutline()), [
      { eventId: 50, warnings: 0 },
      { eventId: 51, warnings: 2 }
    ]);
  });
});

describe('emevdPendingTabFromFullDocument', () => {
  it('构造 live 标签：sourceHash/判据/模板/形态都来自 full 与输入', () => {
    const tab = emevdPendingTabFromFullDocument(makeInput());
    assert.equal(tab.live, true);
    assert.equal(tab.tabId, 'file://event/common.emevd');
    assert.equal(tab.title, 'common.emevd');
    assert.equal(tab.sourceHash, 'abc123');
    assert.equal(tab.dslTemplate, '$Event(50, x) {\n// ...\n');
    assert.equal(tab.dslTemplateTruncated, false);
    assert.equal(tab.dslTemplateTotalLines, 3);
    assert.equal(tab.sourceStyle, 'dark-script');
    assert.deepEqual(tab.eventWarnings, [
      { eventId: 50, warnings: 0 },
      { eventId: 51, warnings: 2 }
    ]);
  });

  it('document 不带指令体：events 为空 + 显式诊断声明', () => {
    const tab = emevdPendingTabFromFullDocument(makeInput());
    assert.deepEqual(tab.document.events, []);
    assert.ok(
      tab.document.diagnostics.some((d) => d.code === 'EMEVD_INSTRUCTION_BODIES_STAY_IN_MAIN'),
      '应声明指令体留在主进程权威文档'
    );
    assert.ok(
      !tab.document.diagnostics.some((d) => d.code === 'EMEVD_OUTLINE_TRUNCATED'),
      '未截断时不应有截断诊断'
    );
  });

  it('outline 截断时挂 EMEVD_OUTLINE_TRUNCATED 诊断', () => {
    const tab = emevdPendingTabFromFullDocument(
      makeInput({
        full: {
          ok: true,
          // 截断时 events 本身只含前 limit 个（core 的 buildEmevdDocumentOutline
          // 已 slice），此处同样只给 1 行。
          outline: makeOutline({
            truncated: true,
            limit: 1,
            eventCount: 2,
            events: [makeOutline().events[0]!]
          })
        }
      })
    );
    assert.ok(
      tab.document.diagnostics.some((d) => d.code === 'EMEVD_OUTLINE_TRUNCATED'),
      '截断时应提示判据只覆盖前 limit 个事件'
    );
    assert.equal(tab.eventWarnings?.length, 1, '截断后判据行只含前 limit 个');
  });

  it('无 outline 时判据为空、sourceHash 兜底 null', () => {
    const tab = emevdPendingTabFromFullDocument(makeInput({ full: { ok: true } }));
    assert.deepEqual(tab.eventWarnings, []);
    assert.equal(tab.sourceHash, null);
  });

  it('documentInstanceId 与 revision 透传', () => {
    const tab = emevdPendingTabFromFullDocument(
      makeInput({ full: { ok: true, documentInstanceId: 'doc-1', revision: 7 } })
    );
    assert.equal(tab.document.documentInstanceId, 'doc-1');
    assert.equal(tab.document.revision, 7);
  });
});
