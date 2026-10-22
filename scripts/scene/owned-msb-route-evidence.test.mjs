import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { assertOwnedMsbRouteAssembly, compareOwnedMsbRouteInternals } from './compare-owned-msb-routes.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('reflection rejects absent, duplicate and empty assembly bytes even with a valid producer receipt', () => {
  const assembly = Buffer.from('owned native assembly');
  const producer = Buffer.concat([Buffer.from('prefix'), assembly, Buffer.from('suffix')]);
  const receipt = { executable: { sha256: hash(producer) } };
  assert.equal(assertOwnedMsbRouteAssembly(receipt, producer, assembly).embeddedOffset, 6);
  assert.throws(() => assertOwnedMsbRouteAssembly(receipt, producer, Buffer.from('different assembly')), /NOT_UNIQUELY_EMBEDDED/);
  const duplicate = Buffer.concat([producer, assembly]);
  assert.throws(() => assertOwnedMsbRouteAssembly({ executable: { sha256: hash(duplicate) } }, duplicate, assembly), /NOT_UNIQUELY_EMBEDDED/);
  assert.throws(() => assertOwnedMsbRouteAssembly(receipt, producer, Buffer.alloc(0)), /ASSEMBLY_EMPTY/);
  assert.throws(() => assertOwnedMsbRouteAssembly({ executable: { sha256: '0'.repeat(64) } }, producer, assembly), /PRODUCER_RECEIPT_MISMATCH/);
});

test('retained native route fields localize a nonzero value error and reject a missing record', () => {
  const oracle = [{ entry: { Unk08: 7002, Unk0C: 7003 } }, { entry: { Unk08: 7163, Unk0C: 7033 } }];
  const observed = [{ unk08: 7002, unk0C: 7003 }, { unk08: 7163, unk0C: 7033 }];
  assert.equal(compareOwnedMsbRouteInternals(oracle, observed).status, 'passed');
  observed[1].unk0C = 7034;
  const wrongValue = compareOwnedMsbRouteInternals(oracle, observed);
  assert.equal(wrongValue.mismatchCount, 1);
  assert.deepEqual(wrongValue.firstMismatch, { path: 'routes[1].unk0C', expected: 7033, actual: 7034 });
  assert.equal(compareOwnedMsbRouteInternals(oracle, observed.slice(0, 1)).firstMismatch.path, 'routes.length');
});
