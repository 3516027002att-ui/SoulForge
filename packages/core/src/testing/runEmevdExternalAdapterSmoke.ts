/**
 * EMEDF external adapter smoke:
 * 1) Synthetic DarkScript3-format JSON assertions (always run, deterministic).
 * 2) Real EMEDF file import when a path is provided (arg 2), validating
 *    instruction/bank counts and vararg presence.
 *
 * SoulForge does NOT bundle EMEDF data. DarkScript3 is All Rights Reserved.
 * This test uses synthetic fixtures that mimic the format, not real data.
 */
import { readFileSync } from 'node:fs';
import {
  parseDs3EmedfJson,
  importDs3EmedfFile,
  type EmedfImportResult,
} from '../emevd/emedfExternalAdapter.js';
import { resolveEmevdRegistry } from '../emevd/emedfRegistryResolver.js';
import {
  validateEmedfRegistry,
  encodedEmedfArgsLength,
  hasVararg,
  varargCount,
  findInstructionDef,
  decodeInstructionArgs,
  type EmedfRegistry,
} from '../emevd/emedfSchema.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/* ------------------------------------------------------------------ */
/*  Synthetic DarkScript3-format JSON fixture                         */
/* ------------------------------------------------------------------ */

function createSyntheticDs3EmedfJson(): string {
  return JSON.stringify({
    unknown: 0,
    main_classes: [
      {
        name: 'Condition - System',
        index: 0,
        instrs: [
          {
            name: 'IF Condition Group',
            index: 0,
            args: [
              { name: 'Result Condition Group', type: 3, enum_name: 'Condition Group' },
              { name: 'Desired Condition Group State', type: 0, enum_name: 'Condition State' },
              { name: 'Target Condition Group', type: 3, enum_name: 'Condition Group' },
            ],
          },
          {
            name: 'IF Parameter Comparison',
            index: 1,
            args: [
              { name: 'Result Condition Group', type: 3, enum_name: 'Condition Group' },
              { name: 'Comparison Type', type: 3, enum_name: 'Comparison Type' },
              { name: 'Lefthand Side', type: 5 },
              { name: 'Righthand Side', type: 5 },
            ],
          },
        ],
      },
      {
        name: 'System',
        index: 2000,
        instrs: [
          {
            name: 'Initialize Event',
            index: 0,
            args: [
              { name: 'Event Slot ID', type: 5 },
              { name: 'Event ID', type: 2 },
              { name: 'Parameters', type: 2, vararg: true },
            ],
          },
          {
            name: 'Set Network Sync State',
            index: 2,
            args: [
              { name: 'Disabled Enabled', type: 0, enum_name: 'DisabledEnabled' },
            ],
          },
        ],
      },
      {
        name: 'Entity',
        index: 2003,
        instrs: [
          {
            name: 'End Event',
            index: 1,
            args: [],
          },
        ],
      },
    ],
    enums: [],
    darkscript: {},
  });
}

/* ------------------------------------------------------------------ */
/*  Synthetic checks                                                  */
/* ------------------------------------------------------------------ */

