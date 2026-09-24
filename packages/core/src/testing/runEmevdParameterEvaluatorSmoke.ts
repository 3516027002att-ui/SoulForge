import { strict as assert } from 'node:assert';
import { evaluateEmevdParameters } from '../references/emevdParameterEvaluator.js';
import type { EventExport } from '@soulforge/shared';
import type { EmedfRegistry } from '../emevd/emedfSchema.js';

function i32(value: number): string {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32LE(value, 0);
  return bytes.toString('base64');
}

function callBytes(eventId: number, argument: number): string {
  const bytes = Buffer.alloc(8);
  bytes.writeInt32LE(eventId, 0);
  bytes.writeInt32LE(argument, 4);
  return bytes.toString('base64');
}

const registry: EmedfRegistry = {
  schemaVersion: 1,
  game: 'sekiro',
  origin: 'fixture',
  instructions: [
    { bank: 2000, id: 6, name: 'InitializeCommonEvent', args: [
      { name: 'eventId', type: 's32' },
      { name: 'arg', type: 's32', vararg: true }
    ] },
    { bank: 2003, id: 9, name: 'AwardItemLot', args: [{ name: 'itemLotId', type: 's32' }] }
  ]
};

const commonUri = 'file:///event/common.emevd.dcx#event/900';
const callerAUri = 'file:///event/m10.emevd.dcx#event/100';
const callerBUri = 'file:///event/m11.emevd.dcx#event/100';
const common: EventExport = {
  sourceHash: 'common-v1',
  events: [{
    uri: commonUri, sourceUri: 'file:///event/common.emevd.dcx', eventId: 900, sourceHash: 'common-v1',
    instructions: [{
      uri: `${commonUri}#instruction/0`, index: 0, bank: 2003, id: 9, name: 'AwardItemLot',
      args: [{ name: 'itemLotId', value: 'X0_4', argIndex: 0 }],
      raw: { bank: 2003, id: 9, argsBase64: i32(0) }
    }],
    raw: { parameters: [{ instructionIndex: 0, targetStartByte: 0, sourceStartByte: 0, byteCount: 4 }] }
  }]
};

function caller(uri: string, sourceUri: string, lot: number): EventExport {
  return { sourceHash: sourceUri, events: [{
    uri, sourceUri, eventId: 100, sourceHash: sourceUri,
    instructions: [{
      uri: `${uri}#instruction/0`, index: 0, bank: 2000, id: 6, name: 'InitializeCommonEvent',
      args: [{ name: 'eventId', value: 900, argIndex: 0 }, { name: 'arg', value: lot, argIndex: 1 }],
      raw: { bank: 2000, id: 6, argsBase64: callBytes(900, lot) }
    }]
  }] };
}

const exports = [common, caller(callerAUri, 'file:///event/m10.emevd.dcx', 111), caller(callerBUri, 'file:///event/m11.emevd.dcx', 222)];
const a = evaluateEmevdParameters({ eventExports: exports, rootUri: callerAUri, registry });
assert.equal(a.status, 'resolved');
assert.equal(a.traces[0]?.callee, commonUri);
assert.equal(a.traces[0]?.decodedArguments[0]?.value, 111);
const b = evaluateEmevdParameters({ eventExports: exports, rootUri: callerBUri, registry });
assert.equal(b.status, 'resolved');
assert.equal(b.traces[0]?.decodedArguments[0]?.value, 222);

const stale = evaluateEmevdParameters({
  eventExports: exports, rootUri: callerAUri, registry,
  expectedSourceHashes: { 'file:///event/m10.emevd.dcx': 'changed' }
});
assert.equal(stale.status, 'stale');

const cycle = evaluateEmevdParameters({ eventExports: [{
  sourceHash: 'common-v1', events: [{
    ...common.events[0]!,
    instructions: [{
      uri: `${commonUri}#instruction/0`, index: 0, bank: 2000, id: 6, name: 'InitializeCommonEvent',
      args: [{ name: 'eventId', value: 900, argIndex: 0 }], raw: { bank: 2000, id: 6, argsBase64: callBytes(900, 0) }
    }],
    raw: { parameters: [] }
  }]
}], rootUri: commonUri, registry });
assert.equal(cycle.cycles.length, 1);

console.log(JSON.stringify({ ok: true, checks: 6, message: 'bounded EMEVD parameter evaluator smoke passed' }));
