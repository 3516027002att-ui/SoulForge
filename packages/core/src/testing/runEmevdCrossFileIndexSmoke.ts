import assert from 'node:assert/strict';
import type { EventExport, EventSymbol } from '@soulforge/shared';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';

const SOURCE_A = 'file://synthetic/m10_00_00_00.emevd';
const SOURCE_B = 'file://synthetic/m11_00_00_00.emevd';
const STABLE_SOURCE = 'file://synthetic/stable.emevd';

function makeEvent(input: {
  sourceUri: string;
  mapId: string;
  eventId: number;
  sourceHash: string;
  sourceRevision: number;
  instructions: EventSymbol['instructions'];
  raw?: unknown;
}): EventSymbol {
  return {
    uri: `${input.sourceUri}#event/${input.eventId}`,
    sourceUri: input.sourceUri,
    mapId: input.mapId,
    eventId: input.eventId,
    sourceHash: input.sourceHash,
    sourceRevision: input.sourceRevision,
    instructions: input.instructions,
    ...(input.raw === undefined ? {} : { raw: input.raw })
  };
}

function makeExport(input: {
  sourceUri: string;
  mapId: string;
  sourceHash: string;
  sourceRevision: number;
  events: EventSymbol[];
}): EventExport {
  return {
    mapId: input.mapId,
    sourceHash: input.sourceHash,
    sourceRevision: input.sourceRevision,
    events: input.events
  };
}

export function runEmevdCrossFileIndexSmoke(): void {
  const index = new WorkspaceIndex('emevd-cross-file-index-smoke');

  index.upsertEventExport(makeExport({
    sourceUri: SOURCE_A,
    mapId: 'm10_00_00_00',
    sourceHash: 'hash-a',
    sourceRevision: 1,
    events: [makeEvent({
      sourceUri: SOURCE_A,
      mapId: 'm10_00_00_00',
      eventId: 100,
      sourceHash: 'hash-a',
      sourceRevision: 1,
      instructions: [{
        uri: `${SOURCE_A}#event/100/instruction/0`,
        index: 0,
        name: 'CreateCharacter',
        args: [{ name: 'targetEntityId', role: 'entityId', value: 51000000, confidence: 'high' }]
      }]
    })]
  }));
  index.upsertEventExport(makeExport({
    sourceUri: SOURCE_B,
    mapId: 'm11_00_00_00',
    sourceHash: 'hash-b',
    sourceRevision: 2,
    events: [makeEvent({
      sourceUri: SOURCE_B,
      mapId: 'm11_00_00_00',
      eventId: 200,
      sourceHash: 'hash-b',
      sourceRevision: 2,
      instructions: [{
        uri: `${SOURCE_B}#event/200/instruction/0`,
        index: 0,
        name: 'CreateCharacter',
        args: [{ name: 'targetEntityId', role: 'entityId', value: 51100000, confidence: 'high' }]
      }]
    })]
  }));

  const instructionNameMatches = index.searchEvents('CreateCharacter', 10);
  assert.equal(instructionNameMatches.length, 2, 'instruction-name search must include both EMEVD files');
  assert.deepEqual(
    new Set(instructionNameMatches.map((match) => match.item.sourceUri)),
    new Set([SOURCE_A, SOURCE_B])
  );

  const entityIdMatches = index.searchEvents('51100000', 10);
  assert.equal(entityIdMatches.length, 1, 'entity ID search must find the matching event');
  assert.equal(entityIdMatches[0]?.item.sourceUri, SOURCE_B);
  assert.equal(entityIdMatches[0]?.item.eventId, 200);

  const stableRich = makeExport({
    sourceUri: STABLE_SOURCE,
    mapId: 'stable',
    sourceHash: 'stable-hash',
    sourceRevision: 3,
    events: [makeEvent({
      sourceUri: STABLE_SOURCE,
      mapId: 'stable',
      eventId: 300,
      sourceHash: 'stable-hash',
      sourceRevision: 3,
      instructions: [
        {
          uri: `${STABLE_SOURCE}#event/300/instruction/0`,
          index: 0,
          name: 'StableRichInstruction',
          args: []
        },
        {
          uri: `${STABLE_SOURCE}#event/300/instruction/1`,
          index: 1,
          name: 'StableSecondInstruction',
          args: []
        }
      ]
    })]
  });
  index.upsertEventExport(stableRich);

  // An empty export has no physical event identity and must not erase the rich body.
  index.upsertEventExport({
    mapId: 'stable',
    sourceHash: 'stable-hash',
    sourceRevision: 3,
    events: []
  });
  assert.equal(index.getEvent(`${STABLE_SOURCE}#event/300`)?.instructions.length, 2);

  // Same identity: an empty or partial outline must not erase the rich body.
  index.upsertEventExport(makeExport({
    sourceUri: STABLE_SOURCE,
    mapId: 'stable',
    sourceHash: 'stable-hash',
    sourceRevision: 3,
    events: [makeEvent({
      sourceUri: STABLE_SOURCE,
      mapId: 'stable',
      eventId: 300,
      sourceHash: 'stable-hash',
      sourceRevision: 3,
      instructions: [],
      raw: { authority: 'native-verified-outline', instructionCount: 2 }
    })]
  }));
  index.upsertEventExport(makeExport({
    sourceUri: STABLE_SOURCE,
    mapId: 'stable',
    sourceHash: 'stable-hash',
    sourceRevision: 3,
    events: [makeEvent({
      sourceUri: STABLE_SOURCE,
      mapId: 'stable',
      eventId: 300,
      sourceHash: 'stable-hash',
      sourceRevision: 3,
      instructions: [{
        uri: `${STABLE_SOURCE}#event/300/instruction/0`,
        index: 0,
        name: 'OutlinePrefixOnly',
        args: []
      }],
      raw: { authority: 'native-verified-outline', instructionCount: 2 }
    })]
  }));
  assert.deepEqual(
    index.getEvent(`${STABLE_SOURCE}#event/300`)?.instructions.map((instruction) => instruction.name),
    ['StableRichInstruction', 'StableSecondInstruction']
  );

  // Changed identity: the old rich body must not be attached to the new hash.
  index.upsertEventExport(makeExport({
    sourceUri: STABLE_SOURCE,
    mapId: 'stable',
    sourceHash: 'stable-hash-v2',
    sourceRevision: 4,
    events: [makeEvent({
      sourceUri: STABLE_SOURCE,
      mapId: 'stable',
      eventId: 300,
      sourceHash: 'stable-hash-v2',
      sourceRevision: 4,
      instructions: [],
      raw: { authority: 'native-verified-outline', instructionCount: 2 }
    })]
  }));
  const changed = index.getEvent(`${STABLE_SOURCE}#event/300`);
  assert.equal(changed?.sourceHash, 'stable-hash-v2');
  assert.equal(changed?.sourceRevision, 4);
  assert.equal(changed?.instructions.length, 0);
  assert.equal(index.searchEvents('StableRichInstruction', 10).length, 0);

  console.log(JSON.stringify({
    ok: true,
    events: index.getStats().events,
    instructionNameSources: instructionNameMatches.map((match) => match.item.sourceUri),
    entityIdSource: entityIdMatches[0]?.item.sourceUri,
    identityRegression: 'covered'
  }, null, 2));
}

try {
  runEmevdCrossFileIndexSmoke();
  console.log('runEmevdCrossFileIndexSmoke: PASS');
} catch (error) {
  console.error(`runEmevdCrossFileIndexSmoke: FAIL\n${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
}
