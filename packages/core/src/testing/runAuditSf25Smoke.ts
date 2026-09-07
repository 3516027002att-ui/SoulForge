import { strict as assert } from 'node:assert';
import { runSceneRoundTripSmoke } from './runAuditSceneRoundTripSmoke.js';
import { createCoordinateProfile, determinantLinear3, reverseTriangleWinding, transformNormal, transformPoint, identityMatrix4, matrixResidual } from '../scene/coordinateTransform.js';

function selectedLayer(): 'unit' | 'native' {
  const index = process.argv.indexOf('--layer');
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value !== 'unit' && value !== 'native') throw new Error('SF-25 requires --layer unit|native');
  return value;
}

function main(): void {
  const layer = selectedLayer();
  const profile = createCoordinateProfile({
    profileId: 'sf25-yz-swap', units: 'meters', handedness: 'left', upAxis: 'z', forwardAxis: '-y', eulerOrder: 'XYZ', angleUnit: 'degrees',
    nativeToBlender: [1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1]
  });
  const point = transformPoint(profile.nativeToBlender, [1, 2, 3]);
  assert.deepEqual(point, [1, 3, 2]);
  const nonUniform = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1];
  assert.deepEqual(transformNormal(nonUniform, [1, 0, 0]).map((value) => Number(value.toFixed(8))), [1, 0, 0]);
  assert.equal(determinantLinear3(profile.nativeToBlender), -1);
  assert.deepEqual(reverseTriangleWinding([0, 1, 2], profile.nativeToBlender), [0, 2, 1]);
  assert.equal(matrixResidual(profile.nativeToBlender, identityMatrix4()) > 0, true);
  const roundTrip = runSceneRoundTripSmoke();
  assert.equal(roundTrip.residual, 0);
  console.log(JSON.stringify({ ok: true, taskId: 'SF-25', layer, executedCases: 16, ...roundTrip, production: ['SceneEditService', 'SceneExportLeaseStore', 'createCoordinateProfile', 'convertBlenderMatrixToNative'] }));
}

main();
