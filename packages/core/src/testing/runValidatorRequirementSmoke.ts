import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  PatchIrOperation,
  PatchValidatorRequirement,
  ValidatorContract,
  ValidatorResult
} from '@soulforge/shared';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { createWorkspaceTransaction } from '../transactions/workspaceTransaction.js';

const VALIDATOR_ID = 'validator_requirement_smoke';

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-validator-requirement-'));

  await verifyRequiredScopeMustBeConcrete(root);
  await verifyRegistryFailures(root);
  await verifyResultIdentityFailure(root);
  await verifyMalformedResultFailsClosed(root);
  await verifyMissingAndPartialCoverage(root);
  await verifyReportedFailureWithoutDiagnostic(root);
  await verifyThrownAfterCommitRestoresBytes(root);
  await verifyValidCoverageCommits(root);

  console.log(JSON.stringify({
    ok: true,
    message: '事务级 required validator 注册、阶段、结果与 operation 覆盖约束验证通过',
    checks: [
      'required scope=any rejected',
      'missing/duplicate/scope/method registry failures rejected before staging',
      'validator result identity mismatch rejected',
      'malformed validator result rejected without uncaught exception',
      'missing and partial operation coverage rejected',
      'ok=false without error diagnostic rejected',
      'thrown after-commit validator restored original bytes',
      'complete coverage committed'
    ]
  }, null, 2));
}

async function verifyRequiredScopeMustBeConcrete(root: string): Promise<void> {
  const target = await createTarget(root, 'ambiguous.txt');
  const patch = patchFor(root, [operationFor(target, 'ambiguous', {
    validatorId: VALIDATOR_ID,
    scope: 'any',
    required: true
  })]);
  const tx = transaction(root, [stagedValidator(() => resultFor('staged_output', ['ambiguous']))]);
  assertDiagnostic(tx.addPatch(patch), 'PATCH_VALIDATOR_REQUIRED_SCOPE_AMBIGUOUS');
}

async function verifyRegistryFailures(root: string): Promise<void> {
  const target = await createTarget(root, 'registry.txt');
  const patch = patchFor(root, [operationFor(target, 'registry')]);

  assertDiagnostic(transaction(root, []).addPatch(patch), 'REQUIRED_VALIDATOR_NOT_REGISTERED');

  const valid = stagedValidator(() => resultFor('staged_output', ['registry']));
  assertDiagnostic(
    transaction(root, [valid, stagedValidator(() => resultFor('staged_output', ['registry']))]).addPatch(patch),
    'VALIDATOR_REGISTRY_ID_DUPLICATE'
  );

  const wrongScope: ValidatorContract = {
    validatorId: VALIDATOR_ID,
    targetResourceKinds: ['*'],
    validationScope: ['before_staging'],
    validateStagedOutput: () => resultFor('staged_output', ['registry'])
  };
  assertDiagnostic(
    transaction(root, [wrongScope]).addPatch(patch),
    'REQUIRED_VALIDATOR_SCOPE_UNSUPPORTED'
  );

  const missingMethod: ValidatorContract = {
    validatorId: VALIDATOR_ID,
    targetResourceKinds: ['*'],
    validationScope: ['staged_output']
  };
  assertDiagnostic(
    transaction(root, [missingMethod]).addPatch(patch),
    'REQUIRED_VALIDATOR_METHOD_MISSING'
  );
}

async function verifyResultIdentityFailure(root: string): Promise<void> {
  const target = await createTarget(root, 'identity.txt');
  const patch = patchFor(root, [operationFor(target, 'identity')]);
  const validator = stagedValidator(() => ({
    ...resultFor('staged_output', ['identity']),
    validatorId: 'forged_validator'
  }));
  const validation = await stageAndValidate(root, patch, validator);
  assertDiagnostic(validation, 'VALIDATOR_RESULT_IDENTITY_INVALID');
  assert((await readFile(target, 'utf8')) === 'before\n', '身份伪造失败路径修改了目标文件');
}

async function verifyMissingAndPartialCoverage(root: string): Promise<void> {
  const missingTarget = await createTarget(root, 'missing-coverage.txt');
  const missingPatch = patchFor(root, [operationFor(missingTarget, 'missing-coverage')]);
  const missing = await stageAndValidate(root, missingPatch, stagedValidator(() => ({
    ok: true,
    diagnostics: [],
    scope: 'staged_output',
    validatorId: VALIDATOR_ID
  })));
  assertDiagnostic(missing, 'REQUIRED_VALIDATOR_COVERAGE_INCOMPLETE');

  const first = await createTarget(root, 'partial-first.txt');
  const second = await createTarget(root, 'partial-second.txt');
  const partialPatch = patchFor(root, [
    operationFor(first, 'partial-first'),
    operationFor(second, 'partial-second')
  ]);
  const partial = await stageAndValidate(
    root,
    partialPatch,
    stagedValidator(() => resultFor('staged_output', ['partial-first']))
  );
  assertDiagnostic(partial, 'REQUIRED_VALIDATOR_COVERAGE_INCOMPLETE');
}

