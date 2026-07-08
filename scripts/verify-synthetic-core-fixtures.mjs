import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';

const projectPath = process.argv[2] ?? 'bridge/SoulForge.Bridge/SoulForge.Bridge.csproj';

function concat(buffers) {
  return Buffer.concat(buffers);
}

function utf16LeZ(text) {
  return Buffer.from(`${text}\0`, 'utf16le');
}

function leI32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value, 0);
  return buffer;
}

function leF32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatLE(value, 0);
  return buffer;
}

function leLong(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeInt32LE(value, 0);
  buffer.writeInt32LE(0, 4);
  return buffer;
}

function beU32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function adler32(bytes) {
  const mod = 65521;
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % mod;
    b = (b + a) % mod;
  }
  return ((b << 16) | a) >>> 0;
}

function zlibWrap(bytes) {
  return concat([
    Buffer.from([0x78, 0xda]),
    deflateRawSync(bytes, { level: 9 }),
    beU32(adler32(bytes)),
  ]);
}

function toWindowsPath(path) {
  const match = path.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (!match) return path;
  return `${match[1].toUpperCase()}:\\${match[2].replaceAll('/', '\\')}`;
}

function quoteCmd(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runDotnet(args, windowsArgs, windowsCommandLine, windowsPowerShellCommand) {
  const candidates = [
    { command: 'dotnet', args },
    { command: 'dotnet.exe', args: windowsArgs },
    { command: '/mnt/c/Program Files/dotnet/dotnet.exe', args: windowsArgs },
    { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', windowsPowerShellCommand] },
    { command: 'cmd.exe', args: ['/d', '/c', windowsCommandLine] },
  ];
  let lastResult;
  const attempts = [];

  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, candidate.args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    attempts.push({
      command: candidate.command,
      status: result.status,
      error: result.error?.message,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    lastResult = result;
    if (!result.error && result.status === 0) {
      result.attempts = attempts;
      return result;
    }
  }

  if (lastResult) lastResult.attempts = attempts;
  return lastResult;
}

function invokeBridge(command, fixturePath) {
  const absoluteProjectPath = resolve(projectPath);
  const absoluteFixturePath = resolve(fixturePath);
  const args = ['run', '--project', absoluteProjectPath, '--', command, absoluteFixturePath];
  const windowsProjectPath = toWindowsPath(absoluteProjectPath);
  const windowsFixturePath = toWindowsPath(absoluteFixturePath);
  const windowsCwd = toWindowsPath(process.cwd());
  const windowsDotnetPath = 'C:\\Program Files\\dotnet\\dotnet.exe';
  const windowsArgs = ['run', '--project', windowsProjectPath, '--', command, windowsFixturePath];
  const windowsCommandLine = `cd /d ${quoteCmd(windowsCwd)} && ${quoteCmd(windowsDotnetPath)} run --project ${quoteCmd(windowsProjectPath)} -- ${command} ${quoteCmd(windowsFixturePath)}`;
  const windowsPowerShellCommand = `Set-Location -LiteralPath ${quotePowerShell(windowsCwd)}; & ${quotePowerShell(windowsDotnetPath)} run --project ${quotePowerShell(windowsProjectPath)} -- ${command} ${quotePowerShell(windowsFixturePath)}`;
  const result = runDotnet(args, windowsArgs, windowsCommandLine, windowsPowerShellCommand);

  if (result.status !== 0) {
    const attempts = JSON.stringify(result.attempts ?? [], null, 2);
    throw new Error(`Bridge command failed: ${command} ${fixturePath}\n${result.error?.message ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}\nAttempts:\n${attempts}`);
  }

  const stdout = result.stdout ?? '';
  const jsonStart = stdout.indexOf('{');
  if (jsonStart < 0) {
    const attempts = JSON.stringify(result.attempts ?? [], null, 2);
    throw new Error(`Bridge command did not return JSON: ${command} ${fixturePath}\n${result.stdout}\n${result.stderr}\nAttempts:\n${attempts}`);
  }

  return JSON.parse(stdout.slice(jsonStart));
}

function assertPartial(result, command) {
  if (result.parseStatus !== 'partial') {
    throw new Error(`Expected ${command} parseStatus partial, got ${result.parseStatus}`);
  }
}

function assertDiagnosticCode(result, code) {
  const codes = (result.diagnostics ?? []).map((diagnostic) => diagnostic.code);
  if (!codes.includes(code)) {
    throw new Error(`Expected ${code} diagnostic, got: ${codes.join(', ')}`);
  }
}

function assertEvidenceKind(result, kind) {
  const kinds = (result.data?.evidence ?? []).map((entry) => entry.kind);
  if (!kinds.includes(kind)) {
    throw new Error(`Expected ${kind} evidence, got: ${kinds.join(', ')}`);
  }
}

function writeFmgFixture(path) {
  const textA = utf16LeZ('Sekiro text fixture');
  const textB = utf16LeZ('Patch Engine first');
  const stringPool = concat([textA, textB]);
  const tableStart = 24;
  const stringPoolStart = 40;

  writeFileSync(path, concat([
    Buffer.from([0x46, 0x4d, 0x47, 0x00]),
    Buffer.from('SFFX', 'ascii'),
    leI32(1),
    leI32(2),
    leI32(tableStart),
    leI32(stringPoolStart),
    leI32(1000),
    leI32(0),
    leI32(2000),
    leI32(textA.length),
    stringPool,
  ]));
}

function writeEventFixture(path) {
  const eventTableStart = 20;
  const instructionTableStart = 36;

  writeFileSync(path, concat([
    Buffer.from([0x45, 0x56, 0x44, 0x00]),
    Buffer.from('SFEV', 'ascii'),
    leI32(1),
    leI32(1),
    leI32(eventTableStart),
    leI32(1000),
    leI32(2),
    leI32(instructionTableStart),
    leI32(0),
    leI32(0),
    leI32(2000),
    leI32(1),
    leI32(71000000),
    leI32(0),
    leI32(0),
    leI32(1),
    leI32(2001),
    leI32(5),
    leI32(4000),
    leI32(1),
    leI32(0),
  ]));
}

function buildBndPayload() {
  const nameA = utf16LeZ('event/m10_00_00_00.emevd');
  const nameB = utf16LeZ('msg/zhocn/menu.fmg');
  const stringPool = concat([nameA, nameB]);
  const childTableStart = 24;
  const stringPoolStart = 88;
  const payloadOffset = stringPoolStart + stringPool.length;

  return concat([
    Buffer.from('BND4', 'ascii'),
    Buffer.from('SFBN', 'ascii'),
    leI32(1),
    leI32(2),
    leI32(childTableStart),
    leI32(stringPoolStart),
    leI32(1000),
    leI32(0),
    leLong(payloadOffset),
    leLong(16),
    leLong(32),
    leI32(2000),
    leI32(nameA.length),
    leLong(payloadOffset + 16),
    leLong(24),
    leLong(48),
    stringPool,
    Buffer.alloc(40),
  ]);
}

function writeBndFixture(path) {
  writeFileSync(path, buildBndPayload());
}

function writeDcxDfltFixture(path) {
  const payload = buildBndPayload();
  const compressed = zlibWrap(payload);

  writeFileSync(path, concat([
    Buffer.from([0x44, 0x43, 0x58, 0x00]),
    beU32(0x00011000),
    beU32(0x18),
    beU32(0x24),
    beU32(0x44),
    beU32(0x4c),
    Buffer.from([0x44, 0x43, 0x53, 0x00]),
    beU32(payload.length),
    beU32(compressed.length),
    Buffer.from([0x44, 0x43, 0x50, 0x00]),
    Buffer.from('DFLT', 'ascii'),
    beU32(0x20),
    Buffer.from([0x09, 0x00, 0x00, 0x00]),
    beU32(0x00),
    beU32(0x00),
    beU32(0x00),
    beU32(0x00010100),
    Buffer.from([0x44, 0x43, 0x41, 0x00]),
    beU32(0x08),
    compressed,
  ]));
}

function writeParamFixture(path) {
  const rowA = utf16LeZ('Enable Shinobi Fire');
  const rowB = utf16LeZ('Posture Damage');
  const stringPool = concat([rowA, rowB]);
  const rowTableStart = 24;
  const stringPoolStart = 56;

  writeFileSync(path, concat([
    Buffer.from('PARA', 'ascii'),
    Buffer.from('SFPR', 'ascii'),
    leI32(1),
    leI32(2),
    leI32(rowTableStart),
    leI32(stringPoolStart),
    leI32(1000),
    leI32(0),
    leI32(1),
    leI32(2),
    leI32(2000),
    leI32(rowA.length),
    leI32(45),
    leI32(1),
    stringPool,
  ]));
}

function writeMapFixture(path) {
  const entityA = utf16LeZ('c0000_0000_entity');
  const entityB = utf16LeZ('o0000_0000_object');
  const region = utf16LeZ('region_0000');
  const stringPool = concat([entityA, entityB, region]);
  const entityTableStart = 32;
  const regionTableStart = 112;
  const stringPoolStart = 148;

  writeFileSync(path, concat([
    Buffer.from([0x4d, 0x53, 0x42, 0x00]),
    Buffer.from('SFMP', 'ascii'),
    leI32(1),
    leI32(2),
    leI32(entityTableStart),
    leI32(1),
    leI32(regionTableStart),
    leI32(stringPoolStart),
    leI32(1000),
    leI32(0),
    leI32(1),
    leF32(1.0),
    leF32(2.0),
    leF32(3.0),
    leF32(0.0),
    leF32(90.0),
    leF32(0.0),
    leI32(0),
    leI32(2000),
    leI32(entityA.length),
    leI32(2),
    leF32(4.0),
    leF32(5.0),
    leF32(6.0),
    leF32(0.0),
    leF32(180.0),
    leF32(0.0),
    leI32(0),
    leI32(3000),
    leI32(entityA.length + entityB.length),
    leI32(2),
    leF32(7.0),
    leF32(8.0),
    leF32(9.0),
    leF32(10.0),
    leF32(11.0),
    leF32(12.0),
    stringPool,
  ]));
}

const fixtureParent = join(process.cwd(), '.ai-bridge');
mkdirSync(fixtureParent, { recursive: true });
const tempRoot = mkdtempSync(join(fixtureParent, 'soulforge-core-fixtures-'));

try {
  const fmgPath = join(tempRoot, 'synthetic.fmg');
  const eventPath = join(tempRoot, 'm10_00_00_00.synthetic.emevd');
  const paramPath = join(tempRoot, 'SpEffectParam.synthetic.param');
  const mapPath = join(tempRoot, 'm10_00_00_00.synthetic.msb');
  const bndPath = join(tempRoot, 'synthetic.bnd');
  const dcxPath = join(tempRoot, 'synthetic.bnd.dcx');

  writeFmgFixture(fmgPath);
  writeEventFixture(eventPath);
  writeParamFixture(paramPath);
  writeMapFixture(mapPath);
  writeBndFixture(bndPath);
  writeDcxDfltFixture(dcxPath);

  const msg = invokeBridge('export-msg', fmgPath);
  assertPartial(msg, 'export-msg');
  assertDiagnosticCode(msg, 'MSG_FMG_SYNTHETIC_FIXTURE_CONFIRMED');
  if (!msg.data?.entries || msg.data.entries.length !== 2) throw new Error('Expected two MSG entries');

  const event = invokeBridge('export-event', eventPath);
  assertPartial(event, 'export-event');
  assertDiagnosticCode(event, 'EMEVD_SYNTHETIC_FIXTURE_CONFIRMED');
  if (!event.data?.events || event.data.events.length !== 1) throw new Error('Expected one event');
  if (event.data.events[0].instructions.length !== 2) throw new Error('Expected two event instructions');

  const param = invokeBridge('export-param', paramPath);
  assertPartial(param, 'export-param');
  assertDiagnosticCode(param, 'PARAM_SYNTHETIC_FIXTURE_CONFIRMED');
  if (!param.data?.rows || param.data.rows.length !== 2) throw new Error('Expected two PARAM rows');

  const map = invokeBridge('export-map', mapPath);
  assertPartial(map, 'export-map');
  assertDiagnosticCode(map, 'MSB_SYNTHETIC_FIXTURE_CONFIRMED');
  if (!map.data?.entities || map.data.entities.length !== 2) throw new Error('Expected two map entities');
  if (!map.data?.regions || map.data.regions.length !== 1) throw new Error('Expected one map region');

  const bnd = invokeBridge('inspect', bndPath);
  assertPartial(bnd, 'inspect');
  assertDiagnosticCode(bnd, 'BND_SYNTHETIC_FIXTURE_CONFIRMED');
  assertEvidenceKind(bnd, 'binderChildTable');

  const dcx = invokeBridge('inspect', dcxPath);
  assertPartial(dcx, 'inspect');
  assertDiagnosticCode(dcx, 'DCX_PAYLOAD_BOUNDARY_CONFIRMED');
  assertDiagnosticCode(dcx, 'DCX_DFLT_DECOMPRESSED_PREVIEW_READY');
  assertDiagnosticCode(dcx, 'DCX_DFLT_NESTED_BND_CHILD_TABLE_FOUND');
  assertEvidenceKind(dcx, 'dcxPayloadBoundary');
  assertEvidenceKind(dcx, 'dcxDecompressedPreview');
  assertEvidenceKind(dcx, 'dcxNestedBinderChildTable');

  console.log('synthetic core fixtures: ok');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
