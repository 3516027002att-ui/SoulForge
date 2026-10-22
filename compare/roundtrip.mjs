// FMG write round trip for compare/run.mjs (operation "write-roundtrip"). The Bridge writes into a fresh staging root
// under the OS temp directory; the pinned reference tool reads both the source and the output, and lib.mjs
// fmgRoundtripComparisons decides. The expectation never comes from the Bridge result. Dependencies are injected so the
// rule can be driven without run.mjs: runBridge (packages/core dist), readTables(file) -> { status, reason, tables,
// entries } read by the reference tool.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { fmgRoundtripComparisons, pickFmgEditTarget } from './lib.mjs';

export const L1_TEXT_SUFFIX = ' [soulforge-roundtrip-L1]';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (child, parent) => { const rel = relative(resolve(parent), resolve(child)); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };

async function writeFmg(runBridge, file, gameRoot, stagingRoot, outputPath, sourceSha256, target, text) {
  const result = await runBridge({ command: 'write-fmg', filePath: file, allowedRoots: [gameRoot], writableRoots: [stagingRoot],
    oodleRuntimeRoot: gameRoot, timeoutMs: 120_000,
    commandOptions: { outputPath, expectedDocumentHash: sourceSha256, entryIndex: target.ordinal, disallowAmbiguous: true,
      mutations: [{ kind: 'upsert', id: target.id, text }] } });
  const verified = (result.diagnostics ?? []).some(item => item.code === 'FMG_STAGING_WRITE_VERIFIED');
  if (!verified || !existsSync(outputPath)) return { error: result.diagnostics?.[0]?.code ?? 'BRIDGE_WRITE_FAILED' };
  return { ok: true };
}

// Returns { target, levels: [{ level, edit, write, outputSha256, byteIdentical, reference, comparisons }] }.
export async function fmgWriteRoundtrip({ file, gameRoot, runBridge, readTables }) {
  const sourceBefore = sha256(readFileSync(file));
  const stagingRoot = join(tmpdir(), `soulforge-roundtrip-${randomUUID()}`);
  // The staging root must not be inside the game root (which also holds mods/).
  if (inside(stagingRoot, gameRoot)) throw new Error('staging root resolves inside the game root');
  mkdirSync(stagingRoot, { recursive: false });
  try {
    const source = readTables(file);
    if (source.status !== 'ok') return { reference: source, levels: [] };
    const target = pickFmgEditTarget(source.tables.map(table => ({ ordinal: table.ordinal, entries: source.entries.get(table.ordinal) })));
    const levels = [];
    for (const [level, text, edit] of [
      ['L0', target.text, null],
      ['L1', target.text + L1_TEXT_SUFFIX, { ordinal: target.ordinal, id: target.id, text: target.text + L1_TEXT_SUFFIX }]]) {
      const outputPath = join(stagingRoot, level, file.split(/[\\/]/u).pop());
      if (!inside(outputPath, stagingRoot)) throw new Error('output path escapes the staging root');
      mkdirSync(join(stagingRoot, level));
      const write = await writeFmg(runBridge, file, gameRoot, stagingRoot, outputPath, sourceBefore, target, text);
      if (write.error) { levels.push({ level, edit, write }); continue; }
      const outputBytes = readFileSync(outputPath);
      const output = readTables(outputPath);
      levels.push({ level, edit, write, outputSha256: sha256(outputBytes), byteIdentical: sha256(outputBytes) === sourceBefore,
        reference: { status: output.status, reason: output.reason },
        comparisons: output.status === 'ok' ? fmgRoundtripComparisons(source, output, edit) : null });
    }
    return { reference: { status: 'ok' }, target: { ordinal: target.ordinal, id: target.id }, levels };
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
    const sourceAfter = sha256(readFileSync(file));
    if (sourceAfter !== sourceBefore) throw new Error(`SOURCE_CHANGED: ${file} sha256 changed during the round trip`);
  }
}