async function verifyMalformedResultFailsClosed(root: string): Promise<void> {
  const target = await createTarget(root, 'malformed-result.txt');
  const patch = patchFor(root, [operationFor(target, 'malformed-result')]);
  const validator = stagedValidator(() => ({
    ...resultFor('staged_output', ['malformed-result']),
    diagnostics: [null] as unknown as ValidatorResult['diagnostics']
  }));
  const validation = await stageAndValidate(root, patch, validator);
  assertDiagnostic(validation, 'VALIDATOR_RESULT_INVALID');
}

async function verifyReportedFailureWithoutDiagnostic(root: string): Promise<void> {
  const target = await createTarget(root, 'reported-failure.txt');
  const patch = patchFor(root, [operationFor(target, 'reported-failure')]);
  const validation = await stageAndValidate(root, patch, stagedValidator(() => ({
    ...resultFor('staged_output', ['reported-failure']),
    ok: false
  })));
  assertDiagnostic(validation, 'VALIDATOR_REPORTED_FAILURE');
}

async function verifyThrownAfterCommitRestoresBytes(root: string): Promise<void> {
  const target = await createTarget(root, 'after-commit-throw.txt');
  const operation = operationFor(target, 'after-commit-throw', {
    validatorId: VALIDATOR_ID,
    scope: 'after_commit',
    required: true
  });
  const patch = patchFor(root, [operation]);
  const validator: ValidatorContract = {
    validatorId: VALIDATOR_ID,
    targetResourceKinds: ['*'],
    validationScope: ['after_commit'],
    validateAfterCommit: () => {
      throw new Error('sensitive path must not escape through diagnostics');
    }
  };
  const tx = transaction(root, [validator]);
  assert(tx.addPatch(patch).ok, '提交后异常测试无法加入 PatchIR');
  assert((await tx.stage()).ok, '提交后异常测试暂存失败');
  assert((await tx.validate()).ok, '提交后异常测试 staged validation 失败');
  const committed = await tx.commit();
  assertDiagnostic(committed, 'VALIDATOR_EXECUTION_FAILED');
  assertDiagnostic(committed, 'AFTER_COMMIT_VALIDATION_FAILED_ROLLED_BACK');
  assert((await readFile(target, 'utf8')) === 'before\n', '提交后 validator 异常未恢复原字节');
  assert(
    !JSON.stringify(committed.diagnostics).includes('sensitive path'),
    'validator 异常消息泄露到结构化诊断'
  );
}

async function verifyValidCoverageCommits(root: string): Promise<void> {
  const target = await createTarget(root, 'valid.txt');
  const patch = patchFor(root, [operationFor(target, 'valid')]);
  const tx = transaction(root, [stagedValidator(() => resultFor('staged_output', ['valid']))]);
  assert(tx.addPatch(patch).ok, '有效覆盖测试无法加入 PatchIR');
  assert((await tx.stage()).ok, '有效覆盖测试暂存失败');
  assert((await tx.validate()).ok, '有效覆盖测试 validation 失败');
  const committed = await tx.commit();
  assert(committed.ok, `有效覆盖提交失败：${JSON.stringify(committed.diagnostics)}`);
  assert((await readFile(target, 'utf8')) === 'after-valid\n', '有效覆盖未提交目标内容');
}

function transaction(root: string, validators: ValidatorContract[]) {
  return createWorkspaceTransaction({
    workspaceId: 'validator-requirement-smoke',
    workspaceRoot: root,
    validators
  });
}

async function stageAndValidate(
  root: string,
  patch: ReturnType<typeof patchFor>,
  validator: ValidatorContract
) {
  const tx = transaction(root, [validator]);
  assert(tx.addPatch(patch).ok, '定向 validator 测试无法加入 PatchIR');
  assert((await tx.stage()).ok, '定向 validator 测试暂存失败');
  return tx.validate();
}

function stagedValidator(run: () => ValidatorResult): ValidatorContract {
  return {
    validatorId: VALIDATOR_ID,
    targetResourceKinds: ['*'],
    validationScope: ['staged_output'],
    validateStagedOutput: run
  };
}

function resultFor(
  scope: 'staged_output',
  validatedOperationIds: string[]
): ValidatorResult {
  return {
    ok: true,
    diagnostics: [],
    scope,
    validatorId: VALIDATOR_ID,
    validatedOperationIds
  };
}

function patchFor(root: string, operations: PatchIrOperation[]) {
  return createPatchIr({
    workspaceId: 'validator-requirement-smoke',
    title: `validator requirement smoke ${root}`,
    author: 'system',
    operations
  });
}

function operationFor(
  targetPath: string,
  id: string,
  requirement: PatchValidatorRequirement = {
    validatorId: VALIDATOR_ID,
    scope: 'staged_output',
    required: true
  }
): PatchIrOperation {
  return {
    id,
    kind: 'text_edit',
    targetUri: `file://${targetPath.replaceAll('\\', '/')}`,
    targetPath,
    newText: `after-${id}\n`,
    preconditions: [],
    validatorRequirements: [requirement],
    riskLevel: 'safe'
  };
}

async function createTarget(root: string, name: string): Promise<string> {
  const target = join(root, name);
  await writeFile(target, 'before\n', 'utf8');
  return target;
}

function assertDiagnostic(
  result: { ok: boolean; diagnostics: Array<{ code: string }> },
  code: string
): void {
  assert(!result.ok, `${code} 测试意外成功`);
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === code), `缺少诊断 ${code}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
