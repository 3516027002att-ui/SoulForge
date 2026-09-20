import assert from 'node:assert/strict';
import type {
  ReferenceEvidenceDto,
  ReferenceObjectIdentity,
  ReferencePageRecord,
  ReferenceRelationItem,
  ReferenceStatementDto
} from '@soulforge/shared';
import { projectReferenceSearchPage } from '../references/referencePageProjection.js';

const workspaceId = 'workspace://read-action-smoke';

function identity(
  domain: string,
  sourceUri: string,
  extra: Partial<ReferenceObjectIdentity> = {}
): ReferenceObjectIdentity {
  return { workspaceId, domain, sourceUri, ...extra };
}

function evidence(sourceUri: string, statement: ReferenceStatementDto): ReferenceEvidenceDto {
  return { sourceUri, statement };
}

function relation(
  relationId: string,
  from: ReferenceObjectIdentity,
  to: ReferenceObjectIdentity,
  item: ReferenceEvidenceDto,
  relationKind: ReferenceRelationItem['relationKind'] = 'numeric_match'
): ReferenceRelationItem {
  return {
    relationId,
    from,
    to,
    relationKind,
    certainty: 'hypothesis',
    evidence: [item],
    path: [{ from, to, relationKind, certainty: 'hypothesis' }],
    reason: 'fixture read-action source selection'
  };
}

function projectOne(item: ReferenceRelationItem) {
  const record: ReferencePageRecord = {
    resolution: 'resolved',
    relations: [item],
    coverage: {
      scope: 'workspace-bundle',
      status: 'complete',
      domains: [],
      predicateComplete: true,
      negativeConclusionAllowed: true
    },
    page: { returnedCount: 1, hasMore: false },
    diagnostics: [],
    nextActions: []
  };
  return projectReferenceSearchPage(record).relations[0]!.readAction;
}

const scriptSource = 'file://script/155000_battle.luabnd.dcx';
const scriptChild = `${scriptSource}!/155000_battle.lua`;
const eventSource = 'file://event/common.emevd.dcx';

const scriptToEvent = projectOne(relation(
  'script-to-event',
  identity('script', scriptSource, { childChain: ['155000_battle.lua'] }),
  identity('emevd', eventSource, { eventId: 0 }),
  evidence(scriptChild, {
    kind: 'source-text',
    text: 'Common_Parry(0)',
    location: { line: 619, column: 1, byteRange: [15499, 15514] }
  })
));
assert.equal(scriptToEvent?.tool, 'read_luabnd_script');
assert.deepEqual(scriptToEvent?.args, {
  file: scriptSource,
  childPath: '155000_battle.lua',
  sourceOffset: 15499,
  sourceLimit: 256
});

const incompleteScriptSelector = projectOne(relation(
  'script-without-child-chain',
  identity('script', scriptSource),
  identity('emevd', eventSource, { eventId: 0 }),
  evidence(scriptChild, {
    kind: 'source-text',
    text: 'Common_Parry(0)',
    location: { line: 619, column: 1 }
  })
));
assert.equal(incompleteScriptSelector, undefined, 'must not invent a script child path from an incomplete selector');

const eventToScript = projectOne(relation(
  'event-to-script',
  identity('emevd', eventSource, { eventId: 100 }),
  identity('script', scriptSource, { childChain: ['155000_battle.lua'] }),
  evidence(`${eventSource}#event/100#instruction/7`, {
    kind: 'native-rendered',
    text: 'InitializeEvent(100)',
    location: { instructionIndex: 7 }
  }),
  'invokes_script'
));
assert.equal(eventToScript?.tool, 'read_emevd_event');
assert.deepEqual(eventToScript?.args, {
  file: eventSource,
  eventId: 100,
  instructionOffset: 7,
  instructionLimit: 1,
  format: 'json'
});

const paramSource = 'file://param/gameparam.parambnd.dcx';
const paramAction = projectOne(relation(
  'param-entry',
  identity('param', paramSource, { rowId: 1110020, label: 'ItemLotParam#1110020' }),
  identity('param', paramSource, { rowId: 4400, label: 'EquipParamGoods#4400' }),
  evidence(paramSource, {
    kind: 'field-assignment',
    text: 'ItemLotParam#1110020.lotItemId01=4400',
    location: { fieldId: 'lotItemId01' }
  }),
  'references_param_row'
));
assert.equal(paramAction?.tool, 'read_param_fields');
assert.deepEqual(paramAction?.args, {
  table: 'ItemLotParam',
  rowIds: [1110020],
  fieldIds: ['lotItemId01'],
  containerPath: paramSource
});

const fmgSource = 'file://msg/item.msgbnd.dcx';
const fmgAction = projectOne(relation(
  'fmg-entry',
  identity('fmg', fmgSource, { textId: 9801, childChain: ['ItemName'], label: 'ItemName/9801' }),
  identity('param', paramSource, { rowId: 4400, label: 'EquipParamGoods#4400' }),
  evidence(fmgSource, {
    kind: 'source-text',
    text: '葫芦种子'
  }),
  'references_text'
));
assert.equal(fmgAction?.tool, 'read_fmg_entries');
assert.deepEqual(fmgAction?.args, {
  table: 'ItemName',
  ids: [9801],
  containerPath: fmgSource,
  sourceOffset: 0,
  sourceLimit: 256
});

console.log('reference read-action source selection smoke passed');
