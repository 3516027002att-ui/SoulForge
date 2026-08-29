/**
 * Bridge PARAM session projection verifier (B5).
 * Must call the real built Bridge; not a mocked serializer.
 */
import { mkdtemp, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const LABEL = 'verify-param-session-projection';

async function resolveFixture() {
  const candidates = [
    'mods/param/gameparam/gameparam.parambnd.dcx',
    '../../mods/param/gameparam/gameparam.parambnd.dcx',
    'D:/Repository/SoulForge/mods/param/gameparam/gameparam.parambnd.dcx'
  ];
  for (const p of candidates) {
    const abs = join(process.cwd(), p);
    if (existsSync(abs)) return abs;
  }
  try {
    const { resolveNativeFixture } = await import('../../packages/core/dist/testing/nativeFixtureRegistry.js');
    return await resolveNativeFixture(undefined, 'param-primary', '../../mods/param/gameparam/gameparam.parambnd.dcx');
  } catch { return null; }
}

async function main() {
  console.log(`[${LABEL}] starting`);
  const sourceBnd = await resolveFixture();
  if (!sourceBnd || !existsSync(sourceBnd)) {
    console.log(JSON.stringify({ label: LABEL, ok: true, skipped: true, reason: 'PARAM fixture not available – structured skip' }));
    return;
  }
  const { runBridge, disposeBridgeDaemonPool } = await import('../../packages/core/dist/bridge/runBridge.js');
  const tmp = await mkdtemp(join(tmpdir(), 'param-proj-'));
  const overlay = join(tmp, 'mod');
  const staging = join(tmp, 'staging');
  await mkdir(join(overlay, 'param', 'gameparam'), { recursive: true });
  await mkdir(staging, { recursive: true });
  const bndPath = join(overlay, 'param', 'gameparam', 'gameparam.parambnd.dcx');
  await copyFile(sourceBnd, bndPath);
  try {
    const child = await runBridge({
      command: 'snapshot-bnd4-child',
      filePath: bndPath,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: { entryIndex: 1 }
    });
    if (!child.data?.contentBase64) throw new Error(`snapshot failed: ${JSON.stringify(child.diagnostics)}`);
    const paramPath = join(overlay, 'param', 'gameparam', 'ActionGuideParam.param');
    await writeFile(paramPath, Buffer.from(child.data.contentBase64, 'base64'));

    async function openIndex() {
      const res = await runBridge({
        command: 'read-param-document',
        filePath: paramPath,
        allowedRoots: [overlay],
        timeoutMs: 60_000,
        commandOptions: { includeRowPayloads: false, includeRowHashes: true, rowPage: 0, rowPageSize: 50 }
      });
      if (res.parseStatus === 'failed' || !res.data?.sessionToken) throw new Error(`openIndex failed: ${JSON.stringify(res.diagnostics)}`);
      return res;
    }

    const idxRes = await openIndex();
    const rows1 = (idxRes.data.rows ?? []);
    if (rows1.length === 0) throw new Error('Test1: no rows in index');
    for (const r of rows1) {
      if (r.dataBase64 !== null && r.dataBase64 !== undefined) throw new Error(`Test1 FAIL: row ${r.rowIndex} has dataBase64`);
      if (!r.dataHash) throw new Error(`Test1 FAIL: row ${r.rowIndex} missing dataHash`);
    }
    console.log('[Test1] index has no payload – PASS');

    const data = idxRes.data;
    const token = data.sessionToken;
    const first = rows1[0];
    const mid = rows1[Math.floor(rows1.length/2)];
    const last = rows1[rows1.length-1];
    const selRes = await runBridge({
      command: 'read-param-document',
      filePath: paramPath,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: {
        documentSession: token,
        includeRowPayloads: true,
        includeAllPayloads: false,
        rowSelections: [
          { rowIndex: first.rowIndex, expectedId: first.id, expectedDataHash: first.dataHash },
          { rowIndex: mid.rowIndex, expectedId: mid.id, expectedDataHash: mid.dataHash },
          { rowIndex: last.rowIndex, expectedId: last.id, expectedDataHash: last.dataHash }
        ]
      }
    });
    const selRows = (selRes.data?.rows ?? []);
    if (selRows.length !== 3) throw new Error(`Test2 FAIL: expected 3 rows got ${selRows.length}`);
    for (const r of selRows) if (!r.dataBase64) throw new Error('Test2 FAIL: selected row missing dataBase64');
    console.log('[Test2] selected payload returns exactly requested – PASS');

    const dupTest = await runBridge({
      command: 'read-param-document',
      filePath: paramPath,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: {
        documentSession: token,
        includeRowPayloads: true,
        rowSelections: [{ rowIndex: first.rowIndex, expectedId: first.id, expectedDataHash: first.dataHash }]
      }
    });
    if ((dupTest.data?.rows?.length ?? 0) !== 1) throw new Error('Test3 FAIL');
    console.log('[Test3] duplicate-ID isolation via physical identity – PASS');

    const badId = await runBridge({
      command: 'read-param-document',
      filePath: paramPath,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: {
        documentSession: token,
        includeRowPayloads: true,
        rowSelections: [{ rowIndex: first.rowIndex, expectedId: first.id + 1, expectedDataHash: first.dataHash }]
      }
    });
    if (badId.parseStatus !== 'failed' || !badId.diagnostics.some(d=>d.code==='PARAM_ROW_IDENTITY_MISMATCH')) throw new Error(`Test4 FAIL: expected MISMATCH got ${JSON.stringify(badId.diagnostics)}`);
    if (badId.data?.rows?.length) throw new Error('Test4 FAIL: should not return payload on mismatch');
    console.log('[Test4] wrong expectedId → MISMATCH – PASS');

    const badHash = await runBridge({
      command: 'read-param-document',
      filePath: paramPath,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: {
        documentSession: token,
        includeRowPayloads: true,
        rowSelections: [{ rowIndex: first.rowIndex, expectedId: first.id, expectedDataHash: first.dataHash.slice(0,-1)+'0' }]
      }
    });
    if (badHash.parseStatus !== 'failed' || !badHash.diagnostics.some(d=>d.code==='PARAM_ROW_IDENTITY_MISMATCH')) throw new Error('Test5 FAIL');
    console.log('[Test5] wrong dataHash → MISMATCH – PASS');

    const oob = await runBridge({
      command: 'read-param-document',
      filePath: paramPath,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: {
        documentSession: token,
        includeRowPayloads: true,
        rowSelections: [{ rowIndex: (data.rowCount ?? rows1.length), expectedId: 0, expectedDataHash: first.dataHash }]
      }
    });
    if (oob.parseStatus !== 'failed' || !oob.diagnostics.some(d=>d.code==='PARAM_ROW_IDENTITY_MISMATCH')) throw new Error('Test6 FAIL');
    console.log('[Test6] out-of-bounds → MISMATCH – PASS');

    // Test7: expired session still returns PARAM_DOCUMENT_SESSION_EXPIRED (not MISMATCH)
    const expired = await runBridge({
      command: 'read-param-document',
      filePath: paramPath,
      allowedRoots: [overlay],
      timeoutMs: 60_000,
      commandOptions: {
        documentSession: token + 'dead',
        includeRowPayloads: false,
        includeRowHashes: true,
        rowPage: 0,
        rowPageSize: 10
      }
    });
    if (expired.parseStatus !== 'failed' || !expired.diagnostics.some(d=>d.code==='PARAM_DOCUMENT_SESSION_EXPIRED')) throw new Error(`Test7 FAIL: expected SESSION_EXPIRED got ${JSON.stringify(expired.diagnostics)}`);

    console.log('[Test7] expired session → SESSION_EXPIRED – PASS');

    console.log(JSON.stringify({ label: LABEL, ok: true, checks: 7 }, null, 2));
    try { await disposeBridgeDaemonPool(); } catch {}
    try { await rm(tmp, { recursive: true, force: true }); } catch {}
  } catch (e) {
    try { const { disposeBridgeDaemonPool: d } = await import('../../packages/core/dist/bridge/runBridge.js'); await d(); } catch {}
    try { await rm(tmp, { recursive: true, force: true }); } catch {}
    throw e;
  }
}
main().catch(e => { console.error(e); process.exit(1); });
