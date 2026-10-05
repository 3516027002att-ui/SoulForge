import assert from 'node:assert/strict';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { it } from 'node:test';
import { paramPhysicalRowKey } from '@soulforge/shared';
import { ParamWorkbench, type ParamWorkbenchProps } from '../workbench/ParamWorkbench.js';
import { ParamTablePanel, type ParamTablePanelProps } from '../editors/ParamTablePanel.js';
import { ParamDefPanel, type ParamDefPanelProps } from '../editors/ParamDefPanel.js';
import { ParamEditorView, type ParamEditorViewProps } from './ParamEditorView.js';
function props(): ParamEditorViewProps {
  const saved = async () => ({ ok: true, changedFiles: [], diagnostics: [] });
  const file: NonNullable<ParamEditorViewProps['selectedFile']> = { sourceUri: 'resource://owned/a.param', relativePath: 'param/a.param', resourceKind: 'param' as const,
    game: 'sekiro', parseStatus: 'parsed' as const, diagnostics: [], extension: '.param', compoundExtension: '.param',
    formatKind: 'param', formatLabel: 'PARAM', size: 1, mtimeMs: 0 };
  const fields = [{ id: 'priority', name: 'Priority', type: 's8' as const, size: 1, offset: 0 }];
  return { activeEditor: 'param-rows', selectedFile: file, paramWorkbenchFile: null,
    document: { paramFieldEnums: null, paramFieldDefs: fields, paramTypeName: 'TYPE', paramRowDataSize: 2,
      paramFieldDefsOrigin: 'first-party', paramLive: true, paramSourceHash: 'native-hash', paramRows: [],
      paramRowCount: 0, paramIndexLoading: false, paramIndexDiagnostic: null,
      readParamRowsForPanel: async () => [], paramRevealRowId: 7, setParamRevealRowId: () => {},
      paramFieldDefinition: { schemaVersion: 1, typeName: 'TYPE', version: 0, rowDataSize: 2, origin: 'first-party', fields },
      paramFieldDefsDiagnostic: null, paramRowPayloads: new Map(), applyParamFieldMutationFromPanel: saved },
    mutations: { applyContainerParamFieldMutation: saved, applyContainerParamRowNameMutation: saved,
      applyContainerParamRowMutation: saved, applyParamRowMutationFromPanel: saved } };
}
function elements(node: ReactNode): ReactElement[] {
  const all: ReactElement[] = [];
  Children.forEach(node, child => { if (isValidElement<{ children?: ReactNode }>(child)) { all.push(child); all.push(...elements(child.props.children)); } });
  return all;
}
it('container view retains the native target/key, exact command callbacks and type/row-width definition checks', () => {
  const p = props(); p.activeEditor = 'param-container'; p.paramWorkbenchFile = p.selectedFile;
  const workbench = elements(ParamEditorView(p)).find(child => child.type === ParamWorkbench);
  assert.ok(workbench && isValidElement<ParamWorkbenchProps>(workbench));
  assert.equal(workbench.key, 'param-wb:resource://owned/a.param');
  assert.equal(workbench.props.containerUri, p.selectedFile?.sourceUri);
  assert.equal(workbench.props.containerLabel, p.selectedFile?.relativePath);
  assert.equal(workbench.props.onApplyFieldMutation, p.mutations.applyContainerParamFieldMutation);
  assert.equal(workbench.props.onApplyRowNameMutation, p.mutations.applyContainerParamRowNameMutation);
  assert.equal(workbench.props.onApplyRowMutation, p.mutations.applyContainerParamRowMutation);
  assert.equal(workbench.props.resolveDefinition?.('OTHER', 2), null);
  assert.equal(workbench.props.resolveDefinition?.('TYPE', 3), null);
  assert.deepEqual(workbench.props.resolveDefinition?.('TYPE', 2), p.document.paramFieldDefinition);
  for (const paramFieldDefs of [null, []]) {
    const empty = elements(ParamEditorView({ ...p, document: { ...p.document, paramFieldDefs } })).find(child => child.type === ParamWorkbench);
    assert.ok(empty && isValidElement<ParamWorkbenchProps>(empty)); assert.equal(empty.props.resolveDefinition?.('TYPE', 2), null);
  }
});
it('raw-row view preserves physical payload keys, loaded source keys, reveal and native field arguments', async () => {
  const p = props(), identity = { rowIndex: 5, id: 7, dataHash: 'physical-hash' }, input = { rowId: 7, identity,
    fieldId: 'priority', value: 0, rowDataBase64: 'AA==', definition: p.document.paramFieldDefinition };
  p.document.paramRowPayloads = new Map([[paramPhysicalRowKey(identity), 'AA=='], [paramPhysicalRowKey({ ...identity, rowIndex: 6 }), 'AQ==']]);
  const calls: unknown[] = []; p.document.applyParamFieldMutationFromPanel = async value => { calls.push(value); return { ok: true }; };
  p.document.setParamRevealRowId = value => { calls.push(value); };
  const nodes = elements(ParamEditorView(p)), table = nodes.find(child => child.type === ParamTablePanel), fields = nodes.find(child => child.type === ParamDefPanel);
  assert.ok(table && isValidElement<ParamTablePanelProps>(table)); assert.ok(fields && isValidElement<ParamDefPanelProps>(fields));
  assert.equal(table.key, 'resource://owned/a.param:live:native-hash'); assert.equal(table.props.onMutation, p.mutations.applyParamRowMutationFromPanel);
  assert.equal(table.props.onReadRows, p.document.readParamRowsForPanel); assert.equal(table.props.revealRowId, 7);
  table.props.onRevealHandled?.(); assert.equal(fields.props.getRowDataBase64(identity), 'AA==');
  assert.equal(fields.props.getRowDataBase64({ ...identity, rowIndex: 6 }), 'AQ==');
  assert.equal(fields.key, 'paramdef:live:native-hash'); assert.equal(fields.props.definition, p.document.paramFieldDefinition);
  const result = await fields.props.onApplyFieldMutation?.(input); assert.equal(result?.ok, true); assert.deepEqual(calls, [null, input]);
});
it('unloaded/unselected rows preserve readonly projections and omit the native field submission callback', () => {
  const p = props(); const nodes = elements(ParamEditorView({ ...p, selectedFile: null, document: { ...p.document, paramLive: false } }));
  const fields = nodes.find(child => child.type === ParamDefPanel); assert.ok(fields && isValidElement<ParamDefPanelProps>(fields));
  assert.equal(fields.props.typeName, '未加载'); assert.equal(fields.props.rowDataSize, 0); assert.equal(fields.props.origin, 'fixture');
  assert.equal(fields.props.resourceUri, ''); assert.equal(fields.props.onApplyFieldMutation, undefined);
});
it('non-PARAM selection without a container produces no PARAM workbench controls', () => {
  const p = props(); const nodes = elements(ParamEditorView({ ...p, activeEditor: 'script' }));
  assert.equal(nodes.some(child => [ParamWorkbench, ParamTablePanel, ParamDefPanel].some(type => child.type === type)), false);
});
