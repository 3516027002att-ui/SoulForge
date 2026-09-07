import { runAuditRagScopeSmoke } from './runAuditRagScopeSmoke.js';

function parseLayer(): string | undefined {
  const index = process.argv.indexOf('--layer');
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  const layer = parseLayer();
  if (layer !== 'unit' && layer !== 'native') {
    throw new Error('SF-18 smoke 需要显式 --layer unit|native。');
  }
  if (layer === 'native') {
    // SF-18 has no native-format dependency; its required suite is unit-only.
    console.log(JSON.stringify({ ok: true, taskId: 'SF-18', layer, status: 'skipped', reason: 'unit-only retrieval contract' }));
    return;
  }
  const summary = runAuditRagScopeSmoke();
  console.log(JSON.stringify({ ...summary, layer }));
}

main();
