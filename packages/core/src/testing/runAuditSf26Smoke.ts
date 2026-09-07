import { strict as assert } from 'node:assert';
import { runSceneRoundTripSmoke } from './runAuditSceneRoundTripSmoke.js';
import { runBlenderJobSmoke } from './runAuditBlenderJobSmoke.js';

// The dedicated Blender smoke is the production process-control test.  This
// wrapper retains the task's thin entrypoint and adds the shared scene identity
// boundary check without opening a second write path.
const index = process.argv.indexOf('--layer');
const layer = index >= 0 ? process.argv[index + 1] : undefined;
if (layer !== 'unit' && layer !== 'native') throw new Error('SF-26 requires --layer unit|native');
const scene = runSceneRoundTripSmoke();
assert.equal(scene.residual, 0);
await runBlenderJobSmoke();
console.log(JSON.stringify({ ok: true, taskId: 'SF-26', layer, sceneSessionId: scene.sessionId, production: ['BlenderJobService', 'SceneEditService'], note: layer === 'native' ? 'native FLVER/game-load proof remains profile-gated' : undefined }));
