/**
 * CLI ↔ Agent same-runtime smoke (T01, 执行指令 §2.1/§7 L0x, 场景 E, T11).
 *
 * Today tools/soulforge-cli/sfcli.mjs loads the production ToolRegistry
 * directly, so the "same runtime" property partially holds; what is missing
 * is the reusable local session host, batch dispatch, requestId idempotency
 * and persisted proof/audit separation. Those assertions are probed
 * dynamically and fail with "行为未实现" on the baseline.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { decodeReferenceQueryInput } from '@soulforge/shared';

const failures: string[] = [];
let checks = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (!condition) failures.push(detail === undefined ? name : `${name} —— ${detail}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const cliPath = resolve(repoRoot, 'tools/soulforge-cli/sfcli.mjs');

/* ------------------------------------------------------------------ */
/* 1. CLI parameter mapping: old syntax → new tool arguments (§3.1)    */
/* ------------------------------------------------------------------ */

const adapterPath = fileURLToPath(new URL('../cli/nativeCommandAdapter.js', import.meta.url));
check('T11/nativeCommandAdapter-exists', existsSync(adapterPath),
  '行为未实现：packages/core/src/cli/nativeCommandAdapter.ts 尚不存在（T11）');

if (existsSync(adapterPath)) {
  const adapter = await import(new URL('../cli/nativeCommandAdapter.js', import.meta.url).href) as {
    mapCliArgumentsToToolInput?: (tool: string, args: Record<string, unknown>) =>
      { ok: true; input: unknown } | { ok: false; code: string; message: string };
  };
  check('T11/adapter-exported', typeof adapter.mapCliArgumentsToToolInput === 'function');
  if (typeof adapter.mapCliArgumentsToToolInput === 'function') {
    const mapped = adapter.mapCliArgumentsToToolInput('find_references', {
      target: 'param://workspace-A/GameParam/NpcParam/50800000', detail: 'edges'
    });
    check('T11/cli-maps-to-decodable-input', mapped.ok === true
      && decodeReferenceQueryInput(mapped.ok ? mapped.input : {}).ok === true,
    'CLI 旧语法必须映射为与 Agent 完全相同的可解码输入');
  }
}

/* ------------------------------------------------------------------ */
/* 2. Local session host + batch dispatcher (T11)                      */
/* ------------------------------------------------------------------ */

const hostPath = fileURLToPath(new URL('../cli/localSessionHost.js', import.meta.url));
const batchPath = fileURLToPath(new URL('../cli/batchDispatcher.js', import.meta.url));
check('T11/localSessionHost-exists', existsSync(hostPath),
  '行为未实现：packages/core/src/cli/localSessionHost.ts 尚不存在（T11）');
check('T11/batchDispatcher-exists', existsSync(batchPath),
  '行为未实现：packages/core/src/cli/batchDispatcher.ts 尚不存在（T11）');

if (existsSync(batchPath)) {
  const batch = await import(new URL('../cli/batchDispatcher.js', import.meta.url).href) as {
    dispatchBatch?: (calls: Array<{
      requestId: string; tool: string; input: unknown; dependsOn?: string[];
    }>, execute: (tool: string, input: unknown) => Promise<{ ok: boolean }>) => Promise<Array<{
      requestId: string; status: string;
    }>>;
  };
  if (typeof batch.dispatchBatch === 'function') {
    // L06: dependency failure skips downstream without invoking the writer.
    let writerCalls = 0;
    const results = await batch.dispatchBatch([
      { requestId: 'a', tool: 'mutate_param_fields', input: { edits: [] } },
      { requestId: 'b', tool: 'mutate_param_fields', input: { edits: [] }, dependsOn: ['a'] }
    ], async () => {
      writerCalls += 1;
      return { ok: false };
    });
    check('L06/dependency-failure-skips', results[1]?.status === 'skipped_dependency' && writerCalls === 1,
      `L06：依赖失败后后续项必须 skipped_dependency 且不调用 writer，实际 ${JSON.stringify(results[1])} writer=${writerCalls}`);
  }
}