function syntheticChecks(): void {
  const json = createSyntheticDs3EmedfJson();
  const result = parseDs3EmedfJson(json);
  assert(result.ok, `import failed: ${!result.ok ? result.message : ''}`);
  assert(result.instructionCount === 5, `instructionCount ${result.instructionCount}`);
  assert(result.bankCount === 3, `bankCount ${result.bankCount}`);

  const registry = result.registry;
  assert(registry.origin === 'imported', 'origin must be imported');
  assert(registry.game === 'sekiro', 'game must be sekiro');

  // Validate registry passes
  const validation = validateEmedfRegistry(registry);
  assert(validation.ok, `registry validation failed: ${!validation.ok ? validation.message : ''}`);

  // Check instruction names are sanitized
  const ifCondGroup = findInstructionDef(registry, 0, 0);
  assert(ifCondGroup !== undefined, 'bank 0 id 0 must exist');
  assert(ifCondGroup!.name === 'IFConditionGroup', `name: ${ifCondGroup!.name}`);
  assert(ifCondGroup!.args.length === 3, `args: ${ifCondGroup!.args.length}`);
  assert(ifCondGroup!.args[0]!.name === 'resultConditionGroup', `arg0: ${ifCondGroup!.args[0]!.name}`);
  assert(ifCondGroup!.args[0]!.type === 's8', `arg0 type: ${ifCondGroup!.args[0]!.type}`);
  assert(ifCondGroup!.args[1]!.type === 'u8', `arg1 type: ${ifCondGroup!.args[1]!.type}`);
  assert(ifCondGroup!.args[0]!.description === 'enum:Condition Group', 'enum description');

  // Check vararg instruction
  const initEvent = findInstructionDef(registry, 2000, 0);
  assert(initEvent !== undefined, 'bank 2000 id 0 must exist');
  assert(initEvent!.name === 'InitializeEvent', `name: ${initEvent!.name}`);
  assert(initEvent!.args.length === 3, `args: ${initEvent!.args.length}`);
  assert(hasVararg(initEvent!), 'InitializeEvent must have vararg');
  assert(initEvent!.args[2]!.vararg === true, 'last arg must be vararg');
  assert(initEvent!.args[2]!.type === 'u32', `vararg type: ${initEvent!.args[2]!.type}`);

  // Encoded length for vararg = base size only (8 bytes: s32 + u32)
  const baseLen = encodedEmedfArgsLength(initEvent!);
  assert(baseLen === 8, `base encoded length: ${baseLen}`);

  // Vararg count calculation
  assert(varargCount(initEvent!, 8) === 0, 'varargCount(8) = 0');
  assert(varargCount(initEvent!, 12) === 1, 'varargCount(12) = 1');
  assert(varargCount(initEvent!, 16) === 2, 'varargCount(16) = 2');
  assert(varargCount(initEvent!, 20) === 3, 'varargCount(20) = 3');
  assert(varargCount(initEvent!, 10) === -1, 'varargCount(10) = -1 (not aligned)');
  assert(varargCount(initEvent!, 4) === -1, 'varargCount(4) = -1 (too short)');

  // Non-vararg instruction
  const setNetSync = findInstructionDef(registry, 2000, 2);
  assert(setNetSync !== undefined, 'bank 2000 id 2 must exist');
  assert(!hasVararg(setNetSync!), 'SetNetworkSyncState must not have vararg');
  assert(varargCount(setNetSync!, 4) === 0, 'non-vararg exact length');
  assert(varargCount(setNetSync!, 8) === -1, 'non-vararg wrong length');

  // EndEvent with no args
  const endEvent = findInstructionDef(registry, 2003, 1);
  assert(endEvent !== undefined, 'bank 2003 id 1 must exist');
  assert(endEvent!.args.length === 0, 'EndEvent has no args');
  assert(encodedEmedfArgsLength(endEvent!) === 0, 'EndEvent encoded length 0');

  // Decode test for IfConditionGroup
  const buf = Buffer.alloc(4);
  buf.writeInt8(-1, 0);  // resultConditionGroup = -1
  buf.writeUInt8(1, 1);  // desiredConditionGroupState = 1
  buf.writeInt8(0, 2);   // targetConditionGroup = 0
  const decoded = decodeInstructionArgs(registry, 0, 0, buf);
  assert(decoded.ok, 'decode must succeed');
  if (decoded.ok) {
    assert(decoded.args.length === 3, `decoded args: ${decoded.args.length}`);
    assert(decoded.args[0]!.value === -1, `arg0 value: ${decoded.args[0]!.value}`);
    assert(decoded.args[1]!.value === 1, `arg1 value: ${decoded.args[1]!.value}`);
    assert(decoded.args[2]!.value === 0, `arg2 value: ${decoded.args[2]!.value}`);
  }

  // Error cases
  const badJson = parseDs3EmedfJson('not json');
  assert(!badJson.ok && badJson.code === 'EMEDF_IMPORT_PARSE_FAILED', 'bad JSON must fail');

  const noClasses = parseDs3EmedfJson('{}');
  assert(!noClasses.ok && noClasses.code === 'EMEDF_IMPORT_SCHEMA_INVALID', 'missing main_classes must fail');

  // Vararg not last must fail validation
  const badVararg = JSON.stringify({
    main_classes: [{
      name: 'Test',
      index: 0,
      instrs: [{
        name: 'Bad',
        index: 0,
        args: [
          { name: 'A', type: 2, vararg: true },
          { name: 'B', type: 5 },
        ],
      }],
    }],
  });
  const badVarargResult = parseDs3EmedfJson(badVararg);
  assert(!badVarargResult.ok, 'vararg not last must fail');

  // Registry resolver: no path → fixture
  const fixtureResolution = resolveEmevdRegistry(null);
  assert(fixtureResolution.origin === 'fixture', 'null path must resolve to fixture');
  assert(fixtureResolution.registry.origin === 'fixture', 'fixture registry origin');
  assert(fixtureResolution.fallbackReason === undefined, 'no fallback reason for null path');

  // Registry resolver: nonexistent path → fixture with reason
  const badPathResolution = resolveEmevdRegistry('/nonexistent/path/emedf.json');
  assert(badPathResolution.origin === 'fixture', 'bad path must fall back to fixture');
  assert(badPathResolution.fallbackReason !== undefined, 'bad path must have fallback reason');

  console.log(JSON.stringify({ ok: true, message: 'EMEDF external adapter synthetic smoke: ok', cases: 32 }));
}

/* ------------------------------------------------------------------ */
/*  Real file checks (optional)                                       */
/* ------------------------------------------------------------------ */

function realFileChecks(filePath: string): void {
  const result = importDs3EmedfFile(filePath);
  assert(result.ok, `real import failed: ${!result.ok ? result.message : ''}`);
  assert(result.instructionCount > 100, `expected >100 instructions, got ${result.instructionCount}`);
  assert(result.bankCount > 10, `expected >10 banks, got ${result.bankCount}`);

  const registry = result.registry;

  // Verify known instructions exist
  const ifCondGroup = findInstructionDef(registry, 0, 0);
  assert(ifCondGroup !== undefined, 'bank 0 id 0 (IfConditionGroup) must exist in real EMEDF');

  const initEvent = findInstructionDef(registry, 2000, 0);
  assert(initEvent !== undefined, 'bank 2000 id 0 (InitializeEvent) must exist in real EMEDF');
  assert(hasVararg(initEvent!), 'InitializeEvent must have vararg in real EMEDF');

  const endEvent = findInstructionDef(registry, 2003, 1);
  assert(endEvent !== undefined, 'bank 2003 id 1 (EndEvent) must exist in real EMEDF');

  // Count vararg instructions
  const varargCount_ = registry.instructions.filter(i => hasVararg(i)).length;
  assert(varargCount_ >= 2, `expected >=2 vararg instructions, got ${varargCount_}`);

  console.log(JSON.stringify({
    ok: true,
    message: 'EMEDF real file import: ok',
    instructionCount: result.instructionCount,
    bankCount: result.bankCount,
    varargInstructions: varargCount_,
  }));
}

/* ------------------------------------------------------------------ */
/*  Main                                                              */
/* ------------------------------------------------------------------ */

syntheticChecks();

const realPath = process.argv[2];
if (realPath) {
  realFileChecks(realPath);
} else {
  console.log(JSON.stringify({ ok: true, message: 'real EMEDF file not provided, skipping real import', skipped: true }));
}