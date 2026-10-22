import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validatePortableBuilderResourceSources } from './portable-packaging-config.mjs';

const helper = await import('./dotnet-runtime-notices.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw error;
});

async function fixture(rid, version, run) {
  const root = await mkdtemp(join(tmpdir(), 'sf-runtime-notices-'));
  try {
    const project = join(root, 'bridge/SoulForge.Bridge');
    const build = join(project, 'bin/Release/net10.0', rid);
    const packages = join(root, 'restored-packages');
    const pack = join(packages, `microsoft.netcore.app.runtime.${rid}`, version);
    await mkdir(join(build, 'publish'), { recursive: true });
    await mkdir(join(project, 'obj'), { recursive: true });
    await mkdir(pack, { recursive: true });
    await writeFile(join(build, 'SoulForge.Bridge.deps.json'), JSON.stringify({ libraries: {
      [`runtimepack.Microsoft.NETCore.App.Runtime.${rid}/${version}`]: { type: 'runtimepack' }
    } }));
    await writeFile(join(project, 'obj/project.assets.json'), JSON.stringify({ packageFolders: { [packages]: {} } }));
    await writeFile(join(pack, 'LICENSE.TXT'), `License for ${rid}/${version}\n`);
    await writeFile(join(pack, 'THIRD-PARTY-NOTICES.TXT'), `Exact notices for ${rid}/${version}\n`);
    await run({ root, build, pack });
  } finally { await rm(root, { recursive: true, force: true }); }
}

for (const [rid, version] of [['linux-x64', '10.0.12'], ['win-x64', '10.0.0']]) {
  test(`copies actual ${rid} runtime ${version} notices without release path disclosure`, async () => {
    assert.ok(helper, 'actual-runtime notice preparation is missing');
    await fixture(rid, version, async ({ root, build, pack }) => {
      const result = await helper.prepareRuntimeNotices(root, { runtimeIdentifier: rid, packageFolders: [] });
      const target = join(build, 'publish/runtime-notices');
      assert.equal(result.packageVersion, version);
      assert.equal(result.runtimeIdentifier, rid);
      assert.deepEqual(await readFile(join(target, 'LICENSE.txt')), await readFile(join(pack, 'LICENSE.TXT')));
      assert.deepEqual(await readFile(join(target, 'THIRD-PARTY-NOTICES.txt')), await readFile(join(pack, 'THIRD-PARTY-NOTICES.TXT')));
      const manifestText = await readFile(join(target, 'runtime-notices.json'), 'utf8');
      assert.ok(!manifestText.includes(root), 'release metadata must omit private absolute paths');
      assert.equal(JSON.parse(manifestText).packageVersion, version);
    });
  });
}

test('rejects a different runtime target and missing exact-version notice before publication', async () => {
  assert.ok(helper, 'actual-runtime notice preparation is missing');
  await fixture('linux-x64', '10.0.12', async ({ root, build, pack }) => {
    await assert.rejects(helper.prepareRuntimeNotices(root, { runtimeIdentifier: 'win-x64', packageFolders: [] }), /runtime|ENOENT/i);
    await rm(join(pack, 'THIRD-PARTY-NOTICES.TXT'));
    await assert.rejects(helper.prepareRuntimeNotices(root, { runtimeIdentifier: 'linux-x64', packageFolders: [] }), /notice/i);
    await assert.rejects(readFile(join(build, 'publish/runtime-notices/runtime-notices.json')), { code: 'ENOENT' });
  });
});

test('both package profiles include only the prepared runtime legal files', async () => {
  const config = JSON.parse(await readFile(new URL('../apps/desktop/electron-builder.json', import.meta.url)));
  for (const [profile, rid] of [['linux', 'linux-x64'], ['win', 'win-x64']]) {
    const resource = config[profile].extraResources.find(item => item.to === 'bridge/runtime-notices');
    assert.ok(resource, `${profile} package omits its actual runtime notices`);
    assert.ok(resource.from.includes(`/${rid}/publish/runtime-notices`));
    assert.deepEqual(resource.filter, ['LICENSE.txt', 'THIRD-PARTY-NOTICES.txt', 'runtime-notices.json']);
  }
});

test('native package source admits prepared legal directory and rejects a missing legal file', async () => {
  assert.ok(helper, 'actual-runtime notice preparation is missing');
  await fixture('linux-x64', '10.0.12', async ({ root, build }) => {
    await helper.prepareRuntimeNotices(root, { runtimeIdentifier: 'linux-x64', packageFolders: [] });
    const resource = { from: join(build, 'publish/runtime-notices'), to: 'bridge/runtime-notices',
      filter: ['LICENSE.txt', 'THIRD-PARTY-NOTICES.txt', 'runtime-notices.json'] };
    const config = { extraResources: [], linux: { extraResources: [resource] } };
    assert.equal(validatePortableBuilderResourceSources(config, root, { platform: 'linux' })[0].ok, true);
    await rm(join(resource.from, 'THIRD-PARTY-NOTICES.txt'));
    assert.equal(validatePortableBuilderResourceSources(config, root, { platform: 'linux' })[0].ok, false);
  });
});
