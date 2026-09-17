#!/usr/bin/env node
/**
 * First-party EMEVD full-source/native writeback regression.
 *
 * The real common.emevd.dcx is copied into a temporary overlay. The test then
 * assembles the complete document with the bundled EMEDF registry, renders the
 * full editable DarkScript source, changes one typed argument, and commits it
 * through the normal Patch Engine -> Bridge -> native reread path. The game
 * corpus itself is never modified and no external editor/schema is consulted.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  disposeBridgeDaemonPool,
  fingerprintEmedfRegistry,
  formatEmevdAnchor,
  getFirstPartyEmedfRegistry,
  readFullEmevdDocumentViaBridge,
  renderEmevdDarkScript,
  submitEmevdDslPlanViaFourView,
  compileEmevdPatchDsl,
  decodeInstructionArgs,
  findInstructionDef,
  openWorkspaceSession
} from '../packages/core/dist/index.js';

const root = resolve(import.meta.dirname, '..');
const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
const sourcePath = process.argv[2]?.trim()
  || (gameRoot ? join(gameRoot, 'mods', 'event', 'common.emevd.dcx') : null);
const bridge = process.env.SOULFORGE_BRIDGE_PATH?.trim()
  || join(root, 'bridge', 'SoulForge.Bridge', 'bin', 'Debug', 'net10.0', 'win-x64', 'SoulForge.Bridge.exe');

if (!sourcePath || !(await isFile(sourcePath))) {
  console.log(JSON.stringify({
    ok: true,
    status: 'not-attempted',
    code: 'EMEVD_CORPUS_UNAVAILABLE',
    sourcePath
  }));
  process.exit(0);
}
if (!(await isFile(bridge))) {
  console.error(JSON.stringify({ ok: false, status: 'failed', code: 'EMEVD_BRIDGE_UNAVAILABLE', bridge }));
  process.exit(2);
}

async function isFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function literal(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (!Number.isFinite(value)) throw new Error('不能用非有限 EMEVD 参数做回归写入。');
  return Object.is(value, -0) ? '-0' : String(value);
}

function nextValue(type, value) {
  if (type === 'bool') return !value;
  if (type === 'f32') {
    const candidate = value + 0.25;
    return Number.isFinite(candidate) ? candidate : value - 0.25;
  }
  const limits = {
    u8: [0, 0xff],
    s8: [-0x80, 0x7f],
    u16: [0, 0xffff],
    s16: [-0x8000, 0x7fff],
    u32: [0, 0xffffffff],
    s32: [-0x80000000, 0x7fffffff]
  }[type];
  if (!limits) throw new Error(`不支持的 EMEVD 回归字段类型：${type}`);
  return value < limits[1] ? value + 1 : value - 1;
}

function selectTypedArgument(document, registry) {
  for (const [eventIndex, event] of document.events.entries()) {
    for (const [instructionIndex, instruction] of event.instructions.entries()) {
      const definition = findInstructionDef(registry, instruction.bank, instruction.id);
      if (!definition || !instruction.anchor) continue;
      const raw = Buffer.from(instruction.argsBase64, 'base64');
      const decoded = decodeInstructionArgs(registry, instruction.bank, instruction.id, raw);
      if (!decoded.ok) continue;
      const argDef = definition.args.find((arg) => !arg.vararg);
      const arg = argDef ? decoded.args.find((item) => item.name === argDef.name) : undefined;
      if (!arg || !Number.isFinite(Number(arg.value))) continue;
      const after = nextValue(arg.type, arg.value);
      return {
        eventIndex,
        instructionIndex,
        event,
        instruction,
        definition,
        arg,
        after
      };
    }
  }
  throw new Error('真实 EMEVD 语料中没有可由 first-party EMEDF 解码的固定参数。');
}

async function main() {
  const registry = getFirstPartyEmedfRegistry();
  const schemaFingerprint = fingerprintEmedfRegistry(registry);
  const scratch = await mkdtemp(join(tmpdir(), 'soulforge-emevd-first-party-roundtrip-'));
  const overlayRoot = join(scratch, 'overlay');
  const stagingRoot = join(scratch, 'staging');
  const backupRoot = join(scratch, 'backups');
  const target = join(overlayRoot, 'event', 'common.emevd.dcx');
  try {
    await mkdir(dirname(target), { recursive: true });
    await mkdir(stagingRoot, { recursive: true });
    await mkdir(backupRoot, { recursive: true });
    await copyFile(sourcePath, target);
    const originalOuter = await readFile(target);
    const first = await readFullEmevdDocumentViaBridge({
      filePath: target,
      allowedRoots: [overlayRoot, stagingRoot],
      resourceUri: 'file://event/common.emevd.dcx',
      registry,
      documentInstanceId: 'first-party-emevd-roundtrip',
      pageSize: 8192,
      attachIdentity: true,
      ...(gameRoot ? { oodleRuntimeRoot: gameRoot } : {})
    });
    if (!first.ok || !first.document) throw new Error(`完整 EMEVD 读取失败：${JSON.stringify(first.diagnostics)}`);

    const unknown = first.document.events.reduce(
      (sum, event) => sum + event.instructions.filter((instruction) => instruction.unknown).length,
      0
    );
    if (unknown !== 0) throw new Error(`first-party EMEVD 读取存在 ${unknown} 条未知指令。`);
    const rendered = renderEmevdDarkScript(first.document, registry);
    if (!rendered.trim() || rendered.includes('// unknown ') || rendered.includes('DARKSCRIPT_LINE_UNDECODED')) {
      throw new Error('first-party EMEVD 完整源码仍包含未知/未解码占位。');
    }

    const selected = selectTypedArgument(first.document, registry);
    const eventAnchor = formatEmevdAnchor('event', selected.event.anchor);
    const instructionAnchor = formatEmevdAnchor('instruction', selected.instruction.anchor);
    const sourceText = [
      `resource "file://event/common.emevd.dcx"`,
      `base revision ${first.document.revision} schema "${schemaFingerprint}"`,
      `event ${eventAnchor} {`,
      `  instruction ${instructionAnchor} {`,
      `    set arg ${selected.arg.name} = ${literal(selected.after)}`,
      '  }',
      '}'
    ].join('\n');
    const compileRequest = {
      schemaVersion: 1,
      resourceUri: first.document.resourceUri,
      documentInstanceId: first.document.documentInstanceId,
      baseRevision: first.document.revision,
      emedfSchemaFingerprint: schemaFingerprint,
      sourceText,
      mode: 'patch'
    };
    const compiled = compileEmevdPatchDsl(compileRequest, first.document, registry);
    if (!compiled.ok || !compiled.plan || compiled.plan.operations.length !== 1) {
      throw new Error(`first-party EMEVD typed 文本编辑未生成单一 mutation：${JSON.stringify(compiled.diagnostics)}`);
    }
    const session = await openWorkspaceSession({ overlayRoot, game: 'sekiro' });
    const submitted = await submitEmevdDslPlanViaFourView({
      compileRequest,
      document: first.document,
      registry,
      sourcePath: target,
      expectedDocumentHash: first.sourceHash,
      ...(first.outerFileHash ? { expectedOuterFileHash: first.outerFileHash } : {}),
      allowedRoots: [overlayRoot, stagingRoot],
      workspaceId: session.meta.workspaceId,
      workspaceRoot: overlayRoot,
      stagingRoot,
      backupBaseDir: backupRoot,
      session,
      title: 'first-party EMEVD full-source roundtrip',
      ...(gameRoot ? { oodleRuntimeRoot: gameRoot } : {})
    });
    if (!submitted.ok || !submitted.commit?.ok || !submitted.commit.reRead?.ok || !submitted.commit.reRead.byteConsistent) {
      throw new Error(`first-party EMEVD 写回失败：${JSON.stringify(submitted.diagnostics)}`);
    }
    const after = await readFullEmevdDocumentViaBridge({
      filePath: target,
      allowedRoots: [overlayRoot, stagingRoot],
      resourceUri: 'file://event/common.emevd.dcx',
      registry,
      documentInstanceId: 'first-party-emevd-roundtrip-after',
      pageSize: 8192,
      attachIdentity: true,
      cachePolicy: 'bypass',
      ...(gameRoot ? { oodleRuntimeRoot: gameRoot } : {})
    });
    if (!after.ok || !after.document) throw new Error(`写回后 EMEVD 重读失败：${JSON.stringify(after.diagnostics)}`);
    const afterUnknown = after.document.events.reduce(
      (sum, event) => sum + event.instructions.filter((instruction) => instruction.unknown).length,
      0
    );
    if (afterUnknown !== 0) throw new Error(`写回后 first-party EMEVD 出现 ${afterUnknown} 条未知指令。`);
    const rereadEvent = after.document.events[selected.eventIndex];
    const rereadInstruction = rereadEvent?.instructions[selected.instructionIndex];
    if (!rereadInstruction) throw new Error('写回后找不到原指令位置。');
    const rereadArgs = decodeInstructionArgs(
      registry,
      rereadInstruction.bank,
      rereadInstruction.id,
      Buffer.from(rereadInstruction.argsBase64, 'base64')
    );
    const rereadValue = rereadArgs.ok
      ? rereadArgs.args.find((arg) => arg.name === selected.arg.name)?.value
      : undefined;
    if (rereadValue !== selected.after) {
      throw new Error(`typed 参数重读值不一致：预期 ${selected.after}，实际 ${rereadValue}`);
    }
    const untouchedSource = await readFile(sourcePath);
    if (hash(untouchedSource) !== hash(originalOuter)) {
      throw new Error('测试意外修改了原始 EMEVD 语料。');
    }
    console.log(JSON.stringify({
      ok: true,
      status: 'verified-observed',
      sourceFile: basename(sourcePath),
      events: first.document.events.length,
      instructions: first.instructionTotal,
      instructionKinds: new Set(first.document.events.flatMap((event) => event.instructions.map((instruction) => `${instruction.bank}:${instruction.id}`))).size,
      unknownInstructions: 0,
      renderedChars: rendered.length,
      edited: {
        eventIndex: selected.eventIndex,
        instructionIndex: selected.instructionIndex,
        bank: selected.instruction.bank,
        id: selected.instruction.id,
        argument: selected.arg.name,
        before: selected.arg.value,
        after: selected.after,
        reread: rereadValue
      },
      schema: {
        package: registry.packageId,
        version: registry.packageVersion,
        contentDigest: registry.contentDigest
      },
      commit: {
        mutationCount: submitted.commit.mutationCount,
        byteConsistent: submitted.commit.reRead.byteConsistent,
        semanticIdentical: submitted.commit.reRead.semanticIdentical
      }
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
