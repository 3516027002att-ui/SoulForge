import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const gameRoot = 'D:\\mystream\\Sekiro Shadows Die Twice\\Sekiro';
const repoRoot = 'D:\\Repository\\SoulForge';

const entries = [
  { logicalUri: 'sekiro://param/gameparam.parambnd.dcx', relativePath: 'param/gameparam.parambnd.dcx', diskRelativePath: 'param/gameparam/gameparam.parambnd.dcx', resourceRole: 'gameparam', format: 'DFLT' },
  { logicalUri: 'sekiro://map/m10_00_00_00/m10_00_00_00.msb.dcx', relativePath: 'map/m10_00_00_00/m10_00_00_00.msb.dcx', diskRelativePath: 'map/mapstudio/m10_00_00_00.msb.dcx', resourceRole: 'msb', format: 'DFLT', note: 'on-disk canonical is map/mapstudio/m10_00_00_00.msb.dcx (manifest logical path is legacy)' },
  { logicalUri: 'sekiro://map/m10_00_00_00/m10_00_00_00_002021.mapbnd.dcx', relativePath: 'map/m10_00_00_00/m10_00_00_00_002021.mapbnd.dcx', diskRelativePath: 'map/m10_00_00_00/m10_00_00_00_002021.mapbnd.dcx', resourceRole: 'mapbnd', format: 'DFLT', note: 'm002021 static geometry must succeed under 16 MiB frame' },
  { logicalUri: 'sekiro://obj/o000100.objbnd.dcx', relativePath: 'obj/o000100.objbnd.dcx', diskRelativePath: 'obj/o000100.objbnd.dcx', resourceRole: 'obj', format: 'DFLT' },
  { logicalUri: 'sekiro://chr/c1000.chrbnd.dcx', relativePath: 'chr/c1000.chrbnd.dcx', diskRelativePath: 'chr/c1000.chrbnd.dcx', resourceRole: 'chr', format: 'DFLT' },
  { logicalUri: 'sekiro://chr/c0000.chrbnd.dcx', relativePath: 'chr/c0000.chrbnd.dcx', diskRelativePath: 'chr/c0000.chrbnd.dcx', resourceRole: 'chr-leader', format: 'DFLT' },
  { logicalUri: 'sekiro://chr/c0000.anibnd.dcx', relativePath: 'chr/c0000.anibnd.dcx', diskRelativePath: 'chr/c0000.anibnd.dcx', resourceRole: 'anibnd-skeleton', format: 'DFLT' },
  { logicalUri: 'sekiro://chr/c0000_a000_lo.anibnd.dcx', relativePath: 'chr/c0000_a000_lo.anibnd.dcx', diskRelativePath: 'chr/c0000_a000_lo.anibnd.dcx', resourceRole: 'anibnd-animation', format: 'DFLT' },
  { logicalUri: 'sekiro://param/AtkParam_Npc', relativePath: 'param/gameparam.parambnd.dcx#AtkParam_Npc', diskRelativePath: 'param/gameparam/gameparam.parambnd.dcx', resourceRole: 'param-table', format: 'PARAM_TABLE', table: 'AtkParam_Npc' },
  { logicalUri: 'sekiro://param/SpEffectParam', relativePath: 'param/gameparam.parambnd.dcx#SpEffectParam', diskRelativePath: 'param/gameparam/gameparam.parambnd.dcx', resourceRole: 'param-table', format: 'PARAM_TABLE', table: 'SpEffectParam' },
];

function sha256FileSingleRead(absPath) {
  const buf = fs.readFileSync(absPath);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return { byteLength: buf.length, sha256, buf };
}
function dcxProbe(buf) {
  let compression = 'unknown';
  for (let i = 0; i < 60; i++) {
    const tag = buf.slice(i, i+4).toString('ascii');
    if (tag === 'DFLT' || tag === 'KRAK' || tag === 'ZLIB') compression = tag;
  }
  const magic = buf.slice(0,4).toString('ascii');
  return { magic, compression, headerHex0_32: buf.slice(0, 32).toString('hex') };
}

