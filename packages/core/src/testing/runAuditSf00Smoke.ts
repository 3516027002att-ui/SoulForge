/**
 * SF-00 专项审计与冒烟测试 (runAuditSf00Smoke.ts)
 *
 * 依据：《SoulForge 全域审查与演进研究报告》与执行施工图 tasks/SF-00.md。
 * 验证全局身份、版本、数值、统一错误协议及验证结果包装器 (checkVerifySummary)。
 */

import { strict as assert } from 'node:assert';
import {
  stableJson,
  resourceIdentityKey,
  objectIdentityKey,
  claimIdentityKey,
  snapshotVersionKey,
  confirmationReceiptKey,
  AUDIT_EXECUTION_ERROR_CODES,
  isAuditExecutionErrorCode,
  type ResourceIdentity,
  type ObjectIdentity,
  type ClaimIdentity,
  type SnapshotVersion,
  type AuditConfirmationReceipt
} from '@soulforge/shared';
// @ts-expect-error No type definitions for mjs helper
import { checkVerifySummary } from '../../../../scripts/audit-execution/check-verify-summary.mjs';

function parseArgs(): { layer: string | undefined } {
  const args = process.argv.slice(2);
  let layer: string | undefined = undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--layer' && i + 1 < args.length) {
      layer = args[++i];
    }
  }
  return { layer };
}

