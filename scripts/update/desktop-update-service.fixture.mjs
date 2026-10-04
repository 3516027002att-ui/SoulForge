import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const fixtureKey = Symbol.for('sf.desktop-update-service.fixture');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Run the actual service, release client, downloader, installer checks and settings
// hook. Only Electron/updater host effects and HTTP responses are stubbed: no
// installer, user profile, live GitHub request or installed acceptance is involved.
// The service's supported Windows x64 host is modeled on every test platform.
async function harness(run) {
  const parent = join(repositoryRoot, 'node_modules/.cache/desktop-update-service-fixture');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-'));
  const installerName = 'SoulForge-0.9.2-x64.exe';
  const installerPath = join(root, installerName);
  const installerBytes = Buffer.from('owned update fixture; never an executable');
  const sha256 = createHash('sha256').update(installerBytes).digest('hex');
  const sha512 = createHash('sha512').update(installerBytes).digest('base64');
  const releaseBase = 'https://github.com/3516027002att-ui/SoulForge/releases/download/v0.9.2/';
  const latest = `version: 0.9.2\nfiles:\n  - url: ${installerName}\n    sha512: ${sha512}\n    size: ${installerBytes.length}\npath: ${installerName}\nsha512: ${sha512}\n`;
  const sums = `${sha256}  ${installerName}\n`;
  const release = {
    tag_name: 'v0.9.2', name: 'Owned update', body: '', draft: false, prerelease: false,
    html_url: 'https://github.com/3516027002att-ui/SoulForge/releases/tag/v0.9.2',
    assets: [
      [installerName, installerBytes.length], [`${installerName}.blockmap`, 1],
      ['latest.yml', latest.length], ['SHA256SUMS.txt', sums.length]
    ].map(([name, size]) => ({ name, size, state: 'uploaded', browser_download_url: releaseBase + name }))
  };
  const state = {
    installerPath, responses: [1, 0], dialogs: [], downloads: 0, installs: [], feed: null,
    agentActive: false, transactionActive: false, rollbackActive: false, requests: []
  };
  const previousFetch = globalThis.fetch;
  globalThis[fixtureKey] = state;
  globalThis.fetch = async input => {
    const url = String(input); state.requests.push(url);
    const body = url === 'https://api.github.com/repos/3516027002att-ui/SoulForge/releases?per_page=100'
      ? JSON.stringify([release]) : url === releaseBase + 'latest.yml' ? latest
        : url === releaseBase + 'SHA256SUMS.txt' ? sums : null;
    assert.notEqual(body, null, `Unexpected fixture request: ${url}`);
    return new Response(body, { status: 200 });
  };
  let renderer;
  try {
    await writeFile(installerPath, installerBytes);
    const output = join(root, 'update.mjs');
    await build({
      stdin: { contents: `export {DesktopUpdateService} from './apps/desktop/src/main/update/desktopUpdateService.ts';
        export {useRuntimeSettingsController} from './apps/desktop/src/renderer/src/app/useRuntimeSettingsController.ts';`,
        resolveDir: repositoryRoot, loader: 'ts' },
      outfile: output, bundle: true, format: 'esm', platform: 'node', target: 'node22',
      external: ['node:*', 'react', 'builder-util-runtime'],
      define: { 'process.platform': '"win32"', 'process.arch': '"x64"' },
      plugins: [{ name: 'owned-update-host', setup(b) {
        b.onResolve({ filter: /^(electron|electron-updater)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
        b.onLoad({ filter: /^electron$/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `
          const state=()=>globalThis[Symbol.for('sf.desktop-update-service.fixture')];
          export const app={isPackaged:true,getVersion:()=> '0.9.1'};
          export const BrowserWindow={fromWebContents:()=>null};
          export const dialog={showMessageBox:async(...args)=>{
            state().dialogs.push(args.at(-1));return {response:state().responses.shift() ?? 1};}};` }));
        b.onLoad({ filter: /^electron-updater$/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `
          const state=()=>globalThis[Symbol.for('sf.desktop-update-service.fixture')];
          export const autoUpdater={setFeedURL:input=>{state().feed=input;},
            checkForUpdates:async()=>({isUpdateAvailable:true,updateInfo:{version:'0.9.2'}}),
            downloadUpdate:async()=>{state().downloads++;return [state().installerPath];},
            on(){},removeListener(){},
            quitAndInstall:(...args)=>{state().installs.push(args);},
            verifyUpdateCodeSignature:async()=>null};` }));
      } }]
    });
    const { DesktopUpdateService, useRuntimeSettingsController } = await import(pathToFileURL(output).href);
    const service = new DesktopUpdateService({
      userDataPath: root, currentVersion: '0.9.1', isPackaged: true, webContents: {},
      hasActiveAgentRuns: () => state.agentActive,
      hasActiveTransactions: async () => state.transactionActive,
      hasActiveRollbacks: () => state.rollbackActive
    });
    const bridge = {
      getUpdateState: async () => service.state, onUpdateState: listener => service.subscribe(listener),
      getRagLocalModelStatus: async () => ({ state: 'unavailable' }),
      checkForUpdate: () => service.check(), downloadUpdate: () => service.download(),
      cancelUpdate: async () => service.cancel(), installUpdate: () => service.install(),
      setUpdateChannel: ({ channel }) => service.setChannel(channel)
    };
    let controller;
    function Host() {
      controller = useRuntimeSettingsController({ bridge, setStatus() {}, pushToast() {}, announceDesktopOnly() {} });
      return null;
    }
    await act(async () => { renderer = TestRenderer.create(React.createElement(Host)); });
    const click = async () => {
      let result;
      await act(async () => {
        assert(controller.currentUpdateAction.run);
        await controller.runUpdateCommand(async () => {
          result = await controller.currentUpdateAction.run(); return result;
        });
      });
      return result;
    };
    assert.equal((await click()).state.status, 'available');
    assert.equal((await click()).state.status, 'pending-install');
    await run({ service, bridge, state, click, current: () => controller, installerBytes, installerPath, releaseBase });
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    globalThis.fetch = previousFetch;
    delete globalThis[fixtureKey];
    const ownedRelative = relative(parent, root);
    assert(ownedRelative && !ownedRelative.startsWith('..') && !isAbsolute(ownedRelative));
    await rm(root, { recursive: true, force: true });
  }
}

