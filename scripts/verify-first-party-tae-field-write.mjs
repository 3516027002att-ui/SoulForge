#!/usr/bin/env node
/**
 * Verify a first-party typed TAE field mutation against a copied real child.
 * The source ANIBND/game corpus is never written; only a temporary loose TAE
 * copy is changed and reread by the Bridge.
 */
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { disposeBridgeDaemonPool, runBridge } from '../packages/core/dist/bridge/runBridge.js';

const root = resolve(import.meta.dirname, '..');
const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
const bridge = process.env.SOULFORGE_BRIDGE_PATH?.trim()
  || join(root, 'bridge', 'SoulForge.Bridge', 'bin', 'Debug', 'net10.0', 'win-x64', 'SoulForge.Bridge.exe');

if (!gameRoot || !(await directoryExists(join(gameRoot, 'chr')))) {
  console.log(JSON.stringify({ ok: true, status: 'not-attempted', code: 'TAE_CORPUS_ROOT_UNAVAILABLE', gameRoot }));
  process.exit(0);
}
if (!(await fileExists(bridge))) {
  console.error(JSON.stringify({ ok: false, status: 'failed', code: 'TAE_BRIDGE_UNAVAILABLE', bridge }));
  process.exit(2);
}

async function fileExists(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function directoryExists(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function collect(directory, result = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path, result);
    else if (entry.isFile() && /\.anibnd(?:\.dcx)?$/iu.test(entry.name)) result.push(path);
  }
  return result;
}

async function bridgeJson(command, file, options, allowedRoots, writableRoots = []) {
  const envelope = await runBridge({
    bridgeExecutablePath: bridge,
    command,
    filePath: file,
    resourceUri: pathToFileURL(file).href,
    allowedRoots: [...new Set([...allowedRoots, gameRoot])],
    writableRoots,
    oodleRuntimeRoot: gameRoot,
    commandOptions: options,
    timeoutMs: 120_000,
    maxFrameBytes: 32 * 1024 * 1024
  });
  if (envelope.parseStatus === 'failed' || !envelope.data) {
    throw new Error(`${command} 失败：${JSON.stringify(envelope.diagnostics ?? envelope).slice(0, 2_000)}`);
  }
  return envelope;
}

function chooseNextValue(field) {
  if (field.type === 'b') return field.value !== true;
  const number = Number(field.value);
  if (!Number.isFinite(number)) return field.type === 'f32' ? 0.25 : 0;
  if (field.type === 'f32') return Math.abs(number) > 1e30 ? Math.sign(number) * 1e30 : number + 0.25;
  const limits = {
    u8: [0, 0xff], s8: [-0x80, 0x7f], u16: [0, 0xffff], s16: [-0x8000, 0x7fff],
    u32: [0, 0xffffffff], s32: [-0x80000000, 0x7fffffff], s64: [-9_007_199_254_740_991, 9_007_199_254_740_991]
  }[field.type] ?? [-0x80000000, 0x7fffffff];
  return number < limits[1] ? number + 1 : number - 1;
}

const anibnds = (await collect(join(gameRoot, 'chr'))).sort((left, right) => left.localeCompare(right, 'en'));
if (anibnds.length === 0) {
  console.log(JSON.stringify({ ok: true, status: 'not-attempted', code: 'TAE_ANIBND_UNAVAILABLE' }));
  process.exit(0);
}

const scratch = await mkdtemp(join(tmpdir(), 'soulforge-tae-field-write-'));
let selected = null;
try {
  for (const sourcePath of anibnds) {
    const listed = await bridgeJson('list-bnd4-entries', sourcePath, {}, [dirname(sourcePath)]);
    const entries = (listed.data.entries ?? []).filter((entry) => /\.tae$/iu.test(String(entry.name ?? '')));
    for (const entry of entries) {
      const snapshot = await bridgeJson('snapshot-bnd4-child', sourcePath, { entryIndex: entry.index }, [dirname(sourcePath)]);
      const base64 = snapshot.data.contentBase64;
      if (typeof base64 !== 'string' || base64.length === 0) continue;
      const loosePath = join(scratch, `${basename(sourcePath)}-${entry.index}.tae`);
      await writeFile(loosePath, Buffer.from(base64, 'base64'));
      const document = await bridgeJson('read-tae-document', loosePath, {}, [scratch]);
      for (const animation of document.data.animations ?? []) {
        for (let eventIndex = 0; eventIndex < (animation.events ?? []).length; eventIndex += 1) {
          const event = animation.events[eventIndex];
          const field = (event?.templateFields ?? []).find((candidate) => (
            candidate
            && typeof candidate.name === 'string'
            && candidate.isPadding !== true
            && candidate.assert === undefined
            && typeof candidate.type === 'string'
            && ['b', 'u8', 's8', 'u16', 's16', 'u32', 's32', 's64', 'f32'].includes(candidate.type)
            && (typeof candidate.value === 'number' || typeof candidate.value === 'boolean')
          ));
          if (!field || !Number.isSafeInteger(animation.animId)) continue;
          selected = { sourcePath, entry, loosePath, document: document.data, animation, event, eventIndex, field };
          break;
        }
        if (selected) break;
      }
      if (selected) break;
    }
    if (selected) break;
  }

  if (!selected) throw new Error('真实 TAE 语料中没有找到可由 first-party schema 完整解码的非 padding 字段。');
  const outputPath = join(scratch, 'field-write-output.tae');
  const beforeValue = selected.field.value;
  const afterValue = chooseNextValue(selected.field);
  const mutation = {
    mutation: 'set-event-field',
    animId: selected.animation.animId,
    eventIndex: selected.eventIndex,
    fieldIndex: selected.field.index,
    fieldName: selected.field.name,
    value: afterValue,
    ...(selected.event.schemaBankId === undefined ? {} : { schemaBankId: selected.event.schemaBankId })
  };
  const written = await bridgeJson('write-tae-document', selected.loosePath, {
    outputPath,
    expectedDocumentHash: selected.document.sourceHash,
    mutations: [mutation]
  }, [scratch], [scratch]);
  if (written.data.rereadVerified !== true || written.data.fieldUpdateCount !== 1) {
    throw new Error(`TAE typed field 写回未通过 native 重读：${JSON.stringify(written)}`);
  }
  const reread = await bridgeJson('read-tae-document', outputPath, {}, [scratch]);
  const outputAnimation = (reread.data.animations ?? []).find((item) => item.animId === selected.animation.animId);
  const outputEvent = outputAnimation?.events?.[selected.eventIndex];
  const outputField = outputEvent?.templateFields?.find((item) => item.index === selected.field.index);
  if (!outputField || outputField.value !== afterValue) {
    throw new Error(`TAE typed field 重读值不一致：before=${beforeValue} after=${afterValue} reread=${JSON.stringify(outputField)}`);
  }
  console.log(JSON.stringify({
    ok: true,
    status: 'verified-observed',
    sourceFile: basename(selected.sourcePath),
    taeEntryIndex: selected.entry.index,
    animId: selected.animation.animId,
    eventIndex: selected.eventIndex,
    fieldIndex: selected.field.index,
    fieldName: selected.field.name,
    fieldType: selected.field.type,
    beforeValue,
    afterValue,
    rereadValue: outputField.value,
    schemaBankId: selected.event.schemaBankId ?? null
  }, null, 2));
} finally {
  await rm(scratch, { recursive: true, force: true });
  await disposeBridgeDaemonPool();
}