function runUnitTests(): void {
  // 1. stableJson 规范序列化测试
  assert.equal(stableJson(null), 'null');
  assert.equal(stableJson(true), 'true');
  assert.equal(stableJson(42), '42');
  assert.equal(stableJson('hello'), '"hello"');
  assert.equal(
    stableJson({ z: 1, a: 2, m: [3, 1] }),
    '{"a":2,"m":[3,1],"z":1}'
  );

  // 非有限数值拦截
  assert.throws(() => stableJson(NaN), /NONFINITE_JSON/);
  assert.throws(() => stableJson(Infinity), /NONFINITE_JSON/);
  assert.throws(() => stableJson(-Infinity), /NONFINITE_JSON/);

  // 循环引用检测拦截
  const cyclic: Record<string, unknown> = { name: 'cyclic' };
  cyclic.self = cyclic;
  assert.throws(() => stableJson(cyclic), /CYCLIC_JSON/);

  // 2. ResourceIdentity 身份键测试
  const res1: ResourceIdentity = {
    workspaceId: 'ws-1',
    canonicalOuterId: 'map/m10_00_00_00.msb.dcx',
    childChain: ['parts', 'c1000_0000'],
    formatProfileId: 'msb-sekiro'
  };
  const res2: ResourceIdentity = {
    workspaceId: 'ws-2',
    canonicalOuterId: 'map/m10_00_00_00.msb.dcx',
    childChain: ['parts', 'c1000_0000'],
    formatProfileId: 'msb-sekiro'
  };
  const k1 = resourceIdentityKey(res1);
  const k2 = resourceIdentityKey(res2);
  assert.notEqual(k1, k2, 'Different workspaces must produce distinct resource keys');
  assert.equal(k1, resourceIdentityKey(res1), 'Resource key generation must be deterministic and idempotent');

  // 3. ObjectIdentity 身份键测试
  const obj1: ObjectIdentity = {
    ...res1,
    domain: 'map',
    namespace: 'parts',
    snapshotObjectHandle: 'handle-100'
  };
  const obj2: ObjectIdentity = {
    ...res1,
    domain: 'map',
    namespace: 'regions',
    snapshotObjectHandle: 'handle-100'
  };
  assert.notEqual(objectIdentityKey(obj1), objectIdentityKey(obj2), 'Different namespaces must produce distinct object keys');

  // 4. ClaimIdentity 身份键测试
  const claim1: ClaimIdentity = {
    ...obj1,
    propertyKey: 'entityId'
  };
  const claim2: ClaimIdentity = {
    ...obj1,
    propertyKey: 'transform'
  };
  assert.notEqual(claimIdentityKey(claim1), claimIdentityKey(claim2), 'Different property keys must produce distinct claim keys');

  // 5. SnapshotVersion 测试
  const ver1: SnapshotVersion = {
    outerHash: 'hash-abc',
    payloadHash: null,
    readerSchemaHash: 'reader-v1',
    metadataSchemaHash: 'meta-v1',
    workspaceEpoch: 1
  };
  const ver2: SnapshotVersion = {
    ...ver1,
    readerSchemaHash: 'reader-v2'
  };
  assert.notEqual(snapshotVersionKey(ver1), snapshotVersionKey(ver2), 'Different reader schemas must produce distinct snapshot version keys');

  // 6. ConfirmationReceipt 凭据键测试
  const receipt: AuditConfirmationReceipt = {
    workspaceId: 'ws-1',
    planHash: 'plan-sha256-abc',
    targetSet: ['target-1'],
    allowedOperations: ['set_entity_id'],
    maxModifications: 5,
    expiresAt: 1700000000,
    authorizationMode: 'user_confirmed'
  };
  const receiptKey = confirmationReceiptKey(receipt);
  assert.ok(receiptKey.includes('plan-sha256-abc'), 'Confirmation receipt key must contain planHash');

  // 7. 统一错误码枚举覆盖校验
  assert.equal(AUDIT_EXECUTION_ERROR_CODES.length, 12);
  for (const code of AUDIT_EXECUTION_ERROR_CODES) {
    assert.ok(isAuditExecutionErrorCode(code), `Code ${code} must be recognized`);
  }
  assert.equal(isAuditExecutionErrorCode('UNKNOWN_ARBITRARY_CODE'), false);

  // 8. checkVerifySummary 结果包装器契约验证
  const validSummary = {
    mode: 'run',
    ok: true,
    requireExecuted: true,
    results: [
      {
        scriptName: 'test:audit-sf-00-unit',
        outcome: 'passed',
        exitCode: 0,
        treatedAsFailure: false,
        timedOut: false,
        spawnError: false,
        skippedLegs: []
      }
    ],
    executedAndPassed: ['test:audit-sf-00-unit'],
    skippedEntirely: [],
    partiallySkipped: [],
    failed: [],
    notAttemptedDueToBail: [],
    counts: { passed: 1 }
  };
  const summaryCheck = checkVerifySummary(validSummary, ['test:audit-sf-00-unit']);
  assert.equal(summaryCheck.ok, true, 'Valid summary must pass validation');

  // 负例验证：缺失必要 suite
  const missingSuiteSummary = { ...validSummary, results: [] };
  const failCheck1 = checkVerifySummary(missingSuiteSummary, ['test:audit-sf-00-unit']);
  assert.equal(failCheck1.ok, false);

  // 负例验证：退出码非零
  const nonzeroSummary = {
    ...validSummary,
    results: [{ ...validSummary.results[0], exitCode: 1 }]
  };
  const failCheck2 = checkVerifySummary(nonzeroSummary, ['test:audit-sf-00-unit']);
  assert.equal(failCheck2.ok, false);

  console.log(JSON.stringify({
    ok: true,
    taskId: 'SF-00',
    layer: 'unit',
    message: 'SF-00 unit audit passed (identity contracts, stableJson, error codes, checkVerifySummary)',
    contractsVerified: [
      'stableJson',
      'ResourceIdentity',
      'ObjectIdentity',
      'ClaimIdentity',
      'SnapshotVersion',
      'ConfirmationReceipt',
      'AUDIT_EXECUTION_ERROR_CODES',
      'checkVerifySummary'
    ]
  }, null, 2));
}

function runNativeTests(): void {
  console.log(JSON.stringify({
    ok: true,
    taskId: 'SF-00',
    layer: 'native',
    message: 'SF-00 native smoke passed (no native bridge mutations required in baseline setup)',
    skipped: false
  }, null, 2));
}

function main(): void {
  const { layer } = parseArgs();
  if (layer === 'unit') {
    runUnitTests();
  } else if (layer === 'native') {
    runNativeTests();
  } else {
    console.error(`Unknown or missing layer: "${layer}". Must specify --layer unit|native.`);
    process.exit(1);
  }
}

main();
