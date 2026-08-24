import assert from 'node:assert/strict';
import {
  DocumentSemanticSnapshot,
  SimpleCancellationTokenSource
} from '../emevd/language-service/documentSemanticSnapshot.js';
import type { EmedfCompletionItem } from '../emevd/emedfCompletionCatalog.js';

const SAMPLE_CATALOG: EmedfCompletionItem[] = [
  {
    name: 'ShootBullet',
    bank: 2003,
    id: 1,
    args: [
      { name: 'ownerEntityId', type: 's32' },
      { name: 'sourceEntityId', type: 's32' },
      { name: 'dummyPolyId', type: 's32' },
      { name: 'bulletId', type: 's32' }
    ]
  },
  {
    name: 'CharacterDead',
    bank: 1003,
    id: 0,
    args: [{ name: 'characterId', type: 's32' }]
  },
  {
    name: 'InitializeEvent',
    bank: 2000,
    id: 0,
    args: [
      { name: 'slotNumber', type: 's32' },
      { name: 'eventId', type: 's32' }
    ]
  }
];

export async function runDarkScriptLanguageServiceScaleSmoke(): Promise<void> {
  console.log('[Smoke] Generating 50,000+ line synthetic DarkScript3 document...');

  const totalEvents = 5000;
  const lines: string[] = [];

  for (let i = 0; i < totalEvents; i++) {
    const eventId = 100000 + i;
    lines.push(`$Event(${eventId}, Default, function(X0_4) {`);
    lines.push(`    ShootBullet(10000, ${eventId}, 100, 200);`);
    lines.push(`    CharacterDead(X0_4);`);
    lines.push(`    InitializeEvent(0, ${eventId + 1});`);
    lines.push(`    ShootBullet(10001, ${eventId}, 101, 201);`);
    lines.push(`    CharacterDead(X0_4);`);
    lines.push(`    ShootBullet(10002, ${eventId}, 102, 202);`);
    lines.push(`    InitializeEvent(1, ${eventId + 2});`);
    lines.push(`    CharacterDead(X0_4);`);
    lines.push(`    ShootBullet(10003, ${eventId}, 103, 203);`);
    lines.push(`});`);
    lines.push('');
  }

  const documentText = lines.join('\n');
  const actualLineCount = lines.length;
  assert.ok(actualLineCount >= 50000, `Document must have >= 50,000 lines, got ${actualLineCount}`);
  console.log(`[Smoke] Generated document with ${actualLineCount} lines (${(documentText.length / 1024 / 1024).toFixed(2)} MB)`);

  // 1. Snapshot creation performance
  const t0 = performance.now();
  const snapshot = new DocumentSemanticSnapshot(documentText, 1);
  const t1 = performance.now();
  const snapshotTimeMs = t1 - t0;
  console.log(`[Smoke] DocumentSemanticSnapshot creation time: ${snapshotTimeMs.toFixed(2)} ms`);
  assert.ok(snapshotTimeMs < 500, `Snapshot creation must be < 500ms, took ${snapshotTimeMs}ms`);
  assert.equal(snapshot.lineCount, actualLineCount);

  // 2. Line offset and line number conversion tests
  assert.equal(snapshot.getLineOffset(1), 0);
  assert.equal(snapshot.getLineNumber(0), 1);

  const midLine = 25000;
  const midOffset = snapshot.getLineOffset(midLine);
  assert.ok(midOffset > 0 && midOffset < documentText.length);
  assert.equal(snapshot.getLineNumber(midOffset), midLine);

  // 3. Event ranges and indexing
  const eventRanges = snapshot.eventRanges;
  assert.equal(eventRanges.length, totalEvents, `All ${totalEvents} events must be indexed`);

  // 4. Fast event lookup by offset (binary search)
  const lookupT0 = performance.now();
  const eventAtMid = snapshot.getEventAt(midOffset);
  const lookupT1 = performance.now();
  assert.ok(eventAtMid !== null, 'Event at midpoint must be found');
  console.log(`[Smoke] Binary-search getEventAt lookup time: ${(lookupT1 - lookupT0).toFixed(4)} ms (found event ${eventAtMid?.eventId})`);

  // 5. Windowed event retrieval
  const windowEvents = snapshot.getEventsInWindow(25000, 25050);
  assert.ok(windowEvents.length > 0 && windowEvents.length <= 10, `Window of 50 lines should contain ~5-6 events, got ${windowEvents.length}`);

  // 6. Viewport windowed diagnostics (avoiding full-document rescan)
  const diagT0 = performance.now();
  const windowDiags = snapshot.computeWindowDiagnostics(
    { startLine: 25000, endLine: 25050 },
    SAMPLE_CATALOG
  );
  const diagT1 = performance.now();
  const windowDiagTimeMs = diagT1 - diagT0;
  console.log(`[Smoke] Windowed diagnostics computation time: ${windowDiagTimeMs.toFixed(2)} ms`);
  assert.ok(windowDiagTimeMs < 50, `Windowed diagnostics must be fast (< 50ms), took ${windowDiagTimeMs}ms`);

  // 7. Cooperative cancellation test
  const cts = new SimpleCancellationTokenSource();
  cts.cancel();
  const cancelledDiags = snapshot.computeWindowDiagnostics(
    { startLine: 1, endLine: 50000 },
    SAMPLE_CATALOG,
    undefined,
    cts.token
  );
  assert.equal(cancelledDiags.length, 0, 'Cancelled computation must return early immediately with 0 results');

  console.log('[Smoke] DarkScript Language Service 50k+ Scale & Semantic Snapshot Smoke PASSED.');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('runDarkScriptLanguageServiceScaleSmoke.js')) {
  runDarkScriptLanguageServiceScaleSmoke().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
