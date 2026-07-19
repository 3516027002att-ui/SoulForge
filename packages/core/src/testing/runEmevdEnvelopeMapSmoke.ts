/**
 * Bridge envelope → four-view document mapping smoke.
 */
import { emevdEnvelopeToEditorDocument } from '../editing/emevdEnvelopeToDocument.js';

function main(): void {
  const doc = emevdEnvelopeToEditorDocument('file://event/common.emevd', {
    sourceHash: 'abc',
    eventCount: 2,
    instructionCount: 3,
    authority: 'native-verified',
    events: [
      {
        id: 50,
        restBehavior: 1,
        instructionCount: 2,
        instructionStartIndex: 0
      },
      {
        id: 100,
        restBehavior: 0,
        instructionCount: 1,
        instructionStartIndex: 2
      }
    ],
    instructionsSample: [
      { index: 0, bank: 2000, id: 0, argsBase64: 'AAAA' },
      { index: 1, bank: 1000, id: 1, argsBase64: '' },
      { index: 2, bank: 2003, id: 1, argsBase64: '' }
    ]
  });

  if (doc.events.length !== 2) throw new Error('event count');
  if (doc.events[0]!.eventId !== 50 || doc.events[0]!.restBehavior !== 1) {
    throw new Error('event 50 mapping');
  }
  if (doc.events[0]!.instructions.length !== 2) throw new Error('instr count');
  if (doc.events[0]!.instructions[0]!.bank !== 2000) throw new Error('bank');
  if (doc.events[0]!.instructions[0]!.unknown !== false) throw new Error('known sample');
  if (!doc.events[0]!.eventUri.endsWith('#event/50/index/0')) throw new Error('uri');
  if (doc.events[0]!.eventIndex !== 0 || doc.events[1]!.eventIndex !== 1) {
    throw new Error('event index mapping');
  }
  if (!doc.diagnostics.some((d) => d.code === 'EMEVD_AUTHORITY')) {
    throw new Error('authority diagnostic');
  }

  const truncated = emevdEnvelopeToEditorDocument('file://e', {
    eventCount: 500,
    events: Array.from({ length: 10 }, (_, i) => ({ id: i, restBehavior: 0, instructionCount: 0 }))
  }, { maxEvents: 5 });
  if (truncated.events.length !== 5) throw new Error('maxEvents');
  if (!truncated.diagnostics.some((d) => d.code === 'EMEVD_EDITOR_EVENTS_TRUNCATED')) {
    throw new Error('truncation diagnostic');
  }

  const duplicateIds = emevdEnvelopeToEditorDocument('file://duplicates', {
    eventCount: 2,
    events: [
      { id: 88881000, eventIndex: 3, restBehavior: 0, instructionCount: 0 },
      { id: 88881000, eventIndex: 9, restBehavior: 1, instructionCount: 0 }
    ]
  });
  if (duplicateIds.events[0]!.eventUri === duplicateIds.events[1]!.eventUri
    || duplicateIds.events[0]!.eventIndex !== 3
    || duplicateIds.events[1]!.eventIndex !== 9) {
    throw new Error('duplicate event IDs must retain distinct index-bound identities');
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'EMEVD Bridge envelope → 四视图文档映射验证通过',
    events: doc.events.length,
    firstInstrBank: doc.events[0]!.instructions[0]!.bank
  }, null, 2));
}

main();
