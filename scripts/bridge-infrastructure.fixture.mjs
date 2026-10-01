import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('Doctor targets the supported Bridge framework and keeps self-contained publishing', async () => {
  const doctor = await readFile('bridge/SoulForge.Doctor/SoulForge.Doctor.csproj', 'utf8');
  const bridge = await readFile('bridge/SoulForge.Bridge/SoulForge.Bridge.csproj', 'utf8');
  assert.equal(doctor.match(/<TargetFramework>([^<]+)</)?.[1], bridge.match(/<TargetFramework>([^<]+)</)?.[1]);
  assert.match(doctor, /<SelfContained>true<\/SelfContained>/);
  assert.match(doctor, /<PublishSingleFile>true<\/PublishSingleFile>/);
  const sdk = JSON.parse(await readFile('global.json', 'utf8')).sdk;
  assert.match(sdk.version, /^10\./);
  assert.equal(sdk.allowPrerelease, false);
});

test('Codex design references resolve to upstream and retain their attribution', async () => {
  const license = await readFile('licenses/openai-codex.txt', 'utf8');
  assert.match(license, /Copyright 2025 OpenAI/);
  assert.match(license, /Apache License/);
  assert.match(license, /Version 2\.0/);
  assert.match(license, /END OF TERMS AND CONDITIONS/);
  for (const file of ['agentLoop', 'contextCompactor', 'retryPolicy', 'rolloutRecorder']) {
    const source = await readFile(`packages/core/src/model-services/${file}.ts`, 'utf8');
    assert.match(source, /https:\/\/github\.com\/openai\/codex/);
  }
  const smoke = await readFile('packages/core/src/testing/runAiConformanceSmoke.ts', 'utf8');
  assert.match(smoke, /https:\/\/github\.com\/openai\/codex/);
  const notice = await readFile('NOTICE', 'utf8');
  assert.match(notice, /Copyright 2025 OpenAI/);
  assert.match(notice, /design reference/);
});
