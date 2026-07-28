import {
  applyEmevdEditorMutation,
  buildFourViewState,
  createEmevdEditorDocument,
  selectEmevdView,
  tryParseEmevdDsl
} from '../editing/emevdFourViewController.js';

function main(): void {
  const doc0 = createEmevdEditorDocument({
    resourceUri: 'file://event/common.emevd',
    bytesBase64: Buffer.from('EVD-DEMO').toString('base64'),
    events: [
      {
        eventId: 50,
        restBehavior: 0,
        instructions: [
          { bank: 1, id: 10, argsBase64: 'AAA=', unknown: true },
          { bank: 1, id: 20, argsBase64: 'BBB=', unknown: true }
        ]
      },
      { eventId: 100, restBehavior: 0, instructions: [] }
    ]
  });
  let selection = selectEmevdView({ view: 'flow' }, 'table', doc0.events[0]!.eventUri);
  let state = buildFourViewState(doc0, selection);
  if (state.tableRows.length !== 2) throw new Error('table rows');
  if (!state.dslText.includes('$Event(50')) throw new Error('dsl missing event');
  if (state.selection.view !== 'table') throw new Error('selection view');

  selection = selectEmevdView(selection, 'bytes', doc0.events[0]!.eventUri, doc0.events[0]!.instructions[0]!.instructionUri);
  if (selection.instructionUri !== doc0.events[0]!.instructions[0]!.instructionUri) {
    throw new Error('instruction selection lost');
  }

  const mutated = applyEmevdEditorMutation(doc0, {
    kind: 'emevd_set_rest_behavior',
    eventUri: doc0.events[0]!.eventUri,
    restBehavior: 1,
    baseRevision: 0
  });
  if (!mutated.ok) throw new Error(JSON.stringify(mutated));
  if (mutated.document.revision !== 1) throw new Error('revision');
  if (mutated.document.events[0]!.restBehavior !== 1) throw new Error('restBehavior');
  if (mutated.document.events[1]!.restBehavior !== 0) throw new Error('sibling restBehavior changed');
  if (mutated.document.events[1]!.eventId !== 100) throw new Error('sibling id');

  const stale = applyEmevdEditorMutation(mutated.document, {
    kind: 'emevd_set_rest_behavior',
    eventUri: doc0.events[0]!.eventUri,
    restBehavior: 0,
    baseRevision: 0
  });
  if (stale.ok || stale.code !== 'EDITOR_REVISION_CONFLICT') throw new Error('stale must conflict');

  const idChange = applyEmevdEditorMutation(mutated.document, {
    kind: 'emevd_update_id',
    eventUri: mutated.document.events[0]!.eventUri,
    newEventId: 51,
    baseRevision: 1
  });
  if (!idChange.ok) throw new Error(JSON.stringify(idChange));
  if (idChange.document.events[0]!.eventId !== 51) throw new Error('id not updated');
  if (!idChange.document.events[0]!.eventUri.endsWith('#event/51')) throw new Error('uri not updated');

  const dslParse = tryParseEmevdDsl('$Event(broken');
  if (dslParse.ok || dslParse.code !== 'EMEVD_DSL_NON_AUTHORITATIVE') {
    throw new Error('DSL must be non-authoritative');
  }

  // Four views share same revision after mutation
  const after = buildFourViewState(idChange.document, { view: 'dsl', eventUri: idChange.document.events[0]!.eventUri });
  if (after.document.revision !== 2) throw new Error('shared revision broken');
  if (!after.dslText.includes('$Event(51')) throw new Error('dsl not synced');

  const instrUri = idChange.document.events[0]!.instructions[0]!.instructionUri;
  const argsMut = applyEmevdEditorMutation(idChange.document, {
    kind: 'emevd_set_instruction_args',
    eventUri: idChange.document.events[0]!.eventUri,
    instructionUri: instrUri,
    argsBase64: Buffer.from([1, 2, 3]).toString('base64'), // length mismatch vs AAA=
    baseRevision: 2
  });
  if (argsMut.ok || argsMut.code !== 'EMEVD_ARGS_LENGTH_MISMATCH') {
    throw new Error('args length mismatch must fail');
  }
  const sameLen = applyEmevdEditorMutation(idChange.document, {
    kind: 'emevd_set_instruction_args',
    eventUri: idChange.document.events[0]!.eventUri,
    instructionUri: instrUri,
    argsBase64: Buffer.from('ZZZ=').toString('base64') === 'ZZZ='
      ? 'ZZZ='
      : Buffer.from([9, 9, 9]).toString('base64'),
    baseRevision: 2
  });
  // AAA= is 3 bytes raw when decoded... actually base64 AAA= is 2 bytes? Let me use exact previous
  const prevB64 = idChange.document.events[0]!.instructions[0]!.argsBase64;
  const prev = Buffer.from(prevB64, 'base64');
  const flipped = Buffer.from(prev);
  flipped[0] = (flipped[0]! ^ 0xff) & 0xff;
  const argsOk = applyEmevdEditorMutation(idChange.document, {
    kind: 'emevd_set_instruction_args',
    eventUri: idChange.document.events[0]!.eventUri,
    instructionUri: instrUri,
    argsBase64: flipped.toString('base64'),
    baseRevision: 2
  });
  if (!argsOk.ok) throw new Error(JSON.stringify(argsOk));
  if (argsOk.document.events[0]!.instructions[0]!.argsBase64 !== flipped.toString('base64')) {
    throw new Error('instruction args not applied in IR');
  }
  void sameLen;

  console.log(JSON.stringify({
    ok: true,
    message: 'EMEVD 四视图 revision/selection/mutation 同步验证通过',
    revision: argsOk.document.revision,
    events: after.tableRows.length,
    instructionArgsMutation: true,
    dslNonAuthoritative: true,
    views: ['flow', 'table', 'dsl', 'bytes']
  }, null, 2));
}

main();
