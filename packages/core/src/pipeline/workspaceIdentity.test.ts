import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeWorkspaceId } from '../workspace/resourceUri.js';
import { scanWorkspace } from '../workspace/scanWorkspace.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { analyzeWorkspace } from './workspacePipeline.js';

async function withWorkspaceAlias(run: (root: string, alias: string, sibling: string) => Promise<void>): Promise<void> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'sf-workspace-identity-'));
  const root = join(fixtureRoot, 'mod');
  const alias = join(fixtureRoot, 'mod-alias');
  const sibling = join(fixtureRoot, 'other-mod');
  try {
    await mkdir(root);
    await mkdir(sibling);
    await writeFile(join(root, 'fixture.txt'), 'readonly identity fixture');
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await run(root, alias, sibling);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

test('scanner uses the physical session identity while retaining selected alias paths', async () => {
  await withWorkspaceAlias(async (root, alias, sibling) => {
    const session = await openWorkspaceSession({ overlayRoot: alias });
    const expectedId = makeWorkspaceId(await realpath(root));
    const scan = await scanWorkspace({ workspaceRoot: alias, includeContentHashes: false });
    assert.equal(scan.workspaceId, expectedId);
    assert.equal(scan.workspaceId, session.meta.workspaceId);
    assert.equal(scan.workspaceRoot, alias);
    assert.equal(scan.files.length, 1);
    const file = scan.files[0];
    assert.ok(file);
    assert.equal(file.workspaceId, expectedId);
    assert.equal(file.id, `${expectedId}:fixture.txt`);
    assert.equal(file.absolutePath, join(alias, 'fixture.txt'));
    assert.equal(file.sourceUri, 'file://fixture.txt');
    assert.notEqual((await scanWorkspace({ workspaceRoot: sibling })).workspaceId, expectedId);
  });
});

test('analysis of supplied files and its own scan keeps the canonical session identity', async () => {
  await withWorkspaceAlias(async (_root, alias) => {
    const session = await openWorkspaceSession({ overlayRoot: alias });
    const scan = await scanWorkspace({ workspaceRoot: alias, includeContentHashes: false });
    for (const files of [scan.files, undefined]) {
      const analyzed = await analyzeWorkspace({
        workspaceRoot: alias,
        ...(files ? { files } : {}),
        parseTextResources: false,
        parseJsonFixtures: false,
        inspectNativeResources: false
      });
      assert.equal(analyzed.index.workspaceId, session.meta.workspaceId);
      const file = analyzed.index.getFiles()[0];
      assert.ok(file);
      assert.equal(file.workspaceId, session.meta.workspaceId);
      assert.equal(file.absolutePath, join(alias, 'fixture.txt'));
    }
  });
});

test('a missing workspace root retains a structured diagnostic and cannot admit supplied files', async () => {
  await withWorkspaceAlias(async (root) => {
    const missing = join(root, 'missing');
    const scan = await scanWorkspace({ workspaceRoot: missing });
    assert.deepEqual(scan.files, []);
    assert.ok(scan.diagnostics.some(diagnostic => diagnostic.code === 'WORKSPACE_ROOT_NOT_DIRECTORY'
      && diagnostic.severity === 'error'));
    const existingFiles = (await scanWorkspace({ workspaceRoot: root })).files;
    for (const files of [existingFiles, undefined]) {
      const analyzed = await analyzeWorkspace({
        workspaceRoot: missing,
        ...(files ? { files } : {}),
        inspectNativeResources: false
      });
      assert.deepEqual(analyzed.index.getFiles(), []);
      assert.ok(analyzed.diagnostics.some(diagnostic => diagnostic.code === 'WORKSPACE_ROOT_NOT_DIRECTORY'
        && diagnostic.severity === 'error'));
    }
  });
});
