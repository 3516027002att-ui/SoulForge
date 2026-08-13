/**
 * alignEmevdDocumentAnchors 单测。
 *
 * renderer-unit 是纯 node SSR（无 DOM）。本模块是纯函数，正好在这里验证：
 * DSL 模板与 bounded envelope 是同一份 Bridge 文档的两个投影，事件顺序一致，
 * 对齐必须按「锚出现顺序」逐事件赋值；截断模板 / 空模板要回退到 eventId 兜底，
 * 与 renderSource 的 `@e:<anchor ?? eventId>` 形态对齐。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  alignEmevdDocumentAnchors,
  extractEmevdEventAnchors
} from './alignEmevdDocumentAnchors.js';
import type { EmevdEditorDocument } from '@soulforge/shared';

function makeDocument(eventIds: number[]): EmevdEditorDocument {
  return {
    schemaVersion: 1,
    resourceUri: 'file://event/common.emevd',
    revision: 1,
    events: eventIds.map((eventId) => ({
      eventUri: `file://event/common.emevd#event/${eventId}`,
      eventId,
      restBehavior: eventId % 2,
      layer: -1,
      instructions: []
    })),
    bytesBase64: '',
    diagnostics: [],
    documentInstanceId: 'doc-instance'
  };
}

describe('extractEmevdEventAnchors', () => {
  it('按出现顺序提取 `event @e:<anchor>` 行', () => {
    const anchors = extractEmevdEventAnchors(
      ['resource "x"', 'event @e:abc123 {', '  set id = 50', 'event @e:def456 {', ''].join('\n')
    );
    assert.deepEqual(anchors, ['abc123', 'def456']);
  });

  it('空模板返回空数组，不含任何锚', () => {
    assert.deepEqual(extractEmevdEventAnchors(''), []);
  });

  it('指令行里的 @e: 不误判为事件锚（锚必须在行首）', () => {
    const anchors = extractEmevdEventAnchors(
      ['event @e:only {', '  instruction @i:x { // 内含 @e:fake 不是事件锚', ''].join('\n')
    );
    assert.deepEqual(anchors, ['only']);
  });
});

describe('alignEmevdDocumentAnchors', () => {
  it('按 DSL 模板锚顺序给事件赋值 localNodeId', () => {
    const doc = makeDocument([50, 60]);
    const aligned = alignEmevdDocumentAnchors(
      doc,
      ['event @e:a1b2 {', 'event @e:c3d4 {', ''].join('\n')
    );
    assert.equal(aligned.events[0]!.anchor?.localNodeId, 'a1b2');
    assert.equal(aligned.events[1]!.anchor?.localNodeId, 'c3d4');
    // 事件本体与顺序不变，只是补上锚。
    assert.deepEqual(aligned.events.map((e) => e.eventId), [50, 60]);
  });

  it('bounded 模板截断时，没有锚行的事件回退到 eventId（与 renderSource 兜底对齐）', () => {
    const doc = makeDocument([50, 60, 70]);
    const aligned = alignEmevdDocumentAnchors(
      doc,
      ['event @e:a1b2 {', ''].join('\n')
    );
    assert.equal(aligned.events[0]!.anchor?.localNodeId, 'a1b2');
    assert.equal(aligned.events[1]!.anchor?.localNodeId, '60');
    assert.equal(aligned.events[2]!.anchor?.localNodeId, '70');
  });

  it('空模板（完整文档读取失败）时全部回退到 eventId', () => {
    const doc = makeDocument([50, 60]);
    const aligned = alignEmevdDocumentAnchors(doc, null);
    assert.deepEqual(
      aligned.events.map((e) => e.anchor?.localNodeId),
      ['50', '60']
    );
  });

  it('模板锚多于事件时忽略多余锚，不越界', () => {
    const doc = makeDocument([50]);
    const aligned = alignEmevdDocumentAnchors(doc, 'event @e:aa {\nevent @e:bb {');
    assert.equal(aligned.events.length, 1);
    assert.equal(aligned.events[0]!.anchor?.localNodeId, 'aa');
  });

  it('anchor 的 documentInstanceId 与 sourceFingerprint 有值（类型契约完整）', () => {
    const aligned = alignEmevdDocumentAnchors(makeDocument([50]), 'event @e:aa {');
    const anchor = aligned.events[0]!.anchor;
    assert.ok(anchor);
    assert.equal(anchor.documentInstanceId, 'doc-instance');
    assert.equal(anchor.sourceFingerprint, '50');
  });
});
