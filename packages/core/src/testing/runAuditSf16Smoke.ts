import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { runBridge } from '../bridge/runBridge.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import { createSmokeWorkspace } from './harness/smokeWorkspace.js';
import { runSf16ProtocolAudit } from './audit/sf-16/bridgeProtocolSf16Helper.js';

interface Args {
  layer?: string;
  executable?: string;
  nativeFixture?: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const result: Args = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value !== '--layer' && value !== '--bridge-executable' && value !== '--native-fixture') continue;
    const next = args[index + 1];
    if (next === undefined) continue;
    index += 1;
    if (value === '--layer') result.layer = next;
    else if (value === '--bridge-executable') result.executable = next;
    else result.nativeFixture = next;
  }
  return result;
}

function resolveExecutable(explicit?: string): string {
  const candidate = explicit
    ?? process.env.SOULFORGE_BRIDGE_EXECUTABLE
    ?? 'bridge/SoulForge.Bridge/bin/Debug/net10.0/win-x64/SoulForge.Bridge.exe';
  // Workspace scripts run with packages/core as cwd, while direct audits are
  // commonly launched from the repository root. Anchor relative paths to the
  // repository inferred from this compiled module so both entry points select
  // the same production Bridge executable.
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const executable = resolve(repositoryRoot, candidate);
  if (!existsSync(executable)) {
    throw new Error(`SF16_ENVIRONMENT_BLOCKED: production Bridge executable not found: ${executable}`);
  }
  return executable;
}

async function prepareQueueDirectory(root: string): Promise<string> {
  const queueRoot = join(root, 'queue-input');
  await mkdir(queueRoot, { recursive: true });
  // read-dcx-document is a real Bridge command. A deterministic, bounded DFLT
  // payload makes each worker perform native inflate + round-trip compression
  // while the smoke fills the queue; it is disposable workspace data, never
  // game data. The bytes are deliberately not all-zero so the compression
  // work remains observable even when the file is served from the cache.
  const payload = Buffer.alloc(4 * 1024 * 1024);
  let state = 0x13579bdf;
  for (let index = 0; index < payload.length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    payload[index] = state >>> 24;
  }
  const compressed = deflateSync(payload);
  const header = Buffer.alloc(0x38);
  header.write('DCX\0', 0, 'ascii');
  header.writeUInt32BE(0x02, 0x04);
  header.writeUInt32BE(0x02, 0x08);
  header.write('DCS\0', 0x18, 'ascii');
  header.writeUInt32BE(payload.length, 0x1c);
  header.writeUInt32BE(compressed.length, 0x20);
  header.write('DCP\0', 0x24, 'ascii');
  header.write('DFLT', 0x28, 'ascii');
  header.write('DCA\0', 0x30, 'ascii');
  header.writeUInt32BE(8, 0x34);
  const queueSource = join(queueRoot, 'queue-source.bin');
  await writeFile(queueSource, Buffer.concat([header, compressed]));
  return queueSource;
}

function syntheticExportFixture(): Buffer {
  // This is the reviewed SF-EV fixture consumed by the existing production
  // SyntheticFixtureExports path. It is intentionally not a second EMEVD
  // parser: the smoke only needs a deterministic successful export payload.
  const bytes = Buffer.alloc(64);
  bytes.write('EVD\0', 0, 'ascii');
  bytes.write('SFEV', 4, 'ascii');
  bytes.writeInt32LE(1, 8); // fixture version
  bytes.writeInt32LE(1, 12); // event count
  bytes.writeInt32LE(24, 16); // event table start
  bytes.writeInt32LE(100, 24); // event id
  bytes.writeInt32LE(1, 28); // instruction count
  bytes.writeInt32LE(40, 32); // instruction table start
  bytes.writeInt32LE(0, 40); // instruction index
  bytes.writeInt32LE(2000, 44); // synthetic opcode
  bytes.writeInt32LE(1, 48); // role: flag
  bytes.writeInt32LE(42, 52); // argument value
  bytes.writeInt32LE(0, 56); // no param-name binding
  return bytes;
}

async function runUnit(executable: string): Promise<Record<string, unknown>> {
  const workspace = await createSmokeWorkspace('audit-sf16-unit');
  try {
    const staging = join(workspace.root, 'staging');
    await mkdir(staging, { recursive: true });
    const sourcePath = join(workspace.root, 'unit-event.emevd');
    await writeFile(sourcePath, syntheticExportFixture());
    const queuePath = await prepareQueueDirectory(workspace.root);
    const exported = await runBridge({
      bridgeExecutablePath: executable,
      command: 'export-event',
      filePath: sourcePath,
      allowedRoots: [workspace.root],
      writableRoots: [staging],
      workspaceSessionId: 'sf16-unit-export',
      timeoutMs: 20_000,
      maxFrameBytes: 64 * 1024,
      maxConcurrency: 2
    });
    if (exported.diagnostics.some((item) => item.code === 'UNKNOWN_COMMAND')) {
      throw new Error(`production export was not dispatched: ${JSON.stringify(exported.diagnostics)}`);
    }
    const protocol = await runSf16ProtocolAudit({
      executable,
      root: workspace.root,
      sourcePath,
      queuePath,
      maxFrameBytes: 64 * 1024
    });
    return {
      layer: 'unit',
      productionExport: { parseStatus: exported.parseStatus, diagnosticCodes: exported.diagnostics.map((item) => item.code) },
      protocol
    };
  } finally {
    await workspace.dispose();
  }
}

async function runNative(executable: string, explicitFixture?: string): Promise<Record<string, unknown>> {
  const fixture = await resolveNativeFixture(
    explicitFixture,
    'emevd-primary',
    '../../mods/event/common.emevd.dcx'
  );
  const workspace = await createSmokeWorkspace('audit-sf16-native');
  try {
    const staging = join(workspace.root, 'staging');
    await mkdir(staging, { recursive: true });
    const sourcePath = join(workspace.root, 'native-event.emevd.dcx');
    await copyFile(fixture, sourcePath);
    const queuePath = await prepareQueueDirectory(workspace.root);
    const exported = await runBridge({
      bridgeExecutablePath: executable,
      command: 'export-event',
      filePath: sourcePath,
      allowedRoots: [workspace.root],
      writableRoots: [staging],
      ...(process.env.SOULFORGE_SEKIRO_GAME_ROOT
        ? { oodleRuntimeRoot: process.env.SOULFORGE_SEKIRO_GAME_ROOT }
        : {}),
      workspaceSessionId: 'sf16-native-export',
      timeoutMs: 60_000,
      maxFrameBytes: 64 * 1024,
      maxConcurrency: 2
    });
    if (exported.parseStatus === 'failed') {
      throw new Error(`native production export failed: ${JSON.stringify(exported.diagnostics)}`);
    }
    const protocol = await runSf16ProtocolAudit({
      executable,
      root: workspace.root,
      sourcePath,
      queuePath,
      maxFrameBytes: 64 * 1024
    });
    return {
      layer: 'native',
      fixture,
      productionExport: { parseStatus: exported.parseStatus, diagnosticCodes: exported.diagnostics.map((item) => item.code) },
      protocol
    };
  } finally {
    await workspace.dispose();
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.layer !== 'unit' && args.layer !== 'native') {
    throw new Error('SF16_INVALID_LAYER: expected --layer unit or --layer native.');
  }
  const executable = resolveExecutable(args.executable);
  const result = args.layer === 'unit'
    ? await runUnit(executable)
    : await runNative(executable, args.nativeFixture);
  console.log(JSON.stringify({ ok: true, message: 'SF-16 production Bridge protocol smoke passed', ...result }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
