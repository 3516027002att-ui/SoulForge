/**
 * Bridge PARAM session projection verifier (B5).
 * Must call the real built Bridge; not a mocked serializer.
 */
import { mkdir, copyFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveNativeFixture } from '../../packages/core/dist/testing/nativeFixtureRegistry.js';
import { withSmokeWorkspace } from '../../packages/core/dist/testing/harness/smokeWorkspace.js';

const LABEL = 'verify-param-session-projection';

async function resolveFixture() {
  const explicitSource = process.argv[2]?.trim();
  const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
  const registry = process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim();
  const fixtureRoot = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim();
  if (!explicitSource && !gameRoot && !registry && !fixtureRoot) {
    return { status: 'unavailable', code: 'NATIVE_PARAM_INPUT_REQUIRED' };
  }
  if (!explicitSource && Boolean(registry) !== Boolean(fixtureRoot)) throw new Error('NATIVE_FIXTURE_CONFIG_INCOMPLETE');
  try {
    // param-primary is the gameparam binder role, not a standalone PARAM leaf.
    const sourceBnd = await realpath(await resolveNativeFixture(
      explicitSource ?? (!registry && gameRoot ? join(gameRoot, 'mods/param/gameparam/gameparam.parambnd.dcx') : undefined),
      'param-primary', '../../mods/param/gameparam/gameparam.parambnd.dcx'
    ));
    if (!(await stat(sourceBnd)).isFile()) throw new Error('NATIVE_PARAM_SOURCE_NOT_FILE');
    if (!/\.parambnd(?:\.dcx)?$/iu.test(sourceBnd)) throw new Error('PARAM_BINDER_INPUT_REQUIRED: provide a gameparam PARAM binder, not a PARAM leaf.');
    return { status: 'available', sourceBnd, oodleRoot: process.env.SOULFORGE_OODLE_RUNTIME_ROOT?.trim() || gameRoot };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error?.code ?? '')) {
      return { status: 'unavailable', code: 'NATIVE_PARAM_SOURCE_UNAVAILABLE' };
    }
    throw error;
  }
}