if (existsSync(hostPath)) {
  const hostModule = await import(new URL('../cli/localSessionHost.js', import.meta.url).href) as {
    LocalSessionHost?: new (sessionName: string, workspaceId: string, principal: string) => {
      dispatch: (request: { id: string; tool: string; args: Record<string, unknown> }, call: (tool: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<unknown>;
      close: () => void;
    };
  };
  if (typeof hostModule.LocalSessionHost === 'function') {
    const host = new hostModule.LocalSessionHost('smoke', 'workspace', 'cli-smoke');
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const call = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return calls;
    };
    const outcomes = await Promise.all([
      host.dispatch({ id: 'same', tool: 'read', args: {} }, call),
      host.dispatch({ id: 'other', tool: 'read', args: {} }, call),
      host.dispatch({ id: 'same', tool: 'read', args: {} }, call)
    ]);
    check('T11/host-serializes-and-deduplicates', maxActive === 1 && calls === 2
      && JSON.stringify(outcomes[0]) === JSON.stringify(outcomes[2]),
    `本地会话必须串行执行并共享重复 requestId 的 Promise，实际 max=${maxActive}, calls=${calls}`);
    let conflict = false;
    try {
      await host.dispatch({ id: 'same', tool: 'read', args: { changed: true } }, call);
    } catch (error) {
      conflict = error instanceof Error && error.message === 'CLI_REQUEST_ID_CONFLICT';
    }
    check('T11/host-rejects-request-id-conflict', conflict);
    host.close();
  }
}

/* ------------------------------------------------------------------ */
/* 3. CLI one-shot still works and routes through the registry (§9.5)  */
/* ------------------------------------------------------------------ */

const cliSource = existsSync(cliPath) ? await import('node:fs').then((fs) => fs.readFileSync(cliPath, 'utf8')) : '';
check('T11/cli-file-exists', existsSync(cliPath));
check('T11/cli-uses-core-registry', cliSource.includes('packages/core/dist') && cliSource.includes('call'),
  'CLI 必须调用 core 运行时而不是另实现一套工具语义');
check('T11/cli-routes-through-local-session', cliSource.includes('openLocalCliSession')
  && !cliSource.includes('new MemoryOperationLogStore'),
  'CLI 必须通过统一 LocalCliSession，不能重新创建内存 operation log');
// Hard check: CLI must not import a mutation facade directly (bypass gate).
check('T11/cli-no-direct-mutation-facade', !/from '[^']*containerParamEdit/.test(cliSource)
  && !/import\(['"][^']*containerParamEdit/.test(cliSource),
'CLI 不得直连底层 mutation facade 绕开门禁（交付前硬检查）');

/* ------------------------------------------------------------------ */
/* 4. Same-semantics probe: `sfcli call find_references` with a new    */
/*    selector must decode identically to the Agent path (场景 E).     */
/*    Runs the real CLI with --help-level argument rejection only.     */
/* ------------------------------------------------------------------ */

if (existsSync(cliPath)) {
  const badWorkspace = resolve(tmpdir(), 'soulforge-ref-cli-missing-ws');
  const run = spawnSync(process.execPath, [
    cliPath, '--workspace', badWorkspace, '--json',
    'call', 'find_references', JSON.stringify({
      target: { domain: 'emevd', sourceUri: 'workspace://fixture/x.emevd.dcx', eventId: 6000 }
    })
  ], { encoding: 'utf8', timeout: 120_000 });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  // The workspace does not exist, so the CLI must fail cleanly (not silently),
  // and once T08 lands, a *valid* workspace must accept the target selector.
  check('E/cli-fails-closed-on-missing-workspace', run.status !== 0 || output.length === 0 || /error|失败|不存在/i.test(output),
  `场景 E：CLI 对不存在的工作区必须失败关闭，实际 status=${run.status}`);
  check('E/cli-target-selector-accepted', !/INVALID_INPUT/.test(output) || /workspace/i.test(output),
  '行为未实现：CLI 路径的 find_references 必须与 Agent 一样接受 target 选择器（当前若报 INVALID_INPUT 且与工作区无关，说明 T08 未接线）');
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, checks, failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, checks, message: 'reference CLI session smoke passed' }, null, 2));
}

