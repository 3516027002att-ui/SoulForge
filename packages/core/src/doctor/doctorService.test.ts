import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runDoctorDiagnosis, runDoctorAutoFix } from './doctorService.js';

describe('SoulForge 只狼环境体检与补全服务 (Doctor Service)', () => {
  it('能够正常执行环境诊断并返回结构化报告', async () => {
    const report = await runDoctorDiagnosis();
    assert.ok(report);
    assert.ok(report.timestamp);
    assert.ok(report.overallStatus === 'Pass' || report.overallStatus === 'Warn' || report.overallStatus === 'Fail');
    assert.ok(Array.isArray(report.items));
    assert.ok(report.items.length >= 2);

    const sekiroItem = report.items.find((i) => i.key === 'sekiro_game_path');
    assert.ok(sekiroItem);
    assert.equal(typeof sekiroItem.message, 'string');
  });

  it('能够正常执行自动补全流程', async () => {
    const fixResult = await runDoctorAutoFix();
    assert.ok(fixResult);
    assert.equal(typeof fixResult.success, 'boolean');
    assert.equal(typeof fixResult.message, 'string');
    assert.ok(Array.isArray(fixResult.actions));
  });
});