const filesystemArtifacts = [];
for (const e of entries) {
  const abs = path.join(gameRoot, e.diskRelativePath);
  const { byteLength, sha256, buf } = sha256FileSingleRead(abs);
  const probe = dcxProbe(buf);
  const rec = {
    logicalUri: e.logicalUri,
    relativePath: e.relativePath,
    diskRelativePath: e.diskRelativePath,
    absolutePath: abs,
    byteLength,
    sha256,
    size: byteLength,
    dcxMagic: probe.magic,
    compressionObserved: probe.compression,
    compressionExpected: 'DFLT',
  };
  if (probe.compression !== 'DFLT') {
    rec.compressionNote = 'observed is KRAK (Oodle) on this 1.6 install; manifest expected DFLT is stale for Sekiro 1.6 oodle build';
  }
  if (e.resourceRole) rec.resourceRole = e.resourceRole;
  if (e.format) rec.format = e.format;
  if (e.table) rec.table = e.table;
  if (e.note) rec.note = e.note;
  if (e.logicalUri.includes('map') && e.logicalUri.includes('mapbnd')) {
    rec.inventory = { method: 'filesystem-hash-only', bndInventory: 'unavailable - Andre.SoulsFormats not present (no SoulsFormats.dll/PackageReference; bridge uses custom parser)', rawBndReadAttempted: false };
  }
  if (e.logicalUri.includes('.msb.')) {
    rec.inventory = { method: 'filesystem-hash-only', msbInventory: 'unavailable - Andre.SoulsFormats not present; msb type-0 count (499) must be verified via Andre/independent parse per 0.5.1/24.3' };
  }
  filesystemArtifacts.push(rec);
}

const now = new Date();
const utcIso = now.toISOString();
const head = execSync('git rev-parse HEAD', {cwd: repoRoot}).toString().trim();
const short12 = head.slice(0,12);
const safeUtc = utcIso.replaceAll(':','-').replace('.','-');
const dirName = safeUtc + '-' + short12;

const payload = {
  schemaVersion: 'filesystem-artifacts-v1',
  generatedAtUtc: utcIso,
  generator: 'node:crypto single-read (no SoulForge parser)',
  gameRoot,
  sourceGameRoot: gameRoot,
  snapshot: { gitHead: head, short12, dirName },
  oodleRuntime: { dll: path.join(gameRoot, 'oo2core_6_win64.dll'), exists: fs.existsSync(path.join(gameRoot, 'oo2core_6_win64.dll')) },
  entryCount: filesystemArtifacts.length,
  entries: filesystemArtifacts,
  triSource: {
    filesystem: 'present',
    andre: 'unavailable - no Andre.SoulsFormats on this machine; file hash only',
    matureTool: 'pending - per 24.3 requires independent mature tool availability probe per workflow',
    note: 'filesystem layer complete (byteLength+sha256 single read, no SoulForge parser); Andre BND inventory and mature tool black-box availability must be filled by separate Andre + mature-tool runs per 0.5.1/24.3 before corpus manifest can be sealed',
  },
  manifestRef: 'testdata/corpus/mission1-sekiro-acceptance.manifest.json (v1 placeholder with 0000/1111 pending hashes)',
  logicalUriCount: 10,
  expectedLogic: '138 PARAM tables via gameparam.parambnd.dcx, 499 type-0 via m10 MSB, m002021 mapbnd, o000100, c1000, c0000 leader+skeleton+animation, AtkParam_Npc/SpEffectParam tables',
};

const outDir = path.join(repoRoot, 'output', 'mission1-evidence', dirName, 'corpus-tri-source');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'filesystem-artifacts.json');
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log('WROTE ' + outPath);
console.log(JSON.stringify(payload, null, 2));
