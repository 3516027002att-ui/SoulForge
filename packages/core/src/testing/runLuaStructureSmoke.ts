import { strict as assert } from 'node:assert';
import { buildLuaStructureIndex, parseLuaStaticSubset } from '../references/luaStaticSubset.js';

const source = `
local EFFECT = 9003
function Goal_Activate(ai)
  if ai:IsInsideArena() then
    AddSpecialEffect(EFFECT)
  else
    UnknownGameApi(42)
  end
end
`;
const parsed = parseLuaStaticSubset(source);
const structure = buildLuaStructureIndex(source, parsed);
assert.equal(structure.status, 'complete');
assert.equal(structure.goals[0]?.name, 'Goal_Activate');
assert(structure.branches.some((branch) => branch.kind === 'if'));
assert.equal(structure.constants[0]?.value, 9003);
assert(structure.unsupportedApis.some((item) => item.callee === 'AddSpecialEffect'));
assert(structure.unsupportedApis.some((item) => item.callee === 'UnknownGameApi'));
assert(parsed.calls.every((call) => call.span.startOffset < call.span.endOffset));

const assigned = buildLuaStructureIndex('Goal.Activate = function(ai)\n return 1\nend\nlocal helper = function() end\nconsume(function() end)');
assert.equal(assigned.goals[0]?.name, 'Goal.Activate');
assert.equal(assigned.functions[1]?.name, 'helper');
assert.equal(assigned.functions[2]?.name, '<anonymous>');
assert.equal(buildLuaStructureIndex('local X = 1; X = 2').constants.some((item) => item.name === 'X'), false);
assert.equal(buildLuaStructureIndex('function broken() return 1').status, 'partial');
assert.equal(buildLuaStructureIndex('function loops() for i=1,3 do while true do break end end end').status, 'complete');

console.log(JSON.stringify({ ok: true, checks: 12, message: 'Lua structural evidence smoke passed' }));
