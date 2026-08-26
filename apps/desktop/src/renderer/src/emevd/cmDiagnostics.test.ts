/**
 * EMEVD CodeMirror diagnostics 与增量 source fill 的时序回归。
 *
 * 目标是把「普通续片跳过」和「完成片只分析一次完整文档」钉在同一个真实的
 * diagnostics extension listener 上，同时确认普通用户编辑仍会触发原有 debounce。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import type { EmedfCompletionItem } from '@soulforge/core';
import {
  emevdDiagnosticsExtension,
  isSourceFillCompletionTransaction,
  isSourceFillTransaction
} from './cmDiagnostics.js';
import {
  sourceFillAnnotation,
  sourceFillCompletionAnnotation
} from './incrementalSourceInjection.js';

const CATALOG: EmedfCompletionItem[] = [
  { name: 'KnownInstruction', bank: 0, id: 1, args: [] }
];

const PREFIX = '$Event(100, Default, function() {\n  KnownInstruction();';
const MIDDLE_SLICE_1 = '\n  KnownInstruction();';
const MIDDLE_SLICE_2 = '\n  KnownInstruction();';
const COMPLETION_TAIL = '\n  UnknownInstruction();\n});';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface DiagnosticsHarness {
  readonly getState: () => EditorState;
  readonly apply: (spec: TransactionSpec) => void;
  readonly runCount: () => number;
  readonly lastDiagnostics: () => ReadonlyArray<{ code: string; message: string }>;
  readonly dispatchCount: () => number;
}

function createHarness(doc: string): DiagnosticsHarness {
  let runCount = 0;
  let lastDiagnostics: ReadonlyArray<{ code: string; message: string }> = [];
  let dispatches = 0;
  let state = EditorState.create({
    doc,
    extensions: [
      emevdDiagnosticsExtension(
        () => CATALOG,
        () => ({}),
        (diagnostics) => {
          runCount += 1;
          lastDiagnostics = diagnostics;
        }
      )
    ]
  });
  let listener: ((update: ViewUpdate) => void) | undefined;

  const view = {
    get state(): EditorState {
      return state;
    },
    dispatch(spec: TransactionSpec): void {
      const startState = state;
      const transaction = state.update(spec);
      state = transaction.state;
      dispatches += 1;
      if (listener) listener(makeUpdate(startState, transaction, view as unknown as EditorView));
    }
  } as unknown as EditorView;

  listener = state.facet(EditorView.updateListener)[0];
  assert.ok(listener, 'diagnostics extension 应注册 update listener');

  return {
    getState: () => state,
    apply(spec) {
      const startState = state;
      const transaction = state.update(spec);
      state = transaction.state;
      listener!(makeUpdate(startState, transaction, view));
    },
    runCount: () => runCount,
    lastDiagnostics: () => lastDiagnostics,
    dispatchCount: () => dispatches
  };
}

function makeUpdate(
  startState: EditorState,
  transaction: ReturnType<EditorState['update']>,
  view: EditorView
): ViewUpdate {
  return {
    startState,
    state: transaction.state,
    transactions: [transaction],
    view,
    changes: transaction.changes,
    docChanged: transaction.docChanged,
    changedRanges: [],
    viewportChanged: false,
    heightChanged: false,
    geometryChanged: false,
    focusChanged: false,
    selectionSet: false,
    empty: false,
    scrolledIntoView: false
  } as unknown as ViewUpdate;
}

function sourceFillAnnotations(complete = false) {
  return [
    sourceFillAnnotation.of(true),
    ...(complete ? [sourceFillCompletionAnnotation.of(true)] : []),
    Transaction.addToHistory.of(false)
  ];
}

describe('EMEVD incremental source diagnostics completion', () => {
  it('区分普通 source fill 与 completion transaction', () => {
    const state = EditorState.create({ doc: 'prefix', extensions: [] });
    const middle = state.update({ annotations: sourceFillAnnotations() });
    const complete = state.update({ annotations: sourceFillAnnotations(true) });

    assert.equal(isSourceFillTransaction(middle), true);
    assert.equal(isSourceFillCompletionTransaction(middle), false);
    assert.equal(isSourceFillTransaction(complete), true);
    assert.equal(isSourceFillCompletionTransaction(complete), true);
  });

  it('中间多片不触发全文分析，完成片用完整文档只触发一次，普通编辑仍触发', async () => {
    const harness = createHarness(PREFIX);
    const append = (insert: string, complete = false): void => {
      const current = harness.getState();
      harness.apply({
        changes: { from: current.doc.length, insert },
        annotations: sourceFillAnnotations(complete)
      });
    };

    append(MIDDLE_SLICE_1);
    append(MIDDLE_SLICE_2);
    await delay(380);
    assert.equal(harness.runCount(), 0, '中间 source slice 不应触发 diagnostics');

    append(COMPLETION_TAIL, true);
    await delay(450);
    assert.equal(harness.runCount(), 1, 'completion 应只触发一次最终 diagnostics');
    assert.equal(harness.getState().doc.toString(), PREFIX + MIDDLE_SLICE_1 + MIDDLE_SLICE_2 + COMPLETION_TAIL);
    assert.ok(
      harness.lastDiagnostics().some((diagnostic) => (
        diagnostic.code === 'EMEVD_UNKNOWN_INSTRUCTION'
        && diagnostic.message.includes('UnknownInstruction')
      )),
      '最终 diagnostics 必须覆盖 completion 刚补齐的后半内容'
    );
    assert.equal(harness.dispatchCount(), 1, '最终 diagnostics 结果只应回写一次 StateField');

    const current = harness.getState();
    harness.apply({
      changes: { from: current.doc.length, insert: '\n  AnotherUnknownInstruction();' }
    });
    await delay(450);
    assert.equal(harness.runCount(), 2, '普通用户编辑仍应触发 diagnostics');
    assert.ok(
      harness.lastDiagnostics().some((diagnostic) => diagnostic.message.includes('AnotherUnknownInstruction')),
      '普通编辑的 diagnostics 应使用编辑后的文档'
    );
  });
});
