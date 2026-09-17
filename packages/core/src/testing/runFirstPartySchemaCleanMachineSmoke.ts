import assert from 'node:assert/strict';
import {
  decodeInstructionArgs,
  decodeRowFields,
  encodeFieldMutation,
  encodedEmedfArgsLength,
  findInstructionDef,
  getFirstPartyEmedfRegistry,
  getFirstPartyParamMetadataPackage,
  hasVararg,
  mutateInstructionArg,
  resolveEmevdRegistry,
  validateFirstPartyEmedfRegistry,
  validateParamMetadataPackage
} from '../index.js';

const ENVIRONMENT_KEYS = [
  'LOCALAPPDATA',
  'SOULFORGE_EMEDF_PATH',
  'SOULFORGE_YAPPED_SDT_ROOT'
] as const;

function withCleanEnvironment<T>(run: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of ENVIRONMENT_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    return run();
  } finally {
    for (const key of ENVIRONMENT_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

withCleanEnvironment(() => {
  const paramPackage = getFirstPartyParamMetadataPackage();
  const paramValidation = validateParamMetadataPackage(paramPackage);
  assert.equal(paramValidation.ok, true, '内置 PARAM schema 必须通过摘要校验');
  assert.equal(paramPackage.source.kind, 'first-party');
  assert.equal(paramPackage.definitions.length, 160);
  assert.equal(new Set(paramPackage.definitions.map((entry) => entry.document.origin)).size, 1);
  assert.equal(paramPackage.definitions[0]?.document.origin, 'first-party');

  const mutationDefinition = paramPackage.definitions.find((entry) =>
    entry.document.fields.some((field) => field.bitfield !== undefined)
  );
  assert.ok(mutationDefinition, '内置 PARAM schema 应至少包含一个位域定义');
  const scalarField = mutationDefinition.document.fields.find((field) =>
    field.bitfield === undefined && ['u8', 'u16', 'u32', 's8', 's16', 's32'].includes(field.type)
  );
  const bitfield = mutationDefinition.document.fields.find((field) => field.bitfield !== undefined);
  assert.ok(scalarField, '内置 PARAM schema 应包含可写标量字段');
  assert.ok(bitfield, '内置 PARAM schema 应包含可写位域字段');
  const scalarRow = Buffer.alloc(mutationDefinition.document.rowDataSize);
  const scalarMutation = encodeFieldMutation(scalarRow, mutationDefinition.document, scalarField.id, 1);
  assert.equal(scalarMutation.ok, true, '内置 PARAM 标量写入必须通过布局校验');
  if (scalarMutation.ok) {
    const scalarValue = decodeRowFields(scalarMutation.next, mutationDefinition.document)
      .find((field) => field.fieldId === scalarField.id);
    assert.equal(scalarValue?.value, 1);
  }
  const bitfieldRow = Buffer.alloc(mutationDefinition.document.rowDataSize);
  bitfieldRow[bitfield.offset] = 0xf0;
  const bitfieldMutation = encodeFieldMutation(bitfieldRow, mutationDefinition.document, bitfield.id, 1);
  assert.equal(bitfieldMutation.ok, true, '内置 PARAM 位域写入必须保留同字节其他位');
  if (bitfieldMutation.ok) {
    assert.equal(bitfieldMutation.next[bitfield.offset], 0xf1);
    const bitfieldValue = decodeRowFields(bitfieldMutation.next, mutationDefinition.document)
      .find((field) => field.fieldId === bitfield.id);
    assert.equal(bitfieldValue?.value, 1);
  }

  const emedf = getFirstPartyEmedfRegistry();
  const emedfValidation = validateFirstPartyEmedfRegistry(emedf);
  assert.equal(emedfValidation.ok, true, '内置 EMEVD schema 必须通过摘要校验');
  assert.equal(emedf.origin, 'first-party');
  assert.equal(emedf.instructions.length, 405);
  assert.equal(emedf.banks?.length, 27);
  assert.equal(new Set(emedf.instructions.map((instruction) => instruction.bank)).size, 26);

  const explicitExternal = resolveEmevdRegistry('C:/third-party/sekiro-common.emedf.json');
  assert.equal(explicitExternal.origin, 'first-party');
  assert.ok(explicitExternal.diagnostics?.some((item) => item.code === 'EMEVD_EXTERNAL_SCHEMA_FORBIDDEN'));
  const emptyExternal = resolveEmevdRegistry('');
  assert.ok(emptyExternal.diagnostics?.some((item) => item.code === 'EMEVD_EXTERNAL_SCHEMA_FORBIDDEN'));

  const scalar = findInstructionDef(emedf, 0, 0);
  assert.ok(scalar, '内置 schema 应覆盖真实 corpus 的 bank 0:0');
  const scalarBytes = Buffer.alloc(encodedEmedfArgsLength(scalar));
  const scalarRead = decodeInstructionArgs(emedf, scalar.bank, scalar.id, scalarBytes);
  assert.equal(scalarRead.ok, true);

  const vararg = emedf.instructions.find(hasVararg);
  assert.ok(vararg, '内置 schema 应保留 vararg 定义');
  const varargBytes = Buffer.alloc(encodedEmedfArgsLength(vararg) + 8, 0xa5);
  const varargRead = decodeInstructionArgs(emedf, vararg.bank, vararg.id, varargBytes);
  assert.equal(varargRead.ok, true);
  const fixedArg = vararg.args.find((arg) => !arg.vararg);
  assert.ok(fixedArg, 'vararg 指令应保留至少一个固定参数');
  const mutated = mutateInstructionArg(emedf, vararg.bank, vararg.id, varargBytes, fixedArg.name, 0);
  assert.equal(mutated.ok, true);
  if (mutated.ok) assert.deepEqual(mutated.args.subarray(encodedEmedfArgsLength(vararg)), varargBytes.subarray(encodedEmedfArgsLength(vararg)));

  const unknown = decodeInstructionArgs(emedf, 9999, 9999, Buffer.alloc(0));
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.code, 'EMEDF_UNKNOWN_INSTRUCTION');
  const mismatch = decodeInstructionArgs(emedf, scalar.bank, scalar.id, Buffer.alloc(scalarBytes.length + 1));
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.code, 'EMEDF_ARGS_LENGTH_MISMATCH');
});

console.log(JSON.stringify({
  ok: true,
  message: 'first-party schema clean-machine smoke: ok',
  paramDefinitions: 160,
  emedfInstructions: 405,
  emedfBanks: 27
}));
