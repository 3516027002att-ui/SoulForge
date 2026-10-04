import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaeExport } from '@soulforge/shared';
import { searchTaeActionPage } from './taeActionSearch.js';

type SearchItem = ReturnType<typeof searchTaeActionPage>['matches'][number]['item'] & {
  indexedEventsComplete?: boolean; eventsTruncated?: boolean;
};

function source(count: number, eventCount: number | undefined = count, text = 'needle'): TaeExport {
  return { chrId: 'c0000', sourceUri: 'file://chr/c0000.anibnd.dcx', animations: [{
    animId: 10, code: 'A0010', taeEntryIndex: 2, eventCount,
    eventsComplete: eventCount === count,
    events: Array.from({ length: count }, (_, index) => ({
      uri: `action://c0000/entry/2/A0010/e${index}`, index, eventTypeId: 0,
      typeName: text, startTime: 0, endTime: 1, startFrame: 0, endFrame: 30, fields: []
    }))
  }] };
}

test('TAE search separates complete cached events from the delivered preview', () => {
  const input = source(296), before = structuredClone(input);
  const item: SearchItem = searchTaeActionPage(() => [input], () => 1, { limit: 2, eventLimit: 1 }).matches[0]!.item;
  assert.equal(item.events.length, 1);
  assert.equal(item.eventsComplete, false);
  assert.equal(item.indexedEventsComplete, true);
  assert.equal(item.eventsTruncated, true);
  assert.deepEqual(input, before, 'projection must not change index coverage or source symbols');
});

test('TAE oversized events keep the byte bound without claiming an empty preview is complete', () => {
  const input = source(1, 1, 'x'.repeat(21_000));
  const item: SearchItem = searchTaeActionPage(() => [input], () => 1, { limit: 1 }).matches[0]!.item;
  assert.equal(item.events.length, 0);
  assert.equal(item.eventPageSize, 1, 'native continuation still makes progress');
  assert.equal(item.eventsComplete, false);
  assert.equal(item.indexedEventsComplete, true);
  assert.equal(item.eventsTruncated, true);
});

test('TAE complete delivered events are not marked truncated', () => {
  const input = source(2);
  const item: SearchItem = searchTaeActionPage(() => [input], () => 1).matches[0]!.item;
  assert.equal(item.events.length, 2);
  assert.equal(item.indexedEventsComplete, true);
  assert.equal(item.eventsComplete, true);
  assert.equal(item.eventsTruncated, false);
});

test('TAE missing or incomplete index coverage stays partial even when all cached events are delivered', () => {
  for (const input of [source(1, 296), source(1), source(2)]) {
    if (input.animations[0]!.eventCount === 1) delete input.animations[0]!.eventCount;
    if (input.animations[0]!.events.length === 2) input.animations[0]!.events[1]!.index = 3;
    const item: SearchItem = searchTaeActionPage(() => [input], () => 1).matches[0]!.item;
    assert.equal(item.events.length, input.animations[0]!.events.length);
    assert.equal(item.indexedEventsComplete, false);
    assert.equal(item.eventsComplete, false);
    assert.equal(item.eventsTruncated, true);
  }
});
