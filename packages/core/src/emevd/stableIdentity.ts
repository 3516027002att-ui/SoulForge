import { createHash, randomUUID } from 'node:crypto';
import type {
  EmevdEditorDocument,
  EmevdEventIr,
  EmevdInstructionIr,
  EmevdNodeAnchor
} from '@soulforge/shared';

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function localId(kind: 'event' | 'instruction', seed: unknown): string {
  return createHash('sha256').update(`${kind}:${stableJson(seed)}`).digest('hex').slice(0, 12);
}

export function computeEmevdInstructionFingerprint(instruction: EmevdInstructionIr): string {
  return sha256(stableJson({
    bank: instruction.bank,
    id: instruction.id,
    argsBase64: instruction.argsBase64,
    unknown: instruction.unknown
  }));
}

export function computeEmevdEventFingerprint(event: EmevdEventIr): string {
  return sha256(stableJson({
    eventId: event.eventId,
    restBehavior: event.restBehavior,
    layer: event.layer,
    instructions: event.instructions.map((instruction) => ({
      anchor: instruction.anchor?.localNodeId ?? null,
      bank: instruction.bank,
      id: instruction.id,
      argsBase64: instruction.argsBase64,
      unknown: instruction.unknown
    }))
  }));
}

export function formatEmevdAnchor(kind: 'event' | 'instruction', anchor: EmevdNodeAnchor): string {
  return `@${kind === 'event' ? 'e' : 'i'}:${anchor.localNodeId}`;
}

export function attachEmevdStableIdentity(
  document: EmevdEditorDocument,
  options?: { documentInstanceId?: string }
): EmevdEditorDocument {
  const documentInstanceId = document.documentInstanceId ?? options?.documentInstanceId ?? randomUUID();
  const events = document.events.map((event, eventIndex) => {
    const eventSourceFingerprint = event.anchor?.sourceFingerprint ?? sha256(stableJson({
      eventId: event.eventId,
      restBehavior: event.restBehavior,
      layer: event.layer,
      instructions: event.instructions.map((instruction) => ({
        bank: instruction.bank,
        id: instruction.id,
        argsBase64: instruction.argsBase64,
        unknown: instruction.unknown
      }))
    }));
    const eventAnchor: EmevdNodeAnchor = event.anchor ?? {
      documentInstanceId,
      localNodeId: localId('event', {
        resourceUri: document.resourceUri,
        eventIndex,
        sourceFingerprint: eventSourceFingerprint
      }),
      sourceFingerprint: eventSourceFingerprint
    };
    const instructions = event.instructions.map((instruction, instructionIndex) => {
      const sourceFingerprint = instruction.anchor?.sourceFingerprint
        ?? computeEmevdInstructionFingerprint(instruction);
      const anchor: EmevdNodeAnchor = instruction.anchor ?? {
        documentInstanceId,
        localNodeId: localId('instruction', {
          eventLocalNodeId: eventAnchor.localNodeId,
          instructionIndex,
          sourceFingerprint
        }),
        sourceFingerprint
      };
      return { ...instruction, anchor };
    });
    return { ...event, anchor: eventAnchor, instructions };
  });
  return { ...document, documentInstanceId, events };
}
