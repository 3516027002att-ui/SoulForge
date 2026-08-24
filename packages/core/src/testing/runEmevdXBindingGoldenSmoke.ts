/**
 * EVENT real X-binding golden differential.
 *
 * The source is a user-owned Sekiro common.emevd.dcx and a user-owned
 * DarkScript3 EMEDF file.  The source is copied byte-for-byte into a temp
 * overlay; the game file and fixture registry are never rewritten.  The
 * differential compares the DarkScript compiler's typed parameter plan with
 * the parameter table returned after Bridge-native KRAK write + canonical
 * reread.  It is deliberately not a SoulsFormats/DarkScript3 oracle claim:
 * that external runtime is not bundled by SoulForge.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { EmevdDslCompileRequest, EmevdEditorDocument, EmevdEventIr } from '@soulforge/shared';
import {
  submitEmevdDslPlanViaFourView
} from '../editing/emevdFourViewController.js';
import { readFullEmevdDocumentViaBridge } from '../editing/emevdFullDocument.js';
import { compileEmevdDarkScript } from '../emevd/darkScriptCompiler.js';
import { importDs3EmedfFile } from '../emevd/emedfExternalAdapter.js';
import { fingerprintEmedfRegistry } from '../emevd/dslCompiler.js';
import { findInstructionDef, type EmedfRegistry } from '../emevd/emedfSchema.js';
import { renderEmevdDarkScript, renderEventLines } from '../emevd/darkScriptRenderer.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { disposeBridgeDaemonPool, runBridge } from '../bridge/runBridge.js';
import { searchRealEmedf } from './realEmedfLocator.js';

interface RealEmevdRead {
  sourceHash: string;
  sourceFormat?: string;
  outerFileHash?: string;
}

interface ParameterRow {
  instructionIndex: number;
  targetStartByte: number;
  sourceStartByte: number;
  byteCount: number;
  unkId: number;
}

type GoldenStatus = 'PASS' | 'UNSUPPORTED' | 'BLOCKED';

function compileRequest(
  sourceText: string,
  document: EmevdEditorDocument,
  schemaFingerprint: string
): EmevdDslCompileRequest {
  if (!document.documentInstanceId) throw new Error('EMEVD_X_BINDING_DOCUMENT_ID_MISSING');
  return {
    schemaVersion: 1,
    resourceUri: document.resourceUri,
    documentInstanceId: document.documentInstanceId,
    baseRevision: document.revision,
    emedfSchemaFingerprint: schemaFingerprint,
    sourceText,
    mode: 'dark-script'
  };
}

function fail(message: string): never {
  throw new Error(message);
}

function eventBlock(source: string, eventId: number, mutate: (body: string[]) => string[]): string {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`$Event(${eventId},`));
  if (start < 0) fail(`找不到目标事件源码块：${eventId}`);
  const end = lines.findIndex((line, index) => index > start && line === '});');
  if (end < 0) fail(`目标事件缺少收尾：${eventId}`);
  const body = lines.slice(start + 1, end);
  const changed = mutate(body);
  return [...lines.slice(0, start + 1), ...changed, ...lines.slice(end)].join('\n');
}

function firstXToken(lines: string[]): { token: string; sourceStartByte: number; byteCount: number } | undefined {
  const match = lines.join('\n').match(/X(\d+)_(\d+)/);
  if (!match) return undefined;
  return { token: match[0]!, sourceStartByte: Number(match[1]), byteCount: Number(match[2]) };
}

function replaceFirstX(lines: string[], replacement: string): string[] {
  const copy = [...lines];
  for (let index = 0; index < copy.length; index += 1) {
    if (!/X\d+_\d+/.test(copy[index]!)) continue;
    copy[index] = copy[index]!.replace(/X\d+_\d+/, replacement);
    return copy;
  }
  fail('目标事件没有可替换的 X binding。');
}

function parameterRows(event: EmevdEventIr): ParameterRow[] {
  return (event.parameters ?? []).map((row) => ({
    instructionIndex: row.instructionIndex,
    targetStartByte: row.targetStartByte,
    sourceStartByte: row.sourceStartByte,
    byteCount: row.byteCount,
    unkId: row.unkId ?? 0
  }));
}

function sameRows(actual: ParameterRow[], expected: ParameterRow[]): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function chooseTarget(document: EmevdEditorDocument, registry: EmedfRegistry): {
  event: EmevdEventIr;
  lines: string[];
  xTokens: string[];
  insertName: string;
} {
  const zeroArgNames = registry.instructions
    .filter((definition) => definition.args.length === 0)
    .map((definition) => definition.name);
  for (const event of document.events) {
    if ((event.parameters?.length ?? 0) < 2 || event.instructions.length < 3) continue;
    if (event.instructions.some((instruction) => instruction.unknown)) continue;
    const lines = renderEventLines(event, registry);
    const body = lines.slice(1, -1);
    if (body.length < 2 || body[0]!.trimStart().startsWith('WaitFor(')) continue;
    if (body.some((line) => line.trimStart().startsWith('//'))) continue;
    const xTokens = [...new Set(body.join('\n').match(/X\d+_\d+/g) ?? [])];
    if (xTokens.length < 2) continue;
    const presentNames = new Set(event.instructions.map((instruction) => {
      const definition = findInstructionDef(registry, instruction.bank, instruction.id);
      return definition?.name;
    }));
    const insertName = zeroArgNames.find((name) => !presentNames.has(name));
    if (!insertName) continue;
    return { event, lines, xTokens, insertName };
  }
  fail('真实 common.emevd 中未找到可完全由真实 EMEDF 解码、含多 X 且可安全前插的事件。');
}

async function readNativeFull(
  filePath: string,
  allowedRoots: string[],
  registry: EmedfRegistry,
  documentInstanceId: string,
  oodleRuntimeRoot: string
) {
  return readFullEmevdDocumentViaBridge({
    filePath,
    allowedRoots,
    resourceUri: 'file://event/common.emevd',
    registry,
    documentInstanceId,
    pageSize: 8192,
    cachePolicy: 'bypass',
    attachIdentity: true,
    oodleRuntimeRoot,
    timeoutMs: 120_000
  });
}

async function runStructuralCase(input: {
  label: string;
  sourceText: string;
  document: EmevdEditorDocument;
  registry: EmedfRegistry;
  schemaFingerprint: string;
  targetEventId: number;
  expectedInstructionCount: number;
  sourceOuter: Buffer;
  root: string;
  oodleRuntimeRoot: string;
}): Promise<{ label: string; parameterCount: number; instructionCount: number }> {
  const overlayRoot = join(input.root, input.label, 'overlay');
  const stagingRoot = join(input.root, input.label, 'staging');
  const target = join(overlayRoot, 'event', 'common.emevd.dcx');
  await mkdir(join(overlayRoot, 'event'), { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  await writeFile(target, input.sourceOuter);
  const session = await openWorkspaceSession({ overlayRoot, game: 'sekiro' });
  const sourceHash = (await readNativeFull(
    target,
    [overlayRoot, stagingRoot, input.oodleRuntimeRoot],
    input.registry,
    input.document.documentInstanceId!,
    input.oodleRuntimeRoot
  )).sourceHash;
  if (!sourceHash) fail(`${input.label}: 缺少 native payload sourceHash`);

  const compiled = compileEmevdDarkScript(
    compileRequest(input.sourceText, input.document, input.schemaFingerprint),
    input.document,
    input.registry
  );
  if (!compiled.ok || !compiled.plan) fail(`${input.label}: 编译失败 ${JSON.stringify(compiled.diagnostics)}`);
  const parameterOp = compiled.plan.operations.find((operation) => operation.kind === 'set_event_parameters');
  if (!parameterOp || parameterOp.kind !== 'set_event_parameters') {
    fail(`${input.label}: 缺少 set_event_parameters`);
  }
  const expectedParameters = parameterOp.parameters.map((row) => ({ ...row, unkId: row.unkId ?? 0 }));

  const submitted = await submitEmevdDslPlanViaFourView({
    compileRequest: compileRequest(input.sourceText, input.document, input.schemaFingerprint),
    document: input.document,
    registry: input.registry,
    sourcePath: target,
    expectedDocumentHash: sourceHash,
    expectedOuterFileHash: createHash('sha256').update(input.sourceOuter).digest('hex'),
    oodleRuntimeRoot: input.oodleRuntimeRoot,
    allowedRoots: [overlayRoot, stagingRoot, input.oodleRuntimeRoot],
    workspaceId: session.meta.workspaceId,
    workspaceRoot: overlayRoot,
    stagingRoot,
    title: `EVENT X-binding golden ${input.label}`
  });
  if (!submitted.ok || !submitted.nextDocument || !submitted.commit?.ok) {
    fail(`${input.label}: native submit 失败 ${JSON.stringify(submitted.diagnostics)}`);
  }
  if (!submitted.commit.reRead?.byteConsistent) fail(`${input.label}: native byte consistency 失败`);
  if (submitted.nextDocument.revision !== input.document.revision + 1) fail(`${input.label}: revision 未递增`);
  if (!submitted.nextDocument.diagnostics.some((diagnostic) => diagnostic.code === 'EMEVD_CANONICAL_REREAD')) {
    fail(`${input.label}: nextDocument 非 canonical reread`);
  }
  const event = submitted.nextDocument.events.find((candidate) => candidate.eventId === input.targetEventId);
  if (!event) fail(`${input.label}: canonical reread 缺少目标事件`);
  if (event.instructions.length !== input.expectedInstructionCount) {
    fail(`${input.label}: instructionCount=${event.instructions.length}，期望 ${input.expectedInstructionCount}`);
  }
  const actualParameters = parameterRows(event);
  if (!sameRows(actualParameters, expectedParameters)) {
    fail(`${input.label}: X-binding golden differential 失败：${JSON.stringify({ expectedParameters, actualParameters })}`);
  }
  return { label: input.label, parameterCount: actualParameters.length, instructionCount: event.instructions.length };
}

async function main(): Promise<void> {
  const explicitSource = process.argv[2]?.trim();
  const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
  const sourcePath = resolve(explicitSource || (gameRoot ? join(gameRoot, 'event', 'common.emevd.dcx') : ''));
  const oodleRuntimeRoot = process.env.SOULFORGE_OODLE_RUNTIME_ROOT?.trim() || gameRoot || dirname(sourcePath);
  const emedfPath = process.env.SOULFORGE_EMEDF_PATH?.trim() || await searchRealEmedf();

  if (!explicitSource && !gameRoot) {
    console.log(JSON.stringify({ status: 'UNSUPPORTED' satisfies GoldenStatus, code: 'EVENT_X_BINDING_REAL_GAME_ROOT_MISSING', message: '未提供真实 Sekiro game root 或 common.emevd.dcx。' }, null, 2));
    process.exitCode = 2;
    return;
  }
  if (!emedfPath) {
    console.log(JSON.stringify({ status: 'UNSUPPORTED' satisfies GoldenStatus, code: 'EVENT_X_BINDING_REAL_EMEDF_MISSING', message: '未定位用户本机 DarkScript3 EMEDF。' }, null, 2));
    process.exitCode = 2;
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'soulforge-emevd-x-binding-golden-'));
  try {
    const imported = importDs3EmedfFile(emedfPath);
    if (!imported.ok) {
      console.log(JSON.stringify({ status: 'BLOCKED' satisfies GoldenStatus, code: imported.code, message: imported.message }, null, 2));
      process.exitCode = 2;
      return;
    }
    const registry = imported.registry;
    const schemaFingerprint = fingerprintEmedfRegistry(registry);
    const sourceOuter = await readFile(sourcePath);
    const sourceOuterHash = createHash('sha256').update(sourceOuter).digest('hex');
    const documentInstanceId = 'emevd-x-binding-golden-real';
    const baseline = await readNativeFull(
      sourcePath,
      [dirname(sourcePath), root, oodleRuntimeRoot],
      registry,
      documentInstanceId,
      oodleRuntimeRoot
    );
    if (!baseline.ok || !baseline.document || baseline.sourceFormat !== 'dcx' || baseline.outerFileHash !== sourceOuterHash) {
      console.log(JSON.stringify({ status: 'BLOCKED' satisfies GoldenStatus, code: 'EVENT_X_BINDING_NATIVE_READ_FAILED', diagnostics: baseline.diagnostics, sourceFormat: baseline.sourceFormat, outerFileHash: baseline.outerFileHash, sourceOuterHash }, null, 2));
      process.exitCode = 2;
      return;
    }
    const target = chooseTarget(baseline.document, registry);
    const rendered = renderEmevdDarkScript(baseline.document, registry);
    const headerBody = target.lines.slice(1, -1);
    const firstX = firstXToken(headerBody);
    if (!firstX) fail('目标事件 X token 消失。');
    const maxSource = Math.max(...(target.event.parameters ?? []).map((row) => row.sourceStartByte + row.byteCount));
    const newSource = maxSource + 16;
    const structuralCases = [
      {
        label: 'front-insert',
        sourceText: eventBlock(rendered, target.event.eventId, (body) => [`    ${target.insertName}();`, ...body]),
        expectedInstructionCount: target.event.instructions.length + 1
      },
      {
        label: 'delete-prefix',
        sourceText: eventBlock(rendered, target.event.eventId, (body) => body.slice(1)),
        expectedInstructionCount: target.event.instructions.length - 1
      },
      {
        label: 'new-x',
        sourceText: eventBlock(rendered, target.event.eventId, (body) => replaceFirstX(body, `X${newSource}_${firstX.byteCount}`)),
        expectedInstructionCount: target.event.instructions.length
      }
    ];
    const results = [];
    for (const scenario of structuralCases) {
      results.push(await runStructuralCase({
        ...scenario,
        document: baseline.document,
        registry,
        schemaFingerprint,
        targetEventId: target.event.eventId,
        sourceOuter,
        root,
        oodleRuntimeRoot
      }));
    }

    const widthSource = eventBlock(rendered, target.event.eventId, (body) => replaceFirstX(body, `X${firstX.sourceStartByte}_${firstX.byteCount + 4}`));
    const widthCompiled = compileEmevdDarkScript(
      compileRequest(widthSource, baseline.document, schemaFingerprint),
      baseline.document,
      registry
    );
    if (widthCompiled.ok || !widthCompiled.diagnostics.some((diagnostic) => diagnostic.code === 'EMEVD_PARAMETER_WIDTH_MISMATCH')) {
      fail(`width mismatch 未被 fail-closed 拒绝：${JSON.stringify(widthCompiled.diagnostics)}`);
    }
    const eventParameters = parameterRows(target.event);
    if (target.xTokens.length < 2 || eventParameters.length < 2) fail('真实多 X baseline 证据不足。');
    console.log(JSON.stringify({
      status: 'PASS' satisfies GoldenStatus,
      source: sourcePath,
      emedf: emedfPath,
      compression: 'KRAK',
      targetEventId: target.event.eventId,
      insertInstruction: target.insertName,
      baseline: { instructionCount: target.event.instructions.length, parameterCount: eventParameters.length, distinctX: target.xTokens.length },
      cases: results,
      widthMismatch: { status: 'PASS', diagnostic: 'EMEVD_PARAMETER_WIDTH_MISMATCH', committed: false },
      oracle: 'real DarkScript3 EMEDF layout + Bridge native KRAK writer/canonical reread differential',
      nonClaims: ['未运行 SoulsFormats/DarkScript3 外部运行时 oracle；未声称其独立 oracle PASS。', '只写临时 overlay，不写真实游戏文件。']
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.log(JSON.stringify({ status: 'BLOCKED' satisfies GoldenStatus, code: 'EVENT_X_BINDING_GOLDEN_FAILED', message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
