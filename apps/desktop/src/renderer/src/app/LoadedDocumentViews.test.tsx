import assert from 'node:assert/strict';
import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { it } from 'node:test';
import { PlainTextEditorView, MapEditorView, TextEditorView, EventEditorView } from './LoadedDocumentViews.js';
import { MsgTableEditor } from '../components/MsgTableEditor.js';
import { PanelErrorBoundary } from '../components/PanelErrorBoundary.js';
import { MsbScenePanel, type MsbScenePanelProps } from '../editors/MsbScenePanel.js';
import { FmgWorkbenchPanel, type FmgWorkbenchPanelProps } from '../editors/FmgWorkbenchPanel.js';
import { EventSourceWorkbenchPanel, type EventSourceWorkbenchPanelProps } from '../editors/EventSourceWorkbenchPanel.js';
function elements(node: ReactNode): ReactElement[] {
  const all: ReactElement[] = [];
  Children.forEach(node, child => { if (isValidElement<{ children?: ReactNode }>(child)) { all.push(child); all.push(...elements(child.props.children)); } });
  return all;
}
it('plain text keeps exact draft/baseline controls, row callbacks, diagnostics and readonly accessibility', async () => {
  const calls: unknown[] = [];
  const resource: ComponentProps<typeof PlainTextEditorView>['document'] = {
    editDirty: true, saveCurrentText: async () => { calls.push('save'); return null; }, setEditText: text => { calls.push(text); },
    lastSavedText: '\ufeffbaseline\r\n', hasMsgTable: true, msgRows: [], addMsgRow: () => {}, removeMsgRow: () => {}, updateMsgRow: () => {},
    editText: 'new\ntext', canEditText: false, saveDiagnostics: ['owned diagnostic'], selectedFile: null
  };
  const nodes = elements(PlainTextEditorView({ document: resource }));
  const buttons = nodes.filter(n => n.type === 'button'); assert.equal(buttons.length, 2);
  for (const button of buttons) { assert.ok(isValidElement<{ disabled: boolean; onClick(): void }>(button)); assert.equal(button.props.disabled, false); await button.props.onClick(); }
  assert.deepEqual(calls, ['save', '\ufeffbaseline\r\n']);
  const editor = nodes.find(n => n.type === 'textarea'); assert.ok(editor && isValidElement<{ value: string; readOnly: boolean; 'aria-label': string; 'aria-readonly': boolean }>(editor));
  assert.equal(editor.props.value, resource.editText); assert.equal(editor.props.readOnly, true); assert.equal(editor.props['aria-readonly'], true);
  assert.equal(editor.props['aria-label'], '资源文本内容（未选择文件）');
  const rows = nodes.find(n => n.type === MsgTableEditor); assert.ok(rows && isValidElement<ComponentProps<typeof MsgTableEditor>>(rows));
  assert.equal(rows.props.onAdd, resource.addMsgRow); assert.equal(rows.props.onRemove, resource.removeMsgRow); assert.equal(rows.props.onUpdate, resource.updateMsgRow);
  assert.equal(nodes.filter(n => n.type === 'span').length, 1);
  const clean = elements(PlainTextEditorView({ document: { ...resource, editDirty: false, hasMsgTable: false, saveDiagnostics: [] } }));
  assert.equal(clean.some(n => n.type === MsgTableEditor), false);
  for (const button of clean.filter(n => n.type === 'button')) { assert.ok(isValidElement<{ disabled: boolean }>(button)); assert.equal(button.props.disabled, true); }
});
it('map view retains native revision/data/count references, original remount key and captured revision callback', () => {
  const calls: string[] = [];
  const map: ComponentProps<typeof MapEditorView>['document'] = { msbSourceHash: 'native-hash', msbParts: [], msbRegions: [], msbRoutes: [],
    msbModels: [], msbEvents: [], msbSourceCounts: { models: 0, parts: 0, regions: 0, events: 0, routes: 0 }, setMsbSourceHash: hash => { calls.push(hash); } };
  const failure = { kind: 'msb-open-failed' as const, document: 'map', code: 'OWNED_FAILURE', message: 'owned failure' };
  const element = MapEditorView({ selectedFile: { sourceUri: 'resource://owned/map', relativePath: 'map/map.msb' }, document: map, openFailure: failure });
  assert.ok(isValidElement<MsbScenePanelProps>(element)); assert.equal(element.type, MsbScenePanel); assert.equal(element.key, 'resource://owned/map:native-hash:0:0:0');
  assert.equal(element.props.mapResourceUri, 'resource://owned/map'); assert.equal(element.props.revision, 'native-hash'); assert.equal(element.props.game, 'sekiro');
  assert.equal(element.props.parts, map.msbParts); assert.equal(element.props.models, map.msbModels); assert.equal(element.props.sourceCounts, map.msbSourceCounts);
  assert.equal(element.props.openFailure, failure); assert.equal(element.props.onRevisionChange, map.setMsbSourceHash);
  element.props.onRevisionChange?.('native-new-hash'); assert.deepEqual(calls, ['native-new-hash']);
});
it('text view retains native entries, live catalog/reveal and original mutation identity', () => {
  const submit = async () => {}, clear = () => {};
  const entries = [{ id: 7, text: 'native text' }], reveal = { tableId: 'native-table', entryId: 7 };
  const element = TextEditorView({ selectedFile: { sourceUri: 'resource://owned/msg' }, document: { fmgEntries: entries, submitFmgEntry: submit },
    live: true, revealRequest: reveal, onRevealHandled: clear });
  assert.ok(isValidElement<FmgWorkbenchPanelProps>(element)); assert.equal(element.type, FmgWorkbenchPanel); assert.equal(element.key, 'resource://owned/msg');
  assert.equal(element.props.entries, entries); assert.equal(element.props.live, true); assert.equal(element.props.revealRequest, reveal);
  assert.equal(element.props.onRevealHandled, clear); assert.equal(element.props.onMutation, submit);
});
it('event view stays present while hidden and retains its fixed boundary plus original DSL/jump commands', () => {
  const event: ComponentProps<typeof EventEditorView>['document'] = { eventOpening: false, eventSourcePreview: null,
    eventPendingTab: null, submitEventDsl: async () => ({ ok: true, diagnostics: [] }) };
  const jump: ComponentProps<typeof EventEditorView>['onJumpResource'] = async () => ({ kind: 'insufficient_evidence', code: 'insufficient_evidence', message: 'owned evidence absent' });
  for (const active of [true, false]) {
    const element = EventEditorView({ active, document: event, onJumpResource: jump }); assert.equal(element.type, PanelErrorBoundary); assert.equal(element.key, 'panel-boundary:event');
    const nodes = elements(element), host = nodes.find(n => n.type === 'div'); assert.ok(host && isValidElement<{ hidden: boolean }>(host)); assert.equal(host.props.hidden, !active);
    const panel = nodes.find(n => n.type === EventSourceWorkbenchPanel); assert.ok(panel && isValidElement<EventSourceWorkbenchPanelProps>(panel));
    assert.equal(panel.props.active, active); assert.equal(panel.props.pendingTab, event.eventPendingTab); assert.equal(panel.props.onDslSubmit, event.submitEventDsl); assert.equal(panel.props.onJumpResource, jump);
  }
});