test('Later retains the downloaded update and settings install action through a confirmed retry', () => harness(async h => {
  const pendingInfo = h.service.state.info;
  const declined = await h.click();
  const nextAction = h.current().currentUpdateAction.run;
  const retry = await h.click();
  assert.equal(declined.state.status, 'blocked', `Later published ${declined.state.status}; next action returned ${retry.error?.code ?? retry.state.status}`);
  assert.equal(declined.ok, false);
  assert.equal(declined.error.code, 'UPDATE_INSTALL_DECLINED');
  assert.equal(declined.error.retryable, true);
  assert.deepEqual(declined.state.diagnostic, declined.error);
  assert.deepEqual(declined.state.info, pendingInfo);
  assert.equal(nextAction, h.bridge.installUpdate);
  assert.equal(retry.ok, true);
  assert.equal(retry.state.status, 'installed');
  assert.equal(h.state.dialogs.length, 2);
  assert.equal(h.state.downloads, 1);
  assert.equal(h.state.requests.length, 3);
  assert.deepEqual(h.state.feed, { provider: 'generic', url: h.releaseBase });
  assert.deepEqual(h.state.installs, [[false, true]]);
}));

test('a deferred install still revalidates the downloaded bytes before host installation', () => harness(async h => {
  await h.click();
  const tampered = Buffer.from(h.installerBytes); tampered[0] ^= 1;
  await writeFile(h.installerPath, tampered);
  const result = await h.click();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'UPDATE_HASH_MISMATCH');
  assert.equal(h.state.downloads, 1);
  assert.deepEqual(h.state.installs, []);
}));

test('a deferred install retains active Agent, transaction and rollback blockers until they clear', () => harness(async h => {
  await h.click();
  for (const [flag, code] of [
    ['agentActive', 'UPDATE_INSTALL_BLOCKED_AGENT_ACTIVE'],
    ['transactionActive', 'UPDATE_INSTALL_BLOCKED_TRANSACTION'],
    ['rollbackActive', 'UPDATE_INSTALL_BLOCKED_TRANSACTION']
  ]) {
    h.state[flag] = true;
    const result = await h.click();
    assert.equal(result.state.status, 'blocked');
    assert.equal(result.error.code, code);
    assert.equal(h.current().currentUpdateAction.run, h.bridge.installUpdate);
    assert.equal(h.state.dialogs.length, 1);
    assert.deepEqual(h.state.installs, []);
    h.state[flag] = false;
  }
  assert.equal((await h.click()).state.status, 'installed');
  assert.equal(h.state.downloads, 1);
  assert.deepEqual(h.state.installs, [[false, true]]);
}));
