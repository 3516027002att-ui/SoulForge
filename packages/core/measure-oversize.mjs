// 临时测量脚本：确认 oversize fixture 能被 C# 解析且报 oversize，跑完即删。
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSyntheticEmevd } from './dist/testing/syntheticEmevdBytes.js';
import { disposeBridgeDaemonPool, runBridge } from './dist/bridge/runBridge.js';

const EVENTS = 1000;
const PER_EVENT = 900;
const specs = [];
for (let e = 0; e < EVENTS; e += 1) {
  const instructions = [];
  for (let i = 0; i < PER_EVENT; i += 1) {
    instructions.push({ bank: 9999, id: 1, args: Buffer.alloc(0) });
  }
  specs.push({ id: 1000 + e, restBehavior: 0, instructions });
}
const bytes = buildSyntheticEmevd(specs);

const dir = await mkdtemp(join(tmpdir(), 'sf-oversize-'));
const file = join(dir, 'common.emevd');
await writeFile(file, bytes);

const read = async (label) => {
  const t0 = Date.now();
  const result = await runBridge({
    command: 'read-emevd-document',
    filePath: file,
    allowedRoots: [dir],
    timeoutMs: 600_000,
    commandOptions: { instructionPage: 0, instructionPageSize: 1 }
  });
  const ms = Date.now() - t0;
  const cache = result.diagnostics.find((d) => d.code === 'EMEVD_DOCUMENT_CACHE_STATE');
  console.log(label, JSON.stringify({
    ms,
    parseStatus: result.parseStatus,
    instructionTotal: result.data?.instructionTotal,
    cache: cache?.detail ?? null,
    diagnostics: result.diagnostics.map((d) => d.code)
  }));
};

try {
  await read('read1');
  await read('read2');
} finally {
  await disposeBridgeDaemonPool();
}
