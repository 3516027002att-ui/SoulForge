import { test as base } from '@playwright/test';
import { basename } from 'node:path';
import { createElectronTestResources } from '../../../../scripts/electron-test-resources.mjs';

export { expect, _electron as electron } from '@playwright/test';
const owners = new Map();
export const test = base.extend({
  ownedElectronResources: [async ({}, use, testInfo) => {
    const owner = await createElectronTestResources(basename(testInfo.file).replace(/[^A-Za-z0-9._-]/g, '-'));
    owners.set(testInfo.testId, owner);
    try { await use(owner); }
    finally { owners.delete(testInfo.testId); await owner.dispose(); }
  }, { auto: true }]
});

export function testWorkspace() {
  const owner = owners.get(test.info().testId);
  if (!owner) throw new Error('E2E_TEST_OWNER_MISSING');
  return owner;
}
