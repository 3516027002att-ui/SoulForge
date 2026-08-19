/**
 * FMG / EMEVD Agent 门面：分组、权限、写路径声明、禁止文本补丁打原生容器。
 * 不落盘到用户 mods。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultToolRegistry, type ToolContext } from '../ai/toolRegistry.js';
import { groupFmgEdits } from '../editing/fmgEdit.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';

const failures: string[] = [];
let checks = 0;
function check(name: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (!condition) failures.push(detail === undefined ? name : `${name} —— ${detail}`);
}

const grouped = groupFmgEdits([
  { table: 'Title', id: 1, text: 'a' },
  { table: 'title', id: 2, text: 'b' },
  { table: 'Description', id: 3, text: 'c' }
]);
check('group/two-tables', grouped.size === 2, `size=${grouped.size}`);
check('group/title-merged', (grouped.get('title')?.length ?? 0) === 2);

const fmgSource = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../src/editing/fmgEdit.ts'), 'utf8');
check('fmg/uses-write-fmg', fmgSource.includes('commitFmgMutationsViaBridge'));
check('fmg/requires-entry-index', fmgSource.includes('entryIndex: resolved.entryIndex'));
check('fmg/no-loose-msgbnd', !fmgSource.includes('writeFile('));

const evSource = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../src/editing/emevdEdit.ts'), 'utf8');
check('emevd/uses-four-view', evSource.includes('submitEmevdDslPlanViaFourView'));
check('emevd/no-direct-write-emevd', !evSource.includes("command: 'write-emevd'"));

const registry = createDefaultToolRegistry();
const names = new Set(registry.list().map((tool) => tool.name));
check('tools/read_fmg', names.has('read_fmg_entries'));
check('tools/mutate_fmg', names.has('mutate_fmg_entries'));
check('tools/read_emevd', names.has('read_emevd_outline'));
check('tools/apply_emevd', names.has('apply_emevd_dsl'));

const plan = { mode: 'plan', workspaceIndex: new WorkspaceIndex('ws') } as ToolContext;
for (const tool of ['mutate_fmg_entries', 'apply_emevd_dsl'] as const) {
  const denied = await registry.run(
    tool,
    tool === 'apply_emevd_dsl'
      ? { file: 'event/common.emevd.dcx', dsl: 'event @e:x {}' }
      : { edits: [{ table: 'Title', id: 1, text: 'x' }] },
    plan
  );
  check(
    `permission/plan-denies-${tool}`,
    denied.ok === false && denied.error?.code === 'TOOL_PERMISSION_DENIED',
    JSON.stringify(denied.error)
  );
}

const blocked = await registry.run(
  'propose_text_patch',
  {
    targetUri: 'file://msg/zhocn/item.msgbnd.dcx',
    targetPath: 'msg/zhocn/item.msgbnd.dcx',
    newText: 'nope'
  },
  { mode: 'normal', workspaceIndex: new WorkspaceIndex('ws') } as ToolContext
);
check(
  'propose/rejects-msgbnd',
  blocked.ok === false && blocked.error?.code === 'USE_NATIVE_EDIT_FACADE',
  JSON.stringify(blocked.error)
);

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, checks, failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    ok: true,
    checks,
    message: 'FMG/EMEVD native edit facade smoke passed'
  }, null, 2));
}
