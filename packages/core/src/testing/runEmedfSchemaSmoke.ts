/**
 * EMEDF fixture schema decode/encode/mutate (equal-length) smoke.
 */
import {
  createSekiroFixtureEmedf,
  decodeInstructionArgs,
  encodeInstructionArgs,
  mutateInstructionArg
} from '../emevd/emedfSchema.js';

function main(): void {
  const registry = createSekiroFixtureEmedf();
  // Synthetic 12-byte payload matching bank 2000 id 0 fixture layout
  const raw = Buffer.alloc(12);
  raw.writeInt8(1, 0); // resultConditionGroup
  raw.writeUInt8(0, 1); // desiredComparisonType
  raw.writeInt8(-1, 2); // targetConditionGroup
  raw.writeUInt8(0, 3);
  raw.writeUInt32LE(0, 4);
  raw.writeUInt32LE(0, 8);

  const decoded = decodeInstructionArgs(registry, 2000, 0, raw);
  if (!decoded.ok) throw new Error(decoded.message);
  if (decoded.args[0]?.value !== 1 || decoded.args[2]?.value !== -1) {
    throw new Error(`decode mismatch: ${JSON.stringify(decoded.args)}`);
  }

  const encoded = encodeInstructionArgs(registry, 2000, 0, {
    resultConditionGroup: 1,
    desiredComparisonType: 0,
    targetConditionGroup: -1,
    pad0: 0,
    pad1: 0,
    pad2: 0
  });
  if (!encoded.ok) throw new Error(encoded.message);
  if (encoded.args.length !== 12) {
    throw new Error(`expected 12 bytes, got ${encoded.args.length}`);
  }

  const mutated = mutateInstructionArg(registry, 2000, 0, raw, 'resultConditionGroup', 5);
  if (!mutated.ok) throw new Error(mutated.message);
  if (mutated.args.readInt8(0) !== 5) throw new Error('mutation did not write');
  if (raw.readInt8(0) !== 1) throw new Error('original buffer mutated');

  const unknown = decodeInstructionArgs(registry, 9999, 0, raw);
  if (unknown.ok || unknown.code !== 'EMEDF_UNKNOWN_INSTRUCTION') {
    throw new Error('expected unknown instruction');
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'EMEDF fixture schema 解码/编码/等长 mutation 验证通过',
    instruction: decoded.def.name,
    argCount: decoded.args.length,
    mutatedFirst: mutated.args.readInt8(0)
  }, null, 2));
}

main();
