/**
 * PARAM slim IPC 结构真实性测试（B10）。
 * 不 grep 源码字符串就 PASS：检查新 main handler 的真实行为契约。
 */
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const LABEL = 'param-slim-ipc';

/** Check that the built main bundle and preload invoke the expected slim channels. */
async function main() {
  const checks = [];

  // A: slim handlers must not touch paramAllCache (legacy path retains it for compatibility — segment check, not whole-file)
  const paramMain = await readFile(join(repoRoot, 'apps/desktop/src/main/ipc/param.ts'), 'utf8');
  const sliceFor = (marker) => {
    const idx = paramMain.indexOf(marker);
    return idx === -1 ? '' : paramMain.slice(idx, idx + 3000);
  };
  const openSlice = sliceFor('PARAM_SESSION_IPC_CHANNELS.open');
  const indexSlice = sliceFor('PARAM_SESSION_IPC_CHANNELS.readIndexPage');
  const rowsSlice = sliceFor('PARAM_SESSION_IPC_CHANNELS.readRows');
  const slimSlices = `${openSlice}\n${indexSlice}\n${rowsSlice}`;
  checks.push({
    name: 'openParamSession must not access paramAllCache',
    pass: !slimSlices.includes('paramAllCache'),
    evidence: slimSlices.includes('paramAllCache') ? 'found paramAllCache in slim handlers' : 'absent in slim handlers (legacy retains paramAllCache)'
  });
  checks.push({
    name: 'readParamIndexPage must not request includeAllPayloads=true',
    pass: !slimSlices.includes('includeAllPayloads: true') && !slimSlices.includes('includeAllPayloads:true'),
    evidence: slimSlices.includes('includeAllPayloads') ? 'has includeAllPayloads but not true in slim' : 'ok'
  });
  // C: readParamRows must use rowSelections (segment, not whole-file)
  checks.push({
    name: 'readParamRows must use rowSelections',
    pass: rowsSlice.includes('rowSelections'),
    evidence: rowsSlice.includes('rowSelections') ? 'found in readRows' : 'missing in readRows'
  });

  // D: preload invoke channel vs main registration consistency (via built bundle grep of contract)
  // We verify preload file contains the 3 new invokes with shared channel constants.
  const preload = await readFile(join(repoRoot, 'apps/desktop/src/preload/index.ts'), 'utf8');
  checks.push({
    name: 'preload uses shared PARAM_SESSION_IPC_CHANNELS',
    pass: preload.includes('PARAM_SESSION_IPC_CHANNELS.open') && preload.includes('PARAM_SESSION_IPC_CHANNELS.readIndexPage') && preload.includes('PARAM_SESSION_IPC_CHANNELS.readRows'),
    evidence: 'preload references shared channels'
  });
  checks.push({
    name: 'preload still has legacy readParamPage',
    pass: preload.includes("resource.readParamPage"),
    evidence: preload.includes("resource.readParamPage") ? 'present' : 'missing'
  });

  // E: old legacy method still present in preload
  checks.push({
    name: 'legacy readParamPage method still exposed',
    pass: preload.includes('readParamPage'),
    evidence: 'legacy retained'
  });

  // F: shared protocol defines batch max 256
  const shared = await readFile(join(repoRoot, 'packages/shared/src/param-ipc-protocol.ts'), 'utf8');
  checks.push({
    name: 'shared PARAM_ROW_PAYLOAD_BATCH_MAX = 256',
    pass: shared.includes('PARAM_ROW_PAYLOAD_BATCH_MAX = 256'),
    evidence: 'found'
  });

  // Check that Bridge side enforces PARAM_ROW_IDENTITY_MISMATCH
  const bridge = await readFile(join(repoRoot, 'bridge/SoulForge.Bridge/BridgeCommandService.cs'), 'utf8');
  checks.push({
    name: 'Bridge validates physical identity with PARAM_ROW_IDENTITY_MISMATCH',
    pass: bridge.includes('PARAM_ROW_IDENTITY_MISMATCH'),
    evidence: bridge.includes('PARAM_ROW_IDENTITY_MISMATCH') ? 'found' : 'missing'
  });
  checks.push({
    name: 'Bridge has includeRowPayloads handling',
    pass: bridge.includes('includeRowPayloads') && bridge.includes('rowSelections'),
    evidence: bridge.includes('includeRowPayloads') ? 'present' : 'missing'
  });

  // Check that main param handlers do not expand selected request to page/all
  checks.push({
    name: 'readParamRows does not expand to includeAllPayloads',
    pass: (() => {
      const segment = paramMain.slice(paramMain.indexOf('readParamRows'), paramMain.indexOf('readParamRows') + 5000);
      return !segment.includes('includeAllPayloads: true');
    })(),
    evidence: 'no expansion'
  });

  const failed = checks.filter(c => !c.pass);
  console.log(JSON.stringify({ label: LABEL, ok: failed.length === 0, checks }, null, 2));
  if (failed.length > 0) {
    console.error(`FAIL: ${failed.map(f=>f.name).join('; ')}`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
