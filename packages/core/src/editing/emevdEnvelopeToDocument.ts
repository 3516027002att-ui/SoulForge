/**
 * Map Bridge EMEVD envelope (renderer-safe subset) into EmevdEditorDocument.
 * Instruction sample is capped by Bridge; full bank is not required for four-view skeleton.
 */

import type { EmevdEditorDocument, EmevdEventIr, EmevdInstructionIr } from '@soulforge/shared';

export interface BridgeEmevdEnvelopeLike {
  sourceHash?: string;
  eventCount?: number;
  instructionCount?: number;
  events?: Array<{
    id: number;
    eventIndex?: number;
    restBehavior?: number;
    instructionCount?: number;
    instructionStartIndex?: number;
    layer?: number;
  }>;
  instructionsSample?: Array<{
    index: number;
    bank: number;
    id: number;
    argsBase64?: string;
    argsLength?: number;
  }>;
  authority?: string;
}

export function emevdEnvelopeToEditorDocument(
  resourceUri: string,
  envelope: BridgeEmevdEnvelopeLike,
  options?: { maxEvents?: number; bytesBase64?: string }
): EmevdEditorDocument {
  const maxEvents = options?.maxEvents ?? 256;
  const sampleByIndex = new Map(
    (envelope.instructionsSample ?? []).map((item) => [item.index, item])
  );
  const events: EmevdEventIr[] = (envelope.events ?? []).slice(0, maxEvents).map((event, index) => {
    const eventIndex = event.eventIndex ?? index;
    const eventUri = `${resourceUri}#event/${event.id}/index/${eventIndex}`;
    const start = event.instructionStartIndex ?? -1;
    const count = event.instructionCount ?? 0;
    const instructions: EmevdInstructionIr[] = [];
    if (start >= 0 && count > 0) {
      for (let i = 0; i < Math.min(count, 64); i += 1) {
        const globalIndex = start + i;
        const sample = sampleByIndex.get(globalIndex);
        instructions.push({
          instructionUri: `${eventUri}/instr/${i}`,
          bank: sample?.bank ?? 0,
          id: sample?.id ?? 0,
          argsBase64: sample?.argsBase64 ?? '',
          unknown: !sample
        });
      }
    }
    return {
      eventUri,
      eventId: event.id,
      eventIndex,
      restBehavior: event.restBehavior ?? 0,
      layer: event.layer ?? -1,
      instructions
    };
  });

  const diagnostics: EmevdEditorDocument['diagnostics'] = [];
  if ((envelope.eventCount ?? 0) > maxEvents) {
    diagnostics.push({
      severity: 'info',
      code: 'EMEVD_EDITOR_EVENTS_TRUNCATED',
      message: `编辑器仅加载前 ${maxEvents} 个事件（共 ${envelope.eventCount}）。`
    });
  }
  if (envelope.authority) {
    diagnostics.push({
      severity: 'info',
      code: 'EMEVD_AUTHORITY',
      message: `Bridge authority=${envelope.authority}`
    });
  }

  return {
    schemaVersion: 1,
    resourceUri,
    revision: 0,
    events,
    bytesBase64: options?.bytesBase64 ?? '',
    diagnostics
  };
}
