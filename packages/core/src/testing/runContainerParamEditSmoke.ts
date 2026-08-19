/**
 * PARAM Agent 门面：分组、字段编码、权限、禁止文本补丁打原生容器。
 * 不落盘到用户 mods，不声明 native authority。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ParamDefDocument } from '@soulforge/shared';
import { createDefaultToolRegistry, type ToolContext } from '../ai/toolRegistry.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import {
  applyEditsToRowBytes,
  groupParamEdits,
  normalizeTableToken
} from '../param/containerParamEdit.js';
import { applyParamFieldMutation } from '../param/paramFieldMutation.js';

const failures: string[] = [];
let checks = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (!condition) failures.push(detail === undefined ? name : `${name} —— ${detail}`);
}

const DEF: ParamDefDocument = {
  schemaVersion: 1,
  typeName: 'DEMO_PARAM_ST',
  version: 1,
  rowDataSize: 16,
  origin: 'fixture',
  fields: [
    { id: 'f_id', name: 'idHint', type: 's32', offset: 0, size: 4 },
    { id: 'f_hp', name: 'hp', type: 'u16', offset: 4, size: 2, min: 0, max: 9999 },
    { id: 'f_rate', name: 'rate', type: 'f32', offset: 8, size: 4 }
  ]
};

const row = Buffer.alloc(16);
row.writeInt32LE(7, 0);
row.writeUInt16LE(100, 4);
row.writeFloatLE(1.5, 8);

const grouped = groupParamEdits([
  { table: 'Bullet.param', rowId: 1, fieldId: 'life', value: 2 },
  { table: 'AtkParam_Pc', rowId: 2, fieldId: 'atkStam', value: 8 },
  { table: 'bullet', rowId: 3, fieldId: 'initVellocity', value: 640 }
]);
check('group/two-tables', grouped.size === 2, `size=${grouped.size}`);
check(
  'group/bullet-merged',
  (grouped.get('bullet')?.length ?? 0) === 2,
  `bullet=${grouped.get('bullet')?.length}`
);
check('normalize/basename', normalizeTableToken('N:\\\\SPRJ\\\\data\\\\Bullet.param') === 'bullet');

const applied = applyEditsToRowBytes({
  rowDataBase64: row.toString('base64'),
  definition: DEF,
  edits: [
    { fieldId: 'f_hp', value: 200 },
    { fieldId: 'f_rate', value: 3 }
  ]
});
check('encode/ok', applied.ok === true);
if (applied.ok) {
  check('encode/before-hp', applied.before.f_hp === 100, `before=${String(applied.before.f_hp)}`);
  check('encode/after-hp', applied.after.f_hp === 200, `after=${String(applied.after.f_hp)}`);
  check('encode/before-rate', applied.before.f_rate === 1.5);
  check('encode/after-rate', applied.after.f_rate === 3);
  const again = applyParamFieldMutation({
    rowDataBase64: applied.nextDataBase64,
    definition: DEF,
    fieldId: 'f_hp',
    value: 200
  });
  check('encode/idempotent-ok', again.ok);
}

const missing = applyEditsToRowBytes({
  rowDataBase64: row.toString('base64'),
  definition: DEF,
  edits: [{ fieldId: 'nope', value: 1 }]
});
check('encode/missing-field', missing.ok === false && missing.code === 'PARAMDEF_FIELD_NOT_FOUND');

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../src/param/containerParamEdit.ts'), 'utf8');
check('source/uses-write-param', source.includes("command: 'write-param'") || source.includes('commitParamMutationsViaBridge'));
check('source/uses-write-bnd4', source.includes("command: 'write-bnd4'"));
check('source/no-smithbox-regex', !source.includes('FIELD_DEF ='));
check('source/no-index-scan', !source.includes('index < 180'));

const registry = createDefaultToolRegistry();
const listed = new Set(registry.list().map((tool) => tool.name));
check('tools/registered-read', listed.has('read_param_fields'));
check('tools/registered-mutate', listed.has('mutate_param_fields'));

const emptyContext = { mode: 'plan', workspaceIndex: new WorkspaceIndex('ws') } as ToolContext;
const planDenied = await registry.run(
  'mutate_param_fields',
  { edits: [{ table: 'Bullet', rowId: 1, fieldId: 'life', value: 2 }] },
  emptyContext
);
check(
  'permission/plan-denies-mutate',
  planDenied.ok === false && planDenied.error?.code === 'TOOL_PERMISSION_DENIED',
  JSON.stringify(planDenied.error)
);

const nativeBlocked = await registry.run(
  'propose_text_patch',
  {
    targetUri: 'file://param/gameparam/gameparam.parambnd.dcx',
    targetPath: 'param/gameparam/gameparam.parambnd.dcx',
    newText: 'nope'
  },
  { mode: 'normal', workspaceIndex: new WorkspaceIndex('ws') } as ToolContext
);
check(
  'propose/rejects-parambnd',
  nativeBlocked.ok === false && nativeBlocked.error?.code === 'USE_NATIVE_EDIT_FACADE',
  JSON.stringify(nativeBlocked.error)
);

const emevdBlocked = await registry.run(
  'propose_text_patch',
  {
    targetUri: 'file://event/common.emevd.dcx',
    targetPath: 'event/common.emevd.dcx',
    newText: 'nope'
  },
  { mode: 'normal', workspaceIndex: new WorkspaceIndex('ws') } as ToolContext
);
check(
  'propose/rejects-emevd',
  emevdBlocked.ok === false && emevdBlocked.error?.code === 'USE_NATIVE_EDIT_FACADE',
  JSON.stringify(emevdBlocked.error)
);

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, checks, failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, checks, message: 'containerParamEdit facade smoke passed' }, null, 2));
}
