/**
 * EMEDF completion catalog smoke（T4-3）：
 * 从 fixture registry 与 synthetic 导入 registry 投影补全目录，
 * 钉住只读公开字段（name/bank/id/args）与同名指令保留。
 */
import {
  createSekiroFixtureEmedf,
  type EmedfRegistry,
} from '../emevd/emedfSchema.js';
import { parseDs3EmedfJson } from '../emevd/emedfExternalAdapter.js';
import { listEmedfCompletionItems } from '../emevd/emedfCompletionCatalog.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/* fixture registry：IfConditionGroup / WaitFor / EndEvent */
const fixture = createSekiroFixtureEmedf();
const fixtureItems = listEmedfCompletionItems(fixture);

assert(fixtureItems.length === 3, `fixture 投影应含 3 条指令，实际 ${fixtureItems.length}`);
const ifCondition = fixtureItems.find((item) => item.name === 'IfConditionGroup');
assert(ifCondition, 'fixture 应含 IfConditionGroup');
assert(ifCondition.bank === 2000 && ifCondition.id === 0, 'IfConditionGroup 应保持 bank=2000 id=0');
assert(
  ifCondition.args[0]!.name === 'resultConditionGroup' && ifCondition.args[0]!.type === 's8',
  'IfConditionGroup 首参应为 resultConditionGroup:s8'
);

/* synthetic 导入：同名指令（不同 bank:id）应全部保留 */
const imported = parseDs3EmedfJson(
  JSON.stringify({
    main_classes: [
      {
        name: 'System',
        index: 2000,
        instrs: [
          { name: 'GotoEvent', index: 1, args: [{ name: 'Event ID', type: 3 }] },
        ],
      },
      {
        name: 'System 2',
        index: 2001,
        instrs: [
          { name: 'GotoEvent', index: 2, args: [{ name: 'Event ID', type: 3 }] },
        ],
      },
    ],
  })
);
assert(imported.ok, `synthetic 导入应成功，实际 ${imported.ok ? '' : imported.message}`);
const importedItems = listEmedfCompletionItems((imported as { registry: EmedfRegistry }).registry);
const gotos = importedItems.filter((item) => item.name === 'GotoEvent');
assert(gotos.length === 2, `同名 GotoEvent 应保留 2 条，实际 ${gotos.length}`);
assert(
  gotos.some((item) => item.bank === 2000 && item.id === 1) &&
    gotos.some((item) => item.bank === 2001 && item.id === 2),
  '同名指令应保留各自 bank:id'
);
assert(
  gotos.every((item) => item.args.length === 1 && item.args[0]!.name === 'eventId'),
  'GotoEvent 参数应投影为 eventId'
);

console.log(`emedf-completion-catalog ok（fixture=${fixtureItems.length}，导入=${importedItems.length}）`);