export async function verifyParamSessionProjection() {
  console.log(`[${LABEL}] starting`);
  const fixture = await resolveFixture();
  if (fixture.status === 'unavailable') {
    console.log(JSON.stringify({ label: LABEL, ok: false, status: 'skipped', executed: false,
      authority: 'unverified', code: fixture.code,
      scope: 'native PARAM binder child projection/session/CAS',
      message: 'Native checks were not executed. Configure an explicit gameparam.parambnd[.dcx] path, SOULFORGE_SEKIRO_GAME_ROOT, or SOULFORGE_NATIVE_FIXTURE_REGISTRY with SOULFORGE_NATIVE_FIXTURE_ROOT (param-primary binder role).' }));
    return;
  }
  const { runBridge, disposeBridgeDaemonPool } = await import('../../packages/core/dist/bridge/runBridge.js');
  try {
    await withSmokeWorkspace(LABEL, async (workspace) => {
      const overlay = join(workspace.root, 'mod');
      const staging = join(workspace.root, 'staging');
      await mkdir(join(overlay, 'param', 'gameparam'), { recursive: true });
      await mkdir(staging, { recursive: true });
      const bndPath = join(overlay, 'param', 'gameparam', 'gameparam.parambnd.dcx');
      await copyFile(fixture.sourceBnd, bndPath);
      const inventory = await runBridge({
        command: 'list-bnd4-entries', filePath: bndPath, allowedRoots: [overlay], timeoutMs: 60_000,
        ...(fixture.oodleRoot ? { oodleRuntimeRoot: fixture.oodleRoot } : {}),
        commandOptions: { includeContentHashes: true }
      });
      if (inventory.parseStatus === 'failed' || !inventory.data?.entries) throw new Error(`PARAM binder inventory failed: ${JSON.stringify(inventory.diagnostics)}`);
      const matches = inventory.data.entries.filter(entry => typeof entry.name === 'string'
        && entry.name.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() === 'actionguideparam.param');
      if (matches.length !== 1) throw new Error(`PARAM_CHILD_IDENTITY_NOT_UNIQUE: expected one ActionGuideParam.param, found ${matches.length}.`);
      const selected = matches[0];
      if (!Number.isSafeInteger(selected.index) || selected.index < 0 || !/^[a-f0-9]{64}$/iu.test(selected.contentHash ?? '')
        || !/^[a-f0-9]{64}$/iu.test(inventory.data.sourceHash ?? '')) throw new Error('PARAM_CHILD_IDENTITY_INVALID: native index and source/child hashes are required.');
      const paramPath = join(staging, 'ActionGuideParam.param');
      const child = await runBridge({
        command: 'extract-bnd4-child',
        filePath: bndPath,
        allowedRoots: [overlay],
        writableRoots: [staging],
        timeoutMs: 60_000,
        ...(fixture.oodleRoot ? { oodleRuntimeRoot: fixture.oodleRoot } : {}),
        commandOptions: { entryIndex: selected.index, outputPath: paramPath }
      });
      if (child.parseStatus === 'failed' || !child.data) throw new Error(`extract failed: ${JSON.stringify(child.diagnostics)}`);
      if (child.data.index !== selected.index || child.data.name !== selected.name || child.data.contentHash !== selected.contentHash
        || child.data.sourceHash !== inventory.data.sourceHash) throw new Error('PARAM_CHILD_IDENTITY_MISMATCH: extracted child differs from the native binder inventory.');

      async function openIndex() {
        const res = await runBridge({
          command: 'read-param-document',
          filePath: paramPath,
          allowedRoots: [staging],
          timeoutMs: 60_000,
          commandOptions: { includeRowPayloads: false, includeRowHashes: true, rowPage: 0, rowPageSize: 50 }
        });
        if (res.parseStatus === 'failed' || !res.data?.sessionToken) throw new Error(`openIndex failed: ${JSON.stringify(res.diagnostics)}`);
        return res;
      }

      const idxRes = await openIndex();
      const rows1 = (idxRes.data.rows ?? []);
      if (rows1.length < 3) throw new Error('Test1: the selected PARAM must contain at least three indexed rows');
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
        allowedRoots: [staging],
        timeoutMs: 60_000,
        commandOptions: {
          documentSession: token,
          includeRowPayloads: true,
          includeRowHashes: true,
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
      for (const expected of [first, mid, last]) {
        if (selRows.filter(row => row.rowIndex === expected.rowIndex && row.id === expected.id && row.dataHash === expected.dataHash).length !== 1) {
          throw new Error('Test2 FAIL: selected physical row identity/hash differs from the request');
        }
      }
      for (const r of selRows) if (!r.dataBase64) throw new Error('Test2 FAIL: selected row missing dataBase64');
      console.log('[Test2] selected payload returns exactly requested – PASS');

      const dupTest = await runBridge({
        command: 'read-param-document',
        filePath: paramPath,
        allowedRoots: [staging],
        timeoutMs: 60_000,
        commandOptions: {
          documentSession: token,
          includeRowPayloads: true,
          rowSelections: [{ rowIndex: first.rowIndex, expectedId: first.id, expectedDataHash: first.dataHash }]
        }
      });
      if ((dupTest.data?.rows?.length ?? 0) !== 1) throw new Error('Test3 FAIL');
      console.log('[Test3] one physical row selection returns one payload – PASS');

      const badId = await runBridge({
        command: 'read-param-document',
        filePath: paramPath,
        allowedRoots: [staging],
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
        allowedRoots: [staging],
        timeoutMs: 60_000,
        commandOptions: {
          documentSession: token,
          includeRowPayloads: true,
          rowSelections: [{ rowIndex: first.rowIndex, expectedId: first.id,
            expectedDataHash: first.dataHash.slice(0,-1) + (first.dataHash.endsWith('0') ? '1' : '0') }]
        }
      });
      if (badHash.parseStatus !== 'failed' || !badHash.diagnostics.some(d=>d.code==='PARAM_ROW_IDENTITY_MISMATCH')) throw new Error('Test5 FAIL');
      console.log('[Test5] wrong dataHash → MISMATCH – PASS');

      const oob = await runBridge({
        command: 'read-param-document',
        filePath: paramPath,
        allowedRoots: [staging],
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
        allowedRoots: [staging],
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

      console.log(JSON.stringify({ label: LABEL, ok: true, status: 'passed', executed: true, checks: 7,
        scope: 'native ActionGuideParam child projection/session/CAS on the explicit owned-copy binder',
        childIdentity: { index: selected.index, name: selected.name, contentHash: selected.contentHash } }, null, 2));
    });
  } finally {
    await disposeBridgeDaemonPool();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyParamSessionProjection().catch(e => { console.error(e); process.exit(1); });
}
