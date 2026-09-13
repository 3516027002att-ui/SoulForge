/**
 * TAE native animId 边界回归。
 *
 * readTaeEvents 通过 Node loader 只替换 Bridge transport，仍执行真实的
 * TAE read facade；索引侧直接走 ingestBridgeResult，避免复制生产 guard。
 * 该 smoke 不宣称真实 Sekiro native parser 或 Bridge binary 能力。
 */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BridgeResult } from '@soulforge/shared';
import { ingestBridgeResult } from '../indexing/ingestBridgeResult.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import type { NativeEditSession } from '../editing/nativeEditSession.js';

const SOURCE_URI = 'file://chr/c0000.anibnd.dcx';
const SOURCE_PATH = 'chr/c0000.anibnd.dcx';
const MOCK_URL = 'soulforge-tae-anim-id-validation:bridge';
const CALLBACK_KEY = Symbol.for('soulforge.tae-anim-id-validation.bridge');

type BridgeMockInput = { command?: string; filePath?: string };
type BridgeMock = (input: BridgeMockInput) => Promise<Record<string, unknown>>;

function makeEditSession(overlayRoot: string): NativeEditSession {
  const session = {
    layers: { overlayRoot },
    resolveWritablePath: (absolutePath: string) => ({
      ok: true as const,
      absolutePath,
      diagnostics: []
    })
  };
  return {
    session,
    allowedRoots: () => [overlayRoot],
  } as unknown as NativeEditSession;
}

function makeIngestResult(animId: unknown): BridgeResult<unknown> {
  return {
    sourceUri: SOURCE_URI,
    sourcePath: SOURCE_PATH,
    game: 'Sekiro',
    resourceKind: 'action',
    parseStatus: 'partial',
    diagnostics: [],
    data: {
      animations: [{ animId, events: [] }]
    }
  };
}

function assertIngestRejected(animId: unknown): void {
  const index = new WorkspaceIndex(`tae-anim-id-invalid-${String(animId)}`);
  const result = ingestBridgeResult(index, makeIngestResult(animId));
  assert.equal(result.accepted, false, `非法 animId 不得进入索引：${String(animId)}`);
  assert.equal(result.parseStatus, 'partial');
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === 'INGEST_INVALID_FIELD'),
    `非法 animId 必须返回结构化字段诊断：${JSON.stringify(result)}`
  );
  assert.equal(index.toSymbolBundle().tae, undefined, '非法 animId 不得发布 TAE 投影');
}

function assertIngestAccepted(animId: number): void {
  const index = new WorkspaceIndex(`tae-anim-id-valid-${animId}`);
  const result = ingestBridgeResult(index, makeIngestResult(animId));
  assert.equal(result.accepted, true, `safe animId 应被接受：${animId}`);
  assert.equal(result.parseStatus, 'partial');
  const projection = index.toSymbolBundle().tae?.[0];
  assert.ok(projection, `safe animId 应发布 TAE 投影：${JSON.stringify(result)}`);
  assert.equal(projection.animations[0]?.animId, animId);
  assert.equal(projection.animations[0]?.code, `A${String(animId).padStart(4, '0')}`);
}

async function run(): Promise<void> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'soulforge-tae-anim-id-validation-'));
  const filePath = join(fixtureRoot, 'chr', 'c0000.anibnd.dcx');
  await mkdir(join(fixtureRoot, 'chr'), { recursive: true });
  await writeFile(filePath, Buffer.from('controlled-tae-read-fixture'));

  const fixtureGlobals = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const previousCallback = fixtureGlobals[CALLBACK_KEY];
  let currentAnimId: unknown = null;
  fixtureGlobals[CALLBACK_KEY] = (async (input: BridgeMockInput) => {
    assert.equal(input.command, 'read-tae-document');
    return {
      sourceUri: SOURCE_URI,
      sourcePath: SOURCE_PATH,
      game: 'Sekiro',
      resourceKind: 'action',
      parseStatus: 'partial',
      diagnostics: [],
      data: {
        animations: [{
          animId: currentAnimId,
          events: [{ startTime: 0, endTime: 1, eventTypeId: 1 }]
        }]
      }
    };
  }) satisfies BridgeMock;

  const taeEditUrl = new URL('../editing/taeEdit.js?tae-anim-id-validation', import.meta.url);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        context.parentURL?.startsWith(new URL('../editing/taeEdit.js', import.meta.url).href)
        && specifier === '../bridge/runBridge.js'
      ) {
        return { url: MOCK_URL, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === MOCK_URL) {
        return {
          format: 'module',
          shortCircuit: true,
          source: `export async function runBridge(input) {
  return globalThis[Symbol.for(${JSON.stringify(CALLBACK_KEY.description)})](input);
}`
        };
      }
      return nextLoad(url, context);
    }
  });

  try {
    const { readTaeEvents } = await import(taeEditUrl.href) as typeof import('../editing/taeEdit.js');
    const edit = makeEditSession(fixtureRoot);

    for (const animId of [null, -1, Number.MAX_SAFE_INTEGER + 1]) {
      currentAnimId = animId;
      const result = await readTaeEvents({ edit, file: filePath });
      assert.equal(result.ok, false, `非法 native animId 必须拒绝：${String(animId)}`);
      if (result.ok) continue;
      assert.equal(result.error.code, 'TAE_ANIM_ID_INVALID');
    }

    for (const animId of [100000, Number.MAX_SAFE_INTEGER]) {
      currentAnimId = animId;
      const result = await readTaeEvents({ edit, file: filePath });
      assert.equal(result.ok, true, `大 safe animId 应被 read facade 接受：${animId}`);
      if (!result.ok) continue;
      assert.equal(result.events[0]?.animId, animId);
      assert.equal(result.events[0]?.code, `A${String(animId).padStart(4, '0')}`);
    }
  } finally {
    hooks.deregister();
    if (previousCallback === undefined) delete fixtureGlobals[CALLBACK_KEY];
    else fixtureGlobals[CALLBACK_KEY] = previousCallback;
    await rm(fixtureRoot, { recursive: true, force: true });
  }

  for (const invalid of [null, -1, Number.MAX_SAFE_INTEGER + 1]) assertIngestRejected(invalid);
  for (const valid of [100000, Number.MAX_SAFE_INTEGER]) assertIngestAccepted(valid);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then(() => {
    console.log('runTaeAnimIdValidationSmoke: PASS');
  }).catch((error: unknown) => {
    console.error(`runTaeAnimIdValidationSmoke: FAIL\n${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
