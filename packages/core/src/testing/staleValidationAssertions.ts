/** Independent test contracts for Issue24. Expectations are reviewed constants. */
import assert from 'node:assert/strict';

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'expected object record');
  return value as Record<string, unknown>;
}

export function assertSekiroBytecodeSnapshot(value: unknown): void {
  const script = record(value);
  assert.equal(script.representation, 'bytecode');
  assert.equal(script.loaderProfileId, 'sekiro-ai-luabnd', 'the registered Sekiro AI profile must remain explicit');
  assert.equal(script.canWriteBack, true, 'Sekiro HKS source editing is enabled; compiler/staging gates still apply');
}

export function requireIndexedSearchResult(value: unknown, sourceUri: string): Record<string, unknown> {
  const envelope = record(value);
  assert.equal(envelope.ok, true, 'search_resources must succeed');
  const matches = record(record(envelope.data).record).matches;
  assert.ok(Array.isArray(matches), 'search_resources must expose data.record.matches');
  const selected = matches.map(match => record(record(match).item)).filter(item => item.sourceUri === sourceUri);
  assert.equal(selected.length, 1, 'search must return exactly one expected indexed identity');
  const item = selected[0]!;
  assert.equal(item.resourceKind, 'chr');
  return item;
}

export function requireRollbackOpId(value: unknown): string {
  const opId = record(record(record(value).data).record).opId;
  assert.ok(typeof opId === 'string' && opId.trim().length > 0, 'committed rollback requires a nonempty operation id');
  return opId;
}

export function classifyGlbDocument(value: unknown): 'empty' | 'candidate' {
  const envelope = record(value);
  assert.ok(envelope.parseStatus === 'parsed' || envelope.parseStatus === 'partial', 'only a successful native read can classify a sample');
  const meshCount = record(envelope.data).meshCount;
  assert.ok(typeof meshCount === 'number' && Number.isSafeInteger(meshCount) && meshCount >= 0, 'invalid native mesh count');
  return meshCount === 0 ? 'empty' : 'candidate';
}

export function classifyGlbMesh(value: unknown, meshIndex: number): 'empty' | 'drawable' {
  const envelope = record(value);
  assert.ok(envelope.parseStatus === 'parsed' || envelope.parseStatus === 'partial', 'only a successful native mesh read can classify topology');
  const mesh = record(envelope.data);
  assert.equal(mesh.meshIndex, meshIndex, 'native mesh identity mismatch');
  for (const key of ['vertexCount', 'indexCount']) {
    assert.ok(typeof mesh[key] === 'number' && Number.isSafeInteger(mesh[key]) && mesh[key] >= 0, `invalid native ${key}`);
  }
  if (mesh.geometryEmpty === true) {
    assert.ok(Array.isArray(envelope.diagnostics) && envelope.diagnostics.some(d => record(d).code === 'FLVER_MESH_EMPTY_TOPOLOGY'),
      'empty geometry requires the native topology diagnostic');
    return 'empty';
  }
  assert.ok((mesh.vertexCount as number) > 0 && (mesh.indexCount as number) > 0 && typeof mesh.positionsBase64 === 'string' && mesh.positionsBase64.length > 0,
    'drawable mesh must carry nonempty native geometry');
  return 'drawable';
}
